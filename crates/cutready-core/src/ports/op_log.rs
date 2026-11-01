use serde::{Deserialize, Serialize};

use super::PortError;

/// Lifecycle of one write in the op log. A write is logged `Pending` before
/// the document is replaced and marked `Committed` after, so a crash between
/// the two can be reconciled by hash on the next open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpLogState {
    Pending,
    Committed,
}

/// A document write about to happen inside a run. `ops` holds the contract
/// edit operations as JSON until the typed `EditOp` contract lands (roadmap
/// 4.6), when this becomes `Vec<EditOp>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewOpLogEntry {
    pub run_id: String,
    /// Project-relative document path.
    pub doc: String,
    pub actor: String,
    pub ops: serde_json::Value,
    pub before_hash: String,
    pub after_hash: String,
}

/// A logged write. The store assigns `seq` and owns `state`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpLogEntry {
    pub seq: u64,
    pub state: OpLogState,
    #[serde(flatten)]
    pub write: NewOpLogEntry,
}

/// Local, never-versioned record of document writes (SQLite on desktop, next
/// to `agent-state.db`). Shape may grow when runs land (roadmap 4.9).
pub trait OpLogStore: Send + Sync {
    /// Logs a write as `Pending` before the document is replaced and returns
    /// its sequence number.
    fn append_pending(&self, write: NewOpLogEntry) -> Result<u64, PortError>;
    /// Marks a pending write `Committed`. Committing twice is a no-op;
    /// an unknown `seq` is `NotFound`. There is no way back to `Pending`.
    fn commit(&self, seq: u64) -> Result<(), PortError>;
    /// Entries still `Pending`, oldest first.
    fn pending(&self) -> Result<Vec<OpLogEntry>, PortError>;
    /// All entries for a run, oldest first.
    fn entries_for_run(&self, run_id: &str) -> Result<Vec<OpLogEntry>, PortError>;
}
