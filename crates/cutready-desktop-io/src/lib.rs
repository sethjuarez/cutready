//! Desktop implementations of the `cutready-core` ports. The Tauri app, CLI
//! and MCP server share these so every desktop host has the same file, lock
//! and clock behavior.

mod clock;
mod files;
mod lock;
mod log;

pub use clock::SystemClock;
pub use files::StdFiles;
pub use lock::FileLock;
pub use log::TracingLog;

use cutready_core::{PortError, PortErrorKind};

fn io_error(context: impl std::fmt::Display, err: std::io::Error) -> PortError {
    let kind = match err.kind() {
        std::io::ErrorKind::NotFound => PortErrorKind::NotFound,
        _ => PortErrorKind::Io,
    };
    PortError::new(kind, format!("{context}: {err}"))
}
