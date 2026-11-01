//! The write transaction every host uses for project documents: lock,
//! reconcile, edit, log pending, write, commit. Documents are the truth; the
//! op log records which run wrote what so review can diff, keep or undo it.

use std::path::Path;

use serde_json::Value;

use crate::contracts::DocumentKind;
use crate::document::DocumentError;
use crate::edit_ops::{self, ContentEditError, NoteLock};
use crate::notes;
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

/// A write's outcome. `seq` is the op-log entry, `None` when the bytes didn't
/// change (nothing is logged or written).
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

    /// Applies `ops` to the project-relative `doc` as part of `run_id`.
    ///
    /// Holds the project lock for the whole transaction. Hosts whose callers
    /// already hold it must make [`Lock::acquire`] reentrant per thread.
    pub fn apply(
        &self,
        run_id: &str,
        doc: &str,
        kind: DocumentKind,
        expected: Expected,
        ops: &[Value],
    ) -> Result<Applied, ContentEditError> {
        let _guard = self.lock.acquire().map_err(DocumentError::from)?;
        self.reconcile_locked().map_err(DocumentError::from)?;
        let run = self.log.run(run_id).map_err(DocumentError::from)?;
        let path = Path::new(doc);
        let current = self.read(path)?;
        let expected_version = match expected {
            Expected::Version(version) => Some(version),
            Expected::Absent => None,
            Expected::Unchecked => match &current {
                Some(content) => Some(edit_ops::document_version(content.as_bytes())),
                None if starts_with_replacement(ops) => None,
                None => {
                    return Err(DocumentError::from(PortError::new(
                        PortErrorKind::NotFound,
                        doc.to_string(),
                    ))
                    .into())
                }
            },
        };
        let note_locked = match kind {
            DocumentKind::Note => notes::get_note_lock(self.files, doc)?.locked,
            _ => false,
        };
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
        let mut seq = None;
        if changed {
            let first_write = !self
                .log
                .entries_for_run(run_id)
                .map_err(DocumentError::from)?
                .iter()
                .any(|e| e.write.doc == doc && e.state == OpLogState::Committed);
            let baseline = first_write.then(|| match &current {
                Some(content) => Baseline::Content(content.clone()),
                None => Baseline::Absent,
            });
            let entry = NewOpLogEntry {
                run_id: run.id,
                doc: doc.to_string(),
                actor: run.actor,
                ops: Value::Array(ops.to_vec()),
                before_hash: current
                    .as_deref()
                    .map(|c| edit_ops::document_version(c.as_bytes()))
                    .unwrap_or_else(|| ABSENT_HASH.to_string()),
                after_hash: edit.version.clone(),
                at: now,
                baseline,
            };
            let logged = self
                .log
                .append_pending(entry)
                .map_err(DocumentError::from)?;
            self.files
                .write_atomic(path, edit.content.as_bytes())
                .map_err(DocumentError::from)?;
            self.log.commit(logged).map_err(DocumentError::from)?;
            seq = Some(logged);
        }
        if let Some(note_lock) = edit.note_lock.filter(|lock| lock.changed) {
            notes::set_note_lock(self.files, doc, note_lock.locked)?;
        }
        Ok(Applied {
            content: edit.content,
            version: edit.version,
            changed,
            note_lock: edit.note_lock,
            seq,
        })
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

    fn read(&self, path: &Path) -> Result<Option<String>, DocumentError> {
        match self.files.read(path) {
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
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
                Expected::Absent,
                &[note("# A")],
            )
            .unwrap();
        let second = session
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
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
            .apply(
                &other,
                "plan.md",
                DocumentKind::Note,
                Expected::Unchecked,
                &[note("# C")],
            )
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
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
                Expected::Absent,
                &[note("# A")],
            )
            .unwrap();

        let same = session
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
                Expected::Unchecked,
                &[note("# A")],
            )
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
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
                Expected::Absent,
                &[note("# A")],
            )
            .unwrap();
        let stale = version("# old");

        let err = session
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
                Expected::Version(stale),
                &[note("# B")],
            )
            .unwrap_err();
        assert!(matches!(
            err,
            ContentEditError::Stale(ref s) if s.current_version.as_deref() == Some(version("# A").as_str())
        ));
        let err = session
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
                Expected::Absent,
                &[note("# B")],
            )
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
                DocumentKind::Note,
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
            .apply(
                "run-9",
                "plan.md",
                DocumentKind::Note,
                Expected::Absent,
                &[note("# A")],
            )
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
            .apply(
                &run,
                "a.md",
                DocumentKind::Note,
                Expected::Absent,
                &[note("# A")],
            )
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
            .apply(
                &run,
                "b.md",
                DocumentKind::Note,
                Expected::Absent,
                &[note("# B")],
            )
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
            .apply(
                &run,
                "a.md",
                DocumentKind::Note,
                Expected::Absent,
                &[note("# A")],
            )
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
                DocumentKind::Storyboard,
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
                                    DocumentKind::Storyboard,
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
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
                Expected::Absent,
                &[note("# A")],
            )
            .unwrap();

        let locked = session
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
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
        let err = session
            .apply(
                &run,
                "plan.md",
                DocumentKind::Note,
                Expected::Unchecked,
                &[json!({ "kind": "write_note", "content": "# B" })],
            )
            .unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        assert_eq!(ports.files.read(Path::new("plan.md")).unwrap(), b"# A");
    }
}
