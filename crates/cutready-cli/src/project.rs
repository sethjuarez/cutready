//! A CutReady project opened with the desktop ports, plus the failures CLI
//! and MCP callers see.

use std::path::{Path, PathBuf};

use cutready_core::contracts::{AppliedEdit, CmdError, CmdErrorCode, DocumentSnapshot, RunReview};
use cutready_core::edit_ops::{self, ContentEditError};
use cutready_core::edit_session::{kind_of, Applied, EditSession, Expected, ReviewError};
use cutready_core::{Clock, Files, OpLogStore, PortErrorKind};
use cutready_desktop_io::repo_lock::RepoLock;
use cutready_desktop_io::state_dir::{enclosing_git_dir, git_state_dir, OP_LOG_FILENAME};
use cutready_desktop_io::{SqliteOpLogStore, StdFiles};
use serde_json::Value;

/// Why a command was refused: the `CmdError` every runtime reports. Clients
/// branch on its `code`; failures outside the edit contract are
/// `command_failed`.
#[derive(Debug)]
pub struct Failure(Box<CmdError>);

impl Failure {
    pub fn other(message: impl Into<String>) -> Self {
        Self(Box::new(CmdError {
            code: CmdErrorCode::CommandFailed,
            message: message.into(),
            details: None,
        }))
    }

    pub fn error(&self) -> &CmdError {
        &self.0
    }

    pub fn message(&self) -> &str {
        &self.0.message
    }
}

impl From<CmdError> for Failure {
    fn from(err: CmdError) -> Self {
        Self(Box::new(err))
    }
}

impl From<&ContentEditError> for Failure {
    fn from(err: &ContentEditError) -> Self {
        match CmdError::try_from(err) {
            Ok(cmd) => cmd.into(),
            Err(message) => Self::other(message),
        }
    }
}

impl From<&ReviewError> for Failure {
    fn from(err: &ReviewError) -> Self {
        match CmdError::try_from(err) {
            Ok(cmd) => cmd.into(),
            Err(message) => Self::other(message),
        }
    }
}

impl From<cutready_core::PortError> for Failure {
    fn from(err: cutready_core::PortError) -> Self {
        Self::other(err.message)
    }
}
/// One project's desktop ports, opened per command so no handle outlives it.
pub struct Project {
    root: PathBuf,
    files: StdFiles,
    lock: RepoLock,
    log: SqliteOpLogStore,
}

impl Project {
    /// Opens the project at `root`. It must already live in a git repository
    /// (its own or an enclosing one), where its op log and write lock are;
    /// the CLI never creates one.
    pub fn open(root: &Path) -> Result<Self, Failure> {
        let root = std::path::absolute(root)
            .map_err(|e| Failure::other(format!("{}: {e}", root.display())))?;
        if !root.is_dir() {
            return Err(Failure::other(format!(
                "{} is not a project folder",
                root.display()
            )));
        }
        if !root.join(".git").is_dir() && enclosing_git_dir(&root).is_none() {
            return Err(Failure::other(format!(
                "{} is not in a git repository; open it in CutReady first",
                root.display()
            )));
        }
        let state_dir = git_state_dir(&root, &root);
        Ok(Self {
            files: StdFiles::new(&root),
            lock: RepoLock::for_path(&root),
            log: SqliteOpLogStore::open(&state_dir.join(OP_LOG_FILENAME))?,
            root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn session<'a>(&'a self, clock: &'a dyn Clock) -> EditSession<'a> {
        EditSession::new(&self.files, &self.lock, &self.log, clock)
    }

    /// Starts a run whose writes the app shows for review.
    pub fn begin_run(&self, actor: &str, clock: &dyn Clock) -> Result<String, Failure> {
        Ok(self.session(clock).begin_run(actor)?)
    }

    /// Reads a `.sk`, `.sb` or `.md` document with the version an edit of it
    /// must expect.
    pub fn read(&self, doc: &str) -> Result<DocumentSnapshot, Failure> {
        let rel = cutready_core::path::project_relative(doc)?;
        let path = rel.to_string_lossy().replace('\\', "/");
        kind_of(&path).map_err(|e| Failure::other(e.to_string()))?;
        match self.files.read(&rel) {
            Ok(bytes) => {
                let version = edit_ops::document_version(&bytes);
                let content = String::from_utf8(bytes)
                    .map_err(|_| Failure::other(format!("{path} is not valid UTF-8")))?;
                Ok(DocumentSnapshot {
                    path,
                    content: Some(content),
                    version: Some(version),
                })
            }
            Err(err) if err.kind == PortErrorKind::NotFound => Ok(DocumentSnapshot {
                path,
                content: None,
                version: None,
            }),
            Err(err) => Err(err.into()),
        }
    }

    /// Applies `ops` to `doc` as part of `run_id`, which `actor` must have
    /// started. `expected` is the version the ops were computed against
    /// (`None`: the document must not exist yet); a mismatch is
    /// `stale_document`. Note locks are enforced.
    pub fn apply(
        &self,
        clock: &dyn Clock,
        actor: &str,
        run_id: &str,
        doc: &str,
        expected: Option<&str>,
        ops: &[Value],
    ) -> Result<Applied, Failure> {
        let run = self.log.run(run_id).map_err(|err| match err.kind {
            PortErrorKind::NotFound => Failure::other(format!("No run {run_id}; begin one first")),
            _ => err.into(),
        })?;
        if run.actor != actor {
            return Err(Failure::other(format!(
                "Run {run_id} belongs to {}, not {actor}",
                run.actor
            )));
        }
        let expected = match expected {
            Some(version) => Expected::Version(version.to_string()),
            None => Expected::Absent,
        };
        self.session(clock)
            .apply(run_id, doc, expected, ops)
            .map_err(|err| Failure::from(&err))
    }

    /// Runs with changes awaiting Keep or Undo, oldest first: what the app's
    /// review panel shows.
    pub fn reviews(&self, clock: &dyn Clock) -> Result<Vec<RunReview>, Failure> {
        Ok(self.session(clock).pending_reviews()?)
    }
    /// Keeps a run's changes to `doc` through `through_seq` (from `reviews`);
    /// `stale_review` if the run changed the document since.
    pub fn keep(
        &self,
        clock: &dyn Clock,
        run_id: &str,
        doc: &str,
        through_seq: u64,
    ) -> Result<(), Failure> {
        self.session(clock)
            .keep(run_id, doc, through_seq)
            .map_err(|err| Failure::from(&err))
    }

    /// Undoes a run's changes to `doc` through `through_seq`, keeping later
    /// edits that don't overlap; `undo_conflict` when they do.
    pub fn undo(
        &self,
        clock: &dyn Clock,
        run_id: &str,
        doc: &str,
        through_seq: u64,
    ) -> Result<(), Failure> {
        self.session(clock)
            .undo(run_id, doc, through_seq)
            .map_err(|err| Failure::from(&err))
    }
}

/// An apply's result on the wire.
pub fn applied_edit(run_id: &str, path: &str, applied: &Applied) -> AppliedEdit {
    AppliedEdit {
        run_id: run_id.to_string(),
        path: path.to_string(),
        version: applied.version.clone(),
        changed: applied.changed,
        seq: applied.seq,
        note_locked: applied.note_lock.as_ref().map(|lock| lock.locked),
        note_lock_changed: applied.note_lock.as_ref().map(|lock| lock.changed),
    }
}
