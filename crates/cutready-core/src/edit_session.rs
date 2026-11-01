//! The write transaction every host uses for project documents: lock,
//! reconcile, edit, log pending, write, commit. Documents are the truth; the
//! op log records which run wrote what so review can diff, keep or undo it.

use std::path::Path;

use serde_json::{json, Value};

use crate::contracts::DocumentKind;
use crate::document::DocumentError;
use crate::edit_ops::{self, ContentEditError, NoteLock};
use crate::notes::{self, LOCKS_PATH};
use crate::path::project_relative;
use crate::ports::{
    Baseline, Clock, Files, Lock, NewOpLogEntry, OpLogState, OpLogStore, PortError, PortErrorKind,
};

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

    /// Logs every write pending, replaces the files, then commits them. A
    /// crash in between is settled by [`Self::reconcile`], file by file.
    fn commit_writes(
        &self,
        run_id: &str,
        actor: &str,
        at: chrono::DateTime<chrono::Utc>,
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
}
