pub mod accessibility;
// CmdError is serialized straight across IPC, so its size never sits on a hot path.
#[allow(clippy::result_large_err)]
pub mod agent;
pub mod animation;
pub mod automation;
pub mod diagnostics;
pub mod draftline;
pub mod draftline_history;
pub mod draftline_merge;
pub mod draftline_shelf;
pub mod export;
pub mod feedback;
pub mod github;
pub mod identity;
pub mod import;
pub mod interaction;
pub mod narration_preview;
// CmdError is serialized straight across IPC, so its size never sits on a hot path.
#[allow(clippy::result_large_err)]
pub mod note;
// CmdError is serialized straight across IPC, so its size never sits on a hot path.
#[allow(clippy::result_large_err)]
pub mod project;
pub mod recording;
// CmdError is serialized straight across IPC, so its size never sits on a hot path.
#[allow(clippy::result_large_err)]
pub mod repo_clone;
pub mod review;
pub mod screenshot;
pub mod secrets;
// CmdError is serialized straight across IPC, so its size never sits on a hot path.
#[allow(clippy::result_large_err)]
pub mod sketch;
// CmdError is serialized straight across IPC, so its size never sits on a hot path.
#[allow(clippy::result_large_err)]
pub mod storyboard;
pub mod terminal;
pub mod version_saves;
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

/// Typed edit failures (stale, locked, invalid op) keep their codes; the rest
/// keep the writer's wording as `command_failed`.
impl From<crate::engine::document_writer::WriteError> for CmdError {
    fn from(error: crate::engine::document_writer::WriteError) -> Self {
        use crate::engine::document_writer::WriteError;
        match error {
            WriteError::Project(project) => project.into(),
            WriteError::Edit(ref edit) => {
                CmdError::try_from(edit).unwrap_or_else(|_| CmdError::failed(error.to_string()))
            }
        }
    }
}

impl From<crate::engine::document_writer::SaveError> for CmdError {
    fn from(error: crate::engine::document_writer::SaveError) -> Self {
        use crate::engine::document_writer::SaveError;
        match error {
            SaveError::Write(write) => write.into(),
            SaveError::Rebase(ref rebase) => {
                CmdError::try_from(rebase).unwrap_or_else(|_| CmdError::failed(error.to_string()))
            }
        }
    }
}

#[cfg(test)]
mod cmd_error_tests;
