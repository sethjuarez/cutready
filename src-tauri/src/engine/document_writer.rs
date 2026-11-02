//! The desktop's single write path for project documents (`.sk`, `.sb`, `.md`).
//!
//! Every edit is a run-scoped transaction through
//! `cutready_core::edit_session::EditSession`: the repository write lock
//! ([`write_lock`]), op-log reconcile, the op batch against the bytes on
//! disk, a pending op-log entry, the atomic write, then the commit. The op log
//! (`op-log.db`) lives in the project's runtime state dir under the git dir,
//! next to `agent-state.db`. App edits join a per-process "user" run; agent
//! tool calls made inside [`in_agent_run`] join that agent run's own run.
//! `scripts/check-document-writes.mjs` keeps raw document writes out of the
//! rest of the app. Callers may already hold the (reentrant) write lock.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use cutready_core::contracts::{DocumentKind, RunReview};
use cutready_core::document::{self, DocumentError};
use cutready_core::edit_ops::{self, ContentEditError, NoteLock};
pub use cutready_core::edit_session::Expected;
use cutready_core::edit_session::{
    EditSession, NoteLockPolicy, RebaseError, Reconciled, ReviewError, USER_ACTOR,
};
use cutready_core::models::sketch::{Sketch, Storyboard};
use cutready_core::{OpLogStore, PortError, PortErrorKind};
use cutready_desktop_io::{SqliteOpLogStore, StdFiles, SystemClock};
use serde_json::{json, Value};

use crate::engine::project::{self, ProjectError};
use crate::engine::write_lock::{self, RepoLock};

use cutready_desktop_io::state_dir::OP_LOG_FILENAME;
const AGENT_ACTOR: &str = "agent";

/// Why a document write failed.
#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error(transparent)]
    Project(#[from] ProjectError),
    #[error("{}", edit_message(.0))]
    Edit(#[from] ContentEditError),
}

/// Unreadable or unsavable documents keep the app's `ProjectError` wording.
fn edit_message(err: &ContentEditError) -> String {
    match err {
        ContentEditError::Document(doc) => ProjectError::from(doc.clone()).to_string(),
        other => other.to_string(),
    }
}

impl From<DocumentError> for WriteError {
    fn from(err: DocumentError) -> Self {
        WriteError::Project(err.into())
    }
}

impl From<PortError> for WriteError {
    fn from(err: PortError) -> Self {
        DocumentError::from(err).into()
    }
}

impl From<WriteError> for String {
    fn from(err: WriteError) -> Self {
        err.to_string()
    }
}

/// A document after a successful write.
#[derive(Debug, Clone)]
#[allow(dead_code)] // `version`, `changed` and `seq` serve version-tracking callers.
pub struct Written {
    pub content: String,
    pub version: String,
    /// Whether the bytes on disk changed.
    pub changed: bool,
    /// The note's lock, for notes.
    pub note_lock: Option<NoteLock>,
    /// The op-log entry for the write, when the bytes changed.
    pub seq: Option<u64>,
}

impl Written {
    pub fn sketch(&self) -> Result<Sketch, WriteError> {
        Ok(document::sketch_from_json(&self.content)?)
    }

    pub fn storyboard(&self) -> Result<Storyboard, WriteError> {
        Ok(document::storyboard_from_json(&self.content)?.0)
    }
}

/// The document kind for a project path, from its extension.
pub fn kind_of(path: &Path) -> Result<DocumentKind, ProjectError> {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("sk") => Ok(DocumentKind::Sketch),
        Some("sb") => Ok(DocumentKind::Storyboard),
        Some("md") => Ok(DocumentKind::Note),
        _ => Err(ProjectError::Invalid(format!(
            "Not a project document: {}",
            path.display()
        ))),
    }
}

/// Apply `ops` to the document at project-relative `rel`, following note
/// locks.
pub fn edit(
    root: &Path,
    rel: &str,
    expected: Expected,
    ops: &[Value],
) -> Result<Written, WriteError> {
    let abs = project::safe_resolve(root, rel)?;
    apply(root, &abs, expected, ops, NoteLockPolicy::Enforce)
}

/// [`edit`] for a sketch or storyboard the caller already resolved under
/// `root`. Notes go through [`edit`].
pub fn edit_file(
    root: &Path,
    abs: &Path,
    expected: Expected,
    ops: &[Value],
) -> Result<Written, WriteError> {
    if kind_of(abs)? == DocumentKind::Note {
        return Err(ProjectError::Invalid("Edit notes by project path".into()).into());
    }
    apply(root, abs, expected, ops, NoteLockPolicy::Enforce)
}

/// [`edit`] for a sketch, returning the sketch after the ops.
pub fn edit_sketch(
    root: &Path,
    rel: &str,
    expected: Expected,
    ops: &[Value],
) -> Result<Sketch, WriteError> {
    edit(root, rel, expected, ops)?.sketch()
}

/// [`edit`] for a storyboard, returning the storyboard after the ops.
pub fn edit_storyboard(
    root: &Path,
    rel: &str,
    expected: Expected,
    ops: &[Value],
) -> Result<Storyboard, WriteError> {
    edit(root, rel, expected, ops)?.storyboard()
}

/// Write a whole sketch at `abs` under `root` over the version the caller
/// read (`Absent` to create it).
pub fn write_sketch(
    root: &Path,
    abs: &Path,
    sketch: &Sketch,
    expected: Expected,
) -> Result<Written, WriteError> {
    replace(root, abs, Imported::Sketch(sketch), expected)
}

/// Write a whole storyboard over the version the caller read, like
/// [`write_sketch`].
pub fn write_storyboard(
    root: &Path,
    abs: &Path,
    storyboard: &Storyboard,
    expected: Expected,
) -> Result<Written, WriteError> {
    replace(root, abs, Imported::Storyboard(storyboard), expected)
}

/// Write a whole note over the version the caller read. Not lock-gated.
pub fn write_note(
    root: &Path,
    abs: &Path,
    content: &str,
    expected: Expected,
) -> Result<Written, WriteError> {
    replace(root, abs, Imported::Note(content), expected)
}

/// A whole document an import writes.
pub enum Imported<'a> {
    Sketch(&'a Sketch),
    Storyboard(&'a Storyboard),
    Note(&'a str),
}

impl<'a> From<&'a Sketch> for Imported<'a> {
    fn from(sketch: &'a Sketch) -> Self {
        Self::Sketch(sketch)
    }
}

impl<'a> From<&'a String> for Imported<'a> {
    fn from(note: &'a String) -> Self {
        Self::Note(note)
    }
}

/// The one unchecked write: an import that may overwrite whatever is on
/// disk. `scripts/check-document-writes.mjs` keeps its callers to the import
/// entry points; every other write states the version it expects.
pub(crate) fn import_document<'a>(
    root: &Path,
    abs: &Path,
    document: impl Into<Imported<'a>>,
) -> Result<Written, WriteError> {
    replace(root, abs, document.into(), Expected::Unchecked)
}

#[cfg(test)]
pub fn replace_sketch(root: &Path, abs: &Path, sketch: &Sketch) -> Result<Written, WriteError> {
    import_document(root, abs, Imported::Sketch(sketch))
}

#[cfg(test)]
pub fn replace_storyboard(
    root: &Path,
    abs: &Path,
    storyboard: &Storyboard,
) -> Result<Written, WriteError> {
    import_document(root, abs, Imported::Storyboard(storyboard))
}

#[cfg(test)]
pub fn replace_note(root: &Path, abs: &Path, content: &str) -> Result<Written, WriteError> {
    import_document(root, abs, Imported::Note(content))
}

/// What the caller expects on disk at `abs`, from the bytes there now: the
/// file's version, or `Absent`. Call it under the write lock, after reading
/// the document being replaced.
pub fn expected_on_disk(abs: &Path) -> Result<Expected, WriteError> {
    match std::fs::read(abs) {
        Ok(bytes) => Ok(Expected::Version(edit_ops::document_version(&bytes))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Expected::Absent),
        Err(err) => Err(ProjectError::Io(err.to_string()).into()),
    }
}

/// A document with the version of the bytes it came from.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Versioned<T> {
    pub document: T,
    /// The exact file text, which the app sends back as a save's base.
    pub content: String,
    pub version: String,
    /// Whether a save was merged onto changes made since its base.
    pub merged: bool,
    /// For a merged save, its base with its ops applied: what the app's
    /// editor holds, so its next base while the merged document can't be
    /// shown. Absent otherwise, where `content` is that document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synced: Option<Synced>,
}

/// A document text and its version.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Synced {
    pub content: String,
    pub version: String,
}

impl Synced {
    fn of(content: String) -> Self {
        let version = cutready_core::edit_ops::document_version(content.as_bytes());
        Self { content, version }
    }
}

impl Versioned<String> {
    pub fn sketch(self) -> Result<Versioned<Sketch>, WriteError> {
        Ok(Versioned {
            document: document::sketch_from_json(&self.content)?,
            content: self.content,
            version: self.version,
            merged: self.merged,
            synced: self.synced,
        })
    }

    pub fn storyboard(self) -> Result<Versioned<Storyboard>, WriteError> {
        Ok(Versioned {
            document: document::storyboard_from_json(&self.content)?.0,
            content: self.content,
            version: self.version,
            merged: self.merged,
            synced: self.synced,
        })
    }
}

impl From<Written> for Versioned<String> {
    fn from(written: Written) -> Self {
        Self {
            document: written.content.clone(),
            content: written.content,
            version: written.version,
            merged: false,
            synced: None,
        }
    }
}

/// A new document at `rel` holding `content` (a conflict copy). Refuses as
/// stale when the file exists.
pub fn create_from_text(
    root: &Path,
    rel: &str,
    content: &str,
) -> Result<Versioned<String>, WriteError> {
    let abs = project::safe_resolve(root, rel)?;
    let written = match kind_of(&abs)? {
        DocumentKind::Sketch => {
            let sketch = document::sketch_from_json(content)?;
            write_sketch(root, &abs, &sketch, Expected::Absent)
        }
        DocumentKind::Storyboard => {
            let storyboard = document::storyboard_from_json(content)?.0;
            write_storyboard(root, &abs, &storyboard, Expected::Absent)
        }
        DocumentKind::Note => write_note(root, &abs, content, Expected::Absent),
    }?;
    Ok(written.into())
}

/// Why an app save wrote nothing.
#[derive(Debug, thiserror::Error)]
pub enum SaveError {
    #[error(transparent)]
    Write(#[from] WriteError),
    #[error(transparent)]
    Rebase(RebaseError),
}

/// An app save: `ops` made against `base`, the document the editor last
/// loaded or saved, whose version is `expected_version`. When the file
/// changed since, the save is three-way merged onto it, or rejected as stale
/// when the changes overlap.
pub fn save(
    root: &Path,
    rel: &str,
    expected_version: &str,
    base: &str,
    ops: &[Value],
) -> Result<Versioned<String>, SaveError> {
    let abs = project::safe_resolve(root, rel).map_err(WriteError::from)?;
    kind_of(&abs).map_err(WriteError::from)?;
    let rel = relative(root, &abs)?;
    let ports = Ports::open(root)?;
    let session = ports.session();
    let run = ports.run(&session).map_err(WriteError::from)?;
    let rebased = session
        .apply_rebased(&run, &rel, expected_version, base, ops)
        .map_err(|err| match err {
            RebaseError::Edit(edit) => SaveError::Write(not_found_as_project(edit, &abs)),
            stale => SaveError::Rebase(stale),
        })?;
    Ok(Versioned {
        document: rebased.applied.content.clone(),
        content: rebased.applied.content,
        version: rebased.applied.version,
        merged: rebased.merged,
        synced: rebased.local.map(Synced::of),
    })
}

/// Remove a document file under `root`, holding the repository write lock so
/// it never interleaves with another process's write. A missing file is
/// already deleted. Not yet logged: review of deletes arrives with Keep/Undo.
pub fn delete(root: &Path, path: &Path) -> Result<(), WriteError> {
    kind_of(path)?;
    let _guard = write_lock::lock(root).map_err(ProjectError::Io)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(ProjectError::Io(err.to_string()).into()),
    }
}

/// Settle writes a crash interrupted, so the op log matches the disk. Runs
/// on project open; every write also reconciles first.
pub fn open_project(root: &Path) -> Result<Reconciled, WriteError> {
    let ports = Ports::open(root)?;
    Ok(ports.session().reconcile()?)
}

/// Runs with changes awaiting Keep or Undo, oldest first.
pub fn pending_reviews(root: &Path) -> Result<Vec<RunReview>, WriteError> {
    Ok(Ports::open(root)?.session().pending_reviews()?)
}

/// Keeps a run's changes to `doc` through the review's `through_seq`.
pub fn keep_run_document(
    root: &Path,
    run_id: &str,
    doc: &str,
    through_seq: u64,
) -> Result<(), String> {
    let ports = Ports::open(root)?;
    ports
        .session()
        .keep(run_id, doc, through_seq)
        .map_err(review_message)
}

/// Undoes a run's changes to `doc` through the review's `through_seq`,
/// keeping later edits that don't overlap.
pub fn undo_run_document(
    root: &Path,
    run_id: &str,
    doc: &str,
    through_seq: u64,
) -> Result<(), String> {
    let ports = Ports::open(root)?;
    ports
        .session()
        .undo(run_id, doc, through_seq)
        .map_err(review_message)
}

fn review_message(err: ReviewError) -> String {
    match err {
        ReviewError::Undo(cutready_core::review::UndoError::Document(doc)) => {
            ProjectError::from(doc).to_string()
        }
        other => other.to_string(),
    }
}

/// Run `f` with document writes on this thread attributed to the agent run
/// `agent_run_id` (one op-log run per agent run and project).
pub fn in_agent_run<R>(agent_run_id: &str, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            AGENT_RUN.with(|run| *run.borrow_mut() = self.0.take());
        }
    }
    let previous = AGENT_RUN.with(|run| run.borrow_mut().replace(agent_run_id.to_string()));
    let _restore = Restore(previous);
    f()
}

thread_local! {
    static AGENT_RUN: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn replace(
    root: &Path,
    abs: &Path,
    document: Imported<'_>,
    expected: Expected,
) -> Result<Written, WriteError> {
    let (kind, op) = match document {
        Imported::Sketch(sketch) => (
            DocumentKind::Sketch,
            json!({ "kind": "replace_sketch", "sketch": to_value(sketch)? }),
        ),
        Imported::Storyboard(storyboard) => (
            DocumentKind::Storyboard,
            json!({ "kind": "replace_storyboard", "storyboard": to_value(storyboard)? }),
        ),
        Imported::Note(content) => (
            DocumentKind::Note,
            json!({ "kind": "replace_note", "content": content }),
        ),
    };
    if kind_of(abs)? != kind {
        return Err(
            ProjectError::Invalid(format!("Not a {kind:?} document: {}", abs.display())).into(),
        );
    }
    apply(root, abs, expected, &[op], NoteLockPolicy::Ignore)
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, WriteError> {
    serde_json::to_value(value)
        .map_err(|e| WriteError::Project(ProjectError::Invalid(e.to_string())))
}

fn relative(root: &Path, abs: &Path) -> Result<String, WriteError> {
    let rel = abs
        .strip_prefix(root)
        .map_err(|_| ProjectError::PathTraversal(abs.to_string_lossy().into_owned()))?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

/// Legacy commands read the file first and fail when it's gone.
fn not_found_as_project(err: ContentEditError, abs: &Path) -> WriteError {
    match err {
        ContentEditError::Document(DocumentError::Port(PortError {
            kind: PortErrorKind::NotFound,
            ..
        })) => ProjectError::NotFound(abs.to_string_lossy().into_owned()).into(),
        other => WriteError::from(other),
    }
}

fn apply(
    root: &Path,
    abs: &Path,
    expected: Expected,
    ops: &[Value],
    policy: NoteLockPolicy,
) -> Result<Written, WriteError> {
    kind_of(abs)?;
    let rel = relative(root, abs)?;
    let ports = Ports::open(root)?;
    let session = ports.session();
    let run = ports.run(&session)?;
    let applied = session
        .apply_with(&run, &rel, expected, ops, policy)
        .map_err(|err| not_found_as_project(err, abs))?;
    Ok(Written {
        content: applied.content,
        version: applied.version,
        changed: applied.changed,
        note_lock: applied.note_lock,
        seq: applied.seq,
    })
}

/// A project's desktop ports, opened per write so no handle outlives it
/// (the folder stays movable and deletable).
struct Ports {
    root: PathBuf,
    state_dir: PathBuf,
    files: StdFiles,
    lock: RepoLock,
    log: SqliteOpLogStore,
    clock: SystemClock,
}

/// Runs this process has open, per project state dir.
#[derive(Default)]
struct Runs {
    user: Option<String>,
    agents: HashMap<String, String>,
}

static RUNS: LazyLock<Mutex<HashMap<PathBuf, Runs>>> = LazyLock::new(Default::default);
static STATE_DIRS: LazyLock<Mutex<HashMap<PathBuf, PathBuf>>> = LazyLock::new(Default::default);

impl Ports {
    fn open(root: &Path) -> Result<Self, WriteError> {
        let state_dir = state_dir(root);
        Ok(Self {
            root: root.to_path_buf(),
            files: StdFiles::new(root),
            lock: RepoLock::for_path(root),
            log: SqliteOpLogStore::open(&state_dir.join(OP_LOG_FILENAME))?,
            clock: SystemClock,
            state_dir,
        })
    }

    fn session(&self) -> EditSession<'_> {
        EditSession::new(&self.files, &self.lock, &self.log, &self.clock)
    }

    /// The op-log run for this thread's writes: the agent run in scope, else
    /// the process's user run. Recreated if the op log was reset.
    fn run(&self, session: &EditSession<'_>) -> Result<String, PortError> {
        let agent = AGENT_RUN.with(|run| run.borrow().clone());
        let mut runs = RUNS.lock().unwrap_or_else(|e| e.into_inner());
        let runs = runs.entry(self.state_dir.clone()).or_default();
        let slot = match &agent {
            Some(id) => runs.agents.entry(id.clone()).or_default(),
            None => runs.user.get_or_insert_with(String::new),
        };
        if !slot.is_empty() {
            match self.log.run(slot) {
                Ok(_) => return Ok(slot.clone()),
                Err(err) if err.kind == PortErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
        }
        let actor = if agent.is_some() {
            AGENT_ACTOR
        } else {
            USER_ACTOR
        };
        *slot = session.begin_run(actor)?;
        log::debug!("[writer] {actor} run {slot} for {}", self.root.display());
        Ok(slot.clone())
    }
}

/// The project a document belongs to when the caller has only its path: the
/// deepest project this process opened or wrote that contains it.
pub fn project_root_for(path: &Path) -> Option<PathBuf> {
    let dirs = STATE_DIRS.lock().unwrap_or_else(|e| e.into_inner());
    dirs.keys()
        .filter(|root| path.starts_with(root))
        .max_by_key(|root| root.components().count())
        .cloned()
}

/// The runtime state dir for `root` (`<git dir>/cutready[/<folder>]`),
/// shared with `agent-state.db`. Cached: it costs a repository discovery.
fn state_dir(root: &Path) -> PathBuf {
    let mut dirs = STATE_DIRS.lock().unwrap_or_else(|e| e.into_inner());
    dirs.entry(root.to_path_buf())
        .or_insert_with(|| project::git_state_dir(root, root))
        .clone()
}

#[cfg(test)]
#[path = "document_writer_tests.rs"]
mod tests;
