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
            "critique_visual",
            "Critique an elucim DSL visual for readability, layout quality, and creativity. Returns issues (problems to fix) and suggestions (creative improvements). Call this after generating a visual and before set_row_visual. Fix any issues, then call set_row_visual.",
            json!({
                "type": "object",
                "properties": {
                    "visual": {
                        "type": "object",
                        "description": "The elucim DSL document to critique (JSON with version and root)"
                    }
                },
                "required": ["visual"]
            }),
        ),
        tool_def(
            "design_plan",
            "Save an English-language design brief for a planning row's visual. MUST be called before generating any DSL JSON. Describes layout, elements, spatial arrangement, color palette, and animation sequence in plain English. This is the conceptual planning pass of the 3-pass design workflow.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch" },
                    "index": { "type": "integer", "description": "0-based row index" },
                    "plan": {
                        "type": "string",
                        "description": "English description of the visual design: what elements to show, where they go on the 960×540 canvas, color choices, and animation sequence"
                    }
                },
                "required": ["path", "index", "plan"]
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
        "critique_visual" => exec_critique_visual(&args),
        "design_plan" => exec_design_plan(project_root, &args),
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
                let visual_line = match &row.visual {
                    Some(_) => "**Visual:** ✓ (elucim DSL attached)\n".to_string(),
                    None => String::new(),
                };
                let plan_line = match &row.design_plan {
                    Some(plan) => format!("**Design Plan:** {}\n", plan),
                    None => String::new(),
                };
                out.push_str(&format!(
                    "## Row {} [{}]\n**Narrative:** {}\n**Actions:** {}\n{}{}{}\n",
                    i, row.time, row.narrative, row.demo_actions, screenshot_line, visual_line, plan_line
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
                design_plan: r.get("design_plan").and_then(|v| v.as_str()).map(|s| s.to_string()),
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
            // Auto-validate before writing — catch errors the agent missed
            let mut errors = Vec::new();
            validate_dsl_doc(v, &mut errors);
            if !errors.is_empty() {
                return format!(
                    "Validation failed ({} error{}) — fix these before calling set_row_visual again:\n{}",
                    errors.len(),
                    if errors.len() == 1 { "" } else { "s" },
                    errors.iter().map(|e| format!("  • {e}")).collect::<Vec<_>>().join("\n")
                );
            }
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

fn exec_design_plan(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    let index = match args.get("index").and_then(|v| v.as_u64()) {
        Some(i) => i as usize,
        None => return "Error: missing 'index' argument".into(),
    };
    let plan = match args.get("plan").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => return "Error: missing 'plan' argument".into(),
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

    sketch.rows[index].design_plan = Some(plan.clone());

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => {
            format!(
                "Design plan saved for row {}. Now generate the DSL JSON based on this plan:\n\n{}",
                index, plan
            )
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
        // polygon requires points array with ≥ 3 entries, each [number, number]
        if t == "polygon" {
            match obj.get("points").and_then(|v| v.as_array()) {
                Some(pts) => {
                    if pts.len() < 3 {
                        errors.push(format!("{path}.points: polygon requires at least 3 points (got {})", pts.len()));
                    }
                    for (i, pt) in pts.iter().enumerate() {
                        if let Some(arr) = pt.as_array() {
                            if arr.len() != 2 || !arr[0].is_number() || !arr[1].is_number() {
                                errors.push(format!("{path}.points[{i}]: each point must be [number, number]"));
                            }
                        } else {
                            errors.push(format!("{path}.points[{i}]: each point must be [number, number], got {}", node_type_name(pt)));
                        }
                    }
                }
                None => {
                    if obj.contains_key("points") {
                        errors.push(format!("{path}.points: must be an array of [number, number] pairs"));
                    } else {
                        errors.push(format!("{path}: polygon requires a \"points\" array"));
                    }
                }
            }
        }
        // line requires x1, y1, x2, y2 as numbers
        if t == "line" || t == "arrow" {
            for coord in &["x1", "y1", "x2", "y2"] {
                match obj.get(*coord) {
                    Some(v) if v.is_number() => {}
                    Some(_) => errors.push(format!("{path}.{coord}: must be a number")),
                    None => errors.push(format!("{path}: {t} requires \"{coord}\"")),
                }
            }
        }
        // bezierCurve requires points array, each [number, number]
        if t == "bezierCurve" {
            if let Some(pts) = obj.get("points").and_then(|v| v.as_array()) {
                for (i, pt) in pts.iter().enumerate() {
                    if let Some(arr) = pt.as_array() {
                        if arr.len() != 2 || !arr[0].is_number() || !arr[1].is_number() {
                            errors.push(format!("{path}.points[{i}]: each point must be [number, number]"));
                        }
                    } else {
                        errors.push(format!("{path}.points[{i}]: each point must be [number, number], got {}", node_type_name(pt)));
                    }
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

/// Validate a DSL document object, collecting errors into the provided Vec.
fn validate_dsl_doc(visual: &Value, errors: &mut Vec<String>) {
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
                    validate_dsl_node(child, &format!("root.children[{i}]"), &mut *errors);
                }
            }
            // Validate root-level requirements
            validate_dsl_node(root, "root", &mut *errors);
        }
        Some(_) => errors.push("root: must be an object".into()),
        None => errors.push("missing required field \"root\"".into()),
    }
}

fn exec_validate_dsl(args: &Value) -> String {
    let visual = match args.get("visual") {
        Some(v) if v.is_object() => v,
        _ => return "Error: 'visual' must be a JSON object".into(),
    };

    let mut errors = Vec::new();
    validate_dsl_doc(visual, &mut errors);

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

// ---------------------------------------------------------------------------
// critique_visual — deterministic layout/readability checks + creative hints
// ---------------------------------------------------------------------------

/// Approximate bounding box for an element.
#[derive(Debug, Clone)]
struct BBox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    label: String,
}

impl BBox {
    fn overlap_area(&self, other: &BBox) -> f64 {
        let ox = (self.x + self.w).min(other.x + other.w) - self.x.max(other.x);
        let oy = (self.y + self.h).min(other.y + other.h) - self.y.max(other.y);
        if ox > 0.0 && oy > 0.0 { ox * oy } else { 0.0 }
    }
}

/// Extract approximate bounding boxes from a flat list of nodes.
fn extract_bboxes(children: &[Value], offset_x: f64, offset_y: f64) -> Vec<BBox> {
    let mut boxes = Vec::new();
    for node in children {
        let obj = match node.as_object() { Some(o) => o, None => continue };
        let t = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "text" => {
                let x = obj.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_x;
                let y = obj.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_y;
                let fs = obj.get("fontSize").and_then(|v| v.as_f64()).unwrap_or(16.0);
                let content = obj.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let char_width = fs * 0.55;
                let text_w = content.len() as f64 * char_width;
                let text_h = fs * 1.3;
                let anchor = obj.get("textAnchor").and_then(|v| v.as_str()).unwrap_or("start");
                let bx = match anchor {
                    "middle" => x - text_w / 2.0,
                    "end" => x - text_w,
                    _ => x,
                };
                let by = y - fs; // text y is baseline
                boxes.push(BBox { x: bx, y: by, w: text_w, h: text_h, label: format!("text '{}'", truncate(content, 20)) });
            }
            "rect" => {
                let x = obj.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_x;
                let y = obj.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_y;
                let w = obj.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = obj.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                boxes.push(BBox { x, y, w, h, label: "rect".into() });
            }
            "circle" => {
                let cx = obj.get("cx").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_x;
                let cy = obj.get("cy").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_y;
                let r = obj.get("r").and_then(|v| v.as_f64()).unwrap_or(0.0);
                boxes.push(BBox { x: cx - r, y: cy - r, w: 2.0 * r, h: 2.0 * r, label: "circle".into() });
            }
            "group" => {
                let gx = obj.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_x;
                let gy = obj.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_y;
                if let Some(gc) = obj.get("children").and_then(|v| v.as_array()) {
                    boxes.extend(extract_bboxes(gc, gx, gy));
                }
            }
            _ => {} // lines, arrows don't have meaningful bounding boxes for overlap
        }
    }
    boxes
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { s.to_string() } else { format!("{}…", &s[..max]) }
}

fn exec_critique_visual(args: &Value) -> String {
    let visual = match args.get("visual") {
        Some(v) if v.is_object() => v,
        _ => return "Error: 'visual' must be a JSON object with version and root".into(),
    };

    let root = match visual.get("root") {
        Some(r) if r.is_object() => r,
        _ => return "Error: visual must have a 'root' object".into(),
    };

    let children = root.get("children").and_then(|v| v.as_array());
    let children = match children {
        Some(c) => c,
        None => return "Error: root has no children array".into(),
    };

    let canvas_w = root.get("width").and_then(|v| v.as_f64()).unwrap_or(960.0);
    let canvas_h = root.get("height").and_then(|v| v.as_f64()).unwrap_or(540.0);
    let bg = root.get("background").and_then(|v| v.as_str()).unwrap_or("");

    let mut issues: Vec<String> = Vec::new();
    let mut suggestions: Vec<String> = Vec::new();

    // Flatten children (including group contents) for analysis
    let all_nodes = flatten_nodes(children);
    let text_nodes = collect_text_nodes(children, 0.0, 0.0);
    let bboxes = extract_bboxes(children, 0.0, 0.0);

    // ── Issue checks ──────────────────────────────────────────────────

    // 1. Element count (relaxed — rich visuals are fine, 40+ is excessive)
    if all_nodes.len() > 40 {
        issues.push(format!(
            "TOO_MANY_ELEMENTS: {} elements total (max recommended: 35). Simplify — remove decorative elements or combine related items into groups.",
            all_nodes.len()
        ));
    } else if all_nodes.len() > 35 {
        suggestions.push(format!(
            "ELEMENT_COUNT: {} elements — consider trimming to ~30 for cleaner design.", all_nodes.len()
        ));
    }

    // 1b. Redundant full-canvas background rectangle
    if let Some(first) = children.first() {
        let is_rect = first.get("type").and_then(|v| v.as_str()) == Some("rect");
        let rx = first.get("x").and_then(|v| v.as_f64()).unwrap_or(f64::MAX);
        let ry = first.get("y").and_then(|v| v.as_f64()).unwrap_or(f64::MAX);
        let rw = first.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let rh = first.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if is_rect && rx <= 5.0 && ry <= 5.0 && rw >= canvas_w - 10.0 && rh >= canvas_h - 10.0 {
            let fill = first.get("fill").and_then(|v| v.as_str()).unwrap_or("");
            if fill.starts_with('$') && fill.contains("background") {
                issues.push(
                    "REDUNDANT_BG_RECT: first child is a full-canvas rect with $background fill — REMOVE it. The root 'background' property already fills the entire canvas.".into()
                );
            }
        }
        // Catch inner "card" rect with margins that doesn't fill edge-to-edge
        if is_rect && rw >= canvas_w * 0.85 && rh >= canvas_h * 0.85
            && (rx > 10.0 || ry > 10.0)
        {
            let fill = first.get("fill").and_then(|v| v.as_str()).unwrap_or("");
            if fill.starts_with('$') {
                issues.push(
                    "INNER_CARD_RECT: first child is a near-full-canvas rect with margins — REMOVE it. Content should fill the canvas edge-to-edge. Use the root 'background' for the base, and place elements directly without an inner card wrapper.".into()
                );
            }
        }
    }

    // 2. Font size checks
    for tn in &text_nodes {
        if tn.font_size < 14.0 {
            issues.push(format!(
                "TINY_FONT: text '{}' has fontSize {:.0} — minimum is 14. Increase to at least 14 for annotations, 18 for labels, 32 for titles.",
                truncate(&tn.content, 25), tn.font_size
            ));
        } else if tn.font_size < 18.0 && tn.content.len() < 30 {
            // Short text that could be a label — suggest bigger
            suggestions.push(format!(
                "SMALL_LABEL: text '{}' is fontSize {:.0} — consider 18+ for better readability.",
                truncate(&tn.content, 25), tn.font_size
            ));
        }
    }

    // 3. Token usage — mandatory tokens
    if !bg.starts_with('$') && bg != "" {
        issues.push(format!(
            "MISSING_BG_TOKEN: root background is '{}' — MUST use '$background' so the visual adapts to dark/light themes.",
            truncate(bg, 20)
        ));
    }
    // Check text fills for token usage
    let mut text_fills_without_token = 0;
    for tn in &text_nodes {
        if !tn.fill.starts_with('$') && !tn.fill.is_empty() {
            text_fills_without_token += 1;
        }
    }
    let total_texts = text_nodes.len();
    if total_texts > 0 && text_fills_without_token == total_texts {
        issues.push(
            "NO_TEXT_TOKENS: ALL text uses hardcoded colors — at least titles and annotations should use $foreground/$muted for theme compatibility.".into()
        );
    } else if total_texts > 2 && text_fills_without_token as f64 / total_texts as f64 > 0.7 {
        suggestions.push(format!(
            "LOW_TOKEN_USAGE: {text_fills_without_token}/{total_texts} text fills are hardcoded hex — use $foreground for titles and $muted for secondary text."
        ));
    }

    // 4. Overlap detection (text-on-text only — most impactful)
    let text_bboxes: Vec<&BBox> = bboxes.iter().filter(|b| b.label.starts_with("text")).collect();
    for i in 0..text_bboxes.len() {
        for j in (i + 1)..text_bboxes.len() {
            let a = text_bboxes[i];
            let b = text_bboxes[j];
            let area = a.overlap_area(b);
            let min_area = (a.w * a.h).min(b.w * b.h);
            if min_area > 0.0 && area / min_area > 0.3 {
                issues.push(format!(
                    "TEXT_OVERLAP: {} overlaps with {} — move them apart or remove one.",
                    a.label, b.label
                ));
            }
        }
    }

    // 5. Margin violations (text only — shapes/rects can go edge-to-edge)
    let margin = 30.0;
    for bbox in &bboxes {
        if bbox.label.starts_with("text") {
            if bbox.x < margin || bbox.y < margin
                || bbox.x + bbox.w > canvas_w - margin
                || bbox.y + bbox.h > canvas_h - margin
            {
                issues.push(format!(
                    "MARGIN_VIOLATION: {} extends beyond {}px margin (at {:.0},{:.0} size {:.0}x{:.0}). Keep content inside the safe area.",
                    bbox.label, margin, bbox.x, bbox.y, bbox.w, bbox.h
                ));
            }
        }
    }

    // 6. Text overflow — text inside a container rect that exceeds rect bounds
    let rect_bboxes: Vec<&BBox> = bboxes.iter().filter(|b| b.label == "rect").collect();
    let text_bboxes_all: Vec<&BBox> = bboxes.iter().filter(|b| b.label.starts_with("text")).collect();
    for tb in &text_bboxes_all {
        // Check if text's center is inside any rect (= text is meant to be in that rect)
        let text_cx = tb.x + tb.w / 2.0;
        let text_cy = tb.y + tb.h / 2.0;
        let mut best_rect: Option<&BBox> = None;
        let mut best_area = f64::MAX;
        for rb in &rect_bboxes {
            if text_cx >= rb.x && text_cx <= rb.x + rb.w
                && text_cy >= rb.y && text_cy <= rb.y + rb.h
                && rb.w * rb.h < best_area
            {
                best_rect = Some(rb);
                best_area = rb.w * rb.h;
            }
        }
        if let Some(container) = best_rect {
            let overshoot_left = container.x - tb.x;
            let overshoot_right = (tb.x + tb.w) - (container.x + container.w);
            let overshoot_bottom = (tb.y + tb.h) - (container.y + container.h);
            let max_overshoot = overshoot_left.max(overshoot_right).max(overshoot_bottom);
            if max_overshoot > 10.0 {
                issues.push(format!(
                    "TEXT_OVERFLOW: {} overflows its container rect by {:.0}px. Shorten the text, reduce fontSize, or widen the container.",
                    tb.label, max_overshoot
                ));
            }
        }
    }

    // ── Creative suggestions ──────────────────────────────────────────

    // 6. Shape variety
    let mut type_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for node in &all_nodes {
        if let Some(t) = node.get("type").and_then(|v| v.as_str()) {
            *type_counts.entry(t.to_string()).or_insert(0) += 1;
        }
    }
    let shape_types: Vec<&str> = ["rect", "circle", "arrow", "line", "polygon"]
        .iter()
        .filter(|t| type_counts.contains_key(**t))
        .copied()
        .collect();
    if shape_types.len() == 1 {
        suggestions.push(format!(
            "LOW_VARIETY: only uses '{}' shapes — mix in arrows, circles, or lines for visual interest.",
            shape_types[0]
        ));
    }

    // 7. Animation usage
    let has_animation = all_nodes.iter().any(|n| {
        n.get("fadeIn").is_some() || n.get("draw").is_some() || n.get("fadeOut").is_some()
    });
    if !has_animation {
        suggestions.push(
            "NO_ANIMATION: no fadeIn/draw/fadeOut found — add staggered fadeIn for progressive reveal (e.g., fadeIn: 5, 15, 25…).".into()
        );
    }

    // 8. Spatial distribution — check if content is clustered
    if !bboxes.is_empty() {
        let avg_y: f64 = bboxes.iter().map(|b| b.y + b.h / 2.0).sum::<f64>() / bboxes.len() as f64;
        let avg_x: f64 = bboxes.iter().map(|b| b.x + b.w / 2.0).sum::<f64>() / bboxes.len() as f64;
        if avg_y < canvas_h * 0.35 {
            suggestions.push("TOP_HEAVY: content is concentrated in the upper third — use more vertical space.".into());
        } else if avg_y > canvas_h * 0.65 {
            suggestions.push("BOTTOM_HEAVY: content is concentrated in the lower third — balance the layout.".into());
        }
        if avg_x < canvas_w * 0.35 {
            suggestions.push("LEFT_HEAVY: content is clustered on the left — spread across the width.".into());
        } else if avg_x > canvas_w * 0.65 {
            suggestions.push("RIGHT_HEAVY: content is clustered on the right — balance the layout.".into());
        }
    }

    // 9. Color variety
    let mut accent_colors: std::collections::HashSet<String> = std::collections::HashSet::new();
    for node in &all_nodes {
        for key in &["fill", "stroke"] {
            if let Some(c) = node.get(*key).and_then(|v| v.as_str()) {
                if c.starts_with('#') || c.starts_with("rgb") {
                    accent_colors.insert(c.to_string());
                }
            }
        }
    }
    if accent_colors.len() == 1 {
        suggestions.push(
            "MONOTONE: only 1 accent color used — add a 2nd complementary color for visual depth (e.g., pair blue with green or purple).".into()
        );
    }

    // ── Build response ────────────────────────────────────────────────

    let pass = issues.is_empty();
    let mut response = String::new();

    if pass && suggestions.is_empty() {
        response.push_str("✓ PASS — visual looks good! Proceed with set_row_visual.\n");
    } else if pass {
        response.push_str("✓ PASS — no issues found, but here are some ideas to make it even better:\n\n");
    } else {
        response.push_str(&format!("✗ FAIL — {} issue(s) to fix:\n\n", issues.len()));
    }

    for (i, issue) in issues.iter().enumerate() {
        response.push_str(&format!("  ISSUE {}: {}\n", i + 1, issue));
    }
    if !issues.is_empty() && !suggestions.is_empty() {
        response.push('\n');
    }
    for (i, sug) in suggestions.iter().enumerate() {
        response.push_str(&format!("  SUGGEST {}: {}\n", i + 1, sug));
    }

    if !pass {
        response.push_str("\nFix the issues above, then call critique_visual again to verify.");
    }

    response
}

/// Collect text nodes with their properties for analysis.
struct TextNodeInfo {
    content: String,
    font_size: f64,
    fill: String,
}

fn collect_text_nodes(children: &[Value], offset_x: f64, offset_y: f64) -> Vec<TextNodeInfo> {
    let mut result = Vec::new();
    for node in children {
        let obj = match node.as_object() { Some(o) => o, None => continue };
        let t = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if t == "text" {
            result.push(TextNodeInfo {
                content: obj.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                font_size: obj.get("fontSize").and_then(|v| v.as_f64()).unwrap_or(16.0),
                fill: obj.get("fill").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            });
        } else if t == "group" {
            let gx = obj.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_x;
            let gy = obj.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_y;
            if let Some(gc) = obj.get("children").and_then(|v| v.as_array()) {
                result.extend(collect_text_nodes(gc, gx, gy));
            }
        }
    }
    result
}

/// Flatten all nodes (including group children) into a single list.
fn flatten_nodes(children: &[Value]) -> Vec<&Value> {
    let mut result = Vec::new();
    for node in children {
        result.push(node);
        if let Some(gc) = node.get("children").and_then(|v| v.as_array()) {
            result.extend(flatten_nodes(gc));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn critique_catches_tiny_fonts() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "text", "content": "Title", "x": 480, "y": 50, "fontSize": 32, "fill": "$foreground", "textAnchor": "middle" },
                    { "type": "text", "content": "tiny annotation", "x": 480, "y": 500, "fontSize": 8, "fill": "$muted", "textAnchor": "middle" }
                ]
            }
        });
        let result = exec_critique_visual(&json!({ "visual": visual }));
        assert!(result.contains("TINY_FONT"), "Should flag fontSize 8 as too small: {result}");
    }

    #[test]
    fn critique_catches_missing_bg_token() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "#0f172a",
                "children": [
                    { "type": "text", "content": "Hello", "x": 480, "y": 100, "fontSize": 32, "fill": "#ffffff", "textAnchor": "middle" }
                ]
            }
        });
        let result = exec_critique_visual(&json!({ "visual": visual }));
        assert!(result.contains("MISSING_BG_TOKEN"), "Should flag hardcoded background: {result}");
        assert!(result.contains("NO_TEXT_TOKENS"), "Should flag all-hex text fills: {result}");
    }

    #[test]
    fn critique_catches_text_overlap() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "text", "content": "First line", "x": 480, "y": 100, "fontSize": 24, "fill": "$foreground", "textAnchor": "middle" },
                    { "type": "text", "content": "Second line", "x": 480, "y": 105, "fontSize": 24, "fill": "$foreground", "textAnchor": "middle" }
                ]
            }
        });
        let result = exec_critique_visual(&json!({ "visual": visual }));
        assert!(result.contains("TEXT_OVERLAP"), "Should detect overlapping text at y=100 and y=105: {result}");
    }

    #[test]
    fn critique_passes_clean_visual() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 90,
                "background": "$background",
                "children": [
                    { "type": "rect", "x": 60, "y": 60, "width": 840, "height": 420, "fill": "$surface", "stroke": "$border", "rx": 16 },
                    { "type": "text", "content": "Title", "x": 480, "y": 120, "fontSize": 34, "fill": "$foreground", "fontWeight": "bold", "textAnchor": "middle", "fadeIn": 5 },
                    { "type": "text", "content": "subtitle", "x": 480, "y": 155, "fontSize": 18, "fill": "$muted", "textAnchor": "middle", "fadeIn": 10 },
                    { "type": "rect", "x": 120, "y": 200, "width": 300, "height": 120, "fill": "rgba(56,189,248,0.1)", "stroke": "#38bdf8", "strokeWidth": 2, "rx": 14, "fadeIn": 20 },
                    { "type": "text", "content": "Feature A", "x": 270, "y": 268, "fontSize": 22, "fill": "#38bdf8", "fontWeight": "700", "textAnchor": "middle", "fadeIn": 22 },
                    { "type": "arrow", "x1": 440, "y1": 260, "x2": 520, "y2": 260, "stroke": "#38bdf8", "strokeWidth": 2, "headSize": 10, "draw": 30 },
                    { "type": "rect", "x": 540, "y": 200, "width": 300, "height": 120, "fill": "rgba(34,197,94,0.08)", "stroke": "#22c55e", "strokeWidth": 2, "rx": 14, "fadeIn": 35 },
                    { "type": "text", "content": "Feature B", "x": 690, "y": 268, "fontSize": 22, "fill": "#22c55e", "fontWeight": "700", "textAnchor": "middle", "fadeIn": 37 }
                ]
            }
        });
        let result = exec_critique_visual(&json!({ "visual": visual }));
        assert!(result.starts_with("✓ PASS"), "Clean visual should pass: {result}");
    }

    #[test]
    fn critique_suggests_shape_variety() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "text", "content": "Title", "x": 480, "y": 80, "fontSize": 34, "fill": "$foreground", "textAnchor": "middle", "fadeIn": 5 },
                    { "type": "rect", "x": 100, "y": 150, "width": 200, "height": 100, "fill": "$surface", "stroke": "#38bdf8", "rx": 12, "fadeIn": 10 },
                    { "type": "rect", "x": 400, "y": 150, "width": 200, "height": 100, "fill": "$surface", "stroke": "#38bdf8", "rx": 12, "fadeIn": 20 },
                    { "type": "rect", "x": 700, "y": 150, "width": 200, "height": 100, "fill": "$surface", "stroke": "#38bdf8", "rx": 12, "fadeIn": 30 }
                ]
            }
        });
        let result = exec_critique_visual(&json!({ "visual": visual }));
        assert!(result.contains("LOW_VARIETY"), "Should suggest shape variety: {result}");
    }

    #[test]
    fn critique_catches_text_overflow_container() {
        // Text "This is a very long label text" at fontSize 20 ≈ 330px wide
        // but the container rect is only 200px wide → overflow
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "rect", "x": 200, "y": 150, "width": 200, "height": 80, "fill": "$surface", "stroke": "$border", "rx": 12 },
                    { "type": "text", "content": "This is a very long label text", "x": 300, "y": 200, "fontSize": 20, "fill": "$foreground", "textAnchor": "middle" }
                ]
            }
        });
        let result = exec_critique_visual(&json!({ "visual": visual }));
        assert!(result.contains("TEXT_OVERFLOW"), "Should detect text overflowing container: {result}");
    }

    #[test]
    fn critique_catches_redundant_bg_rect() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "rect", "x": 0, "y": 0, "width": 960, "height": 540, "fill": "$background" },
                    { "type": "text", "content": "Hello", "x": 480, "y": 270, "fontSize": 34, "fill": "$foreground", "textAnchor": "middle" }
                ]
            }
        });
        let result = exec_critique_visual(&json!({ "visual": visual }));
        assert!(result.contains("REDUNDANT_BG_RECT"), "Should catch redundant background rect: {result}");
    }

    #[test]
    fn critique_catches_inner_card_rect() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "rect", "x": 30, "y": 24, "width": 900, "height": 492, "fill": "$surface", "rx": 20, "stroke": "$border" },
                    { "type": "text", "content": "Title", "x": 480, "y": 100, "fontSize": 34, "fill": "$foreground", "textAnchor": "middle" }
                ]
            }
        });
        let result = exec_critique_visual(&json!({ "visual": visual }));
        assert!(result.contains("INNER_CARD_RECT"), "Should catch inner card rect with margins: {result}");
    }

    #[test]
    fn validate_dsl_catches_bad_polygon_points() {
        // Points as objects instead of [number, number] arrays
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "polygon", "points": [{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 50, "y": 100}], "fill": "$accent" }
                ]
            }
        });
        let result = exec_validate_dsl(&json!({ "visual": visual }));
        assert!(result.contains("point must be [number, number]"), "Should catch object points: {result}");
    }

    #[test]
    fn validate_dsl_accepts_valid_polygon() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "polygon", "points": [[0, 0], [100, 0], [50, 100]], "fill": "$accent" }
                ]
            }
        });
        let result = exec_validate_dsl(&json!({ "visual": visual }));
        assert!(result.contains("Valid"), "Should accept valid polygon: {result}");
    }

    #[test]
    fn validate_dsl_catches_polygon_too_few_points() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "polygon", "points": [[0, 0], [100, 0]], "fill": "$accent" }
                ]
            }
        });
        let result = exec_validate_dsl(&json!({ "visual": visual }));
        assert!(result.contains("at least 3 points"), "Should require 3+ points: {result}");
    }

    #[test]
    fn validate_dsl_catches_missing_line_coords() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "line", "x1": 0, "y1": 0, "stroke": "$foreground" }
                ]
            }
        });
        let result = exec_validate_dsl(&json!({ "visual": visual }));
        assert!(result.contains("requires \"x2\""), "Should catch missing x2: {result}");
        assert!(result.contains("requires \"y2\""), "Should catch missing y2: {result}");
    }

    #[test]
    fn validate_dsl_catches_arrow_missing_coords() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "arrow", "stroke": "$foreground" }
                ]
            }
        });
        let result = exec_validate_dsl(&json!({ "visual": visual }));
        assert!(result.contains("requires \"x1\""), "Should catch missing x1: {result}");
    }

    #[test]
    fn validate_dsl_catches_bezier_bad_points() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "bezierCurve", "points": [[0, 0], "bad", [100, 200]], "stroke": "$foreground" }
                ]
            }
        });
        let result = exec_validate_dsl(&json!({ "visual": visual }));
        assert!(result.contains("point must be [number, number]"), "Should catch bad bezier point: {result}");
    }
}
