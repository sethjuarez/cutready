//! A CutReady project opened with the desktop ports, plus the failures CLI
//! and MCP callers see.

use std::path::{Path, PathBuf};

use cutready_core::contracts::{CmdError, SaveContext};
use cutready_core::edit_ops::{self, ContentEditError};
use cutready_core::edit_session::{kind_of, Applied, EditSession, Expected};
use cutready_core::{Clock, Files, OpLogStore, PortErrorKind};
use cutready_desktop_io::repo_lock::RepoLock;
use cutready_desktop_io::state_dir::{enclosing_git_dir, git_state_dir, OP_LOG_FILENAME};
use cutready_desktop_io::{SqliteOpLogStore, StdFiles};
use serde_json::{json, Value};

/// Why a command was refused. Contract errors carry the `CmdError` every
/// runtime reports (clients branch on its `code`); the rest are plain text.
#[derive(Debug)]
pub enum Failure {
    Contract(Box<CmdError>),
    Other(String),
}

impl Failure {
    pub fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }

    /// `{code, message, details?}` for contract errors, `{message}` otherwise.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Contract(err) => err.to_value(&SaveContext::default()),
            Self::Other(message) => json!({ "message": message }),
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Contract(err) => &err.message,
            Self::Other(message) => message,
        }
    }
}

impl From<&ContentEditError> for Failure {
    fn from(err: &ContentEditError) -> Self {
        match CmdError::try_from(err) {
            Ok(cmd) => Self::Contract(Box::new(cmd)),
            Err(message) => Self::Other(message),
        }
    }
}

impl From<cutready_core::PortError> for Failure {
    fn from(err: cutready_core::PortError) -> Self {
        Self::Other(err.message)
    }
}

/// A document as it is on disk now.
pub struct Snapshot {
    pub path: String,
    /// `None` when the file doesn't exist.
    pub content: Option<String>,
    /// `documentVersion` of the bytes; `None` when the file doesn't exist.
    pub version: Option<String>,
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
    pub fn read(&self, doc: &str) -> Result<Snapshot, Failure> {
        let rel = cutready_core::path::project_relative(doc)?;
        let path = rel.to_string_lossy().replace('\\', "/");
        kind_of(&path).map_err(|e| Failure::other(e.to_string()))?;
        match self.files.read(&rel) {
            Ok(bytes) => {
                let version = edit_ops::document_version(&bytes);
                let content = String::from_utf8(bytes)
                    .map_err(|_| Failure::other(format!("{path} is not valid UTF-8")))?;
                Ok(Snapshot {
                    path,
                    content: Some(content),
                    version: Some(version),
                })
            }
            Err(err) if err.kind == PortErrorKind::NotFound => Ok(Snapshot {
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
}

/// An apply's result as JSON: `{path, version, changed, seq, note_locked?,
/// note_lock_changed?}`.
pub fn applied_json(path: &str, applied: &Applied) -> Value {
    let mut out = json!({
        "path": path,
        "version": applied.version,
        "changed": applied.changed,
        "seq": applied.seq,
    });
    if let Some(lock) = &applied.note_lock {
        out["note_locked"] = json!(lock.locked);
        out["note_lock_changed"] = json!(lock.changed);
    }
    out
}
