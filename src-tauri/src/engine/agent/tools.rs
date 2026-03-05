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
                    "path": { "type": "string", "description": "Relative path exactly as returned by list_project_files (e.g. 'getting-started.md' or 'docs/overview.md')" }
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
                    "path": { "type": "string", "description": "Relative path exactly as returned by list_project_files (e.g. 'introduction.sk' or 'demos/overview.sk')" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "set_planning_rows",
            "Replace ALL planning rows in a sketch, or create a new sketch if it doesn't exist yet. Use this to generate a full plan from scratch.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch. Use a path from list_project_files to update, or a new filename like 'my-sketch.sk' to create" },
                    "title": { "type": "string", "description": "Title for the sketch (optional, used when creating a new sketch)" },
                    "description": { "type": "string", "description": "Brief description of the sketch content and purpose (optional)" },
                    "rows": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "time": { "type": "string", "description": "Duration (e.g. '~30s', '1:00')" },
                                "narrative": { "type": "string", "description": "Voiceover/narration bullets" },
                                "demo_actions": { "type": "string", "description": "On-screen action bullets" },
                                "screenshot": { "type": "string", "description": "Optional path to a screenshot image (relative, e.g. '.cutready/screenshots/pasted-123.png'). Use list_project_images or read the note content to find existing image paths." }
                            },
                            "required": ["time", "narrative", "demo_actions"]
                        }
                    }
                },
                "required": ["path", "rows"]
            }),
        ),
        tool_def(
            "list_project_images",
            "List all images/screenshots in the project's .cutready/screenshots directory. Returns paths that can be used as screenshot values in planning rows.",
            json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        ),
        tool_def(
            "update_planning_row",
            "Update a single planning row by index. Only fields provided are changed.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path exactly as returned by list_project_files" },
                    "index": { "type": "integer", "description": "0-based row index" },
                    "time": { "type": "string", "description": "New time value (optional)" },
                    "narrative": { "type": "string", "description": "New narrative (optional)" },
                    "demo_actions": { "type": "string", "description": "New demo actions (optional)" },
                    "screenshot": { "type": "string", "description": "New screenshot path (optional, e.g. '.cutready/screenshots/pasted-123.png')" }
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
        tool_def(
            "save_feedback",
            "Save user feedback about CutReady. Use this when the user wants to submit feedback, report a bug, request a feature, or share thoughts about the app or an interaction.",
            json!({
                "type": "object",
                "properties": {
                    "category": { "type": "string", "enum": ["General", "Bug", "Feature", "Design"], "description": "Feedback category" },
                    "feedback": { "type": "string", "description": "The user's feedback text" }
                },
                "required": ["category", "feedback"]
            }),
        ),
        tool_def(
            "update_note",
            "Update the full content of an existing note. Use this to clean up, restructure, or rewrite note content.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the note (from list_project_files)" },
                    "content": { "type": "string", "description": "The full markdown content for the note" }
                },
                "required": ["path", "content"]
            }),
        ),
        tool_def(
            "create_note",
            "Create a brand new note in the project. Use this when the user asks you to write something down, take notes, create a document, or save information from the conversation as a note.",
            json!({
                "type": "object",
                "properties": {
                    "filename": { "type": "string", "description": "Filename for the note (e.g. 'meeting-notes.md', 'ideas.md'). Will be created in the project root." },
                    "content": { "type": "string", "description": "The full markdown content for the note" }
                },
                "required": ["filename", "content"]
            }),
        ),
        tool_def(
            "update_storyboard",
            "Update the title and/or description of an existing storyboard.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the storyboard .sb file (from list_project_files)" },
                    "title": { "type": "string", "description": "New title for the storyboard (optional, keeps existing if omitted)" },
                    "description": { "type": "string", "description": "New description for the storyboard" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "recall_memory",
            "Search your memory for information from past conversations, saved facts, or session summaries. Use this when the user references something from a previous discussion, or when you need context about prior decisions. The search uses keyword matching — be specific.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Keywords to search for in memories (e.g. 'user preference narration style', 'login flow demo')" }
                },
                "required": ["query"]
            }),
        ),
        tool_def(
            "save_memory",
            "Save an important fact, decision, or preference to memory so you can recall it in future conversations. Use 'core' for persistent facts about the user or project (e.g. preferences, tech stack, team info). Use 'insight' for decisions or conclusions from the current conversation.",
            json!({
                "type": "object",
                "properties": {
                    "category": { "type": "string", "enum": ["core", "insight"], "description": "Memory category: 'core' for persistent facts, 'insight' for session-specific conclusions" },
                    "content": { "type": "string", "description": "The fact, preference, or insight to remember" },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "Optional tags for easier recall (e.g. ['preference', 'narration'] or ['demo', 'login'])" }
                },
                "required": ["category", "content"]
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
    let start = std::time::Instant::now();

    let result = match call.function.name.as_str() {
        "list_project_files" => exec_list_project_files(project_root),
        "read_note" => exec_read_note(project_root, &args),
        "read_sketch" => exec_read_sketch(project_root, &args),
        "set_planning_rows" => exec_set_planning_rows(project_root, &args),
        "update_planning_row" => exec_update_planning_row(project_root, &args),
        "list_project_images" => exec_list_project_images(project_root),
        "save_feedback" => exec_save_feedback(&args),
        "update_note" => exec_update_note(project_root, &args),
        "create_note" => exec_create_note(project_root, &args),
        "update_storyboard" => exec_update_storyboard(project_root, &args),
        "recall_memory" => exec_recall_memory(project_root, &args),
        "save_memory" => exec_save_memory(project_root, &args),
        other => format!("Unknown tool: {other}"),
    };

    log::debug!("[tool] {} → {}chars in {:?}", call.function.name, result.len(), start.elapsed());
    result
}

fn resolve_path(project_root: &Path, rel: &str) -> PathBuf {
    project_root.join(rel)
}

fn exec_list_project_files(root: &Path) -> String {
    let mut out = String::new();

    if let Ok(sketches) = project::scan_sketches(root) {
        out.push_str("## Sketches\n");
        out.push_str("Use the exact path value with read_sketch/set_planning_rows/update_planning_row.\n");
        for s in &sketches {
            out.push_str(&format!(
                "- path: \"{}\" — {} ({} rows)\n",
                s.path, s.title, s.row_count
            ));
        }
    }

    if let Ok(notes) = project::scan_notes(root) {
        out.push_str("\n## Notes\n");
        out.push_str("Use the exact path value with read_note or update_note.\n");
        for n in &notes {
            out.push_str(&format!("- path: \"{}\" — {}\n", n.path, n.title));
        }
    }

    if let Ok(storyboards) = project::scan_storyboards(root) {
        out.push_str("\n## Storyboards\n");
        out.push_str("Use the exact path value with update_storyboard.\n");
        for sb in &storyboards {
            out.push_str(&format!(
                "- path: \"{}\" — {} ({} sketches)\n",
                sb.path, sb.title, sb.sketch_count
            ));
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
                let screenshot_line = match &row.screenshot {
                    Some(path) => format!("**Screenshot:** {}\n", path),
                    None => String::new(),
                };
                out.push_str(&format!(
                    "## Row {} [{}]\n**Narrative:** {}\n**Actions:** {}\n{}\n",
                    i, row.time, row.narrative, row.demo_actions, screenshot_line
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
                screenshot: r.get("screenshot").and_then(|v| v.as_str()).map(|s| s.to_string()),
            })
            .collect(),
        None => return "Error: 'rows' must be an array".into(),
    };

    // Load existing sketch or create a new one
    let mut sketch = match project::read_sketch(&path) {
        Ok(s) => s,
        Err(_) => {
            // New sketch — use provided title or derive from filename
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    path.file_stem()
                        .map(|s| s.to_string_lossy().replace('-', " ").replace('_', " "))
                        .unwrap_or_else(|| "Untitled".into())
                });
            crate::models::sketch::Sketch {
                title,
                description: serde_json::Value::Null,
                rows: vec![],
                state: crate::models::sketch::SketchState::Draft,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            }
        }
    };

    // Apply optional title/description updates (works for both new and existing sketches)
    if let Some(t) = args.get("title").and_then(|v| v.as_str()) {
        sketch.title = t.to_string();
    }
    if let Some(d) = args.get("description").and_then(|v| v.as_str()) {
        sketch.description = serde_json::Value::String(d.to_string());
    }

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
    if let Some(s) = args.get("screenshot").and_then(|v| v.as_str()) {
        row.screenshot = Some(s.into());
    }

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => format!("Updated row {} in {}", index, path.display()),
        Err(e) => format!("Error writing sketch: {e}"),
    }
}

fn exec_list_project_images(root: &Path) -> String {
    let screenshots_dir = root.join(".cutready").join("screenshots");
    if !screenshots_dir.exists() {
        return "No screenshots directory found.".into();
    }
    let mut images = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&screenshots_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if matches!(ext.to_lowercase().as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg") {
                    if let Ok(rel) = path.strip_prefix(root) {
                        images.push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
        }
    }
    if images.is_empty() {
        return "No images found in .cutready/screenshots/".into();
    }
    images.sort();
    let mut out = format!("Found {} image(s):\n", images.len());
    for img in &images {
        out.push_str(&format!("  {}\n", img));
    }
    out.push_str("\nUse these paths as 'screenshot' values in set_planning_rows or update_planning_row.");
    out
}

fn exec_save_feedback(args: &Value) -> String {
    let category = args.get("category").and_then(|v| v.as_str()).unwrap_or("General");
    let feedback = match args.get("feedback").and_then(|v| v.as_str()) {
        Some(f) if !f.trim().is_empty() => f.trim(),
        _ => return "Error: feedback text is required".into(),
    };

    // Use the same app data path as commands/feedback.rs
    let data_dir = dirs::data_dir()
        .map(|d| d.join("com.cutready"))
        .unwrap_or_else(|| PathBuf::from("."));
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        return format!("Error creating data dir: {e}");
    }

    let path = data_dir.join("feedback.json");
    let mut entries: Vec<Value> = if path.exists() {
        let content = std::fs::read_to_string(&path).unwrap_or_else(|_| "[]".into());
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    entries.push(json!({
        "category": category,
        "feedback": feedback,
        "date": chrono::Utc::now().to_rfc3339(),
    }));

    match serde_json::to_string_pretty(&entries) {
        Ok(json) => match std::fs::write(&path, json) {
            Ok(()) => format!("Feedback saved: [{}] {}", category, feedback),
            Err(e) => format!("Error writing feedback: {e}"),
        },
        Err(e) => format!("Serialization error: {e}"),
    }
}

fn exec_update_note(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    let content = match args.get("content").and_then(|v| v.as_str()) {
        Some(c) => c,
        None => return "Error: missing 'content' argument".into(),
    };

    // Ensure parent directories exist for new notes
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return format!("Error creating directories: {e}");
            }
        }
    }

    match project::write_note(&path, content) {
        Ok(()) => format!("Updated note at {}", path.display()),
        Err(e) => format!("Error writing note: {e}"),
    }
}

fn exec_update_storyboard(root: &Path, args: &Value) -> String {
    let rel = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return "Error: missing 'path' argument".into(),
    };
    let abs = resolve_path(root, rel);

    // Read existing storyboard
    let mut sb = match project::read_storyboard(&abs) {
        Ok(sb) => sb,
        Err(e) => return format!("Error reading storyboard: {e}"),
    };

    // Apply updates
    if let Some(title) = args.get("title").and_then(|v| v.as_str()) {
        sb.title = title.to_string();
    }
    if let Some(desc) = args.get("description").and_then(|v| v.as_str()) {
        sb.description = desc.to_string();
    }
    sb.updated_at = chrono::Utc::now();

    match project::write_storyboard(&sb, &abs, root) {
        Ok(()) => format!("Updated storyboard \"{}\" at {}", sb.title, rel),
        Err(e) => format!("Error writing storyboard: {e}"),
    }
}

fn exec_create_note(root: &Path, args: &Value) -> String {
    let filename = match args.get("filename").and_then(|v| v.as_str()) {
        Some(f) => f,
        None => return "Error: missing 'filename' argument".into(),
    };
    let content = match args.get("content").and_then(|v| v.as_str()) {
        Some(c) => c,
        None => return "Error: missing 'content' argument".into(),
    };

    // Sanitize: ensure it ends with .md and has no path separators
    let safe_name = filename
        .trim()
        .replace(['/', '\\'], "-");
    let safe_name = if safe_name.ends_with(".md") {
        safe_name
    } else {
        format!("{safe_name}.md")
    };

    let path = resolve_path(root, &safe_name);
    if path.exists() {
        return format!("Error: note '{}' already exists. Use update_note to modify it.", safe_name);
    }

    match project::write_note(&path, content) {
        Ok(()) => format!("Created note '{}' successfully", safe_name),
        Err(e) => format!("Error creating note: {e}"),
    }
}

fn exec_recall_memory(root: &Path, args: &Value) -> String {
    let query = match args.get("query").and_then(|v| v.as_str()) {
        Some(q) => q,
        None => return "Error: missing 'query' argument".into(),
    };

    let results = crate::engine::memory::recall(root, query);
    crate::engine::memory::format_recall_results(&results)
}

fn exec_save_memory(root: &Path, args: &Value) -> String {
    let category = match args.get("category").and_then(|v| v.as_str()) {
        Some("core") => crate::engine::memory::MemoryCategory::Core,
        Some("insight") => crate::engine::memory::MemoryCategory::Insight,
        Some(other) => return format!("Error: unknown category '{other}'. Use 'core' or 'insight'."),
        None => return "Error: missing 'category' argument".into(),
    };

    let content = match args.get("content").and_then(|v| v.as_str()) {
        Some(c) => c,
        None => return "Error: missing 'content' argument".into(),
    };

    let tags: Vec<String> = args
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    match crate::engine::memory::save_memory(root, category, content, tags) {
        Ok(()) => format!("Memory saved: {content}"),
        Err(e) => format!("Error saving memory: {e}"),
    }
}
