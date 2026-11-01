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
use cutready_core::edit_ops::{ContentEditError, NoteLock};
pub use cutready_core::edit_session::Expected;
use cutready_core::edit_session::{
    EditSession, NoteLockPolicy, Reconciled, ReviewError, USER_ACTOR,
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

/// Write a whole sketch at `abs` under `root`, creating or replacing it.
pub fn replace_sketch(root: &Path, abs: &Path, sketch: &Sketch) -> Result<Written, WriteError> {
    let op = json!({ "kind": "replace_sketch", "sketch": to_value(sketch)? });
    replace(root, abs, DocumentKind::Sketch, op)
}

/// Write a whole storyboard, creating or replacing the file.
pub fn replace_storyboard(
    root: &Path,
    abs: &Path,
    storyboard: &Storyboard,
) -> Result<Written, WriteError> {
    let op = json!({ "kind": "replace_storyboard", "storyboard": to_value(storyboard)? });
    replace(root, abs, DocumentKind::Storyboard, op)
}

/// Write a whole note, creating or replacing the file. Not lock-gated.
pub fn replace_note(root: &Path, abs: &Path, content: &str) -> Result<Written, WriteError> {
    let op = json!({ "kind": "replace_note", "content": content });
    replace(root, abs, DocumentKind::Note, op)
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

fn replace(root: &Path, abs: &Path, kind: DocumentKind, op: Value) -> Result<Written, WriteError> {
    if kind_of(abs)? != kind {
        return Err(
            ProjectError::Invalid(format!("Not a {kind:?} document: {}", abs.display())).into(),
        );
    }
    apply(
        root,
        abs,
        Expected::Unchecked,
        &[op],
        NoteLockPolicy::Ignore,
    )
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, WriteError> {
    serde_json::to_value(value)
        .map_err(|e| WriteError::Project(ProjectError::Invalid(e.to_string())))
}

fn apply(
    root: &Path,
    abs: &Path,
    expected: Expected,
    ops: &[Value],
    policy: NoteLockPolicy,
) -> Result<Written, WriteError> {
    kind_of(abs)?;
    let rel = abs
        .strip_prefix(root)
        .map_err(|_| ProjectError::PathTraversal(abs.to_string_lossy().into_owned()))?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    let ports = Ports::open(root)?;
    let session = ports.session();
    let run = ports.run(&session)?;
    let applied = session
        .apply_with(&run, &rel, expected, ops, policy)
        .map_err(|err| match err {
            // Legacy commands read the file first and fail when it's gone.
            ContentEditError::Document(DocumentError::Port(PortError {
                kind: PortErrorKind::NotFound,
                ..
            })) => ProjectError::NotFound(abs.to_string_lossy().into_owned()).into(),
            other => WriteError::from(other),
        })?;
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
mod tests {
    use super::*;
    use cutready_core::models::sketch::PlanningRow;

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn replace_creates_then_replaces_without_leaving_temp_files() {
        let dir = project();
        let path = dir.path().join("nested/intro.sk");
        let mut sketch = Sketch::new("Intro", chrono::Utc::now());
        let first = replace_sketch(dir.path(), &path, &sketch).unwrap();
        assert!(first.changed);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            document::sketch_to_json(&sketch).unwrap()
        );

        sketch.title = "Renamed".into();
        let second = replace_sketch(dir.path(), &path, &sketch).unwrap();
        assert!(second.changed);
        assert_ne!(first.version, second.version);
        assert_eq!(files_in(&dir.path().join("nested")), vec!["intro.sk"]);
    }

    #[test]
    fn unchanged_bytes_are_not_rewritten() {
        let dir = project();
        let path = dir.path().join("intro.sk");
        let sketch = Sketch::new("Intro", chrono::Utc::now());
        replace_sketch(dir.path(), &path, &sketch).unwrap();
        let again = replace_sketch(dir.path(), &path, &sketch).unwrap();
        assert!(!again.changed);
    }

    #[test]
    fn expected_absent_rejects_an_existing_file() {
        let dir = project();
        replace_note(dir.path(), &dir.path().join("a.md"), "hi").unwrap();
        let op = json!({ "kind": "replace_note", "content": "" });
        let err = edit(dir.path(), "a.md", Expected::Absent, &[op]).unwrap_err();
        assert!(matches!(
            err,
            WriteError::Edit(ContentEditError::Stale(ref stale)) if stale.current_version.is_some()
        ));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "hi"
        );
    }

    #[test]
    fn expected_version_must_match() {
        let dir = project();
        let written = replace_note(dir.path(), &dir.path().join("a.md"), "one").unwrap();
        let op = json!({ "kind": "write_note", "content": "two" });
        let stale = edit(
            dir.path(),
            "a.md",
            Expected::Version("sha256:00".into()),
            std::slice::from_ref(&op),
        );
        assert!(stale.is_err());
        let ok = edit(
            dir.path(),
            "a.md",
            Expected::Version(written.version),
            &[op],
        )
        .unwrap();
        assert_eq!(ok.content, "two");
    }

    #[test]
    fn unchecked_edit_of_a_missing_file_is_not_found() {
        let dir = project();
        let op = json!({ "kind": "set_title", "title": "x" });
        let err = edit(dir.path(), "gone.sk", Expected::Unchecked, &[op]).unwrap_err();
        assert!(err.to_string().starts_with("Project not found:"), "{err}");
    }

    #[test]
    fn note_lock_ops_update_the_manifest_not_the_note() {
        let dir = project();
        replace_note(dir.path(), &dir.path().join("notes/a.md"), "body").unwrap();
        let lock = json!({ "kind": "set_lock", "locked": true });
        let written = edit(dir.path(), "notes/a.md", Expected::Unchecked, &[lock]).unwrap();
        assert!(!written.changed);
        assert!(
            project::get_note_lock(dir.path(), "notes/a.md")
                .unwrap()
                .locked
        );

        let write = json!({ "kind": "write_note", "content": "new" });
        let err = edit(dir.path(), "notes/a.md", Expected::Unchecked, &[write]).unwrap_err();
        assert_eq!(err.to_string(), cutready_core::notes::NOTE_LOCKED_MESSAGE);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("notes/a.md")).unwrap(),
            "body"
        );
    }

    #[test]
    fn rejected_batches_leave_the_file_untouched() {
        let dir = project();
        let path = dir.path().join("intro.sk");
        let mut sketch = Sketch::new("Intro", chrono::Utc::now());
        sketch.rows.push(PlanningRow::new());
        sketch.locked = true;
        replace_sketch(dir.path(), &path, &sketch).unwrap();
        let before = std::fs::read(&path).unwrap();

        let op = json!({ "kind": "set_title", "title": "x" });
        let err = edit(dir.path(), "intro.sk", Expected::Unchecked, &[op]).unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn unreadable_documents_keep_the_project_error_wording() {
        let dir = project();
        std::fs::write(dir.path().join("bad.sk"), "{").unwrap();
        let op = json!({ "kind": "touch" });
        let err = edit(dir.path(), "bad.sk", Expected::Unchecked, &[op]).unwrap_err();
        assert!(
            err.to_string().starts_with("Deserialization error"),
            "{err}"
        );
    }

    #[test]
    fn non_documents_are_refused() {
        let dir = project();
        let op = json!({ "kind": "touch" });
        assert!(edit(dir.path(), "a.json", Expected::Unchecked, &[op]).is_err());
        assert!(delete(dir.path(), &dir.path().join("a.json")).is_err());
    }

    #[test]
    fn delete_tolerates_a_missing_file() {
        let dir = project();
        let path = dir.path().join("a.md");
        replace_note(dir.path(), &path, "x").unwrap();
        delete(dir.path(), &path).unwrap();
        delete(dir.path(), &path).unwrap();
        assert!(!path.exists());
    }

    fn op_log(root: &Path) -> SqliteOpLogStore {
        SqliteOpLogStore::open(&state_dir(root).join(OP_LOG_FILENAME)).unwrap()
    }

    #[test]
    fn writes_are_logged_in_the_process_user_run() {
        let dir = project();
        let first = replace_note(dir.path(), &dir.path().join("a.md"), "one").unwrap();
        let second = replace_note(dir.path(), &dir.path().join("a.md"), "two").unwrap();
        let unchanged = replace_note(dir.path(), &dir.path().join("a.md"), "two").unwrap();
        assert!(dir
            .path()
            .join(".git/cutready")
            .join(OP_LOG_FILENAME)
            .is_file());
        assert_eq!(unchanged.seq, None);

        let log = op_log(dir.path());
        let entry = log.pending().unwrap();
        assert!(entry.is_empty());
        let run_id = {
            let runs = RUNS.lock().unwrap();
            runs[&state_dir(dir.path())].user.clone().unwrap()
        };
        assert_eq!(log.run(&run_id).unwrap().actor, USER_ACTOR);
        let entries = log.entries_for_run(&run_id).unwrap();
        assert_eq!(
            entries.iter().map(|e| Some(e.seq)).collect::<Vec<_>>(),
            vec![first.seq, second.seq]
        );
        assert!(entries
            .iter()
            .all(|e| e.state == cutready_core::OpLogState::Committed && e.write.doc == "a.md"));
        assert_eq!(
            entries[0].write.baseline,
            Some(cutready_core::Baseline::Absent)
        );
        assert_eq!(entries[1].write.baseline, None);
    }

    #[test]
    fn agent_writes_join_their_own_run_and_scope_is_restored() {
        let dir = project();
        let path = dir.path().join("a.md");
        replace_note(dir.path(), &path, "user").unwrap();
        let agent_seq = in_agent_run("run-1", || {
            let seq = replace_note(dir.path(), &path, "agent").unwrap().seq;
            // Nested scopes restore the outer one.
            in_agent_run("run-2", || {
                replace_note(dir.path(), &path, "other").unwrap()
            });
            (
                seq,
                replace_note(dir.path(), &path, "agent again").unwrap().seq,
            )
        });
        replace_note(dir.path(), &path, "user again").unwrap();

        let (user, agent1, agent2) = {
            let runs = RUNS.lock().unwrap();
            let runs = &runs[&state_dir(dir.path())];
            (
                runs.user.clone().unwrap(),
                runs.agents["run-1"].clone(),
                runs.agents["run-2"].clone(),
            )
        };
        let log = op_log(dir.path());
        assert_eq!(log.run(&agent1).unwrap().actor, AGENT_ACTOR);
        assert_eq!(log.entries_for_run(&user).unwrap().len(), 2);
        let agent_entries = log.entries_for_run(&agent1).unwrap();
        assert_eq!(
            agent_entries
                .iter()
                .map(|e| Some(e.seq))
                .collect::<Vec<_>>(),
            vec![agent_seq.0, agent_seq.1]
        );
        assert_eq!(
            agent_entries[0].write.baseline,
            Some(cutready_core::Baseline::Content("user".into()))
        );
        assert_eq!(log.entries_for_run(&agent2).unwrap().len(), 1);
    }

    #[test]
    fn open_project_settles_writes_a_crash_interrupted() {
        let dir = project();
        replace_note(dir.path(), &dir.path().join("a.md"), "before").unwrap();
        let log = op_log(dir.path());
        let run = log.begin_run(USER_ACTOR, chrono::Utc::now()).unwrap();
        let pending = |doc: &str, after: &str| {
            log.append_pending(cutready_core::NewOpLogEntry {
                run_id: run.clone(),
                doc: doc.into(),
                actor: USER_ACTOR.into(),
                ops: json!([]),
                before_hash: String::new(),
                after_hash: cutready_core::edit_ops::document_version(after.as_bytes()),
                at: chrono::Utc::now(),
                baseline: None,
                images: None,
                effect: cutready_core::ReviewEffect::Review,
            })
            .unwrap()
        };
        // The file write landed before the crash...
        let landed = pending("a.md", "after");
        std::fs::write(dir.path().join("a.md"), "after").unwrap();
        // ...or it didn't.
        let lost = pending("b.md", "never written");

        let settled = open_project(dir.path()).unwrap();
        assert_eq!(settled.committed, vec![landed]);
        assert_eq!(settled.abandoned, vec![lost]);
        assert!(log.pending().unwrap().is_empty());
        let again = open_project(dir.path()).unwrap();
        assert!(again.committed.is_empty() && again.abandoned.is_empty());
    }

    #[test]
    fn concurrent_writers_never_lose_an_edit() {
        let dir = project();
        let path = dir.path().join("story.sb");
        replace_storyboard(
            dir.path(),
            &path,
            &Storyboard::new("Story", chrono::Utc::now()),
        )
        .unwrap();
        std::thread::scope(|scope| {
            for t in 0..4 {
                let root = dir.path();
                scope.spawn(move || {
                    for i in 0..5 {
                        let op = json!({
                            "kind": "insert_storyboard_item",
                            "index": null,
                            "item": { "type": "sketch_ref", "path": format!("s{t}-{i}.sk") },
                        });
                        let write = || {
                            edit(
                                root,
                                "story.sb",
                                Expected::Unchecked,
                                std::slice::from_ref(&op),
                            )
                        };
                        if t % 2 == 0 {
                            write().unwrap();
                        } else {
                            in_agent_run(&format!("agent-{t}"), write).unwrap();
                        }
                    }
                });
            }
        });
        let saved = project::read_storyboard(&path).unwrap();
        assert_eq!(saved.sketch_paths().len(), 20);
        assert!(op_log(dir.path()).pending().unwrap().is_empty());
    }

    #[test]
    fn project_root_for_prefers_the_deepest_known_project() {
        let dir = project();
        let outer = dir.path().join("outer");
        let inner = outer.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        open_project(&outer).unwrap();
        open_project(&inner).unwrap();
        assert_eq!(project_root_for(&inner.join("x/a.sb")), Some(inner));
        assert_eq!(project_root_for(&outer.join("b.sb")), Some(outer));
        assert_eq!(project_root_for(&dir.path().join("elsewhere/c.sb")), None);
    }
}
