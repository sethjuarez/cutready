//! Review, Keep and Undo over MCP and the `cutready-cli` binary.

// Test helpers are test code; a failed unwrap is a failed test.
#![allow(clippy::unwrap_used)]

mod common;

use std::io::Write;
use std::process::{Command, Output, Stdio};

use common::*;
use cutready_cli::mcp::Server;
use serde_json::{json, Value};

const NOW: &str = "2026-07-01T09:30:00Z";

fn ready(server: &mut Server) {
    let response = server
        .handle(&initialize(Some(json!(cutready_cli::CONTRACT_VERSION))))
        .unwrap();
    assert!(response.get("result").is_some(), "{response}");
}

/// The tool's `structuredContent`, asserting `isError` is `error`.
fn tool(server: &mut Server, id: u64, name: &str, arguments: Value, error: bool) -> Value {
    let response = server.handle(&call(id, name, arguments)).unwrap();
    let result = &response["result"];
    assert_eq!(result["isError"], json!(error), "{name}: {response}");
    result["structuredContent"].clone()
}

fn begin(server: &mut Server, id: u64) -> String {
    tool(server, id, "begin_run", json!({}), false)["run_id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn write_note(server: &mut Server, id: u64, run: &str, expected: Value, content: &str) -> Value {
    tool(
        server,
        id,
        "apply_ops",
        json!({
            "run_id": run,
            "path": "notes/plan.md",
            "expected_version": expected,
            "ops": [{ "kind": "replace_note", "content": content }],
        }),
        false,
    )
}

fn review(server: &mut Server, id: u64) -> Vec<Value> {
    tool(server, id, "review", json!({}), false)
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn review_lists_a_run_and_keep_resolves_it() {
    let dir = project();
    write(dir.path(), "notes/plan.md", "Old");
    let clock = clock(NOW);
    let mut server = Server::new(dir.path(), &clock).unwrap();
    ready(&mut server);
    let read = tool(
        &mut server,
        2,
        "read_document",
        json!({ "path": "notes/plan.md" }),
        false,
    );
    let run = begin(&mut server, 3);
    write_note(&mut server, 4, &run, read["version"].clone(), "New");

    let pending = review(&mut server, 5);
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert_eq!(pending[0]["run_id"], json!(run));
    assert_eq!(pending[0]["actor"], json!("mcp"));
    let document = &pending[0]["documents"][0];
    assert_eq!(document["doc"], json!("notes/plan.md"));

    let kept = tool(
        &mut server,
        6,
        "keep",
        json!({ "run_id": run, "path": "notes/plan.md", "through_seq": document["through_seq"] }),
        false,
    );
    assert_eq!(kept["resolved"], json!("keep"));
    assert!(review(&mut server, 7).is_empty());
    let on_disk = std::fs::read_to_string(dir.path().join("notes/plan.md")).unwrap();
    assert_eq!(on_disk, "New");
}

#[test]
fn undo_removes_a_created_document() {
    let dir = project();
    let clock = clock(NOW);
    let mut server = Server::new(dir.path(), &clock).unwrap();
    ready(&mut server);
    let run = begin(&mut server, 2);
    let applied = write_note(&mut server, 3, &run, Value::Null, "# Run\n");
    assert_eq!(applied["run_id"], json!(run));
    let pending = review(&mut server, 4);
    let through = pending[0]["documents"][0]["through_seq"].clone();

    let undone = tool(
        &mut server,
        5,
        "undo",
        json!({ "run_id": run, "path": "notes/plan.md", "through_seq": through }),
        false,
    );
    assert_eq!(
        undone,
        json!({ "run_id": run, "path": "notes/plan.md", "resolved": "undo" })
    );
    assert!(!dir.path().join("notes/plan.md").exists());
    assert!(review(&mut server, 6).is_empty());
}

#[test]
fn keep_through_an_old_seq_is_stale() {
    let dir = project();
    let clock = clock(NOW);
    let mut server = Server::new(dir.path(), &clock).unwrap();
    ready(&mut server);
    let run = begin(&mut server, 2);
    let first = write_note(&mut server, 3, &run, Value::Null, "One");
    let old_seq = review(&mut server, 4)[0]["documents"][0]["through_seq"].clone();
    write_note(&mut server, 5, &run, first["version"].clone(), "Two");

    let refused = tool(
        &mut server,
        6,
        "keep",
        json!({ "run_id": run, "path": "notes/plan.md", "through_seq": old_seq }),
        true,
    );
    assert_eq!(refused["error"]["code"], json!("stale_review"), "{refused}");
    assert_eq!(review(&mut server, 7).len(), 1);
}

#[test]
fn undo_of_a_document_changed_since_conflicts_and_changes_nothing() {
    let dir = project();
    let clock = clock(NOW);
    let mut server = Server::new(dir.path(), &clock).unwrap();
    ready(&mut server);
    let run = begin(&mut server, 2);
    write_note(&mut server, 3, &run, Value::Null, "# Run\n");
    let through = review(&mut server, 4)[0]["documents"][0]["through_seq"].clone();
    write(dir.path(), "notes/plan.md", "# Theirs\n");

    let refused = tool(
        &mut server,
        5,
        "undo",
        json!({ "run_id": run, "path": "notes/plan.md", "through_seq": through }),
        true,
    );
    assert_eq!(
        refused["error"]["code"],
        json!("undo_conflict"),
        "{refused}"
    );
    let on_disk = std::fs::read_to_string(dir.path().join("notes/plan.md")).unwrap();
    assert_eq!(on_disk, "# Theirs\n");
}

#[test]
fn keep_and_undo_need_a_through_seq() {
    let dir = project();
    let clock = clock(NOW);
    let mut server = Server::new(dir.path(), &clock).unwrap();
    ready(&mut server);
    for name in ["keep", "undo"] {
        let response = server
            .handle(&call(
                2,
                name,
                json!({ "run_id": "r", "path": "notes/plan.md" }),
            ))
            .unwrap();
        assert_eq!(response["error"]["code"], json!(-32602), "{response}");
    }
}

#[test]
fn a_connection_only_sees_and_resolves_its_own_runs() {
    let dir = project();
    let clock = clock(NOW);
    let mut first = Server::new(dir.path(), &clock).unwrap();
    let mut second = Server::new(dir.path(), &clock).unwrap();
    ready(&mut first);
    ready(&mut second);
    let run = begin(&mut first, 2);
    write_note(&mut first, 3, &run, Value::Null, "# First\n");
    let through = review(&mut first, 4)[0]["documents"][0]["through_seq"].clone();

    assert!(review(&mut second, 2).is_empty());
    for (id, name) in [(3, "keep"), (4, "undo")] {
        let refused = second
            .handle(&call(
                id,
                name,
                json!({ "run_id": run, "path": "notes/plan.md", "through_seq": through }),
            ))
            .unwrap();
        assert_eq!(refused["error"]["code"], json!(-32602), "{refused}");
    }
    let hijack = second
        .handle(&call(
            5,
            "apply_ops",
            json!({
                "run_id": run,
                "path": "notes/other.md",
                "expected_version": null,
                "ops": [{ "kind": "replace_note", "content": "x" }],
            }),
        ))
        .unwrap();
    assert_eq!(hijack["error"]["code"], json!(-32602), "{hijack}");
    assert!(!dir.path().join("notes/other.md").exists());
    assert_eq!(review(&mut first, 5).len(), 1);
}

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
    serde_json::from_slice(&output.stdout).unwrap_or_else(|err| {
        panic!(
            "stdout is not JSON ({err}): {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn the_cli_reviews_and_undoes_its_own_edit() {
    let dir = project();
    let root = dir.path().to_str().unwrap();
    write(dir.path(), "notes/plan.md", "Old");
    let ops = r#"[{"kind":"replace_note","content":"New"}]"#;
    let version = cutready_core::edit_ops::document_version(b"Old");
    let edited = cli(
        &["edit", root, "notes/plan.md", "--expected", &version],
        ops,
    );
    assert!(edited.status.success(), "{}", stdout_json(&edited));
    let run = stdout_json(&edited)["run_id"].as_str().unwrap().to_string();

    let listed = cli(&["review", root], "");
    assert!(listed.status.success());
    let reviews = stdout_json(&listed);
    assert_eq!(reviews[0]["run_id"], json!(run), "{reviews}");
    assert_eq!(reviews[0]["actor"], json!("cli"));
    let through = reviews[0]["documents"][0]["through_seq"].to_string();

    let stale = cli(
        &[
            "keep",
            root,
            "notes/plan.md",
            "--run",
            &run,
            "--through",
            "0",
        ],
        "",
    );
    assert!(!stale.status.success());
    assert_eq!(stdout_json(&stale)["error"]["code"], json!("stale_review"));

    let undone = cli(
        &[
            "undo",
            root,
            "notes/plan.md",
            "--run",
            &run,
            "--through",
            &through,
        ],
        "",
    );
    assert!(undone.status.success(), "{}", stdout_json(&undone));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("notes/plan.md")).unwrap(),
        "Old"
    );
    assert_eq!(stdout_json(&cli(&["review", root], "")), json!([]));
}

#[test]
fn keep_without_a_run_is_a_usage_error() {
    let dir = project();
    let root = dir.path().to_str().unwrap();
    let output = cli(&["keep", root, "notes/plan.md", "--through", "1"], "");
    assert_eq!(output.status.code(), Some(2));
}
