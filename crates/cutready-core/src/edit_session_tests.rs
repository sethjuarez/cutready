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
    let (saved, _) = document::storyboard_from_json(std::str::from_utf8(&bytes).unwrap()).unwrap();
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

fn rebase_sketch(rows: &[(&str, &str)]) -> String {
    use crate::models::sketch::{PlanningRow, Sketch};
    let mut sketch = Sketch::new("Rebase", Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap());
    sketch.rows = rows
        .iter()
        .map(|(id, narrative)| {
            let mut row = PlanningRow::new();
            row.id = id.to_string();
            row.narrative = narrative.to_string();
            row
        })
        .collect();
    serde_json::to_string_pretty(&sketch).unwrap()
}

fn set_text(row: &str, narrative: &str) -> Value {
    json!({ "kind": "set_row_text", "row_id": row, "narrative": narrative })
}

/// The app holds `base`; a CLI run then edits row `cli_row`.
fn cli_edit_after_base(ports: &Ports, cli_row: &str) -> String {
    let session = ports.session();
    let base = rebase_sketch(&[("a", "A"), ("b", "B")]);
    ports
        .files
        .write_atomic(Path::new("s.sk"), base.as_bytes())
        .unwrap();
    let cli = session.begin_run("cli").unwrap();
    session
        .apply(
            &cli,
            "s.sk",
            Expected::Version(version(&base)),
            &[set_text(cli_row, "CLI")],
        )
        .unwrap();
    base
}

fn narratives(ports: &Ports) -> Vec<String> {
    let sketch = document::sketch_from_json(&read(ports, "s.sk").unwrap()).unwrap();
    sketch.rows.into_iter().map(|row| row.narrative).collect()
}

#[test]
fn a_rebased_save_on_an_unchanged_file_applies_its_ops() {
    let ports = Ports::new();
    let session = ports.session();
    let base = rebase_sketch(&[("a", "A"), ("b", "B")]);
    ports
        .files
        .write_atomic(Path::new("s.sk"), base.as_bytes())
        .unwrap();
    let user = session.begin_run(USER_ACTOR).unwrap();
    let direct = edit_ops::edit_document(
        DocumentKind::Sketch,
        Some(&base),
        Some(&version(&base)),
        &[set_text("a", "Mine")],
        ports.clock.now(),
        false,
    )
    .unwrap();

    let saved = session
        .apply_rebased(
            &user,
            "s.sk",
            &version(&base),
            &base,
            &[set_text("a", "Mine")],
        )
        .unwrap();

    assert!(!saved.merged);
    assert_eq!(saved.applied.content, direct.content);
    assert_eq!(read(&ports, "s.sk").unwrap(), direct.content);
}

#[test]
fn a_cli_edit_to_another_row_is_kept_when_the_app_saves() {
    let ports = Ports::new();
    let session = ports.session();
    let base = cli_edit_after_base(&ports, "b");
    let user = session.begin_run(USER_ACTOR).unwrap();

    let saved = session
        .apply_rebased(
            &user,
            "s.sk",
            &version(&base),
            &base,
            &[set_text("a", "Mine")],
        )
        .unwrap();

    assert!(saved.merged && saved.applied.changed);
    assert_eq!(narratives(&ports), ["Mine", "CLI"]);
    assert_eq!(
        saved.applied.version,
        version(&read(&ports, "s.sk").unwrap())
    );
    let entry = &ports.log.entries_for_run(&user).unwrap()[0];
    assert_eq!(entry.write.after_hash, saved.applied.version);
    assert_eq!(entry.write.ops[0]["kind"], "rebase");
}

#[test]
fn a_cli_edit_to_the_same_row_makes_the_app_save_stale() {
    let ports = Ports::new();
    let session = ports.session();
    let base = cli_edit_after_base(&ports, "a");
    let on_disk = read(&ports, "s.sk").unwrap();
    let user = session.begin_run(USER_ACTOR).unwrap();

    let err = session
        .apply_rebased(
            &user,
            "s.sk",
            &version(&base),
            &base,
            &[set_text("a", "Mine")],
        )
        .unwrap_err();

    let RebaseError::Stale {
        current_version,
        conflicts,
    } = &err
    else {
        panic!("expected stale: {err:?}");
    };
    assert_eq!(current_version.as_deref(), Some(version(&on_disk).as_str()));
    assert_eq!(conflicts[0].path, "/rows/a");
    assert_eq!(
        CmdError::try_from(&err).unwrap().code,
        CmdErrorCode::StaleDocument
    );
    assert_eq!(read(&ports, "s.sk").unwrap(), on_disk);
    assert!(ports.log.entries_for_run(&user).unwrap().is_empty());
}

#[test]
fn the_same_change_on_both_sides_is_not_a_conflict() {
    let ports = Ports::new();
    let session = ports.session();
    let base = cli_edit_after_base(&ports, "a");
    let on_disk = read(&ports, "s.sk").unwrap();
    let user = session.begin_run(USER_ACTOR).unwrap();

    let saved = session
        .apply_rebased(
            &user,
            "s.sk",
            &version(&base),
            &base,
            &[set_text("a", "CLI")],
        )
        .unwrap();

    assert!(saved.merged && !saved.applied.changed);
    assert_eq!(read(&ports, "s.sk").unwrap(), on_disk);
}

#[test]
fn a_note_changed_on_both_sides_conflicts() {
    let ports = Ports::new();
    let session = ports.session();
    let user = session.begin_run(USER_ACTOR).unwrap();
    session
        .apply(&user, "n.md", Expected::Absent, &[note("# Base")])
        .unwrap();
    let cli = session.begin_run("cli").unwrap();
    session
        .apply(
            &cli,
            "n.md",
            Expected::Version(version("# Base")),
            &[note("# CLI")],
        )
        .unwrap();

    let err = session
        .apply_rebased(
            &user,
            "n.md",
            &version("# Base"),
            "# Base",
            &[json!({ "kind": "write_note", "content": "# Mine" })],
        )
        .unwrap_err();

    assert!(matches!(err, RebaseError::Stale { ref conflicts, .. } if !conflicts.is_empty()));
    assert_eq!(read(&ports, "n.md").as_deref(), Some("# CLI"));
}

#[test]
fn a_base_that_isnt_the_expected_version_is_rejected() {
    let ports = Ports::new();
    let session = ports.session();
    let base = rebase_sketch(&[("a", "A")]);
    ports
        .files
        .write_atomic(Path::new("s.sk"), base.as_bytes())
        .unwrap();
    let user = session.begin_run(USER_ACTOR).unwrap();

    let err = session
        .apply_rebased(
            &user,
            "s.sk",
            &version(&base),
            "{}",
            &[set_text("a", "Mine")],
        )
        .unwrap_err();

    assert!(matches!(err, RebaseError::Stale { .. }));
    assert_eq!(read(&ports, "s.sk").unwrap(), base);
}

#[test]
fn a_merge_that_would_break_a_lock_is_rejected() {
    let ports = Ports::new();
    let session = ports.session();
    let base = rebase_sketch(&[("a", "A"), ("b", "B")]);
    ports
        .files
        .write_atomic(Path::new("s.sk"), base.as_bytes())
        .unwrap();
    let cli = session.begin_run("cli").unwrap();
    session
        .apply(
            &cli,
            "s.sk",
            Expected::Version(version(&base)),
            &[json!({ "kind": "set_lock", "row_id": "a", "locked": true })],
        )
        .unwrap();
    let on_disk = read(&ports, "s.sk").unwrap();
    let user = session.begin_run(USER_ACTOR).unwrap();

    let err = session
        .apply_rebased(
            &user,
            "s.sk",
            &version(&base),
            &base,
            &[set_text("a", "Mine")],
        )
        .unwrap_err();

    assert!(matches!(err, RebaseError::Stale { .. }), "{err:?}");
    assert_eq!(read(&ports, "s.sk").unwrap(), on_disk);
}
