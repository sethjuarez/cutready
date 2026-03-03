//! Tool definitions and execution for the AI assistant.
//!
//! Each tool maps to a project operation (read notes, read/update sketches, etc.)
//! and is exposed to the LLM via function calling.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::engine::agent::llm::{FunctionDefinition, ToolCall, ToolDefinition};
use crate::engine::project;
use crate::models::sketch::PlanningRow;

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

/// All tools available to the AI assistant.
pub fn all_tools() -> Vec<ToolDefinition> {
    vec![
        tool_def(
            "list_project_files",
            "List all sketches and notes in the project",
            json!({ "type": "object", "properties": {}, "required": [] }),
        ),
        tool_def(
            "read_note",
            "Read the full markdown content of a note",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the note (e.g. 'notes/overview.md')" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "read_sketch",
            "Read a sketch's planning rows (time, narrative, demo_actions, screenshot)",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch (e.g. 'sketches/demo.sk')" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "set_planning_rows",
            "Replace ALL planning rows in a sketch. Use this to generate a full plan from scratch.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch" },
                    "rows": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "time": { "type": "string", "description": "Duration (e.g. '~30s', '1:00')" },
                                "narrative": { "type": "string", "description": "Voiceover/narration bullets" },
                                "demo_actions": { "type": "string", "description": "On-screen action bullets" }
                            },
                            "required": ["time", "narrative", "demo_actions"]
                        }
                    }
                },
                "required": ["path", "rows"]
            }),
        ),
        tool_def(
            "update_planning_row",
            "Update a single planning row by index. Only fields provided are changed.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch" },
                    "index": { "type": "integer", "description": "0-based row index" },
                    "time": { "type": "string", "description": "New time value (optional)" },
                    "narrative": { "type": "string", "description": "New narrative (optional)" },
                    "demo_actions": { "type": "string", "description": "New demo actions (optional)" }
                },
                "required": ["path", "index"]
            }),
        ),
        tool_def(
            "delegate_to_agent",
            "Delegate a task to another AI agent with a different specialization. The agent runs independently and returns its result. Available agents: planner, writer, editor, plus any custom agents.",
            json!({
                "type": "object",
                "properties": {
                    "agent_id": { "type": "string", "description": "ID of the agent to delegate to (e.g. 'writer', 'editor', 'planner')" },
                    "message": { "type": "string", "description": "The task to delegate — be specific about what you want the agent to do" }
                },
                "required": ["agent_id", "message"]
            }),
        ),
        tool_def(
            "fetch_url",
            "Fetch a web page and return its content as clean readable text. Use this to pull in reference material, documentation, or any web content. Scripts, styles, and navigation are stripped.",
            json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The URL to fetch (e.g. 'https://docs.example.com/guide')" }
                },
                "required": ["url"]
            }),
        ),
    ]
}

fn tool_def(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        tool_type: "function".into(),
        function: FunctionDefinition {
            name: name.into(),
            description: description.into(),
            parameters,
        },
    }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/// Execute a single tool call and return the result as a string.
pub fn execute_tool(call: &ToolCall, project_root: &Path) -> String {
    let args: Value = serde_json::from_str(&call.function.arguments).unwrap_or(json!({}));

    match call.function.name.as_str() {
        "list_project_files" => exec_list_project_files(project_root),
        "read_note" => exec_read_note(project_root, &args),
        "read_sketch" => exec_read_sketch(project_root, &args),
        "set_planning_rows" => exec_set_planning_rows(project_root, &args),
        "update_planning_row" => exec_update_planning_row(project_root, &args),
        other => format!("Unknown tool: {other}"),
    }
}

fn resolve_path(project_root: &Path, rel: &str) -> PathBuf {
    project_root.join(rel)
}

fn exec_list_project_files(root: &Path) -> String {
    let mut out = String::new();

    if let Ok(sketches) = project::scan_sketches(root) {
        out.push_str("## Sketches\n");
        for s in &sketches {
            out.push_str(&format!(
                "- {} ({}, {} rows)\n",
                s.path, s.title, s.row_count
            ));
        }
    }

    if let Ok(notes) = project::scan_notes(root) {
        out.push_str("\n## Notes\n");
        for n in &notes {
            out.push_str(&format!("- {} ({})\n", n.path, n.title));
        }
    }

    if out.is_empty() {
        "No sketches or notes found in this project.".into()
    } else {
        out
    }
}

fn exec_read_note(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    match project::read_note(&path) {
        Ok(content) => content,
        Err(e) => format!("Error reading note: {e}"),
    }
}

fn exec_read_sketch(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    match project::read_sketch(&path) {
        Ok(sketch) => {
            let mut out = format!("# {}\n\n", sketch.title);
            for (i, row) in sketch.rows.iter().enumerate() {
                out.push_str(&format!(
                    "## Row {} [{}]\n**Narrative:** {}\n**Actions:** {}\n\n",
                    i, row.time, row.narrative, row.demo_actions
                ));
            }
            out
        }
        Err(e) => format!("Error reading sketch: {e}"),
    }
}

fn exec_set_planning_rows(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    let rows_val = match args.get("rows") {
        Some(v) => v,
        None => return "Error: missing 'rows' argument".into(),
    };

    let new_rows: Vec<PlanningRow> = match rows_val.as_array() {
        Some(arr) => arr
            .iter()
            .map(|r| PlanningRow {
                time: r.get("time").and_then(|v| v.as_str()).unwrap_or("").into(),
                narrative: r
                    .get("narrative")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .into(),
                demo_actions: r
                    .get("demo_actions")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .into(),
                screenshot: None,
            })
            .collect(),
        None => return "Error: 'rows' must be an array".into(),
    };

    let mut sketch = match project::read_sketch(&path) {
        Ok(s) => s,
        Err(e) => return format!("Error reading sketch: {e}"),
    };

    let count = new_rows.len();
    sketch.rows = new_rows;

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => format!("Set {count} planning rows in {}", path.display()),
        Err(e) => format!("Error writing sketch: {e}"),
    }
}

fn exec_update_planning_row(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    let index = match args.get("index").and_then(|v| v.as_u64()) {
        Some(i) => i as usize,
        None => return "Error: missing 'index' argument".into(),
    };

    let mut sketch = match project::read_sketch(&path) {
        Ok(s) => s,
        Err(e) => return format!("Error reading sketch: {e}"),
    };

    if index >= sketch.rows.len() {
        return format!(
            "Error: index {} out of range (sketch has {} rows)",
            index,
            sketch.rows.len()
        );
    }

    let row = &mut sketch.rows[index];
    if let Some(t) = args.get("time").and_then(|v| v.as_str()) {
        row.time = t.into();
    }
    if let Some(n) = args.get("narrative").and_then(|v| v.as_str()) {
        row.narrative = n.into();
    }
    if let Some(d) = args.get("demo_actions").and_then(|v| v.as_str()) {
        row.demo_actions = d.into();
    }

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => format!("Updated row {} in {}", index, path.display()),
        Err(e) => format!("Error writing sketch: {e}"),
    }
}
