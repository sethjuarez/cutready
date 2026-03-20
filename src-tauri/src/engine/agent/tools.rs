//! Tool definitions and execution for the AI assistant.
//!
//! Each tool maps to a project operation (read notes, read/update sketches, etc.)
//! and is exposed to the LLM via function calling.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::engine::agent::llm::{ContentPart, FunctionDefinition, ImageUrlData, ToolCall, ToolDefinition};
use crate::engine::project;
use crate::engine::versioning;
use crate::models::sketch::PlanningRow;

// ---------------------------------------------------------------------------
// Image extraction and encoding for vision-capable models
// ---------------------------------------------------------------------------

/// Maximum image file size to encode (5MB).
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// Maximum number of images to include per tool result.
const MAX_IMAGES_PER_RESULT: usize = 5;
/// Images are resized to fit within this dimension before base64 encoding.
/// 768px is generous for `detail: "low"` (512px tiles, 85 tokens each).
const MAX_IMAGE_DIMENSION: u32 = 768;
/// Maximum base64 characters per individual image (~75KB decoded).
const MAX_BASE64_PER_IMAGE: usize = 100_000;
/// Total base64 budget across all images in a single tool result (~225KB decoded).
const MAX_TOTAL_BASE64: usize = 300_000;

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
    let mut total_b64 = 0usize;

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
                            // Try to encode the image (respecting per-image and total budgets)
                            if parts.len() < MAX_IMAGES_PER_RESULT && total_b64 < MAX_TOTAL_BASE64 {
                                if let Some((part, b64_len)) = encode_image_file(root, img_path_str) {
                                    if total_b64 + b64_len <= MAX_TOTAL_BASE64 {
                                        total_b64 += b64_len;
                                        parts.push(part);
                                        found_image = true;
                                    } else {
                                        log::info!(
                                            "[vision] skipping {} — would exceed total base64 budget ({} + {} > {})",
                                            img_path_str, total_b64, b64_len, MAX_TOTAL_BASE64
                                        );
                                    }
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
/// Returns the part and the base64 string length (for budget tracking).
fn encode_image_file(root: &Path, rel_path: &str) -> Option<(ContentPart, usize)> {
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
    if mime == "application/octet-stream" || mime == "image/svg+xml" {
        // SVGs can't be resized with the image crate; skip them for vision
        return None;
    }

    let data = std::fs::read(&path).ok()?;

    // Try to resize if the image is larger than MAX_IMAGE_DIMENSION
    let final_bytes = resize_image_if_needed(&data, mime);

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&final_bytes);
    let b64_len = b64.len();

    if b64_len > MAX_BASE64_PER_IMAGE {
        log::info!(
            "[vision] skipping {} — base64 too large after resize ({} > {} chars)",
            rel_path, b64_len, MAX_BASE64_PER_IMAGE
        );
        return None;
    }

    // Always output as PNG after resize (the image crate decodes/re-encodes)
    let out_mime = if final_bytes.len() < data.len() { "image/png" } else { mime };
    let data_uri = format!("data:{out_mime};base64,{b64}");

    log::debug!(
        "[vision] encoded {} ({} bytes → {} after resize → {} b64 chars)",
        rel_path, data.len(), final_bytes.len(), b64_len
    );

    Some((
        ContentPart::ImageUrl {
            image_url: ImageUrlData {
                url: data_uri,
                detail: Some("low".into()),
            },
        },
        b64_len,
    ))
}

/// Resize an image to fit within MAX_IMAGE_DIMENSION if it exceeds that.
/// Returns the original bytes unchanged if resize isn't needed or fails.
fn resize_image_if_needed(data: &[u8], _mime: &str) -> Vec<u8> {
    let img = match image::load_from_memory(data) {
        Ok(img) => img,
        Err(e) => {
            log::debug!("[vision] couldn't decode image for resize: {e}");
            return data.to_vec();
        }
    };

    let (w, h) = (img.width(), img.height());
    if w <= MAX_IMAGE_DIMENSION && h <= MAX_IMAGE_DIMENSION {
        return data.to_vec();
    }

    // Resize preserving aspect ratio
    let resized = img.resize(
        MAX_IMAGE_DIMENSION,
        MAX_IMAGE_DIMENSION,
        image::imageops::FilterType::Lanczos3,
    );
    log::info!(
        "[vision] resized {}x{} → {}x{} (max {}px)",
        w, h, resized.width(), resized.height(), MAX_IMAGE_DIMENSION
    );

    // Re-encode as PNG
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    if resized.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
        buf
    } else {
        data.to_vec()
    }
}

/// Encode a single image path (e.g., sketch screenshot) as a ContentPart.
pub fn encode_image_at_path(root: &Path, rel_path: &str) -> Option<ContentPart> {
    encode_image_file(root, rel_path).map(|(part, _len)| part)
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
            "Read a sketch's planning rows (time, narrative, demo_actions, screenshot). IMPORTANT: You must provide the 'path' argument — call list_project_files first if you don't know it.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "REQUIRED. Relative path exactly as returned by list_project_files (e.g. 'introduction.sk' or 'demos/overview.sk')" }
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
            "Set an animated framing visual on a planning row using the elucim DSL. Auto-validates structure and auto-critiques layout/readability before saving. Returns validation or critique errors if the visual has issues — fix them and call again. On success, saves the visual and returns any optional suggestions. Pass null to remove a visual.",
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
            "design_plan",
            "Save an English-language design brief for a planning row's visual. Call this before generating DSL JSON to think through the design. Describes layout, elements, spatial arrangement, color palette, and animation sequence in plain English. IMPORTANT: You must provide 'path', 'index', and 'plan' — all three are required.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "REQUIRED. Relative path to the sketch (e.g. 'my-presentation.sk')" },
                    "index": { "type": "integer", "description": "REQUIRED. 0-based row index (e.g. 0 for the first row, 5 for the sixth)" },
                    "plan": {
                        "type": "string",
                        "description": "REQUIRED. English description of the visual design: what elements to show, where they go on the 960×540 canvas, color choices, and animation sequence"
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
        // ── Snapshot / versioning tools ──────────────────────────────
        tool_def(
            "list_snapshots",
            "List the project's version history (git snapshots) in reverse chronological order. Returns commit IDs, messages, and timestamps. Use this to find snapshot IDs for read_file_at_snapshot or compare_snapshots.",
            json!({
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "description": "Maximum number of snapshots to return (default: 20)" }
                },
                "required": []
            }),
        ),
        tool_def(
            "read_file_at_snapshot",
            "Read the content of a specific file at a historical snapshot. Use this to see what a sketch, note, or storyboard looked like at a previous point in time. Get snapshot IDs from list_snapshots.",
            json!({
                "type": "object",
                "properties": {
                    "snapshot_id": { "type": "string", "description": "The commit/snapshot ID (from list_snapshots)" },
                    "path": { "type": "string", "description": "Relative file path (e.g. 'introduction.sk', 'notes/script.md')" }
                },
                "required": ["snapshot_id", "path"]
            }),
        ),
        tool_def(
            "compare_snapshots",
            "Compare two snapshots and see which files changed between them, including line-level addition/deletion counts. Use this to understand what evolved between versions.",
            json!({
                "type": "object",
                "properties": {
                    "from_snapshot": { "type": "string", "description": "The older snapshot ID (from list_snapshots)" },
                    "to_snapshot": { "type": "string", "description": "The newer snapshot ID (from list_snapshots)" }
                },
                "required": ["from_snapshot", "to_snapshot"]
            }),
        ),
        tool_def(
            "list_timelines",
            "List all timelines (branches) in the project. Shows which timeline is currently active, snapshot counts, and display labels.",
            json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        ),
        tool_def(
            "get_current_snapshot",
            "Get information about the current snapshot (HEAD commit) and active timeline. Use this to orient yourself in the project's version history.",
            json!({
                "type": "object",
                "properties": {},
                "required": []
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

    // Entry trace — if tool_exec is missing but this appears, the tool panicked
    log::debug!("[tool] ENTER {} (args {}bytes)", call.function.name, call.function.arguments.len());

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match call.function.name.as_str() {
            "list_project_files" => exec_list_project_files(project_root),
            "read_note" => exec_read_note(project_root, &args, vision_enabled),
            "read_sketch" => exec_read_sketch(project_root, &args, vision_enabled),
            "set_planning_rows" => exec_set_planning_rows(project_root, &args),
            "update_planning_row" => exec_update_planning_row(project_root, &args),
            "set_row_visual" => exec_set_row_visual(project_root, &args),
            "design_plan" => exec_design_plan(project_root, &args),
            "list_project_images" => exec_list_project_images(project_root),
            "save_feedback" => exec_save_feedback(&args),
            "update_note" => exec_update_note(project_root, &args),
            "create_note" => exec_create_note(project_root, &args),
            "update_storyboard" => exec_update_storyboard(project_root, &args),
            "recall_memory" => exec_recall_memory(project_root, &args),
            "save_memory" => exec_save_memory(project_root, &args),
            "list_snapshots" => exec_list_snapshots(project_root, &args),
            "read_file_at_snapshot" => exec_read_file_at_snapshot(project_root, &args),
            "compare_snapshots" => exec_compare_snapshots(project_root, &args),
            "list_timelines" => exec_list_timelines(project_root),
            "get_current_snapshot" => exec_get_current_snapshot(project_root),
            "fetch_url" => exec_fetch_url(&args),
            other => format!("Unknown tool: {other}"),
        }
    }));

    let result = match result {
        Ok(r) => r,
        Err(panic_info) => {
            let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_info.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            log::error!("[tool] PANIC in {}: {}", call.function.name, msg);
            crate::util::trace::emit("tool_panic", "tools", serde_json::json!({
                "name": call.function.name,
                "panic": msg,
            }));
            format!("Error: internal tool panic: {msg}")
        }
    };

    let elapsed = start.elapsed();
    log::debug!("[tool] {} → {}chars in {:?}", call.function.name, result.len(), elapsed);

    let is_error = result.starts_with("Error:") || result.starts_with("Validation failed");
    crate::util::trace::emit("tool_exec", "tools", serde_json::json!({
        "name": call.function.name,
        "duration_ms": elapsed.as_millis(),
        "result_len": result.len(),
        "is_error": is_error,
        "result_preview": if is_error {
            crate::util::trace::truncate(&result, 500)
        } else {
            crate::util::trace::truncate(&result, 200)
        },
    }));

    result
}

/// Extract a JSON object from a tool argument field. Handles three LLM behaviors:
///   1. `{"visual": { ... }}` → normal, returns the nested object
///   2. `{"visual": "{ ... }"}` → stringified, parses and returns
///   3. `{"version": "1.0", "root": {...}}` → flattened (LLM passed DSL as args directly)
fn extract_json_object<'a>(args: &'a Value, key: &str) -> Result<std::borrow::Cow<'a, Value>, String> {
    match args.get(key) {
        Some(v) if v.is_object() => Ok(std::borrow::Cow::Borrowed(v)),
        Some(Value::String(s)) => {
            // LLM passed a stringified JSON — try to parse it
            match serde_json::from_str::<Value>(s) {
                Ok(v) if v.is_object() => Ok(std::borrow::Cow::Owned(v)),
                Ok(_) => Err(format!("Error: '{key}' string parsed but is not a JSON object. Pass the DSL as a JSON object, not a string.")),
                Err(e) => Err(format!("Error: '{key}' is a string but not valid JSON: {e}. Pass the DSL as a JSON object, not a string.")),
            }
        }
        Some(_) => Err(format!("Error: '{key}' must be a JSON object (the elucim DSL document)")),
        None => {
            // Fallback: LLM may have flattened the object into args directly.
            // Detect DSL documents by checking for version+root fields.
            if args.is_object() && (args.get("version").is_some() || args.get("root").is_some()) {
                Ok(std::borrow::Cow::Borrowed(args))
            } else {
                Err(format!("Error: missing required '{key}' argument"))
            }
        }
    }
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
        None => {
            // Graceful fallback: return file listing so the model can self-correct
            // without burning an extra round-trip to list_project_files.
            let listing = exec_list_project_files(root);
            return format!(
                "Error: missing 'path' argument. Call read_sketch with a path from the list below.\n\n{listing}"
            );
        }
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
        None => {
            let listing = exec_list_project_files(root);
            return format!(
                "Error: missing 'path' argument. Call update_planning_row with a path from the list below.\n\n{listing}"
            );
        }
    };
    let index = match args.get("index").and_then(|v| v.as_u64()) {
        Some(i) => i as usize,
        None => {
            let hint = match project::read_sketch(&path) {
                Ok(s) => format!(" Sketch has {} rows (valid indices: 0–{}).", s.rows.len(), s.rows.len().saturating_sub(1)),
                Err(_) => String::new(),
            };
            return format!("Error: missing 'index' (0-based row index).{hint}");
        }
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
        None => {
            let listing = exec_list_project_files(root);
            return format!(
                "Error: missing 'path' argument. Call set_row_visual with a path from the list below.\n\n{listing}"
            );
        }
    };
    let index = match args.get("index").and_then(|v| v.as_u64()) {
        Some(i) => i as usize,
        None => {
            let hint = match project::read_sketch(&path) {
                Ok(s) => format!(" Sketch has {} rows (valid indices: 0–{}).", s.rows.len(), s.rows.len().saturating_sub(1)),
                Err(_) => String::new(),
            };
            return format!("Error: missing 'index' (0-based row index).{hint}");
        }
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

    // null → remove visual, object/string → set visual
    let mut critique_note = String::new();
    match args.get("visual") {
        Some(v) if v.is_null() => {
            row.visual = None;
        }
        _ => {
            let visual = match extract_json_object(args, "visual") {
                Ok(v) => v,
                Err(e) => return e,
            };
            // Auto-validate before writing
            let mut errors = Vec::new();
            validate_dsl_doc(&visual, &mut errors);
            if !errors.is_empty() {
                return format!(
                    "Validation failed ({} error{}) — fix these and call set_row_visual again:\n{}",
                    errors.len(),
                    if errors.len() == 1 { "" } else { "s" },
                    errors.iter().map(|e| format!("  • {e}")).collect::<Vec<_>>().join("\n")
                );
            }
            // Auto-critique for layout/readability issues
            if let Ok((issues, suggestions)) = critique_visual_doc(&visual) {
                if !issues.is_empty() {
                    return format!(
                        "Critique failed ({} issue{}) — fix these and call set_row_visual again:\n{}",
                        issues.len(),
                        if issues.len() == 1 { "" } else { "s" },
                        issues.iter().enumerate()
                            .map(|(i, e)| format!("  ISSUE {}: {e}", i + 1))
                            .collect::<Vec<_>>().join("\n")
                    );
                }
                if !suggestions.is_empty() {
                    critique_note = format!(
                        "\n\nSuggestions for next time:\n{}",
                        suggestions.iter().enumerate()
                            .map(|(i, s)| format!("  {}: {s}", i + 1))
                            .collect::<Vec<_>>().join("\n")
                    );
                }
            }
            // Write visual to external file, store path reference on the row
            match project::write_visual(root, &visual.into_owned()) {
                Ok(rel_path) => {
                    row.visual = Some(serde_json::Value::String(rel_path));
                }
                Err(e) => return format!("Error writing visual file: {e}"),
            }
            // Clear screenshot since visual replaces it
            row.screenshot = None;
        }
    }

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => {
            if sketch.rows[index].visual.is_some() {
                format!("✓ Visual saved on row {} in {}{}", index, path.display(), critique_note)
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
        None => {
            let listing = exec_list_project_files(root);
            return format!(
                "Error: missing 'path' argument. Call design_plan with a path from the list below.\n\n{listing}"
            );
        }
    };
    let index = match args.get("index").and_then(|v| v.as_u64()) {
        Some(i) => i as usize,
        None => {
            // Read the sketch to tell the model how many rows exist
            let hint = match project::read_sketch(&path) {
                Ok(s) => format!(" Sketch has {} rows (valid indices: 0–{}).", s.rows.len(), s.rows.len().saturating_sub(1)),
                Err(_) => String::new(),
            };
            return format!("Error: missing 'index' (0-based row index).{hint}");
        }
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
                let text_w = content.chars().count() as f64 * char_width;
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
    let chars: String = s.chars().take(max).collect();
    if chars.len() < s.len() { format!("{chars}…") } else { chars }
}

/// Run the critique analysis on a visual DSL document.
/// Returns (issues, suggestions). Issues are problems that must be fixed;
/// suggestions are optional improvements.
fn critique_visual_doc(visual: &Value) -> Result<(Vec<String>, Vec<String>), String> {
    let root = match visual.get("root") {
        Some(r) if r.is_object() => r,
        _ => return Err("Error: visual must have a 'root' object".into()),
    };

    let children = root.get("children").and_then(|v| v.as_array());
    let children = match children {
        Some(c) => c,
        None => return Err("Error: root has no children array".into()),
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

    // 1. Element count (relaxed — rich visuals are fine, 70+ is excessive)
    if all_nodes.len() > 60 {
        issues.push(format!(
            "TOO_MANY_ELEMENTS: {} elements total (max recommended: 60). Simplify — remove decorative elements or combine related items into groups.",
            all_nodes.len()
        ));
    } else if all_nodes.len() > 45 {
        suggestions.push(format!(
            "ELEMENT_COUNT: {} elements — consider trimming to ~40 for cleaner design.", all_nodes.len()
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
        } else if tn.font_size < 18.0 && tn.content.chars().count() < 30 {
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

    // 4. Overlap detection (text-on-text only — non-blocking suggestion since
    // LLMs struggle to fix coordinate math reliably)
    let text_bboxes: Vec<&BBox> = bboxes.iter().filter(|b| b.label.starts_with("text")).collect();
    for i in 0..text_bboxes.len() {
        for j in (i + 1)..text_bboxes.len() {
            let a = text_bboxes[i];
            let b = text_bboxes[j];
            let area = a.overlap_area(b);
            let min_area = (a.w * a.h).min(b.w * b.h);
            if min_area > 0.0 && area / min_area > 0.3 {
                suggestions.push(format!(
                    "TEXT_OVERLAP: {} overlaps with {} — move them apart or remove one.",
                    a.label, b.label
                ));
            }
        }
    }

    // 5. Margin violations (text only — non-blocking suggestion)
    let margin = 30.0;
    for bbox in &bboxes {
        if bbox.label.starts_with("text") {
            if bbox.x < margin || bbox.y < margin
                || bbox.x + bbox.w > canvas_w - margin
                || bbox.y + bbox.h > canvas_h - margin
            {
                suggestions.push(format!(
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
                // Downgraded to suggestion — width estimation is approximate (monospace assumption)
                // and produces false positives that waste LLM rounds
                suggestions.push(format!(
                    "TEXT_OVERFLOW: {} overflows its container rect by {:.0}px. Consider shortening the text, reducing fontSize, or widening the container.",
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

    Ok((issues, suggestions))
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

// ---------------------------------------------------------------------------
// Snapshot / versioning tool implementations
// ---------------------------------------------------------------------------

/// Find the repo root (where .git lives) by walking up from the project root.
/// In single-project mode these are the same; in multi-project mode the repo
/// root is the parent containing .git/.
fn find_repo_root(project_root: &Path) -> PathBuf {
    let mut current = project_root.to_path_buf();
    loop {
        if current.join(".git").exists() {
            return current;
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return project_root.to_path_buf(),
        }
    }
}

fn exec_list_snapshots(root: &Path, args: &Value) -> String {
    let repo_root = find_repo_root(root);
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;

    match versioning::list_versions(&repo_root) {
        Ok(versions) => {
            if versions.is_empty() {
                return "No snapshots found. The project has no version history yet.".into();
            }
            let mut out = format!("## Snapshots ({} total, showing up to {})\n\n", versions.len(), limit);
            for v in versions.iter().take(limit) {
                let ts = v.timestamp.format("%Y-%m-%d %H:%M");
                out.push_str(&format!("- `{}` — {} ({})\n", &v.id[..8.min(v.id.len())], v.message, ts));
            }
            if versions.len() > limit {
                out.push_str(&format!("\n_{} more snapshots not shown. Use `limit` to see more._\n", versions.len() - limit));
            }
            out
        }
        Err(e) => format!("Error listing snapshots: {e}"),
    }
}

fn exec_read_file_at_snapshot(root: &Path, args: &Value) -> String {
    let repo_root = find_repo_root(root);
    let snapshot_id = match args.get("snapshot_id").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return "Error: 'snapshot_id' is required".into(),
    };
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return "Error: 'path' is required".into(),
    };

    // In multi-project repos, the file path is relative to the project root,
    // but git stores paths relative to repo root. Compute the prefix.
    let prefix = if repo_root != root {
        root.strip_prefix(&repo_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let git_path = if prefix.is_empty() {
        path.to_string()
    } else {
        format!("{}/{}", prefix, path)
    };

    match versioning::get_file_at_version(&repo_root, snapshot_id, &git_path) {
        Ok(bytes) => {
            match String::from_utf8(bytes) {
                Ok(content) => {
                    let short_id = &snapshot_id[..8.min(snapshot_id.len())];
                    format!("## {} at snapshot {}\n\n{}", path, short_id, content)
                }
                Err(_) => format!("File '{}' exists at this snapshot but is binary (not text).", path),
            }
        }
        Err(e) => format!("Error reading '{}' at snapshot {}: {}", path, &snapshot_id[..8.min(snapshot_id.len())], e),
    }
}

fn exec_compare_snapshots(root: &Path, args: &Value) -> String {
    let repo_root = find_repo_root(root);
    let from = match args.get("from_snapshot").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return "Error: 'from_snapshot' is required".into(),
    };
    let to = match args.get("to_snapshot").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return "Error: 'to_snapshot' is required".into(),
    };

    match versioning::diff_snapshots(&repo_root, from, to) {
        Ok(entries) => {
            if entries.is_empty() {
                return format!(
                    "No differences between snapshots `{}` and `{}`.",
                    &from[..8.min(from.len())],
                    &to[..8.min(to.len())]
                );
            }
            let mut out = format!(
                "## Changes: `{}` → `{}`\n\n| File | Status | +Lines | -Lines |\n| --- | --- | --- | --- |\n",
                &from[..8.min(from.len())],
                &to[..8.min(to.len())]
            );
            for e in &entries {
                out.push_str(&format!(
                    "| {} | {} | +{} | -{} |\n",
                    e.path, e.status, e.additions, e.deletions
                ));
            }
            let total_add: u32 = entries.iter().map(|e| e.additions).sum();
            let total_del: u32 = entries.iter().map(|e| e.deletions).sum();
            out.push_str(&format!(
                "\n**{} file(s) changed**, +{} -{} lines\n",
                entries.len(), total_add, total_del
            ));
            out
        }
        Err(e) => format!("Error comparing snapshots: {e}"),
    }
}

fn exec_list_timelines(root: &Path) -> String {
    let repo_root = find_repo_root(root);
    match versioning::list_timelines(&repo_root) {
        Ok(timelines) => {
            if timelines.is_empty() {
                return "No timelines found.".into();
            }
            let mut out = "## Timelines\n\n".to_string();
            for t in &timelines {
                let active = if t.is_active { " ← active" } else { "" };
                out.push_str(&format!(
                    "- **{}** (\"{}\"): {} snapshot(s){}\n",
                    t.name, t.label, t.snapshot_count, active
                ));
            }
            out
        }
        Err(e) => format!("Error listing timelines: {e}"),
    }
}

fn exec_get_current_snapshot(root: &Path) -> String {
    let repo_root = find_repo_root(root);

    // Get current timeline
    let timeline = match versioning::list_timelines(&repo_root) {
        Ok(tls) => tls.into_iter().find(|t| t.is_active),
        Err(_) => None,
    };

    // Get HEAD commit
    let head = match versioning::list_versions(&repo_root) {
        Ok(versions) => versions.into_iter().next(),
        Err(_) => None,
    };

    let mut out = "## Current State\n\n".to_string();
    if let Some(tl) = &timeline {
        out.push_str(&format!("- **Timeline**: {} (\"{}\")\n", tl.name, tl.label));
        out.push_str(&format!("- **Snapshots on this timeline**: {}\n", tl.snapshot_count));
    } else {
        out.push_str("- **Timeline**: (detached or unknown)\n");
    }
    if let Some(v) = &head {
        let ts = v.timestamp.format("%Y-%m-%d %H:%M");
        out.push_str(&format!("- **HEAD**: `{}` — {} ({})\n", &v.id[..8.min(v.id.len())], v.message, ts));
    } else {
        out.push_str("- **HEAD**: (no commits yet)\n");
    }

    // Check for unsaved changes
    if let Ok(dirty) = versioning::has_unsaved_changes(&repo_root) {
        if dirty {
            out.push_str("- **Unsaved changes**: yes\n");
        }
    }

    out
}

/// Execute fetch_url synchronously.
///
/// Uses `tokio::task::block_in_place` to run the async HTTP request from
/// within a sync tool handler context. This is safe because tool handlers
/// in the Copilot SDK run on a tokio blocking thread.
fn exec_fetch_url(args: &Value) -> String {
    let url = match args.get("url").and_then(|v| v.as_str()) {
        Some(u) => u.to_string(),
        None => return "Error: missing 'url' argument".into(),
    };

    // We're inside a tokio runtime (Tauri async command or Copilot SDK handler).
    // block_in_place allows blocking the current thread without deadlocking the runtime.
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(async {
            match crate::engine::agent::web::fetch_and_clean(&url).await {
                Ok(content) => content,
                Err(e) => format!("Error fetching URL: {e}"),
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Helper: run validate_dsl_doc and return a result string like the old exec_validate_dsl.
    fn run_validate(visual: &Value) -> String {
        let mut errors = Vec::new();
        validate_dsl_doc(visual, &mut errors);
        if errors.is_empty() {
            "Valid".into()
        } else {
            format!("Validation failed: {}", errors.join("; "))
        }
    }

    /// Helper: run critique_visual_doc and return a result string like the old exec_critique_visual.
    fn run_critique(visual: &Value) -> String {
        match critique_visual_doc(visual) {
            Ok((issues, suggestions)) => {
                let pass = issues.is_empty();
                let mut parts = Vec::new();
                if pass {
                    parts.push("✓ PASS".to_string());
                } else {
                    parts.push(format!("✗ FAIL ({} issues)", issues.len()));
                }
                for issue in &issues { parts.push(issue.clone()); }
                for sug in &suggestions { parts.push(sug.clone()); }
                parts.join("\n")
            }
            Err(e) => e,
        }
    }

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
        let result = run_critique(&visual);
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
        let result = run_critique(&visual);
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
        let result = run_critique(&visual);
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
        let result = run_critique(&visual);
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
        let result = run_critique(&visual);
        assert!(result.contains("LOW_VARIETY"), "Should suggest shape variety: {result}");
    }

    #[test]
    fn critique_catches_text_overflow_container() {
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
        let result = run_critique(&visual);
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
        let result = run_critique(&visual);
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
        let result = run_critique(&visual);
        assert!(result.contains("INNER_CARD_RECT"), "Should catch inner card rect with margins: {result}");
    }

    #[test]
    fn validate_dsl_catches_bad_polygon_points() {
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
        let result = run_validate(&visual);
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
        let result = run_validate(&visual);
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
        let result = run_validate(&visual);
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
        let result = run_validate(&visual);
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
        let result = run_validate(&visual);
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
        let result = run_validate(&visual);
        assert!(result.contains("point must be [number, number]"), "Should catch bad bezier point: {result}");
    }

    #[test]
    fn extract_json_object_parses_stringified() {
        let visual_str = r#"{"version":"1.0","root":{"type":"player","width":960,"height":540,"fps":30,"durationInFrames":60,"background":"$background","children":[{"type":"text","content":"Hello","x":480,"y":270,"fontSize":34,"fill":"$foreground","textAnchor":"middle"}]}}"#;
        let args = json!({ "visual": visual_str });
        let result = extract_json_object(&args, "visual");
        assert!(result.is_ok(), "Should auto-parse string visual");
        let visual = result.unwrap();
        let mut errors = Vec::new();
        validate_dsl_doc(&visual, &mut errors);
        assert!(errors.is_empty(), "Parsed visual should be valid: {errors:?}");
    }

    #[test]
    fn extract_json_object_rejects_bad_string() {
        let args = json!({ "visual": "not valid json {" });
        let result = extract_json_object(&args, "visual");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not valid JSON"), "Should report parse error");
    }

    #[test]
    fn extract_json_object_detects_flattened_dsl() {
        let args = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "text", "content": "Hello", "x": 480, "y": 270, "fontSize": 34, "fill": "$foreground", "textAnchor": "middle" }
                ]
            }
        });
        let result = extract_json_object(&args, "visual");
        assert!(result.is_ok(), "Should auto-detect flattened DSL");
        let visual = result.unwrap();
        let mut errors = Vec::new();
        validate_dsl_doc(&visual, &mut errors);
        assert!(errors.is_empty(), "Flattened DSL should be valid: {errors:?}");
    }

    #[test]
    fn critique_accepts_stringified_visual() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "text", "content": "Hello", "x": 480, "y": 270, "fontSize": 34, "fill": "$foreground", "textAnchor": "middle" }
                ]
            }
        });
        let result = critique_visual_doc(&visual);
        assert!(result.is_ok(), "Critique should succeed on valid visual");
    }
}
