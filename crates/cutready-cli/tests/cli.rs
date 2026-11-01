//! The `cutready-cli` binary against a temp project with the app closed.

// Test helpers are test code; a failed unwrap is a failed test.
#![allow(clippy::unwrap_used)]

mod common;

use std::io::Write;
use std::process::{Command, Output, Stdio};

use common::*;
use cutready_cli::CONTRACT_VERSION;
use cutready_core::edit_session::EditSession;
use cutready_desktop_io::repo_lock::RepoLock;
use cutready_desktop_io::state_dir::{git_state_dir, OP_LOG_FILENAME};
use cutready_desktop_io::{SqliteOpLogStore, StdFiles, SystemClock};
use serde_json::{json, Value};

fn cli(args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_cutready-cli"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("cutready-cli runs");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn stdout_json(output: &Output) -> Value {
    assert_contract_output(
        serde_json::from_slice(&output.stdout).unwrap_or_else(|err| {
            panic!(
                "stdout is not JSON ({err}): {}\nstderr: {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        }),
    )
}

const SKETCH: &str = r#"{"title":"Intro","description":null,"rows":[],"state":"draft","created_at":"2026-06-28T20:00:00Z","updated_at":"2026-06-28T20:00:00Z"}"#;

#[test]
fn version_reports_the_contract() {
    let output = cli(&["--version"], "");
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(
        text.contains(&format!("edit contract {CONTRACT_VERSION}")),
        "{text}"
    );
}

#[test]
fn an_edit_shows_up_as_a_pending_cli_run() {
    let dir = project();
    let root = dir.path().to_str().unwrap();
    write(dir.path(), "notes/plan.md", "Old");
    let version = cutready_core::edit_ops::document_version(b"Old");

    let ops = json!([{ "kind": "write_note", "content": "New" }]).to_string();
    let output = cli(
        &["edit", root, "notes/plan.md", "--expected", &version],
        &ops,
    );
    assert!(output.status.success(), "{output:?}");
    let out = stdout_json(&output);
    assert_eq!(out["changed"], true);
    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes/plan.md")).unwrap(),
        "New"
    );

    // The app reads reviews from the same op log through its own ports.
    let log = SqliteOpLogStore::open(&git_state_dir(dir.path(), dir.path()).join(OP_LOG_FILENAME))
        .unwrap();
    let files = StdFiles::new(dir.path());
    let lock = RepoLock::for_path(dir.path());
    let reviews = EditSession::new(&files, &lock, &log, &SystemClock)
        .pending_reviews()
        .unwrap();
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0].actor, "cli");
    assert_eq!(reviews[0].run_id, out["run_id"].as_str().unwrap());
    assert_eq!(reviews[0].documents[0].doc, "notes/plan.md");

    // A stale expected version is refused with the contract error.
    let stale = cli(
        &["edit", root, "notes/plan.md", "--expected", &version],
        &ops,
    );
    assert_eq!(stale.status.code(), Some(1));
    assert_eq!(stdout_json(&stale)["error"]["code"], "stale_document");
}

#[test]
fn edit_creates_a_document_from_an_ops_file() {
    let dir = project();
    let root = dir.path().to_str().unwrap();
    let ops_file = dir.path().join("ops.json");
    std::fs::write(
        &ops_file,
        json!([{ "kind": "replace_note", "content": "Hello" }]).to_string(),
    )
    .unwrap();
    let output = cli(
        &[
            "edit",
            root,
            "hello.md",
            "--expected",
            "absent",
            "--ops",
            ops_file.to_str().unwrap(),
        ],
        "",
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("hello.md")).unwrap(),
        "Hello"
    );
}

#[test]
fn edit_results_have_the_contract_shape() {
    let dir = project();
    let root = dir.path().to_str().unwrap();
    write(dir.path(), "notes/plan.md", "Old");
    write(dir.path(), "intro.sk", SKETCH);
    let edit = |doc: &str, expected: &str, ops: Value| {
        let output = cli(
            &["edit", root, doc, "--expected", expected],
            &ops.to_string(),
        );
        assert!(output.status.success(), "{output:?}");
        stdout_json(&output)
    };

    let old = cutready_core::edit_ops::document_version(b"Old");
    let note = edit(
        "notes/plan.md",
        &old,
        json!([{ "kind": "write_note", "content": "New" }]),
    );
    let new = cutready_core::edit_ops::document_version(b"New");
    let run_id = note["run_id"].clone();
    assert!(note["seq"].is_u64(), "{note}");
    assert_eq!(
        note,
        json!({
            "run_id": run_id, "path": "notes/plan.md", "version": new, "changed": true,
            "seq": note["seq"], "note_locked": false, "note_lock_changed": false,
        })
    );

    // Nothing changed, nothing logged: seq is an explicit null.
    let same = edit(
        "notes/plan.md",
        &new,
        json!([{ "kind": "write_note", "content": "New" }]),
    );
    assert_eq!(same["changed"], false);
    assert_eq!(same["seq"], Value::Null);
    assert!(same.as_object().unwrap().contains_key("seq"), "{same}");

    // Note-lock fields are omitted for other documents.
    let version = cutready_core::edit_ops::document_version(SKETCH.as_bytes());
    let sketch = edit(
        "intro.sk",
        &version,
        json!([{ "kind": "set_title", "title": "Hello" }]),
    );
    let keys: Vec<&str> = sketch
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["changed", "path", "run_id", "seq", "version"],
        "{sketch}"
    );
}

#[test]
fn usage_errors_exit_2() {
    let dir = project();
    let root = dir.path().to_str().unwrap();
    assert_eq!(cli(&[], "").status.code(), Some(2));
    assert_eq!(cli(&["edit", root, "a.md"], "[]").status.code(), Some(2));
    assert_eq!(cli(&["frobnicate"], "").status.code(), Some(2));
}

#[test]
fn validate_reports_each_document() {
    let dir = project();
    let root = dir.path().to_str().unwrap();
    write(dir.path(), "intro.sk", SKETCH);
    write(dir.path(), "broken/bad.sk", "{not json");
    write(dir.path(), "notes/a.md", "Hi");
    write(dir.path(), ".cutready/ignored.md", "x");
    write(dir.path(), "node_modules/pkg/readme.md", "x");

    let output = cli(&["validate", root], "");
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    let report = stdout_json(&output);
    assert_eq!(report["ok"], false);
    let docs: Vec<(&str, bool)> = report["documents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["path"].as_str().unwrap(), d["ok"].as_bool().unwrap()))
        .collect();
    assert_eq!(
        docs,
        [
            ("broken/bad.sk", false),
            ("intro.sk", true),
            ("notes/a.md", true)
        ]
    );
    let documents = report["documents"].as_array().unwrap();
    assert_eq!(documents[0]["error"]["code"], "command_failed", "{report}");
    assert!(documents[0].get("version").is_none(), "{report}");
    assert_eq!(
        documents[2],
        json!({
            "path": "notes/a.md", "ok": true,
            "version": cutready_core::edit_ops::document_version(b"Hi"),
        })
    );

    let good = cli(&["validate", root, "intro.sk"], "");
    assert!(good.status.success(), "{good:?}");
}

#[test]
fn mcp_serves_over_stdio() {
    let dir = project();
    let root = dir.path().to_str().unwrap();
    let input = [
        initialize(Some(json!(CONTRACT_VERSION))),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        call(2, "read_document", json!({ "path": "a.md" })),
    ]
    .iter()
    .map(|m| format!("{m}\n"))
    .collect::<String>();
    let output = cli(&["mcp", root], &input);
    assert!(output.status.success(), "{output:?}");
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(
        lines[1]["result"]["structuredContent"]["content"],
        Value::Null
    );

    let mismatch = cli(
        &["mcp", root],
        &format!("{}\n", initialize(Some(json!(CONTRACT_VERSION + 1)))),
    );
    assert_eq!(mismatch.status.code(), Some(1));
}
