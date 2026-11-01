//! `cutready-cli mcp`: a Model Context Protocol server over stdio (newline-
//! delimited JSON-RPC 2.0, no network listener).
//!
//! The `initialize` handshake carries the edit contract version in
//! `capabilities.experimental.cutready.contractVersion`, both ways. A client
//! that declares another version is refused and the server exits, so a
//! mismatched pair fails closed instead of writing documents either side
//! misreads. Clients that declare none (generic MCP hosts) should check the
//! server's version in the result.

use std::io::{BufRead, Write};
use std::path::Path;

use cutready_core::Clock;
use serde_json::{json, Value};

use crate::project::{applied_json, Failure, Project};
use crate::CONTRACT_VERSION;

/// The MCP revision this server implements.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// The op-log actor of runs started over MCP.
pub const ACTOR: &str = "mcp";

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
/// Server error: a request before a successful `initialize`.
const NOT_INITIALIZED: i64 = -32002;
/// Server error: the client speaks another contract version.
const CONTRACT_MISMATCH: i64 = -32001;

/// One client connection to one project.
pub struct Server<'c> {
    root: std::path::PathBuf,
    clock: &'c dyn Clock,
    initialized: bool,
    closed: bool,
}

impl<'c> Server<'c> {
    /// Serves the project at `root`, checking it opens before any client
    /// connects.
    pub fn new(root: &Path, clock: &'c dyn Clock) -> Result<Self, Failure> {
        let project = Project::open(root)?;
        Ok(Self {
            root: project.root().to_path_buf(),
            clock,
            initialized: false,
            closed: false,
        })
    }

    /// True once the server refused the client and must stop.
    pub fn closed(&self) -> bool {
        self.closed
    }

    /// Reads requests from `input` until it closes (or the handshake fails),
    /// writing one response line per request.
    pub fn serve(&mut self, input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let response = match serde_json::from_str::<Value>(&line) {
                Ok(message) => self.handle(&message),
                Err(err) => Some(error(Value::Null, PARSE_ERROR, &err.to_string(), None)),
            };
            if let Some(response) = response {
                serde_json::to_writer(&mut output, &response)?;
                output.write_all(b"\n")?;
                output.flush()?;
            }
            if self.closed {
                break;
            }
        }
        Ok(())
    }

    /// Handles one JSON-RPC message. Notifications get no response.
    pub fn handle(&mut self, message: &Value) -> Option<Value> {
        // JSON-RPC ids are strings or integers; anything else can't be echoed.
        let id = message.get("id");
        let valid_id = id.filter(|id| id.is_string() || id.is_i64() || id.is_u64());
        let method = message.get("method").and_then(Value::as_str);
        let (Some(method), true, true) = (
            method,
            message.get("jsonrpc") == Some(&json!("2.0")),
            id.is_none() || valid_id.is_some(),
        ) else {
            return Some(error(
                valid_id.cloned().unwrap_or(Value::Null),
                INVALID_REQUEST,
                "Expected a JSON-RPC 2.0 request with a string or integer id",
                None,
            ));
        };
        // A notification: nothing to answer.
        let id = valid_id.cloned()?;
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let outcome = match method {
            "initialize" => self.initialize(&params),
            "ping" => Ok(json!({})),
            _ if !self.initialized => {
                Err((NOT_INITIALIZED, "Send initialize first".to_string(), None))
            }
            "tools/list" => Ok(json!({ "tools": tools() })),
            "tools/call" => self.call(&params),
            _ => Err((METHOD_NOT_FOUND, format!("Unknown method {method}"), None)),
        };
        Some(match outcome {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message, data)) => error(id, code, &message, data),
        })
    }

    fn initialize(&mut self, params: &Value) -> Outcome {
        let declared = params.pointer("/capabilities/experimental/cutready/contractVersion");
        if let Some(declared) = declared {
            if declared.as_u64() != Some(u64::from(CONTRACT_VERSION)) {
                self.closed = true;
                return Err((
                    CONTRACT_MISMATCH,
                    format!(
                        "This cutready-cli speaks edit contract {CONTRACT_VERSION}; the client speaks {declared}. Install matching versions."
                    ),
                    Some(json!({ "server": CONTRACT_VERSION, "client": declared })),
                ));
            }
        }
        self.initialized = true;
        Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {
                "tools": {},
                "experimental": { "cutready": { "contractVersion": CONTRACT_VERSION } },
            },
            "serverInfo": { "name": "cutready", "version": env!("CARGO_PKG_VERSION") },
        }))
    }

    fn call(&self, params: &Value) -> Outcome {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("name is required"))?;
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let project = match Project::open(&self.root) {
            Ok(project) => project,
            Err(err) => return Ok(tool_error(&err)),
        };
        let result = match name {
            "read_document" => {
                let path = string_arg(&args, "path")?;
                project.read(path).map(|doc| {
                    json!({ "path": doc.path, "content": doc.content, "version": doc.version })
                })
            }
            "begin_run" => project
                .begin_run(ACTOR, self.clock)
                .map(|run_id| json!({ "run_id": run_id })),
            "apply_ops" => {
                let run_id = string_arg(&args, "run_id")?;
                let path = string_arg(&args, "path")?;
                let expected = match args.get("expected_version") {
                    Some(Value::String(version)) => Some(version.as_str()),
                    Some(Value::Null) => None,
                    _ => {
                        return Err(invalid(
                            "expected_version is required: the version read_document returned, or null for a new document",
                        ))
                    }
                };
                let ops = args
                    .get("ops")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid("ops must be an array of EditOps"))?;
                project
                    .apply(self.clock, ACTOR, run_id, path, expected, ops)
                    .map(|applied| applied_json(path, &applied))
            }
            other => return Err(invalid(&format!("Unknown tool {other}"))),
        };
        Ok(match result {
            Ok(value) => tool_result(value, false),
            Err(err) => tool_error(&err),
        })
    }
}

type Outcome = Result<Value, (i64, String, Option<Value>)>;

fn invalid(message: &str) -> (i64, String, Option<Value>) {
    (INVALID_PARAMS, message.to_string(), None)
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, (i64, String, Option<Value>)> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(&format!("{key} is required")))
}

fn tool_result(value: Value, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": value.to_string() }],
        "structuredContent": value,
        "isError": is_error,
    })
}

/// A refused tool call. Contract errors put the `CmdError` in
/// `structuredContent`.
fn tool_error(err: &Failure) -> Value {
    tool_result(err.to_json(), true)
}

fn error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message });
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

fn tools() -> Value {
    json!([
        {
            "name": "read_document",
            "description": "Read a project document (.sk sketch, .sb storyboard or .md note) and the version an edit of it must expect. content and version are null when the file doesn't exist.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Project-relative path." } },
                "required": ["path"],
                "additionalProperties": false,
            },
        },
        {
            "name": "begin_run",
            "description": "Start a run. Every apply_ops in it shows in CutReady as one change set to keep or undo.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
        },
        {
            "name": "apply_ops",
            "description": "Apply EditOps to one document as part of a run. Fails with stale_document if the document changed since expected_version, and with the op's error (for example locked_row) without writing anything if any op is refused.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "run_id": { "type": "string" },
                    "path": { "type": "string", "description": "Project-relative .sk, .sb or .md path." },
                    "expected_version": {
                        "type": ["string", "null"],
                        "description": "The version read_document returned; null when the document must not exist yet.",
                    },
                    "ops": { "type": "array", "items": { "type": "object" }, "description": "EditOps, applied in order." },
                },
                "required": ["run_id", "path", "expected_version", "ops"],
                "additionalProperties": false,
            },
        },
    ])
}
