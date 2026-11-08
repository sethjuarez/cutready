//! The live-take pipeline: narration → recorded take → frame analysis →
//! timing plan → silence splice → frame-exact render → render-consistency audit.
//!
//! Coordinate conventions (see `docs/video/live-take-learnings.md`):
//! * *Raw* frames index the sidecar's VP8 recording from its first frame.
//! * The setup navigation is trimmed: the planner's *source* frame `s` is
//!   raw frame `s + head_trim`, and marker PTS are shifted to match.
//! * Host instants are microseconds after page creation (the take's `t0`).

use super::analysis::{
    excluded_frames, first_change, marker_runs, masked, match_markers, output_frame_map,
    output_frame_showing, roi_from_boxes, substitute_excluded, ChangeConfig, Detection, GrayFrames,
    MarkerMatch, Roi, Run, ViewBox,
};
use super::audio::{encode_wav, locate_word_edge, parse_wav, splice_silence, Edge, Pcm};
use super::narration::words_from_boundaries;
use super::script::{LiveTakeScript, Postcondition, ScriptStep, StepKind, SETUP_LABEL};
use super::sidecar_io::{record_take, synthesize_cached, LoggedStep, SpeechAuth, TakeLog};
use super::video::{
    check_cadence, decode_audio_mono, frame_pts, gray_thumbnails, marker_scores, render,
    RenderRequest, THUMB,
};
use crate::engine::demo_timing::{
    audit, fit_epoch, plan_demo_timing, ActionLog, ActionStatus, AuditReport, EpochConfig,
    EpochFit, Fps, FrameIndex, MarkerPair, Micros, ObservedAction, ObservedWord, PlanConfig,
    PlanInput, PlanStepInput,
};
use crate::util::sidecar::SidecarManager;
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// v2 renamed the self-consistency check from `audit` to `renderConsistency`;
/// the independent audit lives in `audit.json` (`super::audit`).
pub const TAKE_REPORT_SCHEMA_V2: &str = "cutready.live-take.v2";
const FPS: Fps = Fps::FPS_25;
const MARKER_RUN_THRESHOLD: f32 = 0.5;
const MARKER_EXCLUDE_THRESHOLD: f32 = 0.02;
const ROI_PAD_PX: f64 = 12.0;
/// Minimum normalized cross-correlation to accept a located cue word.
const MIN_WORD_SCORE: f32 = 0.8;
/// Frames from dispatch that must be marker-free for the action to be measurable.
const DISPATCH_GUARD_FRAMES: usize = 2;

/// The take is valid input but unusable; record another one.
#[derive(Debug)]
pub struct TakeRejected(pub String);

impl std::fmt::Display for TakeRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "take rejected: {}", self.0)
    }
}

impl std::error::Error for TakeRejected {}

pub struct LiveTakeOptions {
    pub script_path: PathBuf,
    pub out_root: PathBuf,
    pub sidecar_dir: PathBuf,
    pub headless: bool,
    pub speech: SpeechAuth,
    /// Takes to record before giving up on rejected ones (at least 1).
    pub max_takes: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageTiming {
    pub stage: String,
    pub ms: u128,
}

pub struct LiveTakeOutcome {
    pub dir: PathBuf,
    pub mp4: PathBuf,
    pub report: PathBuf,
    /// Self-consistency of the render (same detector as the planner).
    pub render_consistency: AuditReport,
    pub stages: Vec<StageTiming>,
    /// Earlier takes of this run that were rejected, with the reason.
    pub rejected: Vec<(PathBuf, String)>,
}

struct Stages(Vec<StageTiming>, Instant);

impl Stages {
    fn new() -> Self {
        Stages(Vec::new(), Instant::now())
    }

    fn mark(&mut self, stage: &str) {
        self.0.push(StageTiming {
            stage: stage.into(),
            ms: self.1.elapsed().as_millis(),
        });
        self.1 = Instant::now();
    }
}

fn ms_to_us(ms: f64) -> Micros {
    Micros((ms * 1000.0).round() as i64)
}

/// Per-step action analysis on the raw recording.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepAnalysis {
    id: String,
    detection: Detection,
    /// Raw frame where the post-marker run starts (detection window end).
    window_end: usize,
    visible_raw_frame: Option<usize>,
}

fn post_marker_start(
    log: &TakeLog,
    matches: &[MarkerMatch],
    runs: &[Run],
    label: &str,
) -> Option<usize> {
    let wanted = format!("post:{label}");
    let i = log.markers.iter().position(|m| m.label == wanted)?;
    let m = matches.iter().find(|m| m.logged_index == i)?;
    Some(runs[m.run_index].start)
}

fn step_roi(step: &ScriptStep, logged: &LoggedStep, viewport: (u32, u32)) -> Roi {
    let full = Roi::full(THUMB.0, THUMB.1);
    let navigates = matches!(step.postcondition, Some(Postcondition::Url { .. }));
    let boxes: Vec<ViewBox> = match step.kind {
        StepKind::Scroll => Vec::new(),
        StepKind::Navigate => logged.observe_box.into_iter().collect(),
        // A click that changes the URL repaints the page; the clicked link's
        // own styling changes too little (or late) to anchor on.
        StepKind::Click if navigates && logged.observe_box.is_none() => return full,
        StepKind::Click | StepKind::Type => logged
            .target_box
            .into_iter()
            .chain(logged.observe_box)
            .collect(),
    };
    roi_from_boxes(&boxes, viewport, THUMB, ROI_PAD_PX, 16).unwrap_or(full)
}

/// Locates every audited cue word in the final MP4 audio by matching the
/// original TTS audio around each edge.
fn observe_words(
    original: &Pcm,
    original_words: &[crate::engine::demo_timing::WordTiming],
    planned_words: &[crate::engine::demo_timing::WordTiming],
    final_audio: &[f32],
    word_indices: &[usize],
) -> (Vec<ObservedWord>, Vec<serde_json::Value>) {
    let mono = original.mono_f32();
    let rate = original.sample_rate;
    let mut observed = Vec::new();
    let mut notes = Vec::new();
    for &w in word_indices {
        let (Some(orig), Some(plan)) = (original_words.get(w), planned_words.get(w)) else {
            continue;
        };
        let locate = |edge_us, edge, expected| {
            locate_word_edge(
                &mono,
                final_audio,
                rate,
                edge_us,
                edge,
                expected,
                Micros::from_millis(250),
                Micros::from_millis(500),
                3,
            )
        };
        let start = locate(orig.start_us, Edge::Start, plan.start_us);
        let end = locate(orig.end_us(), Edge::End, plan.end_us());
        notes.push(json!({
            "wordIndex": w, "text": orig.text,
            "plannedStartUs": plan.start_us, "plannedEndUs": plan.end_us(),
            "start": start, "end": end,
        }));
        if let (Some(s), Some(e)) = (start, end) {
            if s.score >= MIN_WORD_SCORE && e.score >= MIN_WORD_SCORE {
                observed.push(ObservedWord {
                    word_index: w,
                    start_us: s.us,
                    end_us: e.us,
                });
            }
        }
    }
    (observed, notes)
}

fn out_dir_for(root: &Path, name: &str) -> PathBuf {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    root.join(format!("{slug}-{stamp}"))
}

/// Creates `base`, or `base-2`, `base-3`, ... if it already exists, so two
/// runs in the same second never share a folder.
fn create_unique_dir(base: &Path) -> Result<PathBuf> {
    if let Some(parent) = base.parent() {
        std::fs::create_dir_all(parent)?;
    }
    for n in 1u32.. {
        let mut dir = base.to_path_buf();
        if n > 1 {
            dir.as_mut_os_string().push(format!("-{n}"));
        }
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).with_context(|| format!("create {}", dir.display())),
        }
    }
    unreachable!("u32 suffixes exhausted")
}

/// Records takes until one is usable (at most `opts.max_takes`). Rejected
/// takes keep their folder, with `rejected.txt` saying why.
pub async fn run_live_take(opts: &LiveTakeOptions) -> Result<LiveTakeOutcome> {
    let mut rejected = Vec::new();
    let max = opts.max_takes.max(1);
    for attempt in 1..=max {
        match run_take_once(opts, attempt).await {
            Ok(mut outcome) => {
                outcome.rejected = rejected;
                return Ok(outcome);
            }
            Err(e) => match (
                e.downcast_ref::<TakeRejected>(),
                e.downcast_ref::<RejectedIn>(),
            ) {
                (Some(r), Some(dir)) => {
                    let _ = std::fs::write(dir.0.join("rejected.txt"), r.to_string());
                    if attempt == max {
                        return Err(e);
                    }
                    rejected.push((dir.0.clone(), r.to_string()));
                }
                _ => return Err(e),
            },
        }
    }
    unreachable!("the last attempt returns")
}

/// Context attached to a [`TakeRejected`] error: the take's folder.
#[derive(Debug)]
struct RejectedIn(PathBuf);

impl std::fmt::Display for RejectedIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "in {}", self.0.display())
    }
}

async fn run_take_once(opts: &LiveTakeOptions, attempt: u32) -> Result<LiveTakeOutcome> {
    let mut stages = Stages::new();
    let script_text = std::fs::read_to_string(&opts.script_path)
        .with_context(|| format!("read {}", opts.script_path.display()))?;
    let script = LiveTakeScript::parse(&script_text).map_err(|e| anyhow!(e))?;
    let script_dir = opts
        .script_path
        .canonicalize()?
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let mut dir = out_dir_for(&opts.out_root, &script.name);
    if attempt > 1 {
        dir.as_mut_os_string().push(format!("-take{attempt}"));
    }
    let dir = create_unique_dir(&dir)?;
    analyze_and_render(opts, &script, &script_dir, &dir, &mut stages)
        .await
        .map_err(|e| {
            if e.downcast_ref::<TakeRejected>().is_some() {
                e.context(RejectedIn(dir.clone()))
            } else {
                e
            }
        })
}

async fn analyze_and_render(
    opts: &LiveTakeOptions,
    script: &LiveTakeScript,
    script_dir: &Path,
    dir: &Path,
    stages: &mut Stages,
) -> Result<LiveTakeOutcome> {
    let dir = dir.to_path_buf();
    let (sidecar, _events) = SidecarManager::spawn(&opts.sidecar_dir)
        .await
        .context("spawn playwright sidecar")?;
    stages.mark("sidecarSpawn");

    // 1. Narration.
    let (synth, cached) = synthesize_cached(
        &sidecar,
        &opts.out_root.join("tts-cache"),
        &script.narration,
        &script.voice,
        &opts.speech,
    )
    .await?;
    stages.mark(if cached { "ttsCached" } else { "tts" });
    let words = words_from_boundaries(&script.narration, &synth.words).map_err(|e| anyhow!(e))?;
    let pcm = parse_wav(&std::fs::read(&synth.audio_path)?).map_err(|e| anyhow!(e))?;
    std::fs::write(dir.join("narration.wav"), encode_wav(&pcm))?;

    // 2. Recorded take.
    let take = record_take(
        &sidecar,
        &dir.join("take"),
        script.viewport,
        script.sidecar_steps(script_dir),
        opts.headless,
    )
    .await;
    let _ = sidecar.shutdown().await;
    let take = take?;
    stages.mark("browserTake");
    let log = &take.log;
    if let Some(bad) = log.steps.iter().find(|s| s.status != "ok") {
        bail!(
            "step {:?} failed: {}",
            bad.label,
            bad.error.as_deref().unwrap_or("unknown error")
        );
    }
    if log.steps.len() != script.steps.len() + 1 || log.steps[0].label != SETUP_LABEL {
        bail!(
            "take log has {} steps, expected setup + {}",
            log.steps.len(),
            script.steps.len()
        );
    }

    // 3. Frame analysis on the raw recording.
    let pts = frame_pts(&take.video)?;
    let first_pts = check_cadence(&pts, FPS.frame_duration(), Micros(1_000))?;
    let thumbs = gray_thumbnails(&take.video)?;
    let scores = marker_scores(&take.video)?;
    if thumbs.len() != pts.len() || scores.len() != pts.len() {
        bail!(
            "decoded {} thumbnails / {} marker frames for {} probed frames",
            thumbs.len(),
            scores.len(),
            pts.len()
        );
    }
    let runs = marker_runs(&scores, MARKER_RUN_THRESHOLD);
    let run_onsets: Vec<Micros> = runs
        .iter()
        .map(|r| FPS.frame_start(r.start as i64))
        .collect();
    let logged: Vec<Micros> = log.markers.iter().map(|m| ms_to_us(m.on_ack_ms)).collect();
    let matches =
        match_markers(&logged, &run_onsets, FPS.frame_start(2), 3).map_err(|e| anyhow!(e))?;
    let excluded = excluded_frames(&scores, MARKER_EXCLUDE_THRESHOLD, 1);
    let raw_pairs: Vec<MarkerPair> = matches
        .iter()
        .map(|m| MarkerPair {
            host_us: m.host_us,
            pts_us: m.pts_us,
        })
        .collect();
    let epoch_config = EpochConfig::default();
    let raw_epoch =
        fit_epoch(&raw_pairs, FPS, &epoch_config).map_err(|e| anyhow!("raw epoch: {e}"))?;

    // Head trim: everything up to the post-setup marker (plus one blended frame).
    let setup_end = post_marker_start(log, &matches, &runs, SETUP_LABEL)
        .and_then(|start| runs.iter().find(|r| r.start == start))
        .map(|r| r.end + 1)
        .ok_or_else(|| anyhow!("post-setup marker not found in the video"))?;
    let head_trim = setup_end as FrameIndex;
    let trimmed: Vec<MarkerPair> = raw_pairs
        .iter()
        .map(|p| MarkerPair {
            host_us: p.host_us,
            pts_us: p.pts_us - FPS.frame_start(head_trim),
        })
        .collect();
    let epoch: EpochFit =
        fit_epoch(&trimmed, FPS, &epoch_config).map_err(|e| anyhow!("epoch: {e}"))?;
    stages.mark("analyzeTake");

    let viewport = (log.record_viewport.width, log.record_viewport.height);
    let change = ChangeConfig::default();
    let mut analyses = Vec::new();
    let mut inputs = Vec::new();
    for (step, logged) in script.steps.iter().zip(&log.steps[1..]) {
        if logged.label != step.id {
            bail!(
                "take step {:?} does not match script step {:?}",
                logged.label,
                step.id
            );
        }
        let dispatched = ms_to_us(logged.dispatched_ms.unwrap_or_default());
        let dispatch_frame = FPS.frame_floor(raw_epoch.host_to_pts(dispatched)).max(0) as usize;
        if masked(&excluded, dispatch_frame, DISPATCH_GUARD_FRAMES) {
            return Err(anyhow!(TakeRejected(format!(
                "a marker frame covers step {:?} at raw frame {dispatch_frame} \
                 (the recording stalled on the marker); its visible effect cannot be measured",
                step.id
            ))));
        }
        let reference = dispatch_frame.saturating_sub(1);
        let window_end = post_marker_start(log, &matches, &runs, &step.id).unwrap_or(thumbs.len());
        let roi = step_roi(step, logged, viewport);
        let detection = first_change(
            &thumbs,
            reference,
            reference + 1,
            window_end,
            roi,
            &excluded,
            &change,
        );
        let visible_raw_frame = detection.frame.filter(|&f| f as FrameIndex >= head_trim);
        let visible_at = visible_raw_frame
            .map(|f| epoch.pts_to_host(FPS.frame_start(f as FrameIndex - head_trim)));
        inputs.push(PlanStepInput {
            id: step.id.clone(),
            cue: step.cue.as_ref().map(|c| c.to_cue()),
            action: ActionLog {
                kind: step.kind.as_str().into(),
                dispatched_at: dispatched,
                input_effect_at: logged.input_effect_ms.map(ms_to_us),
                postcondition_at: logged.postcondition_ms.map(ms_to_us),
                visible_at,
                status: ActionStatus::Ok,
            },
        });
        analyses.push(StepAnalysis {
            id: step.id.clone(),
            detection,
            window_end,
            visible_raw_frame,
        });
    }
    stages.mark("detectActions");

    // 4. Plan.
    let plan_input = PlanInput {
        narration: script.narration.clone(),
        words: words.clone(),
        narration_duration_us: pcm.duration_us(),
        steps: inputs.clone(),
        markers: trimmed.clone(),
        source_frame_count: pts.len() as FrameIndex - head_trim,
        fps: FPS,
        config: PlanConfig::default(),
    };
    let plan = plan_demo_timing(&plan_input).map_err(|e| anyhow!("plan: {e}"))?;
    stages.mark("plan");

    // 5. Splice silence into the narration.
    let (final_pcm, applied) = splice_silence(&pcm, &plan.silences);
    let final_wav = dir.join("final.wav");
    std::fs::write(&final_wav, encode_wav(&final_pcm))?;

    // 6. Render: EDL → raw frame map, marker frames hidden.
    let mut frame_map: Vec<FrameIndex> = output_frame_map(&plan.segments, plan.output_frame_count)
        .map_err(|e| anyhow!(e))?
        .into_iter()
        .map(|s| s + head_trim)
        .collect();
    let markers_hidden = substitute_excluded(&mut frame_map, &excluded);
    let mp4 = dir.join("take.mp4");
    render(&RenderRequest {
        source: &take.video,
        audio: &final_wav,
        output: &mp4,
        log: &dir.join("render.log"),
        width: log.record_viewport.width,
        height: log.record_viewport.height,
        fps: FPS.num(),
        frame_map: &frame_map,
    })?;
    stages.mark("render");

    // 7. Render-consistency audit: re-detect each action in the final MP4
    // (searching where the plan put it, with the analysis ROI) and compare
    // against the cue words in the final audio. It shares the analysis
    // detector, so it can't catch a wrong raw landmark.
    let out_pts = frame_pts(&mp4)?;
    let out_first = check_cadence(&out_pts, FPS.frame_duration(), Micros(1_000))?;
    if out_pts.len() as FrameIndex != plan.output_frame_count || out_first != Micros::ZERO {
        bail!(
            "rendered {} frames starting at {out_first}, planned {} from 0",
            out_pts.len(),
            plan.output_frame_count
        );
    }
    let out_thumbs = gray_thumbnails(&mp4)?;
    let observed_actions = observe_actions(&out_thumbs, &frame_map, &analyses, &change);
    let final_audio = decode_audio_mono(&mp4, pcm.sample_rate)?;
    let audit_cues = plan.audit_cues(&inputs);
    let word_indices: Vec<usize> = audit_cues.iter().map(|c| c.anchor_word_index).collect();
    let (observed_words, word_notes) =
        observe_words(&pcm, &words, &plan.words, &final_audio, &word_indices);
    let report = audit(FPS, &audit_cues, &observed_words, &observed_actions, None);
    stages.mark("renderConsistency");

    let report_path = dir.join("take.json");
    let take_json = json!({
        "schema": TAKE_REPORT_SCHEMA_V2,
        "script": script,
        "scriptPath": opts.script_path,
        "narration": {
            "voice": script.voice,
            "cached": cached,
            "sampleRate": pcm.sample_rate,
            "durationUs": pcm.duration_us(),
            "rawBoundaries": synth.words,
            "words": words,
        },
        "take": {
            "video": take.video,
            "firstFramePtsUs": first_pts,
            "frameCount": pts.len(),
            "log": take.raw_log,
            "markerRuns": runs,
            "markerMatches": matches,
            "rawEpoch": raw_epoch,
            "headTrimFrames": head_trim,
            "steps": analyses,
        },
        "plan": plan,
        "edl": plan.edl(),
        "splices": applied,
        "render": {
            "mp4": mp4,
            "frameMap": frame_map,
            "markerFramesHidden": markers_hidden,
            "outputFrameCount": out_pts.len(),
        },
        "observed": {
            "actions": observed_actions,
            "words": observed_words,
            "wordSearch": word_notes,
        },
        "renderConsistency": report,
        "stages": stages.0.clone(),
    });
    std::fs::write(&report_path, serde_json::to_vec_pretty(&take_json)?)?;
    Ok(LiveTakeOutcome {
        dir,
        mp4,
        report: report_path,
        render_consistency: report,
        stages: std::mem::take(&mut stages.0),
        rejected: Vec::new(),
    })
}

/// Re-detects each action in the rendered video: from the last output frame
/// that shows the source reference frame, the first output frame whose ROI
/// changes. The output has no marker frames left, so nothing is excluded.
fn observe_actions(
    out: &GrayFrames,
    frame_map: &[FrameIndex],
    analyses: &[StepAnalysis],
    change: &ChangeConfig,
) -> Vec<ObservedAction> {
    analyses
        .iter()
        .enumerate()
        .filter_map(|(step_index, a)| {
            a.visible_raw_frame?;
            let reference = output_frame_showing(frame_map, a.detection.reference as FrameIndex)?;
            let until = output_frame_showing(frame_map, a.window_end as FrameIndex - 1)
                .map_or(out.len(), |o| o + 1);
            let d = first_change(
                out,
                reference,
                reference + 1,
                until,
                a.detection.roi,
                &[],
                change,
            );
            d.frame.map(|f| ObservedAction {
                step_index,
                output_frame: f as FrameIndex,
            })
        })
        .collect()
}
