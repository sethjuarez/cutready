//! `cutready-cli mcp` runs the shared EditDocument vectors and the
//! contract-version handshake.

// Test helpers are test code; a failed unwrap is a failed test.
#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use cutready_cli::mcp::Server;
use cutready_cli::CONTRACT_VERSION;
use cutready_core::contracts::DocumentKind;
use cutready_desktop_io::StdFiles;
use serde_json::{json, Value};

fn doc_path(kind: &str) -> &'static str {
    match DocumentKind::from_str_opt(kind).expect("vector kind") {
        DocumentKind::Sketch => "sketches/doc.sk",
        DocumentKind::Storyboard => "doc.sb",
        DocumentKind::Note => "notes/doc.md",
    }
}

fn result(response: Option<Value>) -> Value {
    let response = response.expect("a response");
    assert!(
        response.get("error").is_none(),
        "unexpected error: {response}"
    );
    let result = response["result"].clone();
    if let Some(content) = result.get("structuredContent") {
        assert_contract_output(content.clone());
    }
    result
}

#[test]
fn edit_document_vectors_hold_over_mcp() {
    let vectors = edit_document_vectors();
    let golden = vectors
        .iter()
        .filter(|v| v["name"].as_str().unwrap().starts_with("golden_"))
        .count();
    assert_eq!(
        vectors.len() - golden,
        19,
        "every hand-written EditDocument vector runs"
    );
    assert_eq!(golden, 16, "every golden-seeded EditDocument vector runs");
    for vector in vectors {
        let name = vector["name"].as_str().unwrap();
        let request = &vector["input"]["request"];
        let dir = project();
        let root = dir.path();
        let path = doc_path(request["kind"].as_str().unwrap());
        if let Some(content) = request["content"].as_str() {
            write(root, path, content);
        }
        if request["note_locked"] == true {
            cutready_core::notes::set_note_lock(&StdFiles::new(root), path, true).unwrap();
        }
        let clock = clock(request["now"].as_str().unwrap());
        let mut server = Server::new(root, &clock).unwrap();
        result(server.handle(&initialize(Some(json!(CONTRACT_VERSION)))));
        let run = result(server.handle(&call(2, "begin_run", json!({}))));
        let run_id = run["structuredContent"]["run_id"].clone();
        let applied = result(server.handle(&call(
            3,
            "apply_ops",
            json!({
                "run_id": run_id,
                "path": path,
                "expected_version": request["expected_version"],
                "ops": request["ops"],
            }),
        )));
        let out = &applied["structuredContent"];
        if let Some(want) = vector.get("expectedError") {
            assert_eq!(
                applied["isError"], true,
                "{name}: expected an error, got {out}"
            );
            let out = &out["error"];
            assert_eq!(out["code"], want["code"], "{name}: {out}");
            assert_subset(name, &want["details"], &out["details"]);
            let on_disk = std::fs::read_to_string(root.join(path)).ok();
            assert_eq!(
                on_disk.as_deref(),
                request["content"].as_str(),
                "{name}: unchanged"
            );
        } else {
            let want = &vector["expected"];
            assert_eq!(applied["isError"], false, "{name}: {out}");
            assert_eq!(out["version"], want["version"], "{name}");
            let on_disk = std::fs::read_to_string(root.join(path)).unwrap();
            assert_eq!(Some(on_disk.as_str()), want["content"].as_str(), "{name}");
            if let Some(locked) = want.get("note_locked") {
                assert_eq!(&out["note_locked"], locked, "{name}");
                assert_eq!(
                    out["note_lock_changed"], want["note_lock_changed"],
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn a_contract_mismatch_is_refused_and_closes_the_server() {
    let dir = project();
    let clock = clock("2026-07-01T09:30:00Z");
    let mut server = Server::new(dir.path(), &clock).unwrap();
    let response = server
        .handle(&initialize(Some(json!(CONTRACT_VERSION + 1))))
        .unwrap();
    assert_eq!(response["error"]["code"], -32001);
    assert_eq!(response["error"]["data"]["server"], CONTRACT_VERSION);
    assert_eq!(response["error"]["data"]["client"], CONTRACT_VERSION + 1);
    assert!(server.closed());

    let mut input = Vec::new();
    for message in [
        initialize(Some(json!("1"))),
        call(2, "begin_run", json!({})),
    ] {
        input.extend_from_slice(format!("{message}\n").as_bytes());
    }
    let mut server = Server::new(dir.path(), &clock).unwrap();
    let mut output = Vec::new();
    server.serve(input.as_slice(), &mut output).unwrap();
    let lines: Vec<Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        lines.len(),
        1,
        "nothing is served after a mismatch: {lines:?}"
    );
    assert_eq!(lines[0]["error"]["code"], -32001);
}

#[test]
fn the_handshake_advertises_the_contract_version() {
    let dir = project();
    let clock = clock("2026-07-01T09:30:00Z");
    let mut server = Server::new(dir.path(), &clock).unwrap();
    let init = result(server.handle(&initialize(None)));
    assert_eq!(
        init["capabilities"]["experimental"]["cutready"]["contractVersion"],
        CONTRACT_VERSION
    );
    let tools = result(server.handle(&request(2, "tools/list", json!({}))));
    let names: Vec<&str> = tools["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "list_documents",
            "read_document",
            "begin_run",
            "apply_ops",
            "review",
            "keep",
            "undo"
        ]
    );
}

#[test]
fn calls_before_initialize_are_refused() {
    let dir = project();
    let clock = clock("2026-07-01T09:30:00Z");
    let mut server = Server::new(dir.path(), &clock).unwrap();
    assert!(server.handle(&request(1, "ping", json!({}))).unwrap()["result"].is_object());
    let response = server.handle(&call(2, "begin_run", json!({}))).unwrap();
    assert_eq!(response["error"]["code"], -32002);
    let notification = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    assert!(server.handle(&notification).is_none());
}

#[test]
fn malformed_requests_are_refused_without_running() {
    let dir = project();
    let clock = clock("2026-07-01T09:30:00Z");
    let mut server = Server::new(dir.path(), &clock).unwrap();
    let mut old = initialize(None);
    old["jsonrpc"] = json!("1.0");
    let mut object_id = initialize(None);
    object_id["id"] = json!({ "n": 1 });
    for message in [old, object_id, json!([initialize(None)]), json!("ping")] {
        let response = server.handle(&message).unwrap();
        assert_eq!(response["error"]["code"], -32600, "{message}");
    }
    let response = server.handle(&call(2, "begin_run", json!({}))).unwrap();
    assert_eq!(response["error"]["code"], -32002, "still not initialized");
}

#[test]
fn apply_ops_needs_an_expected_version_and_an_mcp_run() {
    let dir = project();
    let clock = clock("2026-07-01T09:30:00Z");
    let mut server = Server::new(dir.path(), &clock).unwrap();
    result(server.handle(&initialize(None)));
    let ops = json!([{ "kind": "replace_note", "content": "Hi" }]);
    let missing = server
        .handle(&call(
            2,
            "apply_ops",
            json!({ "run_id": "x", "path": "a.md", "ops": ops }),
        ))
        .unwrap();
    assert_eq!(missing["error"]["code"], -32602);

    let project = cutready_cli::project::Project::open(dir.path()).unwrap();
    let user_run = project.begin_run("user", &clock).unwrap();
    let foreign = server
        .handle(&call(
            3,
            "apply_ops",
            json!({ "run_id": user_run, "path": "a.md", "expected_version": null, "ops": ops }),
        ))
        .unwrap();
    assert_eq!(foreign["error"]["code"], -32602, "{foreign}");
    assert!(!dir.path().join("a.md").exists());

    let read = result(server.handle(&call(4, "read_document", json!({ "path": "a.md" }))));
    assert_eq!(read["structuredContent"]["version"], Value::Null);
    let escape = result(server.handle(&call(5, "read_document", json!({ "path": "../x.md" }))));
    assert_eq!(escape["isError"], true);
}

#[test]
fn a_folder_without_git_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let clock = clock("2026-07-01T09:30:00Z");
    assert!(Server::new(dir.path(), &clock).is_err());
    assert!(!dir.path().join(".git").exists());
}

fn initialize_as(client_id: Value) -> Value {
    let mut message = initialize(Some(json!(CONTRACT_VERSION)));
    message["params"]["capabilities"]["experimental"]["cutready"]["clientId"] = client_id;
    message
}

fn begin_and_write(server: &mut Server, id: u64, path: &str) -> (Value, Value) {
    let run = result(server.handle(&call(id, "begin_run", json!({}))));
    let run_id = run["structuredContent"]["run_id"].clone();
    let applied = result(server.handle(&call(
        id + 1,
        "apply_ops",
        json!({
            "run_id": run_id,
            "path": path,
            "expected_version": null,
            "ops": [{ "kind": "replace_note", "content": "Hi" }],
        }),
    )));
    assert_eq!(applied["isError"], false, "{applied}");
    (run_id, applied["structuredContent"]["seq"].clone())
}

#[test]
fn list_documents_reports_each_document_and_its_version() {
    let dir = project();
    write(dir.path(), "b.md", "# B");
    write(dir.path(), "notes/a.md", "# A");
    write(dir.path(), "broken.sk", "{");
    write(dir.path(), ".cutready/hidden.md", "x");
    let clock = clock("2026-07-01T09:30:00Z");
    let mut server = Server::new(dir.path(), &clock).unwrap();
    result(server.handle(&initialize(None)));
    let listed = result(server.handle(&call(2, "list_documents", json!({}))));
    let report = &listed["structuredContent"];
    let paths: Vec<&str> = report["documents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|doc| doc["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["b.md", "broken.sk", "notes/a.md"]);
    assert_eq!(report["ok"], false);
    let read = result(server.handle(&call(3, "read_document", json!({ "path": "b.md" }))));
    assert_eq!(
        report["documents"][0]["version"],
        read["structuredContent"]["version"]
    );
    assert_eq!(report["documents"][1]["ok"], false);
}

#[test]
fn a_client_id_owns_its_runs_across_connections() {
    let dir = project();
    let clock = clock("2026-07-01T09:30:00Z");
    let mut first = Server::new(dir.path(), &clock).unwrap();
    result(first.handle(&initialize_as(json!("canvas-1"))));
    assert_eq!(first.actor(), "mcp:canvas-1");
    let (run_id, seq) = begin_and_write(&mut first, 2, "a.md");
    drop(first);

    let mut other = Server::new(dir.path(), &clock).unwrap();
    result(other.handle(&initialize_as(json!("canvas-2"))));
    let reviews = result(other.handle(&call(2, "review", json!({}))));
    assert_eq!(reviews["structuredContent"], json!([]));
    let refused = other
        .handle(&call(
            3,
            "keep",
            json!({ "run_id": run_id, "path": "a.md", "through_seq": seq }),
        ))
        .unwrap();
    assert_eq!(refused["error"]["code"], -32602, "{refused}");

    let mut again = Server::new(dir.path(), &clock).unwrap();
    result(again.handle(&initialize_as(json!("canvas-1"))));
    let reviews = result(again.handle(&call(2, "review", json!({}))));
    assert_eq!(reviews["structuredContent"][0]["run_id"], run_id);
    assert_eq!(reviews["structuredContent"][0]["actor"], "mcp:canvas-1");
    let kept = result(again.handle(&call(
        3,
        "keep",
        json!({ "run_id": run_id, "path": "a.md", "through_seq": seq }),
    )));
    assert_eq!(kept["isError"], false, "{kept}");
}

#[test]
fn without_a_client_id_runs_belong_to_their_connection() {
    let dir = project();
    let clock = clock("2026-07-01T09:30:00Z");
    let mut first = Server::new(dir.path(), &clock).unwrap();
    result(first.handle(&initialize(None)));
    assert_eq!(first.actor(), "mcp");
    let (run_id, seq) = begin_and_write(&mut first, 2, "a.md");

    let mut second = Server::new(dir.path(), &clock).unwrap();
    result(second.handle(&initialize(None)));
    let reviews = result(second.handle(&call(2, "review", json!({}))));
    assert_eq!(reviews["structuredContent"], json!([]));
    let refused = second
        .handle(&call(
            3,
            "undo",
            json!({ "run_id": run_id, "path": "a.md", "through_seq": seq }),
        ))
        .unwrap();
    assert_eq!(refused["error"]["code"], -32602);
}

#[test]
fn a_malformed_client_id_is_refused() {
    let dir = project();
    let clock = clock("2026-07-01T09:30:00Z");
    for bad in [json!(null), json!(""), json!("has space"), json!(7), json!("x".repeat(65))] {
        let mut server = Server::new(dir.path(), &clock).unwrap();
        let response = server.handle(&initialize_as(bad.clone())).unwrap();
        assert_eq!(response["error"]["code"], -32602, "{bad}");
        let after = server.handle(&call(2, "begin_run", json!({}))).unwrap();
        assert_eq!(after["error"]["code"], -32002, "{bad}: not initialized");
    }
}
