//! `cutready-cli edit`: apply EditOps to one document as a CLI run.

use std::path::Path;

use cutready_core::contracts::AppliedEdit;
use cutready_core::Clock;
use serde_json::Value;

use crate::project::{applied_edit, Failure, Project};

/// The op-log actor of runs started from the command line.
pub const ACTOR: &str = "cli";

/// What the caller expects on disk before the edit.
pub enum Expect {
    Version(String),
    Absent,
}

/// Applies `ops` to `doc` in `run_id` (a new CLI run when `None`) and returns
/// the contract's `AppliedEdit`.
pub fn edit(
    root: &Path,
    clock: &dyn Clock,
    doc: &str,
    expect: &Expect,
    ops: &[Value],
    run_id: Option<&str>,
) -> Result<AppliedEdit, Failure> {
    let project = Project::open(root)?;
    let run_id = match run_id {
        Some(id) => id.to_string(),
        None => project.begin_run(ACTOR, clock)?,
    };
    let expected = match expect {
        Expect::Version(version) => Some(version.as_str()),
        Expect::Absent => None,
    };
    let applied = project.apply(clock, ACTOR, &run_id, doc, expected, ops)?;
    Ok(applied_edit(&run_id, doc, &applied))
}

/// Parses an ops document: a JSON array of EditOps.
pub fn parse_ops(text: &str) -> Result<Vec<Value>, Failure> {
    let value = serde_json::from_str::<Value>(text)
        .map_err(|err| Failure::other(format!("ops are not valid JSON: {err}")))?;
    value
        .as_array()
        .cloned()
        .ok_or_else(|| Failure::other("ops must be a JSON array of EditOps"))
}
