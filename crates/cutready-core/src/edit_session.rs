//! The write transaction every host uses for project documents: lock,
//! reconcile, edit, log pending, write, commit. Documents are the truth; the
//! op log records which run wrote what so review can diff, keep or undo it.

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::contracts::{
    CmdError, CmdErrorCode, DocumentKind, DocumentReview, RunReview, UndoConflict, UndoWrite,
};
use crate::document::DocumentError;
use crate::edit_ops::{self, ContentEditError, NoteLock};
use crate::notes::{self, LOCKS_PATH};
use crate::path::project_relative;
use crate::ports::{
    Baseline, Clock, Files, Images, Lock, NewOpLogEntry, OpLogEntry, OpLogState, OpLogStore,
    PortError, PortErrorKind, Resolution, ReviewEffect,
};
use crate::review::{self, UndoError};

/// The app's own edits: kept as they commit, never up for review.
pub const USER_ACTOR: &str = "user";
/// Runs that write review undos.
pub const REVIEW_ACTOR: &str = "review";

/// What the caller believes is on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expected {
    /// The file's bytes must have this version (`sha256:…`).
    Version(String),
    /// The file must not exist yet.
    Absent,
    /// Whatever is on disk now. For callers that don't track versions; not
    /// optimistic concurrency.
    Unchecked,
}

/// Whether a note edit follows the lock manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteLockPolicy {
    /// Locked notes reject edits; `set_lock` ops update the manifest.
    Enforce,
    /// Import and create paths: the note is treated as unlocked and the
    /// manifest is left alone.
    Ignore,
}

/// A write's outcome. `seq` is the document's op-log entry, `None` when its
/// bytes didn't change (nothing is logged or written for it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub content: String,
    pub version: String,
    pub changed: bool,
    pub note_lock: Option<NoteLock>,
    pub seq: Option<u64>,
}

/// Pending entries settled by [`EditSession::reconcile`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reconciled {
    pub committed: Vec<u64>,
    pub abandoned: Vec<u64>,
}

/// Hash recorded as `before_hash` when the document didn't exist.
pub const ABSENT_HASH: &str = "";

/// Why Keep or Undo failed. Nothing changed.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ReviewError {
    #[error("The run changed this document again; review its latest changes.")]
    Stale,
    #[error(transparent)]
    Undo(#[from] UndoError),
}

impl From<DocumentError> for ReviewError {
    fn from(err: DocumentError) -> Self {
        Self::Undo(UndoError::Document(err))
    }
}

impl From<PortError> for ReviewError {
    fn from(err: PortError) -> Self {
        DocumentError::from(err).into()
    }
}

/// The contract's CmdError; unreadable documents surface as their message.
impl TryFrom<&ReviewError> for CmdError {
    type Error = String;

    fn try_from(err: &ReviewError) -> Result<Self, String> {
        match err {
            ReviewError::Stale => Ok(CmdError {
                code: CmdErrorCode::StaleReview,
                message: err.to_string(),
                details: None,
            }),
            ReviewError::Undo(undo) => CmdError::try_from(undo),
        }
    }
}

/// The project document kind for a path's extension.
pub fn kind_of(doc: &str) -> Result<DocumentKind, DocumentError> {
    match Path::new(doc).extension().and_then(|ext| ext.to_str()) {
        Some("sk") => Ok(DocumentKind::Sketch),
        Some("sb") => Ok(DocumentKind::Storyboard),
        Some("md") => Ok(DocumentKind::Note),
        _ => Err(PortError::new(
            PortErrorKind::InvalidPath,
            format!("Not a project document: {doc}"),
        )
        .into()),
    }
}

/// One file write inside a transaction.
struct Write {
    doc: String,
    ops: Value,
    before: Option<String>,
    after: String,
    effect: ReviewEffect,
}

/// One project's write path over its ports. Cheap to build per call.
pub struct EditSession<'a> {
    files: &'a dyn Files,
    lock: &'a dyn Lock,
    log: &'a dyn OpLogStore,
    clock: &'a dyn Clock,
}

impl<'a> EditSession<'a> {
    pub fn new(
        files: &'a dyn Files,
        lock: &'a dyn Lock,
        log: &'a dyn OpLogStore,
        clock: &'a dyn Clock,
    ) -> Self {
        Self {
            files,
            lock,
            log,
            clock,
        }
    }

    /// Starts a run for `actor` (`user`, `agent:<name>`, `cli`, `mcp`).
    pub fn begin_run(&self, actor: &str) -> Result<String, PortError> {
        self.log.begin_run(actor, self.clock.now())
    }

    /// Applies `ops` to the project-relative `doc` (`.sk`, `.sb` or `.md`)
    /// as part of `run_id`, following note locks.
    pub fn apply(
        &self,
        run_id: &str,
        doc: &str,
        expected: Expected,
        ops: &[Value],
    ) -> Result<Applied, ContentEditError> {
        self.apply_with(run_id, doc, expected, ops, NoteLockPolicy::Enforce)
    }

    /// [`Self::apply`] with an explicit note-lock policy.
    ///
    /// Holds the project lock for the whole transaction. Hosts whose callers
    /// already hold it must make [`Lock::acquire`] reentrant per thread.
    pub fn apply_with(
        &self,
        run_id: &str,
        doc: &str,
        expected: Expected,
        ops: &[Value],
        policy: NoteLockPolicy,
    ) -> Result<Applied, ContentEditError> {
        let doc = normalize(doc)?;
        let kind = kind_of(&doc)?;
        let _guard = self.lock.acquire().map_err(DocumentError::from)?;
        self.reconcile_locked().map_err(DocumentError::from)?;
        let run = self.log.run(run_id).map_err(DocumentError::from)?;
        let current = self.read(&doc)?;
        let expected_version = match expected {
            Expected::Version(version) => Some(version),
            Expected::Absent => None,
            Expected::Unchecked => match &current {
                Some(content) => Some(edit_ops::document_version(content.as_bytes())),
                None if starts_with_replacement(ops) => None,
                None => {
                    return Err(DocumentError::from(PortError::new(
                        PortErrorKind::NotFound,
                        doc.clone(),
                    ))
                    .into())
                }
            },
        };
        let follows_locks = kind == DocumentKind::Note && policy == NoteLockPolicy::Enforce;
        let note_locked = follows_locks && notes::get_note_lock(self.files, &doc)?.locked;
        let now = self.clock.now();
        let edit = edit_ops::edit_document(
            kind,
            current.as_deref(),
            expected_version.as_deref(),
            ops,
            now,
            note_locked,
        )?;
        let changed = edit.changes(current.as_deref());

        let mut writes = Vec::new();
        if changed {
            writes.push(Write {
                doc: doc.clone(),
                ops: Value::Array(ops.to_vec()),
                before: current,
                after: edit.content.clone(),
                effect: ReviewEffect::Review,
            });
        }
        if let Some(lock) = edit.note_lock.filter(|lock| lock.changed && follows_locks) {
            let before = self.read(LOCKS_PATH)?;
            let mut manifest = match &before {
                Some(json) => notes::lock_manifest_from_json(json)?,
                None => Default::default(),
            };
            manifest.set_note_lock(&notes::normalize_lock_path(&doc), lock.locked);
            writes.push(Write {
                doc: LOCKS_PATH.to_string(),
                ops: json!([{ "kind": "set_lock", "note": doc, "locked": lock.locked }]),
                before,
                after: notes::lock_manifest_to_json(&manifest)?,
                effect: ReviewEffect::Review,
            });
        }

        let seqs = self
            .commit_writes(&run.id, &run.actor, now, writes)
            .map_err(DocumentError::from)?;
        Ok(Applied {
            content: edit.content,
            version: edit.version,
            changed,
            note_lock: edit.note_lock,
            seq: changed.then(|| seqs[0]),
        })
    }

    /// Runs with changes nobody has kept or undone, oldest first.
    pub fn pending_reviews(&self) -> Result<Vec<RunReview>, PortError> {
        let mut runs: Vec<RunReview> = Vec::new();
        let mut docs: BTreeMap<(String, String), Vec<OpLogEntry>> = BTreeMap::new();
        let mut order: Vec<(String, String)> = Vec::new();
        for entry in self.log.unreviewed()? {
            let key = (entry.write.run_id.clone(), entry.write.doc.clone());
            if !docs.contains_key(&key) {
                order.push(key.clone());
            }
            docs.entry(key).or_default().push(entry);
        }
        for key in order {
            let entries = &docs[&key];
            let (first, last) = (&entries[0], &entries[entries.len() - 1]);
            let document = DocumentReview {
                doc: key.1.clone(),
                through_seq: last.seq,
                writes: entries.len() as u32,
                created: first.write.before_hash == ABSENT_HASH,
                last_at: timestamp(last.write.at),
            };
            match runs.iter_mut().find(|run| run.run_id == key.0) {
                Some(run) => run.documents.push(document),
                None => {
                    let run = self.log.run(&key.0)?;
                    runs.push(RunReview {
                        run_id: run.id,
                        actor: run.actor,
                        started_at: timestamp(run.started_at),
                        documents: vec![document],
                    });
                }
            }
        }
        Ok(runs)
    }

    /// Keeps `run_id`'s changes to `doc` up to `through_seq`, the
    /// [`DocumentReview`] token. Stale if the run wrote to `doc` since.
    pub fn keep(&self, run_id: &str, doc: &str, through_seq: u64) -> Result<(), ReviewError> {
        let doc = normalize(doc)?;
        let _guard = self.lock.acquire()?;
        self.reconcile_locked()?;
        self.reviewed_entries(run_id, &doc, through_seq)?;
        self.log
            .resolve(run_id, &doc, through_seq, Resolution::Kept)?;
        Ok(())
    }

    /// Reverts `run_id`'s changes to `doc` up to `through_seq`, keeping
    /// later edits by others where they don't overlap. The revert is itself
    /// a write in a `review` run, so it is logged and crash-safe.
    pub fn undo(&self, run_id: &str, doc: &str, through_seq: u64) -> Result<(), ReviewError> {
        let doc = normalize(doc)?;
        let _guard = self.lock.acquire()?;
        self.reconcile_locked()?;
        let entries = self.reviewed_entries(run_id, &doc, through_seq)?;
        let current = self.read(&doc)?;
        let content = if doc == LOCKS_PATH {
            undo_whole_file(current.as_deref(), &entries)?
        } else {
            self.undo_document(&doc, current.as_deref(), &entries)?
        };
        if content == current {
            self.log
                .resolve(run_id, &doc, through_seq, Resolution::Undone)?;
            return Ok(());
        }
        let Some(after) = content else {
            // Undoing a document the run created. Deletes aren't logged; a
            // crash before resolving leaves it up for review, and undoing
            // again finds it already gone.
            self.files.remove(Path::new(&doc))?;
            self.log
                .resolve(run_id, &doc, through_seq, Resolution::Undone)?;
            return Ok(());
        };
        let now = self.clock.now();
        let review_run = self.log.begin_run(REVIEW_ACTOR, now)?;
        self.commit_writes(
            &review_run,
            REVIEW_ACTOR,
            now,
            vec![Write {
                doc: doc.clone(),
                ops: json!([{ "kind": "undo_run", "run_id": run_id, "through_seq": through_seq }]),
                before: current,
                after,
                effect: ReviewEffect::Undo {
                    run_id: run_id.to_string(),
                    doc,
                    through_seq,
                },
            }],
        )?;
        Ok(())
    }

    /// The run's unresolved writes to `doc`, checking `through_seq` is the
    /// newest of them.
    fn reviewed_entries(
        &self,
        run_id: &str,
        doc: &str,
        through_seq: u64,
    ) -> Result<Vec<OpLogEntry>, ReviewError> {
        let entries: Vec<_> = self
            .log
            .entries_for_run(run_id)?
            .into_iter()
            .filter(|e| {
                e.write.doc == doc && e.state == OpLogState::Committed && e.resolution.is_none()
            })
            .collect();
        match entries.last() {
            Some(last) if last.seq == through_seq => Ok(entries),
            _ => Err(ReviewError::Stale),
        }
    }

    fn undo_document(
        &self,
        doc: &str,
        current: Option<&str>,
        entries: &[OpLogEntry],
    ) -> Result<Option<String>, ReviewError> {
        let kind = kind_of(doc)?;
        let writes = match entries
            .iter()
            .map(|e| e.write.images.clone())
            .collect::<Option<Vec<_>>>()
        {
            Some(images) => images
                .into_iter()
                .map(|images| UndoWrite {
                    before: images.before,
                    after: images.after,
                })
                .collect::<Vec<_>>(),
            None => return legacy_undo(current, entries),
        };
        let note_locked =
            kind == DocumentKind::Note && notes::get_note_lock(self.files, doc)?.locked;
        Ok(review::undo_document(kind, current, &writes, note_locked, self.clock.now())?.content)
    }

    /// Logs every write pending, replaces the files, then commits them. A
    /// crash in between is settled by [`Self::reconcile`], file by file.
    fn commit_writes(
        &self,
        run_id: &str,
        actor: &str,
        at: DateTime<Utc>,
        writes: Vec<Write>,
    ) -> Result<Vec<u64>, PortError> {
        let run_entries = if writes.is_empty() {
            Vec::new()
        } else {
            self.log.entries_for_run(run_id)?
        };
        let mut seqs = Vec::with_capacity(writes.len());
        for write in &writes {
            let first_write = !run_entries
                .iter()
                .any(|e| e.write.doc == write.doc && e.state == OpLogState::Committed);
            let baseline = first_write.then(|| match &write.before {
                Some(content) => Baseline::Content(content.clone()),
                None => Baseline::Absent,
            });
            seqs.push(
                self.log.append_pending(NewOpLogEntry {
                    run_id: run_id.to_string(),
                    doc: write.doc.clone(),
                    actor: actor.to_string(),
                    ops: write.ops.clone(),
                    before_hash: write
                        .before
                        .as_deref()
                        .map(|c| edit_ops::document_version(c.as_bytes()))
                        .unwrap_or_else(|| ABSENT_HASH.to_string()),
                    after_hash: edit_ops::document_version(write.after.as_bytes()),
                    at,
                    baseline,
                    images: Some(Images {
                        before: write.before.clone(),
                        after: Some(write.after.clone()),
                    }),
                    effect: if actor == USER_ACTOR {
                        ReviewEffect::AutoKeep
                    } else {
                        write.effect.clone()
                    },
                })?,
            );
        }
        for write in &writes {
            self.files
                .write_atomic(Path::new(&write.doc), write.after.as_bytes())?;
        }
        for seq in &seqs {
            self.log.commit(*seq)?;
        }
        Ok(seqs)
    }

    /// Settles writes interrupted by a crash: a pending entry whose document
    /// has its `after_hash` landed; any other didn't.
    pub fn reconcile(&self) -> Result<Reconciled, PortError> {
        let _guard = self.lock.acquire()?;
        self.reconcile_locked()
    }

    fn reconcile_locked(&self) -> Result<Reconciled, PortError> {
        let mut settled = Reconciled::default();
        for entry in self.log.pending()? {
            let on_disk = match self.files.read(Path::new(&entry.write.doc)) {
                Ok(bytes) => Some(edit_ops::document_version(&bytes)),
                Err(err) if err.kind == PortErrorKind::NotFound => None,
                Err(err) => return Err(err),
            };
            if on_disk.as_deref() == Some(entry.write.after_hash.as_str()) {
                self.log.commit(entry.seq)?;
                settled.committed.push(entry.seq);
            } else {
                self.log.abandon(entry.seq)?;
                settled.abandoned.push(entry.seq);
            }
        }
        Ok(settled)
    }

    fn read(&self, doc: &str) -> Result<Option<String>, DocumentError> {
        match self.files.read(Path::new(doc)) {
            // Matches std::fs::read_to_string: invalid UTF-8 is an I/O failure.
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
                DocumentError::Port(PortError::new(
                    PortErrorKind::Io,
                    "stream did not contain valid UTF-8",
                ))
            }),
            Err(err) if err.kind == PortErrorKind::NotFound => Ok(None),
            Err(err) => Err(err.into()),
        }
    }
}

/// Undo for writes logged before review kept images: only a clean revert to
/// the run's baseline, when nothing changed the document since.
fn legacy_undo(
    current: Option<&str>,
    entries: &[OpLogEntry],
) -> Result<Option<String>, ReviewError> {
    let on_disk = current.map(|c| edit_ops::document_version(c.as_bytes()));
    let chained = entries
        .windows(2)
        .all(|pair| pair[1].write.before_hash == pair[0].write.after_hash);
    let last = &entries[entries.len() - 1].write;
    let clean = chained && on_disk.as_deref() == Some(last.after_hash.as_str());
    match (&entries[0].write.baseline, clean) {
        (Some(Baseline::Content(content)), true) => Ok(Some(content.clone())),
        (Some(Baseline::Absent), true) => Ok(None),
        _ => Err(conflict(Some(last.after_hash.clone()), on_disk)),
    }
}

/// Files without entity structure (the lock manifest) undo only cleanly.
fn undo_whole_file(
    current: Option<&str>,
    entries: &[OpLogEntry],
) -> Result<Option<String>, ReviewError> {
    let images: Option<Vec<_>> = entries.iter().map(|e| e.write.images.clone()).collect();
    let Some(images) = images else {
        return legacy_undo(current, entries);
    };
    let chained = images
        .windows(2)
        .all(|pair| pair[1].before == pair[0].after);
    let last = images[images.len() - 1].after.as_deref();
    if chained && current == last {
        return Ok(images[0].before.clone());
    }
    let version = |c: Option<&str>| c.map(|c| edit_ops::document_version(c.as_bytes()));
    Err(conflict(version(last), version(current)))
}

fn conflict(expected: Option<String>, current: Option<String>) -> ReviewError {
    ReviewError::Undo(UndoError::Conflicts(vec![UndoConflict {
        path: String::new(),
        expected_version: expected,
        current_version: current,
    }]))
}

fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

/// The canonical project-relative form (`/`-separated) the op log keys on.
fn normalize(doc: &str) -> Result<String, DocumentError> {
    let path = project_relative(doc)?;
    let parts: Vec<_> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Ok(parts.join("/"))
}

fn starts_with_replacement(ops: &[Value]) -> bool {
    matches!(
        ops.first()
            .and_then(|op| op.get("kind"))
            .and_then(Value::as_str),
        Some("replace_sketch" | "replace_storyboard" | "replace_note")
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::document;
    use crate::models::sketch::Storyboard;
    use crate::testing::{FixedClock, MemoryFiles, MemoryLock, MemoryOpLog};
    use chrono::{TimeZone, Utc};
    use serde_json::json;

    struct Ports {
        files: MemoryFiles,
        lock: MemoryLock,
        log: MemoryOpLog,
        clock: FixedClock,
    }

    impl Ports {
        fn new() -> Self {
            Self {
                files: MemoryFiles::new(),
                lock: MemoryLock::default(),
                log: MemoryOpLog::default(),
                clock: FixedClock::new(Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap()),
            }
        }

        fn session(&self) -> EditSession<'_> {
            EditSession::new(&self.files, &self.lock, &self.log, &self.clock)
        }
    }

    fn note(content: &str) -> Value {
        json!({ "kind": "replace_note", "content": content })
    }

    fn version(content: &str) -> String {
        edit_ops::document_version(content.as_bytes())
    }

    #[test]
    fn writes_are_logged_with_the_baseline_on_the_runs_first_write_only() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("agent:writer").unwrap();

        let first = session
            .apply(&run, "plan.md", Expected::Absent, &[note("# A")])
            .unwrap();
        let second = session
            .apply(
                &run,
                "plan.md",
                Expected::Version(first.version.clone()),
                &[json!({ "kind": "write_note", "content": "# B" })],
            )
            .unwrap();

        assert_eq!(ports.files.read(Path::new("plan.md")).unwrap(), b"# B");
        let entries = ports.log.entries_for_run(&run).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.state == OpLogState::Committed));
        assert_eq!(entries[0].seq, first.seq.unwrap());
        assert_eq!(entries[1].seq, second.seq.unwrap());
        assert_eq!(entries[0].write.actor, "agent:writer");
        assert_eq!(entries[0].write.baseline, Some(Baseline::Absent));
        assert_eq!(entries[0].write.before_hash, ABSENT_HASH);
        assert_eq!(entries[0].write.after_hash, version("# A"));
        assert_eq!(entries[1].write.baseline, None);
        assert_eq!(entries[1].write.before_hash, version("# A"));
        assert_eq!(entries[1].write.after_hash, version("# B"));

        // A second run on the same doc records its own baseline.
        let other = session.begin_run("user").unwrap();
        session
            .apply(&other, "plan.md", Expected::Unchecked, &[note("# C")])
            .unwrap();
        assert_eq!(
            ports.log.entries_for_run(&other).unwrap()[0].write.baseline,
            Some(Baseline::Content("# B".into()))
        );
    }

    #[test]
    fn unchanged_bytes_are_neither_written_nor_logged() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("user").unwrap();
        session
            .apply(&run, "plan.md", Expected::Absent, &[note("# A")])
            .unwrap();

        let same = session
            .apply(&run, "plan.md", Expected::Unchecked, &[note("# A")])
            .unwrap();

        assert!(!same.changed);
        assert_eq!(same.seq, None);
        assert_eq!(ports.log.entries_for_run(&run).unwrap().len(), 1);
    }

    #[test]
    fn a_stale_version_is_rejected_before_anything_is_logged_or_written() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("user").unwrap();
        session
            .apply(&run, "plan.md", Expected::Absent, &[note("# A")])
            .unwrap();
        let stale = version("# old");

        let err = session
            .apply(&run, "plan.md", Expected::Version(stale), &[note("# B")])
            .unwrap_err();
        assert!(matches!(
            err,
            ContentEditError::Stale(ref s) if s.current_version.as_deref() == Some(version("# A").as_str())
        ));
        let err = session
            .apply(&run, "plan.md", Expected::Absent, &[note("# B")])
            .unwrap_err();
        assert!(matches!(err, ContentEditError::Stale(_)));

        assert_eq!(ports.files.read(Path::new("plan.md")).unwrap(), b"# A");
        assert_eq!(ports.log.entries_for_run(&run).unwrap().len(), 1);
    }

    #[test]
    fn unchecked_edits_to_a_missing_document_need_a_replacement() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("user").unwrap();

        let err = session
            .apply(
                &run,
                "gone.md",
                Expected::Unchecked,
                &[json!({ "kind": "write_note", "content": "x" })],
            )
            .unwrap_err();

        assert!(matches!(
            err,
            ContentEditError::Document(DocumentError::Port(PortError {
                kind: PortErrorKind::NotFound,
                ..
            }))
        ));
        assert!(ports.log.entries_for_run(&run).unwrap().is_empty());
    }

    #[test]
    fn writes_need_a_known_run() {
        let ports = Ports::new();
        let err = ports
            .session()
            .apply("run-9", "plan.md", Expected::Absent, &[note("# A")])
            .unwrap_err();
        assert!(matches!(
            err,
            ContentEditError::Document(DocumentError::Port(PortError {
                kind: PortErrorKind::NotFound,
                ..
            }))
        ));
        assert!(!ports.files.exists(Path::new("plan.md")).unwrap());
    }

    #[test]
    fn crash_recovery_commits_writes_that_landed_and_abandons_the_rest() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("agent:writer").unwrap();
        session
            .apply(&run, "a.md", Expected::Absent, &[note("# A")])
            .unwrap();
        let pending = |doc: &str, after: &str, baseline| NewOpLogEntry {
            run_id: run.clone(),
            doc: doc.into(),
            actor: "agent:writer".into(),
            ops: json!([]),
            before_hash: ABSENT_HASH.into(),
            after_hash: version(after),
            at: ports.clock.now(),
            baseline,
            images: None,
            effect: ReviewEffect::Review,
        };
        // Crashed after the write landed, before commit.
        let landed = ports
            .log
            .append_pending(pending("a.md", "# A2", None))
            .unwrap();
        ports
            .files
            .write_atomic(Path::new("a.md"), b"# A2")
            .unwrap();
        // Crashed before the write landed.
        let lost = ports
            .log
            .append_pending(pending("b.md", "# B", Some(Baseline::Absent)))
            .unwrap();

        let settled = session.reconcile().unwrap();

        assert_eq!(settled.committed, vec![landed]);
        assert_eq!(settled.abandoned, vec![lost]);
        assert!(ports.log.pending().unwrap().is_empty());
        assert_eq!(session.reconcile().unwrap(), Reconciled::default());

        // The abandoned write's baseline doesn't count: the run's next write
        // to b.md records it again.
        session
            .apply(&run, "b.md", Expected::Absent, &[note("# B")])
            .unwrap();
        let entries = ports.log.entries_for_run(&run).unwrap();
        let last = entries.last().unwrap();
        assert_eq!(
            (last.write.doc.as_str(), last.state),
            ("b.md", OpLogState::Committed)
        );
        assert_eq!(last.write.baseline, Some(Baseline::Absent));
    }

    #[test]
    fn apply_reconciles_before_writing() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("user").unwrap();
        let lost = ports
            .log
            .append_pending(NewOpLogEntry {
                run_id: run.clone(),
                doc: "a.md".into(),
                actor: "user".into(),
                ops: json!([]),
                before_hash: ABSENT_HASH.into(),
                after_hash: version("# never"),
                at: ports.clock.now(),
                baseline: Some(Baseline::Absent),
                images: None,
                effect: ReviewEffect::Review,
            })
            .unwrap();

        session
            .apply(&run, "a.md", Expected::Absent, &[note("# A")])
            .unwrap();

        let entries = ports.log.entries_for_run(&run).unwrap();
        assert_eq!(entries[0].seq, lost);
        assert_eq!(entries[0].state, OpLogState::Abandoned);
        assert_eq!(entries[1].state, OpLogState::Committed);
    }

    #[test]
    fn concurrent_writers_are_serialized_by_the_lock() {
        let ports = Ports::new();
        let setup = ports.session();
        let run = setup.begin_run("user").unwrap();
        let board = Storyboard::new("Board", ports.clock.now());
        setup
            .apply(
                &run,
                "demo.sb",
                Expected::Absent,
                &[json!({ "kind": "replace_storyboard", "storyboard": serde_json::to_value(&board).unwrap() })],
            )
            .unwrap();
        const WRITES: usize = 20;

        let runs: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..2)
                .map(|writer| {
                    let ports = &ports;
                    scope.spawn(move || {
                        let session = ports.session();
                        let run = session.begin_run(&format!("agent:{writer}")).unwrap();
                        for i in 0..WRITES {
                            let item = json!({ "type": "sketch_ref", "path": format!("w{writer}-{i}.sk") });
                            session
                                .apply(
                                    &run,
                                    "demo.sb",
                                    Expected::Unchecked,
                                    &[json!({ "kind": "insert_storyboard_item", "index": null, "item": item })],
                                )
                                .unwrap();
                        }
                        run
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        let bytes = ports.files.read(Path::new("demo.sb")).unwrap();
        let (saved, _) =
            document::storyboard_from_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
        assert_eq!(saved.items.len(), 2 * WRITES);

        // Every write started from the bytes the previous one left.
        let mut entries: Vec<_> = runs
            .iter()
            .flat_map(|run| ports.log.entries_for_run(run).unwrap())
            .collect();
        entries.sort_by_key(|e| e.seq);
        assert_eq!(entries.len(), 2 * WRITES);
        for pair in entries.windows(2) {
            assert_eq!(pair[1].write.before_hash, pair[0].write.after_hash);
        }
        assert_eq!(
            entries.last().unwrap().write.after_hash,
            edit_ops::document_version(&bytes)
        );
    }

    #[test]
    fn note_locks_are_enforced_and_saved_to_the_manifest() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("user").unwrap();
        session
            .apply(&run, "plan.md", Expected::Absent, &[note("# A")])
            .unwrap();

        let locked = session
            .apply(
                &run,
                "plan.md",
                Expected::Unchecked,
                &[json!({ "kind": "set_lock", "locked": true })],
            )
            .unwrap();

        assert_eq!(
            locked.note_lock,
            Some(NoteLock {
                locked: true,
                changed: true
            })
        );
        assert_eq!(locked.seq, None);
        assert!(
            notes::get_note_lock(&ports.files, "plan.md")
                .unwrap()
                .locked
        );
        // The manifest change is part of the run, with its own baseline.
        let manifest = ports.log.entries_for_run(&run).unwrap().pop().unwrap();
        assert_eq!(manifest.write.doc, LOCKS_PATH);
        assert_eq!(manifest.state, OpLogState::Committed);
        assert_eq!(manifest.write.baseline, Some(Baseline::Absent));
        assert_eq!(
            manifest.write.ops,
            json!([{ "kind": "set_lock", "note": "plan.md", "locked": true }])
        );
        let err = session
            .apply(
                &run,
                "plan.md",
                Expected::Unchecked,
                &[json!({ "kind": "write_note", "content": "# B" })],
            )
            .unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        assert_eq!(ports.files.read(Path::new("plan.md")).unwrap(), b"# A");
    }

    #[test]
    fn ignoring_note_locks_replaces_a_locked_note_and_leaves_the_manifest() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("user").unwrap();
        session
            .apply(&run, "plan.md", Expected::Absent, &[note("# A")])
            .unwrap();
        notes::set_note_lock(&ports.files, "plan.md", true).unwrap();

        let applied = session
            .apply_with(
                &run,
                "plan.md",
                Expected::Unchecked,
                &[note("# Imported")],
                NoteLockPolicy::Ignore,
            )
            .unwrap();

        assert!(applied.changed);
        assert_eq!(
            ports.files.read(Path::new("plan.md")).unwrap(),
            b"# Imported"
        );
        assert!(
            notes::get_note_lock(&ports.files, "plan.md")
                .unwrap()
                .locked
        );
        assert!(ports
            .log
            .entries_for_run(&run)
            .unwrap()
            .iter()
            .all(|e| e.write.doc == "plan.md"));
    }

    #[test]
    fn documents_are_keyed_by_their_normalized_path() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("user").unwrap();
        session
            .apply(&run, "notes/./a.md", Expected::Absent, &[note("# A")])
            .unwrap();
        session
            .apply(&run, "notes\\a.md", Expected::Unchecked, &[note("# B")])
            .unwrap();

        let entries = ports.log.entries_for_run(&run).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|e| e.write.doc.as_str())
                .collect::<Vec<_>>(),
            vec!["notes/a.md", "notes/a.md"]
        );
        assert_eq!(entries[1].write.baseline, None);
    }

    #[test]
    fn only_project_documents_inside_the_project_are_written() {
        let ports = Ports::new();
        let session = ports.session();
        let run = session.begin_run("user").unwrap();
        for doc in ["notes.txt", "../outside.md", "/abs.md"] {
            let err = session
                .apply(&run, doc, Expected::Absent, &[note("# A")])
                .unwrap_err();
            assert!(
                matches!(
                    err,
                    ContentEditError::Document(DocumentError::Port(PortError {
                        kind: PortErrorKind::InvalidPath,
                        ..
                    }))
                ),
                "{doc}: {err:?}"
            );
        }
        assert!(ports.log.entries_for_run(&run).unwrap().is_empty());
    }

    fn read(ports: &Ports, doc: &str) -> Option<String> {
        ports
            .files
            .read(Path::new(doc))
            .ok()
            .map(|b| String::from_utf8(b).unwrap())
    }

    fn review_of(session: &EditSession<'_>, run: &str, doc: &str) -> Option<DocumentReview> {
        session
            .pending_reviews()
            .unwrap()
            .into_iter()
            .find(|r| r.run_id == run)
            .and_then(|r| r.documents.into_iter().find(|d| d.doc == doc))
    }

    #[test]
    fn user_writes_are_kept_and_agent_writes_await_review() {
        let ports = Ports::new();
        let session = ports.session();
        let user = session.begin_run(USER_ACTOR).unwrap();
        let agent = session.begin_run("agent").unwrap();
        session
            .apply(&user, "a.md", Expected::Absent, &[note("# A")])
            .unwrap();
        session
            .apply(&agent, "a.md", Expected::Unchecked, &[note("# A1")])
            .unwrap();
        let last = session
            .apply(&agent, "a.md", Expected::Unchecked, &[note("# A2")])
            .unwrap();
        session
            .apply(&agent, "b.md", Expected::Absent, &[note("# B")])
            .unwrap();

        let reviews = session.pending_reviews().unwrap();
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0].actor, "agent");
        assert_eq!(reviews[0].started_at, "2026-01-02T03:04:05Z");
        let docs = &reviews[0].documents;
        assert_eq!(
            docs.iter()
                .map(|d| (d.doc.as_str(), d.writes, d.created, d.through_seq))
                .collect::<Vec<_>>(),
            vec![("a.md", 2, false, last.seq.unwrap()), ("b.md", 1, true, 4)]
        );
        assert_eq!(docs[0].last_at, "2026-01-02T03:04:05Z");
    }

    #[test]
    fn keep_resolves_only_the_reviewed_writes() {
        let ports = Ports::new();
        let session = ports.session();
        let agent = session.begin_run("agent").unwrap();
        let first = session
            .apply(&agent, "a.md", Expected::Absent, &[note("# A")])
            .unwrap();
        let second = session
            .apply(&agent, "a.md", Expected::Unchecked, &[note("# A2")])
            .unwrap();

        assert_eq!(
            session.keep(&agent, "a.md", first.seq.unwrap()),
            Err(ReviewError::Stale)
        );
        assert_eq!(
            CmdError::try_from(&ReviewError::Stale).unwrap().code,
            CmdErrorCode::StaleReview
        );
        session.keep(&agent, "./a.md", second.seq.unwrap()).unwrap();
        assert!(session.pending_reviews().unwrap().is_empty());
        assert_eq!(
            session.keep(&agent, "a.md", second.seq.unwrap()),
            Err(ReviewError::Stale)
        );
        assert_eq!(read(&ports, "a.md").as_deref(), Some("# A2"));

        // The run's next write is a new review; undo stops at the kept state.
        let third = session
            .apply(&agent, "a.md", Expected::Unchecked, &[note("# A3")])
            .unwrap();
        session.undo(&agent, "a.md", third.seq.unwrap()).unwrap();
        assert_eq!(read(&ports, "a.md").as_deref(), Some("# A2"));
    }

    #[test]
    fn undo_reverts_through_a_logged_review_run() {
        let ports = Ports::new();
        let session = ports.session();
        let user = session.begin_run(USER_ACTOR).unwrap();
        session
            .apply(&user, "a.md", Expected::Absent, &[note("# A")])
            .unwrap();
        let agent = session.begin_run("agent").unwrap();
        session
            .apply(&agent, "a.md", Expected::Unchecked, &[note("# A1")])
            .unwrap();
        let last = session
            .apply(&agent, "a.md", Expected::Unchecked, &[note("# A2")])
            .unwrap();

        session.undo(&agent, "a.md", last.seq.unwrap()).unwrap();

        assert_eq!(read(&ports, "a.md").as_deref(), Some("# A"));
        assert!(session.pending_reviews().unwrap().is_empty());
        let resolutions: Vec<_> = ports
            .log
            .entries_for_run(&agent)
            .unwrap()
            .iter()
            .map(|e| e.resolution)
            .collect();
        assert_eq!(resolutions, vec![Some(Resolution::Undone); 2]);
        let review = ports.log.entries_for_run("run-3").unwrap();
        assert_eq!(ports.log.run("run-3").unwrap().actor, REVIEW_ACTOR);
        assert_eq!(review.len(), 1);
        assert_eq!(review[0].resolution, Some(Resolution::Kept));
        assert_eq!(
            review[0].write.images,
            Some(Images {
                before: Some("# A2".into()),
                after: Some("# A".into())
            })
        );
    }

    #[test]
    fn undo_keeps_later_edits_by_others() {
        let ports = Ports::new();
        let session = ports.session();
        let user = session.begin_run(USER_ACTOR).unwrap();
        let board = Storyboard::new("Story", ports.clock.now());
        session
            .apply(
                &user,
                "s.sb",
                Expected::Absent,
                &[json!({ "kind": "replace_storyboard", "storyboard": serde_json::to_value(&board).unwrap() })],
            )
            .unwrap();
        let agent = session.begin_run("agent").unwrap();
        let inserted = session
            .apply(
                &agent,
                "s.sb",
                Expected::Unchecked,
                &[json!({ "kind": "insert_storyboard_item", "index": null, "item": { "type": "sketch_ref", "path": "a.sk" } })],
            )
            .unwrap();
        let mut renamed: Storyboard = serde_json::from_str(&read(&ports, "s.sb").unwrap()).unwrap();
        renamed.title = "Renamed".into();
        session
            .apply(
                &user,
                "s.sb",
                Expected::Unchecked,
                &[json!({ "kind": "replace_storyboard", "storyboard": serde_json::to_value(&renamed).unwrap() })],
            )
            .unwrap();

        session.undo(&agent, "s.sb", inserted.seq.unwrap()).unwrap();

        let after: Storyboard = serde_json::from_str(&read(&ports, "s.sb").unwrap()).unwrap();
        assert_eq!(after.title, "Renamed");
        assert!(after.items.is_empty());
    }

    #[test]
    fn undoing_a_created_document_deletes_it() {
        let ports = Ports::new();
        let session = ports.session();
        let agent = session.begin_run("agent").unwrap();
        let created = session
            .apply(&agent, "new.md", Expected::Absent, &[note("# New")])
            .unwrap();
        session
            .undo(&agent, "new.md", created.seq.unwrap())
            .unwrap();
        assert_eq!(read(&ports, "new.md"), None);
        assert!(session.pending_reviews().unwrap().is_empty());
    }

    #[test]
    fn a_conflicting_undo_changes_nothing() {
        let ports = Ports::new();
        let session = ports.session();
        let agent = session.begin_run("agent").unwrap();
        let created = session
            .apply(&agent, "a.md", Expected::Absent, &[note("# A")])
            .unwrap();
        let user = session.begin_run(USER_ACTOR).unwrap();
        session
            .apply(&user, "a.md", Expected::Unchecked, &[note("# Mine")])
            .unwrap();

        let err = session
            .undo(&agent, "a.md", created.seq.unwrap())
            .unwrap_err();
        assert_eq!(
            CmdError::try_from(&err).unwrap().code,
            CmdErrorCode::UndoConflict
        );
        assert_eq!(read(&ports, "a.md").as_deref(), Some("# Mine"));
        assert!(review_of(&session, &agent, "a.md").is_some());
    }

    #[test]
    fn a_locked_note_cannot_be_undone() {
        let ports = Ports::new();
        let session = ports.session();
        let user = session.begin_run(USER_ACTOR).unwrap();
        session
            .apply(&user, "a.md", Expected::Absent, &[note("# A")])
            .unwrap();
        let agent = session.begin_run("agent").unwrap();
        let edited = session
            .apply(&agent, "a.md", Expected::Unchecked, &[note("# A1")])
            .unwrap();
        session
            .apply(
                &user,
                "a.md",
                Expected::Unchecked,
                &[json!({ "kind": "set_lock", "locked": true })],
            )
            .unwrap();

        let err = session
            .undo(&agent, "a.md", edited.seq.unwrap())
            .unwrap_err();
        assert_eq!(err, ReviewError::Undo(UndoError::LockedNote));
        assert_eq!(read(&ports, "a.md").as_deref(), Some("# A1"));
    }

    #[test]
    fn an_agents_lock_change_is_its_own_review() {
        let ports = Ports::new();
        let session = ports.session();
        let user = session.begin_run(USER_ACTOR).unwrap();
        session
            .apply(&user, "a.md", Expected::Absent, &[note("# A")])
            .unwrap();
        let before = read(&ports, LOCKS_PATH);
        let agent = session.begin_run("agent").unwrap();
        session
            .apply(
                &agent,
                "a.md",
                Expected::Unchecked,
                &[json!({ "kind": "set_lock", "locked": true })],
            )
            .unwrap();
        let review = review_of(&session, &agent, LOCKS_PATH).unwrap();
        assert!(review_of(&session, &agent, "a.md").is_none());

        session
            .undo(&agent, LOCKS_PATH, review.through_seq)
            .unwrap();
        assert_eq!(read(&ports, LOCKS_PATH), before);
        assert!(session.pending_reviews().unwrap().is_empty());
    }

    #[test]
    fn writes_logged_before_review_undo_only_cleanly() {
        let ports = Ports::new();
        let session = ports.session();
        let agent = session.begin_run("agent").unwrap();
        ports.files.write_atomic(Path::new("a.md"), b"# A").unwrap();
        let legacy = |before: &str, after: &str, baseline| NewOpLogEntry {
            run_id: agent.clone(),
            doc: "a.md".into(),
            actor: "agent".into(),
            ops: json!([]),
            before_hash: version(before),
            after_hash: version(after),
            at: ports.clock.now(),
            baseline,
            images: None,
            effect: ReviewEffect::Review,
        };
        let seq = ports
            .log
            .append_pending(legacy(
                "# Base",
                "# A",
                Some(Baseline::Content("# Base".into())),
            ))
            .unwrap();
        ports.log.commit(seq).unwrap();

        ports
            .files
            .write_atomic(Path::new("a.md"), b"# Other")
            .unwrap();
        assert!(matches!(
            session.undo(&agent, "a.md", seq),
            Err(ReviewError::Undo(UndoError::Conflicts(_)))
        ));
        ports.files.write_atomic(Path::new("a.md"), b"# A").unwrap();
        session.undo(&agent, "a.md", seq).unwrap();
        assert_eq!(read(&ports, "a.md").as_deref(), Some("# Base"));
    }
}
