use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::PortError;

/// Lifecycle of one write in the op log. A write is logged `Pending` before
/// the document is replaced and marked `Committed` after. A crash between the
/// two is reconciled by hash on the next write: if the file has the entry's
/// `after_hash` the write landed (`Committed`); otherwise it didn't
/// (`Abandoned`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpLogState {
    Pending,
    Committed,
    Abandoned,
}

/// A document as it was before a run first wrote to it, so review can diff
/// and undo the whole run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "content", rename_all = "snake_case")]
pub enum Baseline {
    /// The run created the document.
    Absent,
    Content(String),
}

/// A document's full bytes around one write (None when absent), so review
/// can undo it entity by entity. Entries logged before review existed have
/// none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Images {
    pub before: Option<String>,
    pub after: Option<String>,
}

/// What committing a write also records for review, in the same store
/// transaction, so a crash can't separate the write from its review state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReviewEffect {
    /// Awaits Keep or Undo.
    #[default]
    Review,
    /// Kept as it commits: the app's own edits.
    AutoKeep,
    /// An undo write: kept itself, and it resolves the undone run's entries
    /// for `doc` up to `through_seq` as undone.
    Undo {
        run_id: String,
        doc: String,
        through_seq: u64,
    },
}

/// How a committed write was reviewed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    Kept,
    Undone,
}

/// A document write about to happen inside a run. `ops` holds the contract
/// edit operations as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewOpLogEntry {
    pub run_id: String,
    /// Project-relative document path.
    pub doc: String,
    pub actor: String,
    pub ops: serde_json::Value,
    pub before_hash: String,
    pub after_hash: String,
    pub at: DateTime<Utc>,
    /// Set on the run's first write to `doc` only.
    pub baseline: Option<Baseline>,
    pub images: Option<Images>,
    #[serde(default)]
    pub effect: ReviewEffect,
}

/// A logged write. The store assigns `seq` and owns `state`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpLogEntry {
    pub seq: u64,
    pub state: OpLogState,
    /// Set once a committed write is kept or undone.
    pub resolution: Option<Resolution>,
    #[serde(flatten)]
    pub write: NewOpLogEntry,
}

/// A group of writes reviewed (kept or undone) together: one agent execution,
/// one CLI/MCP session, or the app's implicit "user" run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub actor: String,
    pub started_at: DateTime<Utc>,
}

/// Local, never-versioned record of runs and document writes (SQLite on
/// desktop, in the runtime state dir next to `agent-state.db`). Every
/// mutation is durable when it returns: a pending entry must outlive a crash
/// that interrupts the document write it announces.
pub trait OpLogStore: Send + Sync {
    /// Starts a run and returns its store-assigned id.
    fn begin_run(&self, actor: &str, started_at: DateTime<Utc>) -> Result<String, PortError>;
    /// A run by id; `NotFound` when unknown.
    fn run(&self, run_id: &str) -> Result<Run, PortError>;
    /// Logs a write as `Pending` before the document is replaced and returns
    /// its sequence number.
    fn append_pending(&self, write: NewOpLogEntry) -> Result<u64, PortError>;
    /// Marks a pending write `Committed` and applies its [`ReviewEffect`]
    /// atomically. Committing twice is a no-op; an unknown `seq` is
    /// `NotFound`; an abandoned one is `Corrupt`.
    fn commit(&self, seq: u64) -> Result<(), PortError>;
    /// Marks a pending write `Abandoned`: its document write never landed.
    /// Abandoning twice is a no-op; an unknown `seq` is `NotFound`; a
    /// committed one is `Corrupt`.
    fn abandon(&self, seq: u64) -> Result<(), PortError>;
    /// Entries still `Pending`, oldest first.
    fn pending(&self) -> Result<Vec<OpLogEntry>, PortError>;
    /// All entries for a run, oldest first.
    fn entries_for_run(&self, run_id: &str) -> Result<Vec<OpLogEntry>, PortError>;
    /// Resolves the run's committed, unresolved entries for `doc` up to
    /// `through_seq` and returns how many changed. Entries already resolved
    /// keep their resolution.
    fn resolve(
        &self,
        run_id: &str,
        doc: &str,
        through_seq: u64,
        resolution: Resolution,
    ) -> Result<usize, PortError>;
    /// Committed entries nobody has kept or undone, oldest first.
    fn unreviewed(&self) -> Result<Vec<OpLogEntry>, PortError>;
}
