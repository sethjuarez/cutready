//! Tool definitions and execution for the AI assistant.
//!
//! Each tool maps to a project operation (read notes, read/update sketches, etc.)
//! and is exposed to the LLM via function calling.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::engine::agent::llm::{ContentPart, FunctionDefinition, ImageUrlData, ToolCall, ToolDefinition};
use crate::engine::project;
use crate::models::sketch::PlanningRow;

// ---------------------------------------------------------------------------
// Image extraction and encoding for vision-capable models
// ---------------------------------------------------------------------------

/// Maximum image file size to encode (5MB).
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// Maximum number of images to include per tool result.
const MAX_IMAGES_PER_RESULT: usize = 5;

/// MIME type from file extension.
fn mime_from_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Extract image references from markdown content and encode them as base64 ContentParts.
/// Returns (cleaned_text, image_parts).
pub fn extract_and_encode_images(markdown: &str, root: &Path) -> (String, Vec<ContentPart>) {
    let mut parts = Vec::new();
    let mut cleaned = String::with_capacity(markdown.len());

    // Regex-free line-by-line scan for ![...](path) patterns
    for line in markdown.lines() {
        let mut pos = 0;
        let bytes = line.as_bytes();
        let mut line_cleaned = String::new();
        let mut found_image = false;

        while pos < bytes.len() {
            if bytes[pos] == b'!' && pos + 1 < bytes.len() && bytes[pos + 1] == b'[' {
                // Potential image: ![alt](path)
                if let Some(close_bracket) = line[pos + 2..].find(']') {
                    let after_bracket = pos + 2 + close_bracket + 1;
                    if after_bracket < bytes.len() && bytes[after_bracket] == b'(' {
                        if let Some(close_paren) = line[after_bracket + 1..].find(')') {
                            let img_path_str = &line[after_bracket + 1..after_bracket + 1 + close_paren];
                            // Try to encode the image
                            if let Some(part) = encode_image_file(root, img_path_str) {
                                if parts.len() < MAX_IMAGES_PER_RESULT {
                                    parts.push(part);
                                    found_image = true;
                                }
                            }
                            // Skip the image reference in cleaned text
                            pos = after_bracket + 1 + close_paren + 1;
                            continue;
                        }
                    }
                }
            }
            line_cleaned.push(bytes[pos] as char);
            pos += 1;
        }

        if found_image && line_cleaned.trim().is_empty() {
            // Skip lines that were just images
            continue;
        }
        cleaned.push_str(&line_cleaned);
        cleaned.push('\n');
    }

    (cleaned.trim_end().to_string(), parts)
}

/// Encode a single image file as a base64 data URI ContentPart.
fn encode_image_file(root: &Path, rel_path: &str) -> Option<ContentPart> {
    let path = root.join(rel_path);
    if !path.exists() || !path.is_file() {
        return None;
    }

    // Check size
    let metadata = std::fs::metadata(&path).ok()?;
    if metadata.len() > MAX_IMAGE_BYTES {
        log::debug!("[vision] skipping {} ({}MB > 5MB limit)", rel_path, metadata.len() / 1024 / 1024);
        return None;
    }

    let ext = path.extension()?.to_str()?;
    let mime = mime_from_ext(ext);
    if mime == "application/octet-stream" {
        return None;
    }

    let data = std::fs::read(&path).ok()?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    let data_uri = format!("data:{mime};base64,{b64}");

    log::debug!("[vision] encoded {} ({} bytes → {} b64 chars)", rel_path, data.len(), b64.len());

    Some(ContentPart::ImageUrl {
        image_url: ImageUrlData {
            url: data_uri,
            detail: Some("low".into()),
        },
    })
}

/// Encode a single image path (e.g., sketch screenshot) as a ContentPart.
pub fn encode_image_at_path(root: &Path, rel_path: &str) -> Option<ContentPart> {
    encode_image_file(root, rel_path)
}

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
            "set_row_visual",
            "Set an animated framing visual on a planning row using the elucim DSL. The visual replaces the screenshot for that row. Pass null to remove a visual.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch" },
                    "index": { "type": "integer", "description": "0-based row index" },
                    "visual": {
                        "description": "An elucim DSL document (JSON object with version and root), or null to remove",
                        "oneOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "version": { "type": "string", "enum": ["1.0"] },
                                    "root": {
                                        "type": "object",
                                        "description": "Root node — a scene, player, or presentation node. Scene node: { type: 'scene', width, height, children: [...] }. Player node: { type: 'player', width, height, fps, durationInFrames, children: [...] }. Children can be: circle, rect, line, arrow, text, group, polygon, image, axes, latex, graph, matrix, barChart. Text nodes use 'content' (not 'text') for the string. Animations: fadeIn (≥1), fadeOut (≥1), draw, easing. Omit fadeIn for instant visibility."
                                    }
                                },
                                "required": ["version", "root"]
                            },
                            { "type": "null" }
                        ]
                    }
                },
                "required": ["path", "index", "visual"]
            }),
        ),
        tool_def(
            "validate_dsl",
            "Validate an elucim DSL document without writing it. Returns validation errors if the document is malformed. Always call this BEFORE set_row_visual to catch issues early.",
            json!({
                "type": "object",
                "properties": {
                    "visual": {
                        "type": "object",
                        "description": "The elucim DSL document to validate (JSON with version and root)"
                    }
                },
                "required": ["visual"]
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
pub fn execute_tool(call: &ToolCall, project_root: &Path, vision_enabled: bool) -> String {
    let args: Value = serde_json::from_str(&call.function.arguments).unwrap_or(json!({}));
    let start = std::time::Instant::now();

    let result = match call.function.name.as_str() {
        "list_project_files" => exec_list_project_files(project_root),
        "read_note" => exec_read_note(project_root, &args, vision_enabled),
        "read_sketch" => exec_read_sketch(project_root, &args, vision_enabled),
        "set_planning_rows" => exec_set_planning_rows(project_root, &args),
        "update_planning_row" => exec_update_planning_row(project_root, &args),
        "set_row_visual" => exec_set_row_visual(project_root, &args),
        "validate_dsl" => exec_validate_dsl(&args),
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

fn exec_read_note(root: &Path, args: &Value, vision_enabled: bool) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    match project::read_note(&path) {
        Ok(content) => {
            if vision_enabled {
                let (text, image_parts) = extract_and_encode_images(&content, root);
                if !image_parts.is_empty() {
                    // Embed base64 image data as JSON in the tool result so the runner
                    // can reconstruct multimodal content for the next LLM call.
                    let images_json: Vec<String> = image_parts.iter().filter_map(|p| {
                        serde_json::to_string(p).ok()
                    }).collect();
                    log::info!("[vision] read_note: {} images extracted", images_json.len());
                    format!("{text}\n\n[VISION_IMAGES]{}", images_json.join("\n"))
                } else {
                    content
                }
            } else {
                content
            }
        }
        Err(e) => format!("Error reading note: {e}"),
    }
}

fn exec_read_sketch(root: &Path, args: &Value, vision_enabled: bool) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    match project::read_sketch(&path) {
        Ok(sketch) => {
            let mut out = format!("# {}\n\n", sketch.title);
            let mut image_parts: Vec<ContentPart> = Vec::new();
            for (i, row) in sketch.rows.iter().enumerate() {
                let screenshot_line = match &row.screenshot {
                    Some(img_path) => {
                        if vision_enabled {
                            if let Some(part) = encode_image_at_path(root, img_path) {
                                image_parts.push(part);
                            }
                        }
                        format!("**Screenshot:** {}\n", img_path)
                    }
                    None => String::new(),
                };
                out.push_str(&format!(
                    "## Row {} [{}]\n**Narrative:** {}\n**Actions:** {}\n{}\n",
                    i, row.time, row.narrative, row.demo_actions, screenshot_line
                ));
            }
            if vision_enabled && !image_parts.is_empty() {
                let images_json: Vec<String> = image_parts.iter().filter_map(|p| {
                    serde_json::to_string(p).ok()
                }).collect();
                log::info!("[vision] read_sketch: {} screenshots extracted", images_json.len());
                format!("{out}\n[VISION_IMAGES]{}", images_json.join("\n"))
            } else {
                out
            }
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
                visual: r.get("visual").cloned(),
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

fn exec_set_row_visual(root: &Path, args: &Value) -> String {
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

    // null → remove visual, object → set visual
    match args.get("visual") {
        Some(v) if v.is_null() => {
            row.visual = None;
        }
        Some(v) if v.is_object() => {
            row.visual = Some(v.clone());
            // Clear screenshot since visual replaces it
            row.screenshot = None;
        }
        _ => return "Error: 'visual' must be an elucim DSL document object or null".into(),
    }

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => {
            if sketch.rows[index].visual.is_some() {
                format!("Set animated visual on row {} in {}", index, path.display())
            } else {
                format!("Removed visual from row {} in {}", index, path.display())
            }
        }
        Err(e) => format!("Error writing sketch: {e}"),
    }
}

// Valid elucim DSL root node types
const VALID_ROOT_TYPES: &[&str] = &["scene", "player", "presentation"];

// Valid elucim DSL child node types
const VALID_NODE_TYPES: &[&str] = &[
    "circle", "rect", "line", "arrow", "text", "group", "polygon",
    "image", "axes", "latex", "graph", "matrix", "barChart", "slide",
    "bezierCurve", "codeBlock",
];

fn validate_dsl_node(node: &Value, path: &str, errors: &mut Vec<String>) {
    let obj = match node.as_object() {
        Some(o) => o,
        None => {
            errors.push(format!("{path}: expected object, got {}", node_type_name(node)));
            return;
        }
    };

    if let Some(t) = obj.get("type").and_then(|v| v.as_str()) {
        if !VALID_ROOT_TYPES.contains(&t) && !VALID_NODE_TYPES.contains(&t) {
            errors.push(format!("{path}.type: unknown node type \"{t}\". Valid types: {}", VALID_NODE_TYPES.join(", ")));
        }
        // scene/player require width, height
        if (t == "scene" || t == "player") && path == "root" {
            if !obj.contains_key("width") || !obj.contains_key("height") {
                errors.push(format!("{path}: {t} requires width and height"));
            }
        }
        // player requires fps and durationInFrames
        if t == "player" && path == "root" {
            if !obj.contains_key("fps") {
                errors.push(format!("{path}: player requires fps"));
            }
            if !obj.contains_key("durationInFrames") {
                errors.push(format!("{path}: player requires durationInFrames"));
            }
        }
        // text nodes require the "content" property (NOT "text")
        if t == "text" {
            if !obj.contains_key("content") {
                if obj.contains_key("text") {
                    errors.push(format!("{path}: text node uses \"content\" not \"text\" for the string value"));
                } else {
                    errors.push(format!("{path}: text node requires a \"content\" string"));
                }
            }
        }
        // fadeIn/fadeOut/draw must be positive (≥ 1), not zero
        for anim_prop in &["fadeIn", "fadeOut", "draw"] {
            if let Some(v) = obj.get(*anim_prop) {
                if let Some(n) = v.as_f64() {
                    if n < 1.0 {
                        errors.push(format!("{path}.{anim_prop}: must be ≥ 1 (got {n}). Omit the property for instant visibility at frame 0."));
                    }
                } else if !v.is_number() {
                    errors.push(format!("{path}.{anim_prop}: must be a positive number"));
                }
            }
        }
    } else if path != "root" {
        // Non-root nodes must have a type
        errors.push(format!("{path}: missing \"type\" property"));
    }

    // Recursively validate children
    if let Some(children) = obj.get("children").and_then(|v| v.as_array()) {
        for (i, child) in children.iter().enumerate() {
            validate_dsl_node(child, &format!("{path}.children[{i}]"), errors);
        }
    }
}

fn node_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn exec_validate_dsl(args: &Value) -> String {
    let visual = match args.get("visual") {
        Some(v) if v.is_object() => v,
        _ => return "Error: 'visual' must be a JSON object".into(),
    };

    let mut errors = Vec::new();

    // Check version
    match visual.get("version") {
        Some(v) if v.as_str() == Some("1.0") => {}
        Some(v) => errors.push(format!("version: expected \"1.0\", got {v}")),
        None => errors.push("missing required field \"version\" (must be \"1.0\")".into()),
    }

    // Check root
    match visual.get("root") {
        Some(root) if root.is_object() => {
            // Check root type
            match root.get("type").and_then(|v| v.as_str()) {
                Some(t) if VALID_ROOT_TYPES.contains(&t) => {}
                Some(t) => errors.push(format!(
                    "root.type: \"{t}\" is not a valid root type. Must be one of: {}",
                    VALID_ROOT_TYPES.join(", ")
                )),
                None => errors.push("root: missing \"type\" property".into()),
            }
            // Validate children recursively
            if let Some(children) = root.get("children").and_then(|v| v.as_array()) {
                for (i, child) in children.iter().enumerate() {
                    validate_dsl_node(child, &format!("root.children[{i}]"), &mut errors);
                }
            }
            // Validate root-level requirements
            validate_dsl_node(root, "root", &mut errors);
        }
        Some(_) => errors.push("root: must be an object".into()),
        None => errors.push("missing required field \"root\"".into()),
    }

    if errors.is_empty() {
        "Valid — no structural errors found. The DSL document looks correct.".into()
    } else {
        format!("Validation failed ({} error{}):\n{}", errors.len(), if errors.len() == 1 { "" } else { "s" }, errors.iter().map(|e| format!("  • {e}")).collect::<Vec<_>>().join("\n"))
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
