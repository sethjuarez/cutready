//! Desktop implementations of the `cutready-core` ports. The Tauri app, CLI
//! and MCP server share these so every desktop host has the same file, lock
//! and clock behavior, and resolve the same repository write lock and
//! per-project state dir. `secret_vault` locates the Stronghold credential
//! vault and its salt; `StrongholdSecrets` is the `Secrets` port over it.

mod clock;
mod files;
mod lock;
mod log;
mod op_log;
pub mod repo_lock;
pub mod secret_vault;
pub mod state_dir;
mod stronghold_secrets;

pub use stronghold_secrets::StrongholdSecrets;

pub use clock::SystemClock;
pub use files::StdFiles;
pub use lock::FileLock;
pub use log::TracingLog;
pub use op_log::SqliteOpLogStore;

use cutready_core::{PortError, PortErrorKind};

fn io_error(context: impl std::fmt::Display, err: std::io::Error) -> PortError {
    let kind = match err.kind() {
        std::io::ErrorKind::NotFound => PortErrorKind::NotFound,
        _ => PortErrorKind::Io,
    };
    PortError::new(kind, format!("{context}: {err}"))
}
