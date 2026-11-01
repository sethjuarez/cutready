//! Shared setup for the CLI integration tests.

// Test helpers are test code; a failed unwrap is a failed test.
#![allow(clippy::unwrap_used)]
#![allow(dead_code)]

use std::path::Path;

use chrono::{DateTime, Utc};
use cutready_core::testing::FixedClock;
use serde_json::{json, Value};
use tempfile::TempDir;

/// A temp folder that is its own git repository, like a standalone project.
pub fn project() -> TempDir {
    let dir = tempfile::tempdir().expect("temp dir");
    git2::Repository::init(dir.path()).expect("git init");
    dir
}

pub fn clock(now: &str) -> FixedClock {
    let now: DateTime<Utc> = now.parse().expect("timestamp");
    FixedClock::new(now)
}

pub fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

pub fn request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

pub fn initialize(version: Option<Value>) -> Value {
    let mut capabilities = json!({});
    if let Some(version) = version {
        capabilities = json!({ "experimental": { "cutready": { "contractVersion": version } } });
    }
    request(
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": capabilities,
            "clientInfo": { "name": "test", "version": "0" },
        }),
    )
}

pub fn call(id: u64, tool: &str, arguments: Value) -> Value {
    request(
        id,
        "tools/call",
        json!({ "name": tool, "arguments": arguments }),
    )
}

/// The `EditService.editDocument` vectors every host runs.
pub fn edit_document_vectors() -> Vec<Value> {
    let all: Value = serde_json::from_str(include_str!(
        "../../../../contracts/generated/.typra-generated/vectors.json"
    ))
    .expect("vectors.json parses");
    all["vectors"]
        .as_array()
        .expect("vectors")
        .iter()
        .filter(|v| v["contract"] == "EditService" && v["operation"] == "editDocument")
        .map(|v| v["vector"].clone())
        .collect()
}

/// `expected` is a subset of `actual`: every key it names matches.
pub fn assert_subset(name: &str, expected: &Value, actual: &Value) {
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            for (key, value) in want {
                assert_subset(
                    &format!("{name}.{key}"),
                    value,
                    got.get(key).unwrap_or(&Value::Null),
                );
            }
        }
        _ => assert_eq!(expected, actual, "{name}"),
    }
}

/// Every CLI result and MCP `structuredContent` is exactly a contract model.
pub fn assert_contract_output(value: Value) -> Value {
    assert!(
        cutready_cli::output::contract_model(&value).is_some(),
        "not a contract model (contracts/cli.tsp): {value}"
    );
    value
}
