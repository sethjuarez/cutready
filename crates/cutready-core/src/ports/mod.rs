//! Side-effect boundaries for the core. Hosts implement these;
//! `cutready-desktop-io` provides the desktop implementations and
//! [`crate::testing`] provides in-memory ones.

mod clock;
mod error;
mod files;
mod lock;
mod log;
mod op_log;
mod secrets;

pub use clock::Clock;
pub use error::{PortError, PortErrorKind};
pub use files::Files;
pub use lock::{Lock, LockGuard};
pub use log::{Log, LogLevel};
pub use op_log::{
    Baseline, Images, NewOpLogEntry, OpLogEntry, OpLogState, OpLogStore, Resolution, ReviewEffect,
    Run,
};
pub use secrets::Secrets;
