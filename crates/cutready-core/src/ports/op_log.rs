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

/// One document write inside a run. `ops` holds the contract `EditOp` list as
/// JSON so this port doesn't change as ops are added.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpLogEntry {
    /// Assigned by the store on append; ignored on input.
    pub seq: u64,
    pub run_id: String,
    /// Project-relative document path.
    pub doc: String,
    pub actor: String,
    pub ops: serde_json::Value,
    pub before_hash: String,
    pub after_hash: String,
    pub state: OpLogState,
}

/// Local, never-versioned record of document writes (SQLite on desktop, next
/// to `agent-state.db`). Shape may grow when runs land (roadmap 4.9).
pub trait OpLogStore: Send + Sync {
    /// Appends an entry and returns its sequence number.
    fn append(&self, entry: OpLogEntry) -> Result<u64, PortError>;
    fn set_state(&self, seq: u64, state: OpLogState) -> Result<(), PortError>;
    /// Entries still `Pending`, oldest first.
    fn pending(&self) -> Result<Vec<OpLogEntry>, PortError>;
    /// All entries for a run, oldest first.
    fn entries_for_run(&self, run_id: &str) -> Result<Vec<OpLogEntry>, PortError>;
}
