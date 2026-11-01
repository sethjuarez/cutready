// CmdError is serialized straight across IPC, so its size never sits on a hot path.
#[allow(clippy::result_large_err)]
pub mod agent;
pub mod animation;
pub mod automation;
pub mod diagnostics;
pub mod draftline;
pub mod export;
pub mod feedback;
pub mod github;
pub mod identity;
pub mod import;
pub mod interaction;
pub mod narration_preview;
pub mod note;
// CmdError is serialized straight across IPC, so its size never sits on a hot path.
#[allow(clippy::result_large_err)]
pub mod project;
pub mod recording;
pub mod review;
pub mod screenshot;
pub mod secrets;
pub mod sketch;
pub mod storyboard;
pub mod terminal;
pub mod video_import;

/// The typed error envelope commands return (ADR 0003): `command_failed` with
/// the old text for plain failures, or a named code where the UI branches.
pub use cutready_contracts::CmdError;

/// `map_err` adapter for failures that were previously stringified with
/// `e.to_string()`; the message is unchanged.
pub(crate) fn cmd_err(error: impl ToString) -> CmdError {
    CmdError::failed(error.to_string())
}

/// The one Draftline boundary: opening or initializing a project may refuse
/// with a serialized Draftline envelope, which keeps its code and details.
impl From<crate::engine::project::ProjectError> for CmdError {
    fn from(error: crate::engine::project::ProjectError) -> Self {
        match error {
            crate::engine::project::ProjectError::Draftline(json) => {
                CmdError::from_draftline_envelope(json)
            }
            other => CmdError::failed(other.to_string()),
        }
    }
}

#[cfg(test)]
mod cmd_error_tests;
