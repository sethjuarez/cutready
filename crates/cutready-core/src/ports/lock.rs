use super::PortError;

/// Held while a workspace write is in progress; dropping it releases the lock.
pub trait LockGuard: Send {}

/// Serializes document writes to one project across threads **and**
/// processes (app, CLI, MCP server). Replaces the in-process
/// `workspace_write_lock` mutex once writes move into core.
pub trait Lock: Send + Sync {
    /// Blocks until the lock is free.
    fn acquire(&self) -> Result<Box<dyn LockGuard>, PortError>;

    /// Returns `PortErrorKind::Busy` instead of waiting when another holder
    /// has the lock.
    fn try_acquire(&self) -> Result<Box<dyn LockGuard>, PortError>;
}
