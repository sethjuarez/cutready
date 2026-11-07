//! Argument handling and console summary for the headless live-take runner
//! (`examples/live_take.rs`).

use super::pipeline::{run_live_take, LiveTakeOptions};
use super::sidecar_io::SpeechAuth;
use crate::engine::demo_timing::AuditOutcome;
use anyhow::{bail, Result};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliArgs {
    pub script: PathBuf,
    pub out: Option<PathBuf>,
    pub sidecar: Option<PathBuf>,
    pub headful: bool,
    pub max_takes: u32,
}

pub const USAGE: &str =
    "usage: live_take <script.json> [--out DIR] [--sidecar DIR] [--headful] [--max-takes N]\n\
env: SPEECH_ENDPOINT (Azure AI Services endpoint), SPEECH_TOKEN (Entra token; \
only needed when the narration is not cached)";

pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Result<CliArgs> {
    let mut it = args.into_iter();
    let (mut script, mut out, mut sidecar, mut headful) = (None, None, None, false);
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
            "-h" | "--help" => bail!("{USAGE}"),
            s if s.starts_with("--") => bail!("unknown option {s}\n{USAGE}"),
            s if script.is_none() => script = Some(PathBuf::from(s)),
            s => bail!("unexpected argument {s}\n{USAGE}"),
        }
    }
    let Some(script) = script else {
        bail!("{USAGE}");
    };
    Ok(CliArgs {
        script,
        out,
        sidecar,
        headful,
        max_takes,
    })
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// Runs one take and prints a summary. Returns the process exit code
/// (0 when the audit passes, 2 when it fails).
pub async fn run_cli(args: CliArgs) -> Result<i32> {
    let root = repo_root();
    let endpoint = std::env::var("SPEECH_ENDPOINT").unwrap_or_default();
    let token = std::env::var("SPEECH_TOKEN").ok().filter(|t| !t.is_empty());
    // The sidecar runs in its own directory, so every path it sees must be
    // absolute.
    let abs = |p: PathBuf| std::path::absolute(&p).unwrap_or(p);
    let opts = LiveTakeOptions {
        script_path: abs(args.script),
        out_root: abs(args.out.unwrap_or_else(|| root.join(".live-take-out"))),
        sidecar_dir: abs(args
            .sidecar
            .unwrap_or_else(|| root.join("playwright-sidecar"))),
        headless: !args.headful,
        speech: SpeechAuth { endpoint, token },
        max_takes: args.max_takes,
    };
    let outcome = run_live_take(&opts).await?;
    for (dir, reason) in &outcome.rejected {
        println!("retake: {} ({reason})", dir.display());
    }
    println!("mp4:    {}", outcome.mp4.display());
    println!("report: {}", outcome.report.display());
    for s in &outcome.stages {
        println!("stage {:<14} {:>7} ms", s.stage, s.ms);
    }
    for cue in &outcome.audit.cues {
        let drift = cue.drift_us.map_or("-".to_string(), |d| {
            format!("{:+.1} ms", d.get() as f64 / 1000.0)
        });
        let result = match cue.outcome {
            AuditOutcome::Pass => "pass".to_string(),
            AuditOutcome::Fail => "FAIL".to_string(),
            AuditOutcome::Missing { landmark } => format!("MISSING {landmark:?}"),
        };
        println!("cue step {:<2} drift {drift:>10}  {result}", cue.step_index);
    }
    println!(
        "audit: {} (max |drift| {:.1} ms, tolerance {:.1} ms)",
        if outcome.audit.passed {
            "PASSED"
        } else {
            "FAILED"
        },
        outcome.audit.max_abs_drift_us.get() as f64 / 1000.0,
        outcome.audit.tolerance_us.get() as f64 / 1000.0
    );
    Ok(if outcome.audit.passed { 0 } else { 2 })
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
        assert_eq!(a.script, PathBuf::from("s.json"));
        assert_eq!(a.out, Some(PathBuf::from("o")));
        assert!(a.headful);
        assert!(args(&[]).is_err());
        assert!(args(&["a", "b"]).is_err());
        assert!(args(&["a", "--nope"]).is_err());
        assert_eq!(a.max_takes, 3);
        assert_eq!(args(&["s.json", "--max-takes", "1"]).unwrap().max_takes, 1);
        assert!(args(&["s.json", "--max-takes", "0"]).is_err());
    }
}
