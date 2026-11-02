use super::*;
use crate::commands::CmdError;
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

/// A sketch with rows `a` and `b`, as the app loaded it: (text, version).
fn opened_sketch(root: &Path) -> (String, String) {
    let mut sketch = Sketch::new("Intro", chrono::Utc::now());
    for id in ["a", "b"] {
        let mut row = PlanningRow::new();
        row.id = id.into();
        sketch.rows.push(row);
    }
    let written = replace_sketch(root, &root.join("intro.sk"), &sketch).unwrap();
    (written.content, written.version)
}

/// The CLI's edit: its own op-log run, checked against the file it read.
fn cli_edit(root: &Path, doc: &str, ops: &[Value]) {
    let ports = Ports::open(root).unwrap();
    let session = ports.session();
    let run = session.begin_run("cli").unwrap();
    let version = edit_ops::document_version(&std::fs::read(root.join(doc)).unwrap());
    session
        .apply(&run, doc, Expected::Version(version), ops)
        .unwrap();
}

/// The app's save of row edits made on `base`: every row sent back.
fn app_row_save(
    root: &Path,
    (base, version): &(String, String),
    edits: &[(&str, &str)],
) -> Result<Versioned<String>, SaveError> {
    let mut sketch = document::sketch_from_json(base).unwrap();
    for row in &mut sketch.rows {
        if let Some((_, text)) = edits.iter().find(|(id, _)| *id == row.id) {
            row.narrative = (*text).into();
        }
    }
    let op = json!({ "kind": "replace_rows", "rows": sketch.rows });
    save(root, "intro.sk", version, base, &[op])
}

fn narratives(root: &Path) -> Vec<String> {
    let sketch = project::read_sketch(&root.join("intro.sk")).unwrap();
    sketch.rows.into_iter().map(|row| row.narrative).collect()
}

#[test]
fn an_app_save_merges_onto_a_cli_edit_of_another_row() {
    let dir = project();
    let opened = opened_sketch(dir.path());
    cli_edit(
        dir.path(),
        "intro.sk",
        &[json!({ "kind": "set_row_text", "row_id": "b", "narrative": "cli" })],
    );

    let saved = app_row_save(dir.path(), &opened, &[("a", "app")]).unwrap();

    assert!(saved.merged);
    assert_eq!(narratives(dir.path()), ["app", "cli"]);
    let on_disk = std::fs::read_to_string(dir.path().join("intro.sk")).unwrap();
    assert_eq!(saved.content, on_disk);
    assert_eq!(
        saved.version,
        edit_ops::document_version(on_disk.as_bytes())
    );
}

#[test]
fn typing_on_after_a_merged_save_merges_again_from_its_synced_base() {
    let dir = project();
    let opened = opened_sketch(dir.path());
    let cli = json!({ "kind": "set_row_text", "row_id": "b", "narrative": "cli" });
    cli_edit(dir.path(), "intro.sk", &[cli]);
    let first = app_row_save(dir.path(), &opened, &[("a", "app")]).unwrap();
    let synced = first.synced.expect("a merged save reports its synced base");

    // The editor kept typing in row a, so it never showed the merged file.
    let base = (synced.content, synced.version);
    let second = app_row_save(dir.path(), &base, &[("a", "app, more")]).unwrap();

    assert!(second.merged);
    assert_eq!(narratives(dir.path()), ["app, more", "cli"]);
}

#[test]
fn an_app_save_of_a_row_the_cli_changed_is_stale_and_writes_nothing() {
    let dir = project();
    let opened = opened_sketch(dir.path());
    cli_edit(
        dir.path(),
        "intro.sk",
        &[json!({ "kind": "set_row_text", "row_id": "a", "narrative": "cli" })],
    );
    let before = std::fs::read(dir.path().join("intro.sk")).unwrap();

    let err = CmdError::from(app_row_save(dir.path(), &opened, &[("a", "app")]).unwrap_err());

    assert_eq!(err.code, cutready_contracts::CmdErrorCode::StaleDocument);
    let details = err.details.unwrap();
    assert_eq!(
        details.current_version,
        Some(edit_ops::document_version(&before))
    );
    assert!(details.conflicts.is_some_and(|c| !c.is_empty()));
    assert_eq!(std::fs::read(dir.path().join("intro.sk")).unwrap(), before);
}

#[test]
fn the_same_change_on_both_sides_is_not_a_conflict() {
    let dir = project();
    let opened = opened_sketch(dir.path());
    cli_edit(
        dir.path(),
        "intro.sk",
        &[json!({ "kind": "set_row_text", "row_id": "a", "narrative": "same" })],
    );

    let saved = app_row_save(dir.path(), &opened, &[("a", "same")]).unwrap();

    assert!(saved.merged);
    assert_eq!(narratives(dir.path()), ["same", ""]);
}

#[test]
fn an_app_save_onto_a_cli_note_edit_is_stale() {
    let dir = project();
    let written = replace_note(dir.path(), &dir.path().join("a.md"), "one").unwrap();
    cli_edit(
        dir.path(),
        "a.md",
        &[json!({ "kind": "write_note", "content": "cli" })],
    );

    let op = json!({ "kind": "write_note", "content": "app" });
    let err = save(
        dir.path(),
        "a.md",
        &written.version,
        &written.content,
        &[op],
    );

    assert_eq!(
        CmdError::from(err.unwrap_err()).code,
        cutready_contracts::CmdErrorCode::StaleDocument
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.md")).unwrap(),
        "cli"
    );
}

#[test]
fn a_base_that_is_not_the_expected_version_is_rejected() {
    let dir = project();
    let (base, _) = opened_sketch(dir.path());
    let before = std::fs::read(dir.path().join("intro.sk")).unwrap();
    let op = json!({ "kind": "set_title", "title": "x" });

    let err = save(dir.path(), "intro.sk", "sha256:00", &base, &[op]).unwrap_err();

    assert_eq!(
        CmdError::from(err).code,
        cutready_contracts::CmdErrorCode::StaleDocument
    );
    assert_eq!(std::fs::read(dir.path().join("intro.sk")).unwrap(), before);
}

#[test]
fn a_merge_that_would_break_a_cli_lock_is_rejected() {
    let dir = project();
    let opened = opened_sketch(dir.path());
    cli_edit(
        dir.path(),
        "intro.sk",
        &[json!({ "kind": "set_lock", "row_id": "a", "locked": true })],
    );
    let before = std::fs::read(dir.path().join("intro.sk")).unwrap();

    let err = app_row_save(dir.path(), &opened, &[("a", "app")]).unwrap_err();

    assert_eq!(
        CmdError::from(err).code,
        cutready_contracts::CmdErrorCode::StaleDocument
    );
    assert_eq!(std::fs::read(dir.path().join("intro.sk")).unwrap(), before);
}

#[test]
fn an_app_save_with_no_outside_edit_applies_as_before() {
    let dir = project();
    let opened = opened_sketch(dir.path());
    let mut expected = document::sketch_from_json(&opened.0).unwrap();
    expected.rows[0].narrative = "app".into();
    let op = json!({ "kind": "replace_rows", "rows": expected.rows });
    let direct = edit_ops::edit_document(
        DocumentKind::Sketch,
        Some(&opened.0),
        Some(&opened.1),
        std::slice::from_ref(&op),
        chrono::Utc::now(),
        false,
    )
    .unwrap();

    let saved = save(dir.path(), "intro.sk", &opened.1, &opened.0, &[op]).unwrap();

    assert!(!saved.merged);
    assert_eq!(narratives(dir.path()), ["app", ""]);
    let rows =
        |text: &str| serde_json::to_value(document::sketch_from_json(text).unwrap().rows).unwrap();
    assert_eq!(rows(&saved.content), rows(&direct.content));
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
