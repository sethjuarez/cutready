//! Runs the independent audit on a finished take folder (`take.json` +
//! `take.mp4`) and writes `audit.json` and `contact-sheet.png` next to it.
//! It reads only what the take recorded and the final media; nothing from
//! the planner's detections is used.

use super::align::{after_pause, align, content_issues, cue_token, ContentIssue, WordProblem};
use super::media::{audio_offset_ms, gray_frames, rgb_frames, wav_16k, AUDIT_SIZE};
use super::sheet::{write_sheet, SheetFrame, SheetRow, THUMB};
use super::stt::{transcribe, Transcript};
use super::verdict::{decide, overall, CueEvidence, CueVerdict, Verdict, VerdictConfig};
use super::visual::{observe, VisualConfig, VisualEvidence, Window};
use super::witness::{witness, WitnessConfig, WitnessEvidence, WitnessStatus};
use crate::engine::demo_timing::{
    resolve_cues, AuditReport, Cue, CueAnchor, EpochFit, Fps, FrameIndex, WordTiming,
};
use crate::engine::live_take::analysis::ViewBox;
use crate::engine::live_take::script::LiveTakeScript;
use crate::engine::live_take::sidecar_io::{SpeechAuth, TakeLog};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const TAKE_AUDIT_SCHEMA_V1: &str = "cutready.take-audit.v1";
const FPS: Fps = Fps::FPS_25;

/// Word-time model for the recognizer, calibrated on recorded takes (see
/// `docs/video/audit.md`): mid-phrase starts are reported late by a stable
/// amount; starts after a pause are unbiased but noisier.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordModel {
    pub pause_ms: f64,
    pub mid_phrase_correction_ms: f64,
    pub mid_phrase_uncertainty_ms: f64,
    pub after_pause_uncertainty_ms: f64,
    pub word_end_uncertainty_ms: f64,
}

impl Default for WordModel {
    fn default() -> Self {
        Self {
            pause_ms: 100.0,
            mid_phrase_correction_ms: -47.5,
            mid_phrase_uncertainty_ms: 25.0,
            after_pause_uncertainty_ms: 120.0,
            word_end_uncertainty_ms: 120.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditConfig {
    pub words: WordModel,
    pub window_radius_ms: f64,
    pub visual: VisualConfig,
    pub witness: WitnessConfig,
    pub verdict: VerdictConfig,
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            words: WordModel::default(),
            window_radius_ms: 2000.0,
            visual: VisualConfig::default(),
            witness: WitnessConfig::default(),
            verdict: VerdictConfig::default(),
        }
    }
}

pub struct AuditOptions {
    /// `None` skips speech-to-text (offline): every word is uncertain.
    pub stt: Option<SpeechAuth>,
    pub stt_cache: PathBuf,
    pub config: AuditConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordEvidence {
    pub word_index: usize,
    pub text: String,
    pub anchor: CueAnchor,
    pub offset_ms: f64,
    /// Where the expected time came from: `transcript` or, when it is
    /// unavailable, `plan` (used only to place the search window).
    pub source: String,
    pub problem: Option<String>,
    pub heard: Option<String>,
    pub stt_start_ms: Option<f64>,
    pub stt_duration_ms: Option<f64>,
    pub after_pause: Option<bool>,
    pub correction_ms: Option<f64>,
    pub uncertainty_ms: Option<f64>,
    /// Expected action onset on the video clock.
    pub expected_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueReport {
    pub step_index: usize,
    pub step_id: String,
    pub kind: String,
    pub word: WordEvidence,
    pub visual: VisualEvidence,
    pub window_valid: bool,
    pub witness: WitnessEvidence,
    pub verdict: Verdict,
    pub reasons: Vec<String>,
    pub drift_d1_ms: Option<f64>,
    pub drift_d2_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSummary {
    pub engine: String,
    pub audio_sha256: String,
    pub cached: bool,
    pub request_ms: u128,
    pub audio_offset_ms: f64,
    pub wer: f64,
    pub text: String,
    pub content_issues: Vec<ContentIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeAudit {
    pub schema: String,
    pub take_dir: PathBuf,
    pub video: PathBuf,
    pub verdict: Verdict,
    pub cues: Vec<CueReport>,
    pub transcript: Option<TranscriptSummary>,
    /// The old self-consistency check (same detector as the planner), kept
    /// for comparison; it never makes an independent verdict pass.
    pub render_consistency_passed: Option<bool>,
    pub contact_sheet: Option<PathBuf>,
    /// Steps with no resolvable cue word; any makes the take uncertain.
    pub uncued_steps: Vec<String>,
    pub notes: Vec<String>,
    pub config: AuditConfig,
    pub timings_ms: Vec<(String, u128)>,
}

struct TakeInputs {
    script: LiveTakeScript,
    words: Vec<WordTiming>,
    planned_words: Vec<WordTiming>,
    log: TakeLog,
    raw_epoch: EpochFit,
    frame_map: Vec<FrameIndex>,
    render_consistency: Option<AuditReport>,
}

fn field<T: for<'de> Deserialize<'de>>(v: &Value, path: &[&str]) -> Result<T> {
    let mut cur = v;
    for p in path {
        cur = cur
            .get(*p)
            .ok_or_else(|| anyhow!("take.json has no {}", path.join(".")))?;
    }
    serde_json::from_value(cur.clone()).with_context(|| format!("take.json {}", path.join(".")))
}

fn load(dir: &Path) -> Result<TakeInputs> {
    let text = std::fs::read_to_string(dir.join("take.json"))
        .with_context(|| format!("read {}", dir.join("take.json").display()))?;
    let v: Value = serde_json::from_str(&text)?;
    let render_consistency = ["renderConsistency", "audit"].iter().find_map(|k| {
        v.get(*k)
            .and_then(|a| serde_json::from_value(a.clone()).ok())
    });
    Ok(TakeInputs {
        script: field(&v, &["script"])?,
        words: field(&v, &["narration", "words"])?,
        planned_words: field(&v, &["plan", "words"])?,
        log: field(&v, &["take", "log"])?,
        raw_epoch: field(&v, &["take", "rawEpoch"])?,
        frame_map: field(&v, &["render", "frameMap"])?,
        render_consistency,
    })
}

struct Timer(Vec<(String, u128)>, Instant);

impl Timer {
    fn mark(&mut self, stage: &str) {
        self.0.push((stage.into(), self.1.elapsed().as_millis()));
        self.1 = Instant::now();
    }
}

fn problem_name(p: WordProblem) -> &'static str {
    match p {
        WordProblem::NotHeard => "cueWordNotHeard",
        WordProblem::MergedIntoPrevious => "cueWordMerged",
        WordProblem::WeakContext => "cueWordWeakContext",
    }
}

struct Heard<'a> {
    transcript: &'a Transcript,
    alignment: super::align::Alignment,
    audio_offset_ms: f64,
}

fn word_evidence(
    word_index: usize,
    cue: &Cue,
    inputs: &TakeInputs,
    heard: Option<&Heard>,
    model: &WordModel,
) -> WordEvidence {
    let offset_ms = cue.offset_us.get() as f64 / 1000.0;
    let text = inputs
        .words
        .get(word_index)
        .map(|w| w.text.clone())
        .unwrap_or_default();
    let planned_ms = inputs.planned_words.get(word_index).map_or(0.0, |w| {
        let edge = match cue.anchor {
            CueAnchor::WordStart => w.start_us,
            CueAnchor::WordEnd => w.end_us(),
        };
        edge.get() as f64 / 1000.0
    });
    let mut ev = WordEvidence {
        word_index,
        text,
        anchor: cue.anchor,
        offset_ms,
        source: "plan".into(),
        problem: Some("sttSkipped".into()),
        heard: None,
        stt_start_ms: None,
        stt_duration_ms: None,
        after_pause: None,
        correction_ms: None,
        uncertainty_ms: None,
        expected_ms: planned_ms + offset_ms,
    };
    let Some(h) = heard else {
        return ev;
    };
    let j = match cue_token(&h.alignment, word_index) {
        Ok(j) => j,
        Err(p) => {
            ev.problem = Some(problem_name(p).into());
            return ev;
        }
    };
    let w = &h.transcript.words[j];
    let pause = after_pause(
        &h.transcript.words,
        &h.transcript.phrase_first,
        j,
        model.pause_ms,
    );
    let (edge, correction, u) = match cue.anchor {
        CueAnchor::WordStart if pause => (w.start_ms, 0.0, model.after_pause_uncertainty_ms),
        CueAnchor::WordStart => (
            w.start_ms,
            model.mid_phrase_correction_ms,
            model.mid_phrase_uncertainty_ms,
        ),
        CueAnchor::WordEnd => (
            w.start_ms + w.duration_ms,
            0.0,
            model.word_end_uncertainty_ms,
        ),
    };
    ev.source = "transcript".into();
    ev.problem = None;
    ev.heard = Some(w.text.clone());
    ev.stt_start_ms = Some(w.start_ms);
    ev.stt_duration_ms = Some(w.duration_ms);
    ev.after_pause = Some(pause);
    ev.correction_ms = Some(correction);
    ev.uncertainty_ms = Some(u);
    ev.expected_ms = edge + correction + h.audio_offset_ms + offset_ms;
    ev
}

fn scaled(b: ViewBox, sx: f64, sy: f64) -> ViewBox {
    ViewBox {
        x: b.x * sx,
        y: b.y * sy,
        width: b.width * sx,
        height: b.height * sy,
    }
}

/// Audits the take in `dir`. Writes `audit.json`, `stt.json` (when
/// transcribed) and `contact-sheet.png` there.
pub async fn audit_take(dir: &Path, opts: &AuditOptions) -> Result<TakeAudit> {
    let mut timer = Timer(Vec::new(), Instant::now());
    let cfg = &opts.config;
    let inputs = load(dir)?;
    let mp4 = dir.join("take.mp4");
    let frames = gray_frames(&mp4)?;
    let frame_ms = FPS.frame_duration().get() as f64 / 1000.0;
    timer.mark("decodeVideo");

    let mut notes = Vec::new();
    let (transcript, audio_offset) = match &opts.stt {
        Some(auth) => {
            let wav = wav_16k(&mp4)?;
            let (t, body) = transcribe(&wav, auth, &opts.stt_cache).await?;
            std::fs::write(dir.join("stt.json"), body)?;
            (Some(t), audio_offset_ms(&mp4)?)
        }
        None => {
            notes.push("speech-to-text skipped: every cue word is uncertain".into());
            (None, 0.0)
        }
    };
    timer.mark("transcribe");
    let reference: Vec<String> = inputs.words.iter().map(|w| w.text.clone()).collect();
    let heard = transcript.as_ref().map(|t| {
        let hyp: Vec<String> = t.words.iter().map(|w| w.text.clone()).collect();
        Heard {
            transcript: t,
            alignment: align(&reference, &hyp),
            audio_offset_ms: audio_offset,
        }
    });

    // Cue words, found by text in the narration (not by any timing).
    let cues: Vec<Option<Cue>> = inputs
        .script
        .steps
        .iter()
        .map(|s| s.cue.as_ref().map(|c| c.to_cue()))
        .collect();
    let cue_refs: Vec<Option<&Cue>> = cues.iter().map(Option::as_ref).collect();
    let matches = resolve_cues(&inputs.words, &cue_refs).map_err(|e| anyhow!("cues: {e}"))?;
    let mut cued: Vec<(usize, WordEvidence)> = Vec::new();
    let mut uncued_steps = Vec::new();
    for (i, (m, cue)) in matches.iter().zip(&cues).enumerate() {
        if let (Some(m), Some(cue)) = (m, cue) {
            cued.push((
                i,
                word_evidence(m.anchor_word, cue, &inputs, heard.as_ref(), &cfg.words),
            ));
        } else {
            uncued_steps.push(inputs.script.steps[i].id.clone());
        }
    }
    timer.mark("alignWords");

    let n = frames.len();
    let radius = (cfg.window_radius_ms / frame_ms).round() as usize;
    let expected_frames: Vec<usize> = cued
        .iter()
        .map(|(_, w)| (w.expected_ms.max(0.0) / frame_ms).floor() as usize)
        .collect();
    let viewport = inputs.log.record_viewport;
    let (sx, sy) = (
        AUDIT_SIZE.0 as f64 / viewport.width as f64,
        AUDIT_SIZE.1 as f64 / viewport.height as f64,
    );
    let mut reports = Vec::new();
    for (k, (step_index, word)) in cued.into_iter().enumerate() {
        let e = expected_frames[k].min(n.saturating_sub(1));
        let min_lo = if k > 0 {
            (expected_frames[k - 1] + e).div_ceil(2)
        } else {
            0
        };
        let max_hi = expected_frames
            .get(k + 1)
            .map_or(n.saturating_sub(1), |&next| {
                ((e + next) / 2).min(n.saturating_sub(1))
            });
        let win = Window::around(e, radius, min_lo, max_hi);
        let step = &inputs.script.steps[step_index];
        let logged = inputs.log.steps.get(step_index + 1);
        let target = logged.and_then(|l| l.target_box).map(|b| scaled(b, sx, sy));
        let visual = observe(&frames, win, target, &cfg.visual);
        let wit = witness(
            step.kind.as_str(),
            logged.and_then(|l| l.witness.as_ref()),
            &inputs.raw_epoch,
            &inputs.frame_map,
            FPS,
            visual.grid.onset,
            &cfg.witness,
        );
        let window_valid = win.valid(&cfg.visual);
        let expected = match (&word.problem, word.uncertainty_ms) {
            (None, Some(u)) => Ok((word.expected_ms, u)),
            (p, _) => Err(p.clone().unwrap_or_else(|| "noWordTime".into())),
        };
        let CueVerdict {
            verdict,
            reasons,
            drift_d1_ms,
            drift_d2_ms,
        } = decide(
            &CueEvidence {
                expected,
                visual: Some(&visual),
                window_valid,
                witness: wit.status,
                frame_ms,
            },
            &cfg.verdict,
        );
        reports.push(CueReport {
            step_index,
            step_id: step.id.clone(),
            kind: step.kind.as_str().into(),
            word,
            visual,
            window_valid,
            witness: wit,
            verdict,
            reasons,
            drift_d1_ms,
            drift_d2_ms,
        });
    }
    timer.mark("detect");

    let sheet_path = dir.join("contact-sheet.png");
    let target_thumbs: Vec<Option<ViewBox>> = reports
        .iter()
        .map(|r| {
            inputs
                .log
                .steps
                .get(r.step_index + 1)
                .and_then(|l| l.target_box)
                .map(|b| {
                    scaled(
                        b,
                        THUMB.0 as f64 / viewport.width as f64,
                        THUMB.1 as f64 / viewport.height as f64,
                    )
                })
        })
        .collect();
    let contact_sheet = match build_sheet(&mp4, &reports, &target_thumbs, n, &sheet_path) {
        Ok(note) => {
            notes.extend(note);
            Some(sheet_path)
        }
        Err(e) => {
            notes.push(format!("contact sheet failed: {e}"));
            None
        }
    };
    timer.mark("contactSheet");

    let transcript = heard.as_ref().map(|h| TranscriptSummary {
        engine: h.transcript.engine.clone(),
        audio_sha256: h.transcript.audio_sha256.clone(),
        cached: h.transcript.cached,
        request_ms: h.transcript.request_ms,
        audio_offset_ms: h.audio_offset_ms,
        wer: h.alignment.wer,
        text: h.transcript.text.clone(),
        content_issues: content_issues(&reference, &h.transcript.words, &h.alignment),
    });
    let mut verdict = overall(reports.iter().map(|r| r.verdict));
    if !uncued_steps.is_empty() {
        notes.push(format!(
            "steps without a cue word: {}",
            uncued_steps.join(", ")
        ));
        if verdict == Verdict::Pass {
            verdict = Verdict::Uncertain;
        }
    }
    if verdict == Verdict::Pass && contact_sheet.is_none() {
        verdict = Verdict::Uncertain;
    }
    let report = TakeAudit {
        schema: TAKE_AUDIT_SCHEMA_V1.into(),
        take_dir: dir.to_path_buf(),
        video: mp4,
        verdict,
        cues: reports,
        transcript,
        render_consistency_passed: inputs.render_consistency.map(|a| a.passed),
        contact_sheet,
        uncued_steps,
        notes,
        config: *cfg,
        timings_ms: timer.0,
    };
    std::fs::write(dir.join("audit.json"), serde_json::to_vec_pretty(&report)?)?;
    Ok(report)
}

fn build_sheet(
    mp4: &Path,
    reports: &[CueReport],
    targets: &[Option<ViewBox>],
    n: usize,
    out: &Path,
) -> Result<Option<String>> {
    let wanted: Vec<Vec<usize>> = reports
        .iter()
        .map(|r| {
            let w = r.visual.window.expected;
            let mut f: Vec<usize> = (w.saturating_sub(3)..=w + 3).filter(|&f| f < n).collect();
            if let Some(p) = r.visual.grid.onset {
                f.extend([p.saturating_sub(1), p]);
            }
            f.sort_unstable();
            f.dedup();
            f
        })
        .collect();
    let mut all: Vec<usize> = wanted.iter().flatten().copied().collect();
    all.sort_unstable();
    all.dedup();
    let rgb = rgb_frames(mp4, &all, THUMB)?;
    if rgb.len() != all.len() {
        anyhow::bail!("extracted {} of {} sheet frames", rgb.len(), all.len());
    }
    let rows: Vec<SheetRow> = reports
        .iter()
        .zip(&wanted)
        .zip(targets)
        .map(|((r, frames), target)| {
            let w = r.visual.window.expected;
            let drift = |d: Option<f64>| d.map_or("-".into(), |d| format!("{d:+.0}ms"));
            SheetRow {
                header: format!(
                    "{} [{}] word \"{}\" @ {:.0}ms ({}) | {:?} {} | D1 {} D2 {} | witness {:?}",
                    r.step_id,
                    r.kind,
                    r.word.text,
                    r.word.expected_ms,
                    r.word.source,
                    r.verdict,
                    r.reasons.join(","),
                    drift(r.drift_d1_ms),
                    drift(r.drift_d2_ms),
                    r.witness.status,
                ),
                target: *target,
                frames: frames
                    .iter()
                    .map(|&f| {
                        let i = all.binary_search(&f).unwrap_or(0);
                        let mut caption = format!("f{f} ({:+})", f as i64 - w as i64);
                        if f == w {
                            caption.push_str(" WORD");
                        }
                        if Some(f) == r.visual.grid.onset {
                            caption.push_str(" ONSET");
                        }
                        if r.witness.output_frame == Some(f)
                            && r.witness.status != WitnessStatus::Absent
                        {
                            caption.push_str(" DOM");
                        }
                        SheetFrame {
                            frame: f,
                            rgb: rgb[i].clone(),
                            caption,
                            is_word: f == w,
                            is_onset: Some(f) == r.visual.grid.onset,
                        }
                    })
                    .collect(),
            }
        })
        .collect();
    write_sheet(&rows, out)
}
