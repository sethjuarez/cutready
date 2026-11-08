//! Argument handling and console summary for the headless live-take runner
//! (`examples/live_take.rs`).

use super::audit::{audit_take, AuditConfig, AuditOptions, TakeAudit};
use super::pipeline::{run_live_take, LiveTakeOptions};
use super::sidecar_io::SpeechAuth;
use crate::engine::demo_timing::{AuditOutcome, AuditReport};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliMode {
    /// Record, render and audit a take of this script.
    Record(PathBuf),
    /// Re-run the independent audit on an existing take folder.
    AuditOnly(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliArgs {
    pub mode: CliMode,
    pub out: Option<PathBuf>,
    pub sidecar: Option<PathBuf>,
    pub headful: bool,
    pub max_takes: u32,
    /// Skip speech-to-text: cue words become uncertain, never pass.
    pub no_stt: bool,
}

pub const USAGE: &str = "usage: live_take <script.json> [--out DIR] [--sidecar DIR] [--headful] \
[--max-takes N] [--no-stt]\n       live_take --audit-only TAKE_DIR [--out DIR] [--no-stt]\n\
env: SPEECH_ENDPOINT (Azure AI Services endpoint), SPEECH_TOKEN (Entra token; needed for \
uncached narration and for the audit's speech-to-text)\n\
exit: 0 audit pass, 2 fail, 3 uncertain, 1 error, 64 bad arguments";

pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Result<CliArgs> {
    let mut it = args.into_iter();
    let (mut script, mut out, mut sidecar, mut headful) = (None, None, None, false);
    let (mut audit_only, mut no_stt) = (None, false);
    let mut max_takes = 3;
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--out" => out = it.next().map(PathBuf::from),
            "--max-takes" => {
                max_takes = match it.next().and_then(|n| n.parse().ok()) {
                    Some(n) if n >= 1 => n,
                    _ => bail!("--max-takes needs a positive number\n{USAGE}"),
                }
            }
            "--sidecar" => sidecar = it.next().map(PathBuf::from),
            "--headful" => headful = true,
            "--no-stt" => no_stt = true,
            "--audit-only" => match it.next() {
                Some(d) => audit_only = Some(PathBuf::from(d)),
                None => bail!("--audit-only needs a take folder\n{USAGE}"),
            },
            "-h" | "--help" => bail!("{USAGE}"),
            s if s.starts_with("--") => bail!("unknown option {s}\n{USAGE}"),
            s if script.is_none() => script = Some(PathBuf::from(s)),
            s => bail!("unexpected argument {s}\n{USAGE}"),
        }
    }
    let mode = match (script, audit_only) {
        (Some(s), None) => CliMode::Record(s),
        (None, Some(d)) => CliMode::AuditOnly(d),
        (Some(_), Some(_)) => bail!("give a script or --audit-only, not both\n{USAGE}"),
        (None, None) => bail!("{USAGE}"),
    };
    Ok(CliArgs {
        mode,
        out,
        sidecar,
        headful,
        max_takes,
        no_stt,
    })
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// Process exit code for an independent audit verdict.
pub fn exit_code(audit: &TakeAudit, render_consistency_passed: Option<bool>) -> i32 {
    use super::audit::verdict::Verdict;
    if render_consistency_passed == Some(false) {
        return 2;
    }
    match audit.verdict {
        Verdict::Pass => 0,
        Verdict::Fail => 2,
        Verdict::Uncertain => 3,
    }
}

/// Runs one take (or re-audits one) and prints a summary. Returns the
/// process exit code (see [`USAGE`]).
pub async fn run_cli(args: CliArgs) -> Result<i32> {
    let root = repo_root();
    let endpoint = std::env::var("SPEECH_ENDPOINT").unwrap_or_default();
    let token = std::env::var("SPEECH_TOKEN").ok().filter(|t| !t.is_empty());
    let speech = SpeechAuth { endpoint, token };
    // The sidecar runs in its own directory, so every path it sees must be
    // absolute.
    let abs = |p: PathBuf| std::path::absolute(&p).unwrap_or(p);
    let out_root = abs(args.out.unwrap_or_else(|| root.join(".live-take-out")));
    let audit_opts = AuditOptions {
        stt: (!args.no_stt).then(|| speech.clone()),
        stt_cache: out_root.join("stt-cache"),
        config: AuditConfig::default(),
    };
    let (dir, render_consistency) = match args.mode {
        CliMode::AuditOnly(dir) => (abs(dir), None),
        CliMode::Record(script) => {
            let opts = LiveTakeOptions {
                script_path: abs(script),
                out_root,
                sidecar_dir: abs(args
                    .sidecar
                    .unwrap_or_else(|| root.join("playwright-sidecar"))),
                headless: !args.headful,
                speech,
                max_takes: args.max_takes,
            };
            let outcome = run_live_take(&opts).await?;
            for (dir, reason) in &outcome.rejected {
                println!("retake: {} ({reason})", dir.display());
            }
            println!("mp4:    {}", outcome.mp4.display());
            println!("report: {}", outcome.report.display());
            for s in &outcome.stages {
                println!("stage {:<18} {:>7} ms", s.stage, s.ms);
            }
            print_render_consistency(&outcome.render_consistency);
            (outcome.dir, Some(outcome.render_consistency.passed))
        }
    };
    let audit = audit_take(&dir, &audit_opts).await?;
    print_audit(&dir, &audit);
    Ok(exit_code(
        &audit,
        render_consistency.or(audit.render_consistency_passed),
    ))
}

fn print_render_consistency(report: &AuditReport) {
    for cue in &report.cues {
        let drift = cue.drift_us.map_or("-".to_string(), |d| {
            format!("{:+.1} ms", d.get() as f64 / 1000.0)
        });
        let result = match cue.outcome {
            AuditOutcome::Pass => "pass".to_string(),
            AuditOutcome::Fail => "FAIL".to_string(),
            AuditOutcome::Missing { landmark } => format!("MISSING {landmark:?}"),
        };
        println!(
            "consistency step {:<2} drift {drift:>10}  {result}",
            cue.step_index
        );
    }
    println!(
        "render consistency (same detector as the planner): {} (max |drift| {:.1} ms)",
        if report.passed { "passed" } else { "FAILED" },
        report.max_abs_drift_us.get() as f64 / 1000.0,
    );
}

fn print_audit(dir: &Path, audit: &TakeAudit) {
    let ms = |d: Option<f64>| d.map_or("-".to_string(), |d| format!("{d:+.0} ms"));
    for cue in &audit.cues {
        println!(
            "audit {:<16} {:<8} word {:<12} D1 {:>8} D2 {:>8} witness {:<12} {:?} {}",
            cue.step_id,
            cue.kind,
            format!("\"{}\"", cue.word.text),
            ms(cue.drift_d1_ms),
            ms(cue.drift_d2_ms),
            format!("{:?}", cue.witness.status),
            cue.verdict,
            cue.reasons.join(", "),
        );
    }
    if let Some(t) = &audit.transcript {
        println!(
            "transcript: WER {:.1}%, {} content issue(s), audio offset {:+.1} ms",
            t.wer * 100.0,
            t.content_issues.len(),
            t.audio_offset_ms
        );
    }
    for note in &audit.notes {
        println!("note: {note}");
    }
    for (stage, ms) in &audit.timings_ms {
        println!("audit stage {stage:<14} {ms:>7} ms");
    }
    if let Some(sheet) = &audit.contact_sheet {
        println!("contact sheet: {}", sheet.display());
    }
    println!("audit.json: {}", dir.join("audit.json").display());
    println!("independent audit: {:?}", audit.verdict);
}
#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<CliArgs> {
        parse_args(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn parses_script_and_options() {
        let a = args(&["s.json", "--out", "o", "--headful"]).unwrap();
        assert_eq!(a.mode, CliMode::Record(PathBuf::from("s.json")));
        assert!(!a.no_stt);
        assert_eq!(a.out, Some(PathBuf::from("o")));
        assert!(a.headful);
        assert!(args(&[]).is_err());
        assert!(args(&["a", "b"]).is_err());
        assert!(args(&["a", "--nope"]).is_err());
        assert_eq!(a.max_takes, 3);
        assert_eq!(args(&["s.json", "--max-takes", "1"]).unwrap().max_takes, 1);
        assert!(args(&["s.json", "--max-takes", "0"]).is_err());
    }

    #[test]
    fn parses_audit_only_and_no_stt() {
        let a = args(&["--audit-only", "take", "--no-stt"]).unwrap();
        assert_eq!(a.mode, CliMode::AuditOnly(PathBuf::from("take")));
        assert!(a.no_stt);
        assert!(args(&["--audit-only"]).is_err());
        assert!(args(&["s.json", "--audit-only", "take"]).is_err());
    }
}
