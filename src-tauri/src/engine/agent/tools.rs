//! Tool definitions and execution for the AI assistant.
//!
//! Each tool maps to a project operation (read notes, read/update sketches, etc.)
//! and is exposed to the LLM via function calling.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::engine::agent::llm::{ContentPart, ImageUrl, Tool, ToolCall};
use crate::engine::project;
use crate::models::sketch::{PlanningRow, Sketch};

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
                            let img_path_str =
                                &line[after_bracket + 1..after_bracket + 1 + close_paren];
                            // Try to encode the image (respecting per-image and total budgets)
                            if parts.len() < MAX_IMAGES_PER_RESULT && total_b64 < MAX_TOTAL_BASE64 {
                                if let Some((part, b64_len)) = encode_image_file(root, img_path_str)
                                {
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
        log::debug!(
            "[vision] skipping {} ({}MB > 5MB limit)",
            rel_path,
            metadata.len() / 1024 / 1024
        );
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
            rel_path,
            b64_len,
            MAX_BASE64_PER_IMAGE
        );
        return None;
    }

    // Always output as PNG after resize (the image crate decodes/re-encodes)
    let out_mime = if final_bytes.len() < data.len() {
        "image/png"
    } else {
        mime
    };
    let data_uri = format!("data:{out_mime};base64,{b64}");

    log::debug!(
        "[vision] encoded {} ({} bytes → {} after resize → {} b64 chars)",
        rel_path,
        data.len(),
        final_bytes.len(),
        b64_len
    );

    Some((
        ContentPart::ImageUrl {
            image_url: ImageUrl {
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
        w,
        h,
        resized.width(),
        resized.height(),
        MAX_IMAGE_DIMENSION
    );

    // Re-encode as PNG
    let mut buf = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut buf);
    if resized
        .write_to(&mut cursor, image::ImageFormat::Png)
        .is_ok()
    {
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
pub fn all_tools(web_search_enabled: bool) -> Vec<Tool> {
    let mut tools = vec![
        Tool::function(
            "list_project_files",
            "List all sketches, notes, and storyboards in the project. Pass include_images: true to also list screenshots from .cutready/screenshots/.",
            json!({
                "type": "object",
                "properties": {
                    "include_images": { "type": "boolean", "description": "When true, also lists images/screenshots available for use in sketch rows (default: false)" }
                },
                "required": []
            }),
        ),
        Tool::function(
            "read_note",
            "Read the full markdown content of a note.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path exactly as returned by list_project_files (e.g. 'getting-started.md')" }
                },
                "required": ["path"]
            }),
        ),
        Tool::function(
            "write_note",
            "Create a new note or overwrite an existing note with the given content. Creates the file if it doesn't exist; overwrites if it does.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path for the note (e.g. 'meeting-notes.md', 'ideas.md'). Must end with .md." },
                    "content": { "type": "string", "description": "The full markdown content for the note" }
                },
                "required": ["path", "content"]
            }),
        ),
        Tool::function(
            "read_sketch",
            "Read a sketch's planning rows (time, narrative, demo_actions, screenshot). Call list_project_files first if you don't know the path.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "REQUIRED. Relative path exactly as returned by list_project_files (e.g. 'introduction.sk')" }
                },
                "required": ["path"]
            }),
        ),
        Tool::function(
            "write_sketch",
            "Replace ALL planning rows in a sketch, or create a new sketch if the path doesn't exist. Use this to generate a full plan from scratch or restructure an existing sketch.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch. Use a path from list_project_files to update, or a new filename like 'my-sketch.sk' to create" },
                    "title": { "type": "string", "description": "Title for the sketch (optional when updating; used when creating)" },
                    "description": { "type": "string", "description": "Brief description of the sketch content and purpose (optional)" },
                    "rows": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "time": { "type": "string", "description": "Duration (e.g. '~30s', '1:00')" },
                                "narrative": { "type": "string", "description": "Voiceover/narration bullets" },
                                "demo_actions": { "type": "string", "description": "On-screen action bullets" },
                                "screenshot": { "type": "string", "description": "Optional path to a screenshot image (relative, from list_project_files with include_images: true)" }
                            },
                            "required": ["time", "narrative", "demo_actions"]
                        }
                    }
                },
                "required": ["path", "rows"]
            }),
        ),
        Tool::function(
            "update_planning_row",
            "Update a single planning row by index. Only fields provided are changed — useful for targeted edits without touching other rows.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path exactly as returned by list_project_files" },
                    "index": { "type": "integer", "description": "0-based row index" },
                    "time": { "type": "string", "description": "New time value (optional)" },
                    "narrative": { "type": "string", "description": "New narrative (optional)" },
                    "demo_actions": { "type": "string", "description": "New demo actions (optional)" },
                    "screenshot": { "type": "string", "description": "New screenshot path (optional)" }
                },
                "required": ["path", "index"]
            }),
        ),
        Tool::function(
            "set_row_visual",
            "Set an animated framing visual on a planning row using the elucim DSL. Prefer canonical v2 documents with version \"2.0\", scene, and elements keyed by stable semantic IDs; legacy v1 is accepted and migrated. Add lightweight intent metadata to important elements, e.g. intent: { role: 'title'|'subtitle'|'hero'|'step'|'connector'|'label'|'container'|'decoration', importance: 'primary'|'secondary'|'supporting'|'decorative' }. Use CutReady semantic tokens for theme integration: $background, $title, $subtitle, $foreground, $muted, $surface, $border, $accent, $secondary, $tertiary, $success, $warning, $error. Avoid hardcoded cyan/purple for routine emphasis. Prefer polished slide density: roughly 20-40 flattened nodes, 3-5 main objects/steps, minimal labels, and one hero visual metaphor. Avoid token strips, tiny grids, repeated chips, and probability worksheets unless essential. Use valid Elucim fields in element props: text fill (not color), rect rx (not radius), and numeric fadeIn/draw/fadeOut frames. Group nodes are useful for transforms but do not make a crowded slide simpler. Auto-validates structure and auto-critiques layout/readability before saving. Returns validation or critique errors if the visual has issues — fix them and call again. Pass null to remove a visual.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch" },
                    "index": { "type": "integer", "description": "0-based row index" },
                    "visual": {
                        "description": "An elucim DSL v2 document (JSON object with version, scene, and elements), legacy v1 document, or null to remove",
                        "oneOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "version": { "type": "string", "enum": ["2.0"] },
                                    "scene": {
                                        "type": "object",
                                        "description": "Scene metadata. Use { type: 'player', width: 960, height: 540, fps: 30, durationInFrames: 90, background: '$background', children: ['hero', ...] }. Children are top-level element IDs."
                                    },
                                    "elements": {
                                        "type": "object",
                                        "description": "Map of element IDs to { id, type, parentId?, children?, layout?, intent?, props }. props should contain render fields such as x/y/content/fill/rx/fadeIn. intent should describe role and importance for agent edits. Text nodes use props.content (not text). Prefer stable IDs like title, subtitle, hero, step-1."
                                    }
                                },
                                "required": ["version", "scene", "elements"]
                            },
                            { "type": "null" }
                        ]
                    }
                },
                "required": ["path", "index", "visual"]
            }),
        ),
        Tool::function(
            "review_row_visual",
            "Review an existing row visual with Elucim v2 agentic checks. Loads the row visual, normalizes it to v2, validates it, summarizes elements/timelines/state machines, lists deterministic nudge suggestions, verifies renderability, and includes layout critique feedback.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch" },
                    "index": { "type": "integer", "description": "0-based row index" }
                },
                "required": ["path", "index"]
            }),
        ),
        Tool::function(
            "apply_row_visual_nudge",
            "Apply a deterministic CutReady/Elucim visual nudge to an existing row visual and save the updated v2 document. Call review_row_visual first to see available nudge IDs. Safe nudges can be applied directly; review nudges are allowed when the requested visual polish matches the user's intent.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch" },
                    "index": { "type": "integer", "description": "0-based row index" },
                    "nudge_id": { "type": "string", "description": "Nudge ID returned by review_row_visual, e.g. mark-refined, normalize-root-layer-order, add-staggered-intro" }
                },
                "required": ["path", "index", "nudge_id"]
            }),
        ),
        Tool::function(
            "apply_row_visual_command",
            "Apply a deterministic Elucim visual command to an existing row visual and save the updated v2 document. Use for precise machine edits such as metadata updates, element intent annotation, layer ordering, or intro timeline creation without regenerating the visual.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the sketch" },
                    "index": { "type": "integer", "description": "0-based row index" },
                    "command": {
                        "type": "object",
                        "description": "Command object. Supported ops: updateMetadata { metadata }, markRefined, annotateElementIntent, normalizeRootLayerOrder, addStaggeredIntro { timelineId?, staggerFrames?, durationFrames? }"
                    }
                },
                "required": ["path", "index", "command"]
            }),
        ),
        Tool::function(
            "design_plan",
            "Save an English-language design brief for a planning row's visual. Call this before generating DSL JSON to think through the design. Describe a polished 16:9 slide-like composition: title/subtitle, one hero metaphor, 3-5 main objects/steps, spatial arrangement, CutReady semantic tokens, and animation sequence. Prefer fewer large elements over many small boxes or labels. IMPORTANT: You must provide 'path', 'index', and 'plan' — all three are required.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "REQUIRED. Relative path to the sketch (e.g. 'my-presentation.sk')" },
                    "index": { "type": "integer", "description": "REQUIRED. 0-based row index (e.g. 0 for the first row, 5 for the sixth)" },
                    "plan": {
                        "type": "string",
                         "description": "REQUIRED. English description of the visual design: what 3-5 main elements or steps to show, where they go on the 960x540 canvas, which CutReady semantic tokens to use ($title/$subtitle/$foreground/$muted/$surface/$border/$accent/etc.), and animation sequence. Keep the design presentation-grade, not crowded."
                    }
                },
                "required": ["path", "index", "plan"]
            }),
        ),
        Tool::function(
            "read_storyboard",
            "Read a storyboard's title, description, and ordered sketch sequence.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path to the storyboard .sb file (from list_project_files)" }
                },
                "required": ["path"]
            }),
        ),
        Tool::function(
            "write_storyboard",
            "Create a new storyboard or update an existing one. When 'items' is omitted, only title/description are updated and the existing sketch sequence is preserved. When 'items' is provided, the entire sequence is replaced.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Relative path for the storyboard (e.g. 'demo-flow.sb'). Use a path from list_project_files to update, or a new filename to create." },
                    "title": { "type": "string", "description": "Title for the storyboard" },
                    "description": { "type": "string", "description": "Description of what this storyboard covers" },
                    "items": {
                        "type": "array",
                        "description": "Ordered sketch sequence. When provided, replaces all existing items. When omitted, preserves the existing sequence.",
                        "items": {
                            "oneOf": [
                                {
                                    "type": "object",
                                    "description": "A direct reference to a sketch",
                                    "properties": {
                                        "type": { "type": "string", "enum": ["sketch_ref"] },
                                        "path": { "type": "string", "description": "Relative path to the sketch (e.g. 'intro.sk')" }
                                    },
                                    "required": ["type", "path"]
                                },
                                {
                                    "type": "object",
                                    "description": "A named section grouping multiple sketches",
                                    "properties": {
                                        "type": { "type": "string", "enum": ["section"] },
                                        "title": { "type": "string", "description": "Section heading" },
                                        "sketches": {
                                            "type": "array",
                                            "items": { "type": "string" },
                                            "description": "Relative paths to sketches in this section"
                                        }
                                    },
                                    "required": ["type", "title", "sketches"]
                                }
                            ]
                        }
                    }
                },
                "required": ["path"]
            }),
        ),
        Tool::function(
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
        agentive::types::Tool::function(
            "fetch_url",
            "Fetch a web page and return its clean text content. The response includes the page text followed by a deduplicated list of all links found on the page. If the user asks you to follow links or explore further, call fetch_url again on any of those URLs.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The URL to fetch (must start with http:// or https://)" }
                },
                "required": ["url"]
            }),
        ),
        agentive::memory::recall_memory_tool(),
        agentive::memory::save_memory_tool(),
    ];

    if web_search_enabled {
        tools.insert(
            tools.len().saturating_sub(2),
            agentive::types::Tool::function(
                "search_web",
                "Search the public web for current external information. Use only when the user asks to search/look up current information or when current public facts are required. Returns concise results with source URLs.",
                serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Public web search query." },
                        "max_results": { "type": "integer", "description": "Maximum results to return, 1-8. Default 5." }
                    },
                    "required": ["query"]
                }),
            ),
        );
    }

    tools
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/// Execute a single tool call and return the result as a ToolOutput.
pub fn execute_tool(
    call: &ToolCall,
    project_root: &Path,
    vision_enabled: bool,
) -> agentive::ToolOutput {
    let args: Value = agentive::parse_tool_args(&call.function.arguments).unwrap_or(json!({}));
    let start = std::time::Instant::now();

    // Entry trace — if tool_exec is missing but this appears, the tool panicked
    log::debug!(
        "[tool] ENTER {} (args {}bytes)",
        call.function.name,
        call.function.arguments.len()
    );

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match call.function.name.as_str() {
            "list_project_files" => {
                agentive::ToolOutput::from(exec_list_project_files(project_root, &args))
            }
            "read_note" => exec_read_note(project_root, &args, vision_enabled),
            "write_note" => agentive::ToolOutput::from(exec_write_note(project_root, &args)),
            "read_sketch" => exec_read_sketch(project_root, &args, vision_enabled),
            "write_sketch" => agentive::ToolOutput::from(exec_write_sketch(project_root, &args)),
            "update_planning_row" => {
                agentive::ToolOutput::from(exec_update_planning_row(project_root, &args))
            }
            "set_row_visual" => {
                agentive::ToolOutput::from(exec_set_row_visual(project_root, &args))
            }
            "review_row_visual" => {
                agentive::ToolOutput::from(exec_review_row_visual(project_root, &args))
            }
            "apply_row_visual_nudge" => {
                agentive::ToolOutput::from(exec_apply_row_visual_nudge(project_root, &args))
            }
            "apply_row_visual_command" => {
                agentive::ToolOutput::from(exec_apply_row_visual_command(project_root, &args))
            }
            "design_plan" => agentive::ToolOutput::from(exec_design_plan(project_root, &args)),
            "read_storyboard" => {
                agentive::ToolOutput::from(exec_read_storyboard(project_root, &args))
            }
            "write_storyboard" => {
                agentive::ToolOutput::from(exec_write_storyboard(project_root, &args))
            }
            "recall_memory" => agentive::ToolOutput::from(exec_recall_memory(project_root, &args)),
            "save_memory" => agentive::ToolOutput::from(exec_save_memory(project_root, &args)),
            "fetch_url" => {
                let url = args
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                agentive::ToolOutput::from(tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(async {
                        match agentive::web::fetch_and_clean(&url).await {
                            Ok(content) => {
                                // Extract markdown links for the agent to optionally follow
                                let mut links: Vec<String> = Vec::new();
                                let mut rest = content.as_str();
                                while let Some(bracket) = rest.find("](") {
                                    let after = &rest[bracket + 2..];
                                    if let Some(end) = after.find(')') {
                                        let href = after[..end].trim();
                                        if href.starts_with("http://")
                                            || href.starts_with("https://")
                                        {
                                            let href = href.to_string();
                                            if !links.contains(&href) {
                                                links.push(href);
                                            }
                                        }
                                    }
                                    rest = &rest[bracket + 2..];
                                }
                                if links.is_empty() {
                                    content
                                } else {
                                    format!(
                                        "{content}\n\n---\nLinks on this page ({count}):\n{list}",
                                        count = links.len(),
                                        list = links
                                            .iter()
                                            .map(|l| format!("- {l}"))
                                            .collect::<Vec<_>>()
                                            .join("\n")
                                    )
                                }
                            }
                            Err(e) => format!("Error fetching URL: {e}"),
                        }
                    })
                }))
            }
            other => agentive::ToolOutput::from(format!("Unknown tool: {other}")),
        }
    }));

    let output = match result {
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
            crate::util::trace::emit(
                "tool_panic",
                "tools",
                serde_json::json!({
                    "name": call.function.name,
                    "panic": msg,
                }),
            );
            agentive::ToolOutput::from(format!("Error: internal tool panic: {msg}"))
        }
    };

    let elapsed = start.elapsed();
    let result_text = output.text();
    log::debug!(
        "[tool] {} → {}chars in {:?}",
        call.function.name,
        result_text.len(),
        elapsed
    );

    let is_error =
        result_text.starts_with("Error:") || result_text.starts_with("Validation failed");
    crate::util::trace::emit(
        "tool_exec",
        "tools",
        serde_json::json!({
            "name": call.function.name,
            "duration_ms": elapsed.as_millis(),
            "result_len": result_text.len(),
            "is_error": is_error,
            "result_preview": if is_error {
                crate::util::trace::truncate(result_text, 500)
            } else {
                crate::util::trace::truncate(result_text, 200)
            },
        }),
    );

    output
}

/// Extract a JSON object from a tool argument field. Handles three LLM behaviors:
///   1. `{"visual": { ... }}` → normal, returns the nested object
///   2. `{"visual": "{ ... }"}` → stringified, parses and returns
///   3. `{"version": "1.0", "root": {...}}` or v2 document fields → flattened
///      (LLM passed DSL as args directly)
fn extract_json_object<'a>(
    args: &'a Value,
    key: &str,
) -> Result<std::borrow::Cow<'a, Value>, String> {
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
        Some(_) => Err(format!(
            "Error: '{key}' must be a JSON object (the elucim DSL document)"
        )),
        None => {
            // Fallback: LLM may have flattened the object into args directly.
            // Detect v1/v2 DSL documents by checking for document-shape fields.
            if args.is_object()
                && (args.get("version").is_some()
                    || args.get("root").is_some()
                    || args.get("scene").is_some()
                    || args.get("elements").is_some())
            {
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

pub async fn exec_search_web(args: &Value) -> Result<String, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Error: missing 'query' argument".to_string())?;
    let max_results = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .clamp(1, 8) as usize;

    let url = format!(
        "https://duckduckgo.com/html/?q={}",
        urlencoding::encode(query)
    );
    let html = reqwest::Client::new()
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "CutReady/1.0 (+https://github.com/sethjuarez/cutready)",
        )
        .send()
        .await
        .map_err(|e| format!("Search request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Search provider returned an error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Search response read failed: {e}"))?;

    Ok(format_search_results(query, &html, max_results))
}

fn format_search_results(query: &str, html: &str, max_results: usize) -> String {
    let mut out = format!("# Web search results for \"{}\"\n\n", query);
    let results = parse_duckduckgo_results(html, max_results);
    if results.is_empty() {
        out.push_str("No search results found. Try a more specific query.");
        return out;
    }

    for (index, result) in results.iter().enumerate() {
        out.push_str(&format!(
            "{}. [{}]({})\n",
            index + 1,
            result.title,
            result.url
        ));
        if !result.snippet.is_empty() {
            out.push_str(&format!("   {}\n", result.snippet));
        }
    }
    out.push_str("\nUse these source URLs as citations when summarizing sourced facts.");
    out
}

#[derive(Debug, PartialEq, Eq)]
struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

fn parse_duckduckgo_results(html: &str, max_results: usize) -> Vec<SearchResult> {
    let mut results = Vec::new();
    for chunk in html.split("result__a").skip(1) {
        if results.len() >= max_results {
            break;
        }
        let href = extract_attr(chunk, "href").unwrap_or_default();
        let title_html = chunk
            .split('>')
            .nth(1)
            .and_then(|s| s.split("</a>").next())
            .unwrap_or_default();
        let title = strip_tags(title_html);
        if href.is_empty() || title.is_empty() {
            continue;
        }
        let url = normalize_search_url(&href);
        let snippet = chunk
            .split("result__snippet")
            .nth(1)
            .and_then(|s| s.split("</a>").next())
            .map(strip_tags)
            .unwrap_or_default();
        if !url.is_empty() && !results.iter().any(|r: &SearchResult| r.url == url) {
            results.push(SearchResult {
                title,
                url,
                snippet,
            });
        }
    }
    results
}

fn extract_attr(chunk: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = chunk.find(&needle)? + needle.len();
    let end = chunk[start..].find('"')? + start;
    Some(html_unescape(&chunk[start..end]))
}

fn normalize_search_url(href: &str) -> String {
    if let Some(uddg_pos) = href.find("uddg=") {
        let encoded = &href[uddg_pos + 5..];
        let encoded = encoded.split('&').next().unwrap_or(encoded);
        return urlencoding::decode(encoded)
            .map(|s| s.into_owned())
            .unwrap_or_else(|_| href.to_string());
    }
    html_unescape(href)
}

fn strip_tags(value: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    html_unescape(out.trim())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn html_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

pub(crate) fn format_storyboard_for_agent(
    root: &Path,
    storyboard: &crate::models::sketch::Storyboard,
) -> String {
    let mut out = format!("# {}\n", storyboard.title);
    out.push_str(&format!(
        "\nLocked: {}\n",
        if storyboard.locked { "yes" } else { "no" }
    ));
    if !storyboard.description.trim().is_empty() {
        out.push_str(&format!(
            "\n## Description\n{}\n",
            storyboard.description.trim()
        ));
    }

    out.push_str("\n## Ordered Sequence\n");
    if storyboard.items.is_empty() {
        out.push_str("(no sketches)\n");
        return out;
    }

    for (i, item) in storyboard.items.iter().enumerate() {
        match item {
            crate::models::sketch::StoryboardItem::SketchRef { path } => {
                append_storyboard_sketch_summary(&mut out, root, i + 1, path);
            }
            crate::models::sketch::StoryboardItem::Section { title, sketches } => {
                out.push_str(&format!(
                    "{}. Section: \"{}\" ({} sketches)\n",
                    i + 1,
                    title,
                    sketches.len()
                ));
                for (j, sketch_path) in sketches.iter().enumerate() {
                    append_storyboard_sketch_summary(&mut out, root, j + 1, sketch_path);
                }
            }
        }
    }

    out
}

fn append_storyboard_sketch_summary(
    out: &mut String,
    root: &Path,
    index: usize,
    sketch_path: &str,
) {
    let sketch_abs = match project::safe_resolve(root, sketch_path) {
        Ok(path) => path,
        Err(e) => {
            out.push_str(&format!(
                "{}. Sketch: \"{}\" (invalid path: {})\n",
                index, sketch_path, e
            ));
            return;
        }
    };

    match project::read_sketch(&sketch_abs) {
        Ok(sketch) => {
            out.push_str(&format!(
                "{}. Sketch: \"{}\" ({})\n",
                index, sketch.title, sketch_path
            ));
            if let Some(description) = sketch.description.as_str() {
                if !description.trim().is_empty() {
                    out.push_str(&format!("   Description: {}\n", description.trim()));
                }
            }
            if sketch.rows.is_empty() {
                out.push_str("   Rows: none\n");
            } else {
                out.push_str("   Rows:\n");
                for (row_index, row) in sketch.rows.iter().enumerate() {
                    out.push_str(&format!(
                        "   - Row {} [{}]: narrative=\"{}\" actions=\"{}\"\n",
                        row_index + 1,
                        row.time,
                        row.narrative,
                        row.demo_actions
                    ));
                }
            }
        }
        Err(e) => {
            out.push_str(&format!(
                "{}. Sketch: \"{}\" (missing or unreadable: {})\n",
                index, sketch_path, e
            ));
        }
    }
}

fn exec_list_project_files(root: &Path, args: &Value) -> String {
    let include_images = args
        .get("include_images")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut out = String::new();

    if let Ok(sketches) = project::scan_sketches(root) {
        out.push_str("## Sketches\n");
        out.push_str(
            "Use the exact path value with read_sketch/write_sketch/update_planning_row.\n",
        );
        for s in &sketches {
            out.push_str(&format!(
                "- path: \"{}\" — {} ({} rows)\n",
                s.path, s.title, s.row_count
            ));
        }
    }

    if let Ok(notes) = project::scan_notes(root) {
        out.push_str("\n## Notes\n");
        out.push_str("Use the exact path value with read_note or write_note.\n");
        for n in &notes {
            out.push_str(&format!("- path: \"{}\" — {}\n", n.path, n.title));
        }
    }

    if let Ok(storyboards) = project::scan_storyboards(root) {
        out.push_str("\n## Storyboards\n");
        out.push_str("Use the exact path value with read_storyboard or write_storyboard.\n");
        for sb in &storyboards {
            out.push_str(&format!(
                "- path: \"{}\" — {} ({} sketches)\n",
                sb.path, sb.title, sb.sketch_count
            ));
        }
    }

    if include_images {
        let screenshots_dir = root.join(".cutready").join("screenshots");
        if screenshots_dir.exists() {
            let mut images = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&screenshots_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                        if matches!(
                            ext.to_lowercase().as_str(),
                            "png" | "jpg" | "jpeg" | "gif" | "webp"
                        ) {
                            if let Ok(rel) = path.strip_prefix(root) {
                                images.push(rel.to_string_lossy().replace('\\', "/"));
                            }
                        }
                    }
                }
            }
            if !images.is_empty() {
                images.sort();
                out.push_str("\n## Screenshots\n");
                out.push_str("Use these paths as 'screenshot' values in write_sketch or update_planning_row.\n");
                for img in &images {
                    out.push_str(&format!("- {}\n", img));
                }
            }
        }
    }

    if out.is_empty() {
        "No sketches, notes, or storyboards found in this project.".into()
    } else {
        out
    }
}

fn exec_read_note(root: &Path, args: &Value, vision_enabled: bool) -> agentive::ToolOutput {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return agentive::ToolOutput::from("Error: missing 'path' argument"),
    };
    match project::read_note(&path) {
        Ok(content) => {
            if vision_enabled {
                let (text, image_parts) = extract_and_encode_images(&content, root);
                if !image_parts.is_empty() {
                    log::info!("[vision] read_note: {} images extracted", image_parts.len());
                    agentive::ToolOutput::with_images(text, image_parts)
                } else {
                    agentive::ToolOutput::from(content)
                }
            } else {
                agentive::ToolOutput::from(content)
            }
        }
        Err(e) => agentive::ToolOutput::from(format!("Error reading note: {e}")),
    }
}

fn exec_read_sketch(root: &Path, args: &Value, vision_enabled: bool) -> agentive::ToolOutput {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => {
            let listing = exec_list_project_files(root, &Value::Null);
            return agentive::ToolOutput::from(format!(
                "Error: missing 'path' argument. Call read_sketch with a path from the list below.\n\n{listing}"
            ));
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
                let lock_line = if row.locked {
                    "**Locked:** entire row\n".to_string()
                } else {
                    let locked_cells: Vec<&str> = [
                        "time",
                        "narrative",
                        "demo_actions",
                        "screenshot",
                        "visual",
                        "design_plan",
                    ]
                    .into_iter()
                    .filter(|field| row.locks.is_locked(field))
                    .collect();
                    if locked_cells.is_empty() {
                        String::new()
                    } else {
                        format!("**Locked cells:** {}\n", locked_cells.join(", "))
                    }
                };
                out.push_str(&format!(
                    "## Row {} [{}]\n{}**Narrative:** {}\n**Actions:** {}\n{}{}{}\n",
                    i,
                    row.time,
                    lock_line,
                    row.narrative,
                    row.demo_actions,
                    screenshot_line,
                    visual_line,
                    plan_line
                ));
            }
            if vision_enabled && !image_parts.is_empty() {
                log::info!(
                    "[vision] read_sketch: {} screenshots extracted",
                    image_parts.len()
                );
                agentive::ToolOutput::with_images(out, image_parts)
            } else {
                agentive::ToolOutput::from(out)
            }
        }
        Err(e) => agentive::ToolOutput::from(format!("Error reading sketch: {e}")),
    }
}

fn exec_write_sketch(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => return "Error: missing 'path' argument".into(),
    };
    let rows_val = match args.get("rows") {
        Some(v) => v,
        None => return "Error: missing 'rows' argument".into(),
    };

    let mut new_rows: Vec<PlanningRow> = match rows_val.as_array() {
        Some(arr) => arr
            .iter()
            .map(|r| PlanningRow {
                locked: false,
                locks: crate::models::sketch::PlanningCellLocks::default(),
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
                screenshot: r
                    .get("screenshot")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                visual: r.get("visual").cloned(),
                design_plan: r
                    .get("design_plan")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
            .collect(),
        None => return "Error: 'rows' must be an array".into(),
    };

    // Load existing sketch or create a new one
    let mut sketch = match project::read_sketch(&path).ok() {
        Some(s) => s,
        None => {
            // New sketch — use provided title or derive from filename
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    path.file_stem()
                        .map(|s| s.to_string_lossy().replace(['-', '_'], " "))
                        .unwrap_or_else(|| "Untitled".into())
                });
            crate::models::sketch::Sketch {
                title,
                locked: false,
                description: serde_json::Value::Null,
                rows: vec![],
                state: crate::models::sketch::SketchState::Draft,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            }
        }
    };

    if sketch.locked {
        return "Error: This sketch is locked. Unlock it before editing with AI.".into();
    }

    // Apply optional title/description updates (works for both new and existing sketches)
    if let Some(t) = args.get("title").and_then(|v| v.as_str()) {
        sketch.title = t.to_string();
    }
    if let Some(d) = args.get("description").and_then(|v| v.as_str()) {
        sketch.description = serde_json::Value::String(d.to_string());
    }

    if let Err(e) = project::validate_rows_update_allowed(&sketch.rows, &new_rows) {
        return format!("Error: {e}");
    }
    project::apply_locked_row_metadata(&sketch.rows, &mut new_rows);
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
            let listing = exec_list_project_files(root, &Value::Null);
            return format!(
                "Error: missing 'path' argument. Call update_planning_row with a path from the list below.\n\n{listing}"
            );
        }
    };
    let index = match args.get("index").and_then(|v| v.as_u64()) {
        Some(i) => i as usize,
        None => {
            let hint = match project::read_sketch(&path) {
                Ok(s) => format!(
                    " Sketch has {} rows (valid indices: 0–{}).",
                    s.rows.len(),
                    s.rows.len().saturating_sub(1)
                ),
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

    if sketch.locked {
        return "Error: This sketch is locked. Unlock it before editing with AI.".into();
    }
    if sketch.rows[index].locked {
        return format!(
            "Error: Planning row {} is locked. Unlock it before editing with AI.",
            index + 1
        );
    }
    for field in ["time", "narrative", "demo_actions", "screenshot"] {
        if args.get(field).is_some() && sketch.rows[index].locks.is_locked(field) {
            return format!(
                "Error: Planning row {} {} cell is locked. Unlock it before editing with AI.",
                index + 1,
                field.replace('_', " ")
            );
        }
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

fn format_row_summary(row: Option<&PlanningRow>) -> String {
    match row {
        Some(row) => format!(
            "narrative=\"{}\" actions=\"{}\"",
            truncate(&row.narrative, 120),
            truncate(&row.demo_actions, 120)
        ),
        None => "none".into(),
    }
}

fn format_visual_row_context(sketch: &Sketch, index: usize) -> String {
    let row = &sketch.rows[index];
    let flow = sketch
        .rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            format!(
                "{}. {} / {}",
                i,
                truncate(&r.narrative, 72),
                truncate(&r.demo_actions, 72)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "Row context:\n- Sketch title: {}\n- Target row index: {}\n- Target row narrative: {}\n- Target row demo actions: {}\n- Existing screenshot: {}\n- Existing design plan: {}\n- Previous row: {}\n- Next row: {}\n- Sketch high-level flow:\n{}",
        sketch.title,
        index,
        row.narrative,
        row.demo_actions,
        row.screenshot.as_deref().unwrap_or("none"),
        row.design_plan.as_deref().unwrap_or("none"),
        format_row_summary(index.checked_sub(1).and_then(|i| sketch.rows.get(i))),
        format_row_summary(sketch.rows.get(index + 1)),
        flow
    )
}

fn exec_set_row_visual(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => {
            let listing = exec_list_project_files(root, &Value::Null);
            return format!(
                "Error: missing 'path' argument. Call set_row_visual with a path from the list below.\n\n{listing}"
            );
        }
    };
    let index = match args.get("index").and_then(|v| v.as_u64()) {
        Some(i) => i as usize,
        None => {
            let hint = match project::read_sketch(&path) {
                Ok(s) => format!(
                    " Sketch has {} rows (valid indices: 0–{}).",
                    s.rows.len(),
                    s.rows.len().saturating_sub(1)
                ),
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

    if sketch.locked {
        return "Error: This sketch is locked. Unlock it before editing with AI.".into();
    }
    if sketch.rows[index].locked {
        return format!(
            "Error: Planning row {} is locked. Unlock it before editing with AI.",
            index + 1
        );
    }
    if sketch.rows[index].locks.is_locked("visual")
        || sketch.rows[index].locks.is_locked("screenshot")
    {
        return format!(
            "Error: Planning row {} media cell is locked. Unlock it before editing with AI.",
            index + 1
        );
    }

    let row_context = format_visual_row_context(&sketch, index);
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
            // Auto-normalize to v2 and validate before writing. CutReady stores
            // v2 visuals canonically, while critique still runs through the
            // renderable v1 compatibility shape used by the current renderer.
            let visual = match normalize_visual_to_v2(&visual) {
                Ok(v) => v,
                Err(e) => return format!("Validation failed (1 error) — fix this and call set_row_visual again:\n  • {e}\n\n{row_context}"),
            };
            let renderable_visual = match visual_to_renderable_v1(&visual) {
                Ok(v) => v,
                Err(e) => return format!("Validation failed (1 error) — visual could not be made renderable:\n  • {e}\n\n{row_context}"),
            };
            let mut errors = Vec::new();
            validate_dsl_doc(&visual, &mut errors);
            if !errors.is_empty() {
                return format!(
                    "Validation failed ({} error{}) — fix these and call set_row_visual again:\n{}\n\n{}",
                    errors.len(),
                    if errors.len() == 1 { "" } else { "s" },
                    errors
                        .iter()
                        .map(|e| format!("  • {e}"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    row_context
                );
            }
            let mut render_errors = Vec::new();
            validate_dsl_doc(&renderable_visual, &mut render_errors);
            if !render_errors.is_empty() {
                return format!(
                    "Validation failed ({} renderability error{}) — fix these and call set_row_visual again:\n{}\n\n{}",
                    render_errors.len(),
                    if render_errors.len() == 1 { "" } else { "s" },
                    render_errors
                        .iter()
                        .map(|e| format!("  • {e}"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    row_context
                );
            }
            // Auto-critique for layout/readability issues
            if let Ok((issues, suggestions)) = critique_visual_doc(&renderable_visual) {
                if !issues.is_empty() {
                    return format!(
                        "Critique failed ({} issue{}) — fix these and call set_row_visual again:\n{}\n\n{}",
                        issues.len(),
                        if issues.len() == 1 { "" } else { "s" },
                        issues.iter().enumerate()
                            .map(|(i, e)| format!("  ISSUE {}: {e}", i + 1))
                            .collect::<Vec<_>>().join("\n"),
                        row_context
                    );
                }
                if !suggestions.is_empty() {
                    critique_note = format!(
                        "\n\nSuggestions for next time:\n{}",
                        suggestions
                            .iter()
                            .enumerate()
                            .map(|(i, s)| format!("  {}: {s}", i + 1))
                            .collect::<Vec<_>>()
                            .join("\n")
                    );
                }
            }
            // Write visual to external file, store path reference on the row
            match project::write_visual(root, &visual) {
                Ok(rel_path) => {
                    row.visual = Some(serde_json::Value::String(rel_path));
                }
                Err(e) => return format!("Error writing visual file: {e}"),
            }
            let nudges = suggest_visual_nudges(&visual);
            if !nudges.is_empty() {
                let nudge_note = nudges
                    .iter()
                    .map(|n| format!("  • {} [{}]: {}", n.id, n.confidence, n.description))
                    .collect::<Vec<_>>()
                    .join("\n");
                critique_note.push_str(&format!(
                    "\n\nDeterministic polish available via apply_row_visual_nudge:\n{nudge_note}"
                ));
            }
            // Clear screenshot since visual replaces it
            row.screenshot = None;
        }
    }

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => {
            if sketch.rows[index].visual.is_some() {
                format!(
                    "✓ Visual saved on row {} in {}\n\n{}{}",
                    index,
                    path.display(),
                    row_context,
                    critique_note
                )
            } else {
                format!("Removed visual from row {} in {}", index, path.display())
            }
        }
        Err(e) => format!("Error writing sketch: {e}"),
    }
}

fn exec_review_row_visual(root: &Path, args: &Value) -> String {
    let (_path, sketch, index, visual) = match load_row_visual(root, args) {
        Ok(loaded) => loaded,
        Err(e) => return e,
    };

    let normalized = match normalize_visual_to_v2(&visual) {
        Ok(v) => v,
        Err(e) => return format!("Visual validation failed:\n  • {e}"),
    };
    let mut errors = Vec::new();
    validate_dsl_doc(&normalized, &mut errors);
    let renderable = match visual_to_renderable_v1(&normalized) {
        Ok(v) => v,
        Err(e) => return format!("Visual renderability failed:\n  • {e}"),
    };
    let (issues, suggestions) = critique_visual_doc(&renderable).unwrap_or_default();
    let summary = summarize_v2_visual(&normalized);
    let nudges = suggest_visual_nudges(&normalized);
    let row_context = format_visual_row_context(&sketch, index);

    let mut parts = vec![
        "Elucim visual review".to_string(),
        format!("- Valid: {}", if errors.is_empty() { "yes" } else { "no" }),
        "- Renderable: yes".to_string(),
        format!("- Elements: {}", summary.element_count),
        format!("- Timelines: {}", summary.timeline_count),
        format!("- State machines: {}", summary.state_machine_count),
    ];

    if !errors.is_empty() {
        parts.push(format!(
            "\nValidation errors:\n{}",
            errors
                .iter()
                .map(|e| format!("  • {e}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !issues.is_empty() {
        parts.push(format!(
            "\nCritique issues:\n{}",
            issues
                .iter()
                .map(|e| format!("  • {e}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !suggestions.is_empty() {
        parts.push(format!(
            "\nCritique suggestions:\n{}",
            suggestions
                .iter()
                .map(|e| format!("  • {e}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if nudges.is_empty() {
        parts.push("\nNudges: none".into());
    } else {
        parts.push(format!(
            "\nAvailable nudges:\n{}",
            nudges
                .iter()
                .map(|n| format!("  • {} [{}]: {}", n.id, n.confidence, n.description))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !summary.element_ids.is_empty() {
        parts.push(format!("\nElement IDs: {}", summary.element_ids.join(", ")));
    }
    parts.push(format!("\n{row_context}"));
    parts.join("\n")
}

fn exec_apply_row_visual_nudge(root: &Path, args: &Value) -> String {
    let nudge_id = match args.get("nudge_id").and_then(|v| v.as_str()) {
        Some(id) if !id.trim().is_empty() => id.trim(),
        _ => return "Error: missing 'nudge_id' argument".into(),
    };
    let (path, mut sketch, index, visual) = match load_row_visual(root, args) {
        Ok(loaded) => loaded,
        Err(e) => return e,
    };
    if let Err(e) = ensure_row_visual_editable(&sketch, index) {
        return e;
    }

    let normalized = match normalize_visual_to_v2(&visual) {
        Ok(v) => v,
        Err(e) => return format!("Visual validation failed:\n  • {e}"),
    };
    let before = normalized.clone();
    let updated = match apply_visual_nudge(&normalized, nudge_id) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let changed = count_changed_paths(&before, &updated);
    if let Err(e) = validate_agentic_visual(&updated) {
        return format!("Nudge produced an invalid visual; nothing saved:\n  • {e}");
    }
    match save_row_visual(root, &path, &mut sketch, index, &updated) {
        Ok(rel_path) => format!(
            "Applied visual nudge '{nudge_id}' to row {index}. Changed paths: {changed}. Saved: {rel_path}"
        ),
        Err(e) => e,
    }
}

fn exec_apply_row_visual_command(root: &Path, args: &Value) -> String {
    let command = match args.get("command") {
        Some(v) if v.is_object() => v,
        _ => return "Error: missing 'command' object".into(),
    };
    let (path, mut sketch, index, visual) = match load_row_visual(root, args) {
        Ok(loaded) => loaded,
        Err(e) => return e,
    };
    if let Err(e) = ensure_row_visual_editable(&sketch, index) {
        return e;
    }

    let normalized = match normalize_visual_to_v2(&visual) {
        Ok(v) => v,
        Err(e) => return format!("Visual validation failed:\n  • {e}"),
    };
    let before = normalized.clone();
    let updated = match apply_visual_command(&normalized, command) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let changed = count_changed_paths(&before, &updated);
    if let Err(e) = validate_agentic_visual(&updated) {
        return format!("Command produced an invalid visual; nothing saved:\n  • {e}");
    }
    let op = command
        .get("op")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    match save_row_visual(root, &path, &mut sketch, index, &updated) {
        Ok(rel_path) => format!(
            "Applied visual command '{op}' to row {index}. Changed paths: {changed}. Saved: {rel_path}"
        ),
        Err(e) => e,
    }
}

fn exec_design_plan(root: &Path, args: &Value) -> String {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => {
            let listing = exec_list_project_files(root, &Value::Null);
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
                Ok(s) => format!(
                    " Sketch has {} rows (valid indices: 0–{}).",
                    s.rows.len(),
                    s.rows.len().saturating_sub(1)
                ),
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

    if sketch.locked {
        return "Error: This sketch is locked. Unlock it before editing with AI.".into();
    }
    if sketch.rows[index].locked {
        return format!(
            "Error: Planning row {} is locked. Unlock it before editing with AI.",
            index + 1
        );
    }
    if sketch.rows[index].locks.is_locked("design_plan") {
        return format!(
            "Error: Planning row {} design plan cell is locked. Unlock it before editing with AI.",
            index + 1
        );
    }

    sketch.rows[index].design_plan = Some(plan.clone());
    let row_context = format_visual_row_context(&sketch, index);

    match project::write_sketch(&sketch, &path, root) {
        Ok(()) => {
            format!(
                "Design plan saved for row {}.\n\n{}\n\nSaved design plan:\n{}\n\nNow generate DSL JSON based on this plan and row context.",
                index, row_context, plan
            )
        }
        Err(e) => format!("Error writing sketch: {e}"),
    }
}

// Valid elucim DSL root node types
const VALID_ROOT_TYPES: &[&str] = &["scene", "player", "presentation"];

// Valid elucim DSL child node types
const VALID_NODE_TYPES: &[&str] = &[
    "circle",
    "rect",
    "line",
    "arrow",
    "text",
    "group",
    "polygon",
    "image",
    "axes",
    "latex",
    "graph",
    "matrix",
    "barChart",
    "slide",
    "bezierCurve",
    "codeBlock",
];

const V2_LAYOUT_KEYS: &[&str] = &[
    "x",
    "y",
    "width",
    "height",
    "cx",
    "cy",
    "r",
    "x1",
    "y1",
    "x2",
    "y2",
    "rotation",
    "rotationOrigin",
    "scale",
    "translate",
    "zIndex",
];

pub(crate) fn normalize_visual_document_for_save(visual: &Value) -> Result<Value, String> {
    let normalized = normalize_visual_to_v2(visual)?;
    validate_agentic_visual(&normalized)?;
    Ok(normalized)
}

fn normalize_visual_to_v2(visual: &Value) -> Result<Value, String> {
    match visual.get("version") {
        Some(Value::String(version)) if version == "2.0" => {
            validate_v2_doc(visual)?;
            Ok(visual.clone())
        }
        Some(Value::String(version)) if version == "1.0" => migrate_v1_visual_to_v2(visual),
        Some(Value::Number(version))
            if version.as_i64() == Some(1) && visual.get("root").is_some() =>
        {
            let mut coerced = visual.clone();
            if let Some(obj) = coerced.as_object_mut() {
                obj.insert("version".into(), Value::String("1.0".into()));
            }
            migrate_v1_visual_to_v2(&coerced)
        }
        Some(Value::String(version)) if version == "1" && visual.get("root").is_some() => {
            let mut coerced = visual.clone();
            if let Some(obj) = coerced.as_object_mut() {
                obj.insert("version".into(), Value::String("1.0".into()));
            }
            migrate_v1_visual_to_v2(&coerced)
        }
        Some(Value::Number(version)) if version.as_i64() == Some(1) => {
            migrate_legacy_rootless_to_v2(visual)
        }
        Some(Value::String(version)) if version == "1" => migrate_legacy_rootless_to_v2(visual),
        Some(v) => Err(format!("version: expected \"2.0\" or \"1.0\", got {v}")),
        None if visual.get("root").is_some() => {
            let mut coerced = visual.clone();
            if let Some(obj) = coerced.as_object_mut() {
                obj.insert("version".into(), Value::String("1.0".into()));
            }
            migrate_v1_visual_to_v2(&coerced)
        }
        None if visual.get("scene").is_some() && visual.get("elements").is_some() => {
            let mut coerced = visual.clone();
            if let Some(obj) = coerced.as_object_mut() {
                obj.insert("version".into(), Value::String("2.0".into()));
            }
            validate_v2_doc(&coerced)?;
            Ok(coerced)
        }
        None => Err("missing required field \"version\"".into()),
    }
}

fn visual_to_renderable_v1(visual: &Value) -> Result<Value, String> {
    match visual.get("version").and_then(|v| v.as_str()) {
        Some("1.0") => Ok(visual.clone()),
        Some("2.0") => migrate_v2_visual_to_v1(visual),
        _ => {
            let normalized = normalize_visual_to_v2(visual)?;
            migrate_v2_visual_to_v1(&normalized)
        }
    }
}

fn migrate_v1_visual_to_v2(visual: &Value) -> Result<Value, String> {
    let root = visual
        .get("root")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "root: missing or invalid object".to_string())?;
    if root.get("type").and_then(|v| v.as_str()) == Some("presentation") {
        return Err("v1 presentation migration to v2 is not supported for row visuals".into());
    }
    let children = root
        .get("children")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "root.children: missing array".to_string())?;

    let mut used_ids = std::collections::HashSet::new();
    let mut elements = serde_json::Map::new();
    let child_ids = children
        .iter()
        .enumerate()
        .map(|(index, child)| {
            migrate_v1_element_to_v2(
                child,
                &format!(
                    "root.{}[{index}]",
                    child
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("element")
                ),
                None,
                &mut used_ids,
                &mut elements,
            )
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut scene = serde_json::Map::new();
    for key in [
        "type",
        "preset",
        "width",
        "height",
        "fps",
        "durationInFrames",
        "background",
        "controls",
        "loop",
        "autoPlay",
    ] {
        if let Some(value) = root.get(key) {
            scene.insert(key.into(), value.clone());
        }
    }
    if !scene.contains_key("durationInFrames") {
        scene.insert("durationInFrames".into(), Value::Number(120.into()));
    }
    scene.insert(
        "children".into(),
        Value::Array(child_ids.into_iter().map(Value::String).collect()),
    );

    let mut doc = serde_json::Map::new();
    doc.insert("version".into(), Value::String("2.0".into()));
    doc.insert("scene".into(), Value::Object(scene));
    doc.insert("elements".into(), Value::Object(elements));
    doc.insert(
        "metadata".into(),
        json!({
            "polishLevel": "draft",
            "notes": ["Migrated from Elucim v1 by CutReady."]
        }),
    );
    let doc = Value::Object(doc);
    validate_v2_doc(&doc)?;
    Ok(doc)
}

fn migrate_v1_element_to_v2(
    element: &Value,
    fallback_id: &str,
    parent_id: Option<&str>,
    used_ids: &mut std::collections::HashSet<String>,
    elements: &mut serde_json::Map<String, Value>,
) -> Result<String, String> {
    let obj = element
        .as_object()
        .ok_or_else(|| format!("{fallback_id}: element must be an object"))?;
    let element_type = obj
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("group")
        .to_string();
    let base_id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|id| !id.trim().is_empty())
        .unwrap_or(fallback_id);
    let id = reserve_v2_id(base_id, used_ids);

    let child_ids = obj
        .get("children")
        .and_then(|v| v.as_array())
        .map(|children| {
            children
                .iter()
                .enumerate()
                .map(|(index, child)| {
                    migrate_v1_element_to_v2(
                        child,
                        &format!(
                            "{id}.{}[{index}]",
                            child
                                .get("type")
                                .and_then(|v| v.as_str())
                                .unwrap_or("element")
                        ),
                        Some(&id),
                        used_ids,
                        elements,
                    )
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;

    let mut props = serde_json::Map::new();
    let mut layout = serde_json::Map::new();
    for (key, value) in obj {
        if key == "id" || key == "children" {
            continue;
        }
        props.insert(key.clone(), value.clone());
        if V2_LAYOUT_KEYS.contains(&key.as_str()) {
            layout.insert(key.clone(), value.clone());
        }
    }

    let mut v2 = serde_json::Map::new();
    v2.insert("id".into(), Value::String(id.clone()));
    v2.insert("type".into(), Value::String(element_type));
    if let Some(parent_id) = parent_id {
        v2.insert("parentId".into(), Value::String(parent_id.to_string()));
    }
    if let Some(child_ids) = child_ids {
        v2.insert(
            "children".into(),
            Value::Array(child_ids.into_iter().map(Value::String).collect()),
        );
    }
    if !layout.is_empty() {
        v2.insert("layout".into(), Value::Object(layout));
    }
    v2.insert("props".into(), Value::Object(props));
    elements.insert(id.clone(), Value::Object(v2));
    Ok(id)
}

fn reserve_v2_id(base_id: &str, used_ids: &mut std::collections::HashSet<String>) -> String {
    let mut id = base_id.trim().replace([' ', '/', '\\'], "-");
    if id.is_empty() {
        id = "element".into();
    }
    let original = id.clone();
    let mut suffix = 2;
    while used_ids.contains(&id) {
        id = format!("{original}-{suffix}");
        suffix += 1;
    }
    used_ids.insert(id.clone());
    id
}

fn migrate_legacy_rootless_to_v2(visual: &Value) -> Result<Value, String> {
    let elements = visual
        .get("elements")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "legacy rootless visual: expected elements array".to_string())?;
    let mut children = Vec::new();
    if let Some(title) = visual.get("title").and_then(|v| v.as_str()) {
        children.push(json!({
            "type": "text",
            "id": "title",
            "content": title,
            "x": 96,
            "y": 96,
            "fontSize": 48,
            "fill": "$title"
        }));
    }
    children.extend(elements.iter().cloned());
    let v1 = json!({
        "version": "1.0",
        "root": {
            "type": "player",
            "width": visual.get("width").and_then(|v| v.as_u64()).unwrap_or(1920),
            "height": visual.get("height").and_then(|v| v.as_u64()).unwrap_or(1080),
            "fps": visual.get("fps").and_then(|v| v.as_u64()).unwrap_or(30),
            "durationInFrames": visual.get("durationInFrames").and_then(|v| v.as_u64()).or_else(|| visual.get("duration").and_then(|v| v.as_u64())).unwrap_or(120),
            "background": visual.get("background").cloned().unwrap_or_else(|| Value::String("$background".into())),
            "children": children
        }
    });
    migrate_v1_visual_to_v2(&v1)
}

fn migrate_v2_visual_to_v1(visual: &Value) -> Result<Value, String> {
    validate_v2_doc(visual)?;
    let scene = visual
        .get("scene")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "scene: missing or invalid object".to_string())?;
    let children = scene
        .get("children")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "scene.children: missing array".to_string())?;
    let restored_children = children
        .iter()
        .map(|id| {
            id.as_str()
                .ok_or_else(|| "scene.children: child IDs must be strings".to_string())
                .and_then(|id| restore_v2_element_to_v1(visual, id))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut root = serde_json::Map::new();
    for key in [
        "type",
        "preset",
        "width",
        "height",
        "fps",
        "durationInFrames",
        "background",
        "controls",
        "loop",
        "autoPlay",
    ] {
        if let Some(value) = scene.get(key) {
            root.insert(key.into(), value.clone());
        }
    }
    root.insert("children".into(), Value::Array(restored_children));
    Ok(json!({ "version": "1.0", "root": Value::Object(root) }))
}

fn restore_v2_element_to_v1(visual: &Value, id: &str) -> Result<Value, String> {
    let elements = visual
        .get("elements")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "elements: missing or invalid object".to_string())?;
    let element = elements
        .get(id)
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("elements.{id}: missing element"))?;
    let mut restored = element
        .get("layout")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let props = element
        .get("props")
        .and_then(|v| v.as_object())
        .cloned()
        .ok_or_else(|| format!("elements.{id}.props: missing object"))?;
    for (key, value) in props {
        restored.insert(key, value);
    }
    restored.insert("id".into(), Value::String(id.to_string()));
    restored.insert(
        "type".into(),
        Value::String(
            element
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("group")
                .to_string(),
        ),
    );
    if let Some(children) = element.get("children").and_then(|v| v.as_array()) {
        let restored_children = children
            .iter()
            .map(|child| {
                child
                    .as_str()
                    .ok_or_else(|| format!("elements.{id}.children: child IDs must be strings"))
                    .and_then(|child_id| restore_v2_element_to_v1(visual, child_id))
            })
            .collect::<Result<Vec<_>, _>>()?;
        restored.insert("children".into(), Value::Array(restored_children));
    }
    Ok(Value::Object(restored))
}

fn validate_v2_doc(visual: &Value) -> Result<(), String> {
    let obj = visual
        .as_object()
        .ok_or_else(|| "document: must be an object".to_string())?;
    if obj.get("version").and_then(|v| v.as_str()) != Some("2.0") {
        return Err("version: expected \"2.0\"".into());
    }
    let scene = obj
        .get("scene")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "scene: missing or invalid object".to_string())?;
    match scene.get("type").and_then(|v| v.as_str()) {
        Some("scene" | "player") => {}
        Some(t) => {
            return Err(format!(
                "scene.type: expected \"scene\" or \"player\", got \"{t}\""
            ))
        }
        None => return Err("scene.type: missing".into()),
    }
    if !scene
        .get("durationInFrames")
        .and_then(|v| v.as_i64())
        .is_some_and(|n| n > 0)
    {
        return Err("scene.durationInFrames: must be a positive integer".into());
    }
    let scene_children = scene
        .get("children")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "scene.children: must be an array of element IDs".to_string())?;
    let elements = obj
        .get("elements")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "elements: missing or invalid object".to_string())?;

    for (index, child) in scene_children.iter().enumerate() {
        let id = child
            .as_str()
            .ok_or_else(|| format!("scene.children[{index}]: must be an element ID string"))?;
        if !elements.contains_key(id) {
            return Err(format!(
                "scene.children[{index}]: unknown element ID \"{id}\""
            ));
        }
    }
    for (id, element) in elements {
        let element = element
            .as_object()
            .ok_or_else(|| format!("elements.{id}: must be an object"))?;
        if element.get("id").and_then(|v| v.as_str()) != Some(id.as_str()) {
            return Err(format!("elements.{id}.id: must match map key \"{id}\""));
        }
        if element.get("type").and_then(|v| v.as_str()).is_none() {
            return Err(format!("elements.{id}.type: missing"));
        }
        if !element.get("props").is_some_and(|v| v.is_object()) {
            return Err(format!("elements.{id}.props: must be an object"));
        }
        if let Some(parent_id) = element.get("parentId").and_then(|v| v.as_str()) {
            if !elements.contains_key(parent_id) {
                return Err(format!(
                    "elements.{id}.parentId: unknown parent ID \"{parent_id}\""
                ));
            }
        }
        if let Some(children) = element.get("children").and_then(|v| v.as_array()) {
            for (index, child) in children.iter().enumerate() {
                let child_id = child.as_str().ok_or_else(|| {
                    format!("elements.{id}.children[{index}]: must be an element ID string")
                })?;
                if !elements.contains_key(child_id) {
                    return Err(format!(
                        "elements.{id}.children[{index}]: unknown element ID \"{child_id}\""
                    ));
                }
                if elements
                    .get(child_id)
                    .and_then(|v| v.get("parentId"))
                    .and_then(|v| v.as_str())
                    != Some(id.as_str())
                {
                    return Err(format!("elements.{id}.children[{index}]: child \"{child_id}\" must have parentId \"{id}\""));
                }
            }
        }
    }
    validate_v2_timelines(obj, elements)?;
    validate_v2_state_machines(obj)?;
    Ok(())
}

fn validate_v2_timelines(
    doc: &serde_json::Map<String, Value>,
    elements: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    let Some(timelines) = doc.get("timelines") else {
        return Ok(());
    };
    let timelines = timelines
        .as_object()
        .ok_or_else(|| "timelines: must be an object".to_string())?;
    const VALID_PROPERTIES: &[&str] =
        &["opacity", "translate", "scale", "rotate", "fill", "stroke"];
    for (timeline_id, timeline) in timelines {
        let timeline = timeline
            .as_object()
            .ok_or_else(|| format!("timelines.{timeline_id}: must be an object"))?;
        if timeline.get("id").and_then(|v| v.as_str()) != Some(timeline_id.as_str()) {
            return Err(format!(
                "timelines.{timeline_id}.id: must match key \"{timeline_id}\""
            ));
        }
        let duration = timeline
            .get("duration")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("timelines.{timeline_id}.duration: must be positive"))?;
        if duration <= 0.0 || !duration.is_finite() {
            return Err(format!(
                "timelines.{timeline_id}.duration: must be positive"
            ));
        }
        let Some(tracks) = timeline.get("tracks") else {
            continue;
        };
        let tracks = tracks
            .as_array()
            .ok_or_else(|| format!("timelines.{timeline_id}.tracks: must be an array"))?;
        for (track_index, track) in tracks.iter().enumerate() {
            let track = track.as_object().ok_or_else(|| {
                format!("timelines.{timeline_id}.tracks[{track_index}]: must be an object")
            })?;
            let target = track
                .get("target")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    format!("timelines.{timeline_id}.tracks[{track_index}].target: missing")
                })?;
            if !elements.contains_key(target) {
                return Err(format!(
                    "timelines.{timeline_id}.tracks[{track_index}].target: unknown target \"{target}\""
                ));
            }
            let property = track
                .get("property")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    format!("timelines.{timeline_id}.tracks[{track_index}].property: missing")
                })?;
            if !VALID_PROPERTIES.contains(&property) {
                return Err(format!(
                    "timelines.{timeline_id}.tracks[{track_index}].property: unsupported animatable property \"{property}\""
                ));
            }
            let keyframes = track
                .get("keyframes")
                .and_then(|v| v.as_array())
                .ok_or_else(|| {
                    format!("timelines.{timeline_id}.tracks[{track_index}].keyframes: must be a non-empty array")
                })?;
            if keyframes.is_empty() {
                return Err(format!(
                    "timelines.{timeline_id}.tracks[{track_index}].keyframes: must be a non-empty array"
                ));
            }
            let mut previous_frame = -1_i64;
            for (keyframe_index, keyframe) in keyframes.iter().enumerate() {
                let keyframe = keyframe.as_object().ok_or_else(|| {
                    format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}]: must be an object")
                })?;
                let frame = keyframe
                    .get("frame")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| {
                        format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].frame: must be a non-negative integer")
                    })?;
                if frame < 0 {
                    return Err(format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].frame: must be a non-negative integer"));
                }
                if frame as f64 > duration {
                    return Err(format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].frame: cannot exceed timeline duration"));
                }
                if frame <= previous_frame {
                    return Err(format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].frame: frames must be strictly increasing"));
                }
                previous_frame = frame;
                if !keyframe.contains_key("value") {
                    return Err(format!("timelines.{timeline_id}.tracks[{track_index}].keyframes[{keyframe_index}].value: required"));
                }
            }
        }
    }
    Ok(())
}

fn validate_v2_state_machines(doc: &serde_json::Map<String, Value>) -> Result<(), String> {
    let timeline_ids = doc
        .get("timelines")
        .and_then(|v| v.as_object())
        .map(|timelines| {
            timelines
                .keys()
                .cloned()
                .collect::<std::collections::HashSet<_>>()
        })
        .unwrap_or_default();
    let Some(state_machines) = doc.get("stateMachines") else {
        return Ok(());
    };
    let state_machines = state_machines
        .as_object()
        .ok_or_else(|| "stateMachines: must be an object".to_string())?;
    for (machine_id, machine) in state_machines {
        let machine = machine
            .as_object()
            .ok_or_else(|| format!("stateMachines.{machine_id}: must be an object"))?;
        if machine.get("id").and_then(|v| v.as_str()) != Some(machine_id.as_str()) {
            return Err(format!(
                "stateMachines.{machine_id}.id: must match key \"{machine_id}\""
            ));
        }
        let initial = machine
            .get("initial")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("stateMachines.{machine_id}.initial: missing"))?;
        let states = machine
            .get("states")
            .and_then(|v| v.as_object())
            .ok_or_else(|| format!("stateMachines.{machine_id}.states: must be an object"))?;
        if !states.contains_key(initial) {
            return Err(format!(
                "stateMachines.{machine_id}.initial: initial state \"{initial}\" does not exist"
            ));
        }
        for (state_id, state) in states {
            let state = state.as_object().ok_or_else(|| {
                format!("stateMachines.{machine_id}.states.{state_id}: must be an object")
            })?;
            if let Some(timeline) = state.get("timeline").and_then(|v| v.as_str()) {
                if !timeline_ids.contains(timeline) {
                    return Err(format!(
                        "stateMachines.{machine_id}.states.{state_id}.timeline: unknown timeline \"{timeline}\""
                    ));
                }
            }
            if let Some(on) = state.get("on").and_then(|v| v.as_object()) {
                for (event, transition) in on {
                    validate_v2_transition(
                        machine_id,
                        state_id,
                        &format!("on.{event}"),
                        transition,
                        states,
                        &timeline_ids,
                    )?;
                }
            }
            if let Some(transition) = state.get("onComplete") {
                validate_v2_transition(
                    machine_id,
                    state_id,
                    "onComplete",
                    transition,
                    states,
                    &timeline_ids,
                )?;
            }
        }
    }
    Ok(())
}

fn validate_v2_transition(
    machine_id: &str,
    state_id: &str,
    path: &str,
    transition: &Value,
    states: &serde_json::Map<String, Value>,
    timeline_ids: &std::collections::HashSet<String>,
) -> Result<(), String> {
    let (target, timeline) = if let Some(target) = transition.as_str() {
        (target, None)
    } else {
        let transition = transition.as_object().ok_or_else(|| {
            format!("stateMachines.{machine_id}.states.{state_id}.{path}: transition must be a state ID or object")
        })?;
        let target = transition
            .get("target")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                format!("stateMachines.{machine_id}.states.{state_id}.{path}.target: missing")
            })?;
        let timeline = transition.get("timeline").and_then(|v| v.as_str());
        (target, timeline)
    };
    if !states.contains_key(target) {
        return Err(format!(
            "stateMachines.{machine_id}.states.{state_id}.{path}: unknown target state \"{target}\""
        ));
    }
    if let Some(timeline) = timeline {
        if !timeline_ids.contains(timeline) {
            return Err(format!(
                "stateMachines.{machine_id}.states.{state_id}.{path}.timeline: unknown timeline \"{timeline}\""
            ));
        }
    }
    Ok(())
}

struct VisualSummary {
    element_count: usize,
    timeline_count: usize,
    state_machine_count: usize,
    element_ids: Vec<String>,
}

struct VisualNudge {
    id: &'static str,
    confidence: &'static str,
    description: &'static str,
}

fn load_row_visual(root: &Path, args: &Value) -> Result<(PathBuf, Sketch, usize, Value), String> {
    let path = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => resolve_path(root, p),
        None => {
            let listing = exec_list_project_files(root, &Value::Null);
            return Err(format!(
                "Error: missing 'path' argument. Use a sketch path from the list below.\n\n{listing}"
            ));
        }
    };
    let index = match args.get("index").and_then(|v| v.as_u64()) {
        Some(i) => i as usize,
        None => {
            let hint = match project::read_sketch(&path) {
                Ok(s) => format!(
                    " Sketch has {} rows (valid indices: 0–{}).",
                    s.rows.len(),
                    s.rows.len().saturating_sub(1)
                ),
                Err(_) => String::new(),
            };
            return Err(format!("Error: missing 'index' (0-based row index).{hint}"));
        }
    };
    let sketch = project::read_sketch(&path).map_err(|e| format!("Error reading sketch: {e}"))?;
    if index >= sketch.rows.len() {
        return Err(format!(
            "Error: index {} out of range (sketch has {} rows)",
            index,
            sketch.rows.len()
        ));
    }
    let row = &sketch.rows[index];
    let Some(visual_ref) = &row.visual else {
        return Err(format!("Error: row {index} does not have a visual"));
    };
    let visual = if let Some(rel_path) = visual_ref.as_str() {
        project::read_visual(root, rel_path).map_err(|e| format!("Error reading visual: {e}"))?
    } else if visual_ref.is_object() {
        visual_ref.clone()
    } else {
        return Err(format!(
            "Error: row {index} visual reference must be a path string or visual document"
        ));
    };
    Ok((path, sketch, index, visual))
}

fn ensure_row_visual_editable(sketch: &Sketch, index: usize) -> Result<(), String> {
    if sketch.locked {
        return Err("Error: This sketch is locked. Unlock it before editing with AI.".into());
    }
    if sketch.rows[index].locked {
        return Err(format!(
            "Error: Planning row {} is locked. Unlock it before editing with AI.",
            index + 1
        ));
    }
    if sketch.rows[index].locks.is_locked("visual")
        || sketch.rows[index].locks.is_locked("screenshot")
    {
        return Err(format!(
            "Error: Planning row {} media cell is locked. Unlock it before editing with AI.",
            index + 1
        ));
    }
    Ok(())
}

fn save_row_visual(
    root: &Path,
    path: &Path,
    sketch: &mut Sketch,
    index: usize,
    visual: &Value,
) -> Result<String, String> {
    let rel_path = project::write_visual(root, visual)
        .map_err(|e| format!("Error writing visual file: {e}"))?;
    sketch.rows[index].visual = Some(Value::String(rel_path.clone()));
    sketch.rows[index].screenshot = None;
    project::write_sketch(sketch, path, root).map_err(|e| format!("Error writing sketch: {e}"))?;
    Ok(rel_path)
}

fn validate_agentic_visual(visual: &Value) -> Result<(), String> {
    let mut errors = Vec::new();
    validate_dsl_doc(visual, &mut errors);
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    visual_to_renderable_v1(visual).map(|_| ())
}

fn summarize_v2_visual(visual: &Value) -> VisualSummary {
    let mut element_ids = visual
        .get("elements")
        .and_then(|v| v.as_object())
        .map(|elements| elements.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    element_ids.sort();
    VisualSummary {
        element_count: element_ids.len(),
        timeline_count: visual
            .get("timelines")
            .and_then(|v| v.as_object())
            .map(|v| v.len())
            .unwrap_or(0),
        state_machine_count: visual
            .get("stateMachines")
            .and_then(|v| v.as_object())
            .map(|v| v.len())
            .unwrap_or(0),
        element_ids,
    }
}

fn suggest_visual_nudges(visual: &Value) -> Vec<VisualNudge> {
    let mut nudges = Vec::new();
    if visual
        .pointer("/metadata/polishLevel")
        .and_then(|v| v.as_str())
        != Some("refined")
    {
        nudges.push(VisualNudge {
            id: "mark-refined",
            confidence: "safe",
            description: "Mark the document metadata as refined for downstream agents.",
        });
    }
    if elements_need_intent(visual) {
        nudges.push(VisualNudge {
            id: "annotate-element-intent",
            confidence: "safe",
            description: "Add non-rendering intent.role and Elucim-compatible intent.importance metadata to important elements.",
        });
    }
    if scene_children_need_layer_order(visual) {
        nudges.push(VisualNudge {
            id: "normalize-root-layer-order",
            confidence: "safe",
            description:
                "Assign top-level zIndex values that match scene order for stable agent edits.",
        });
    }
    if visual
        .get("timelines")
        .and_then(|v| v.as_object())
        .is_none_or(|timelines| timelines.is_empty())
        && visual
            .pointer("/scene/children")
            .and_then(|v| v.as_array())
            .is_some_and(|children| children.len() > 1)
    {
        nudges.push(VisualNudge {
            id: "add-staggered-intro",
            confidence: "review",
            description: "Add a simple intro timeline and render-compatible fadeIn values for top-level elements.",
        });
    }
    nudges
}

fn apply_visual_nudge(visual: &Value, nudge_id: &str) -> Result<Value, String> {
    match nudge_id {
        "mark-refined" => apply_visual_command(visual, &json!({ "op": "markRefined" })),
        "annotate-element-intent" => {
            apply_visual_command(visual, &json!({ "op": "annotateElementIntent" }))
        }
        "normalize-root-layer-order" => {
            apply_visual_command(visual, &json!({ "op": "normalizeRootLayerOrder" }))
        }
        "add-staggered-intro" => {
            apply_visual_command(visual, &json!({ "op": "addStaggeredIntro" }))
        }
        other => Err(format!("Error: unknown visual nudge '{other}'")),
    }
}

fn apply_visual_command(visual: &Value, command: &Value) -> Result<Value, String> {
    let op = command
        .get("op")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Error: command.op is required".to_string())?;
    let mut updated = visual.clone();
    match op {
        "updateMetadata" | "update_metadata" => {
            let metadata = command
                .get("metadata")
                .and_then(|v| v.as_object())
                .ok_or_else(|| "Error: updateMetadata requires a metadata object".to_string())?;
            let doc = updated
                .as_object_mut()
                .ok_or_else(|| "Error: visual document must be an object".to_string())?;
            let entry = doc
                .entry("metadata")
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            let Some(target) = entry.as_object_mut() else {
                return Err("Error: document metadata must be an object".into());
            };
            for (key, value) in metadata {
                target.insert(key.clone(), value.clone());
            }
        }
        "markRefined" | "mark-refined" | "mark_refined" => {
            let doc = updated
                .as_object_mut()
                .ok_or_else(|| "Error: visual document must be an object".to_string())?;
            let entry = doc
                .entry("metadata")
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            let Some(target) = entry.as_object_mut() else {
                return Err("Error: document metadata must be an object".into());
            };
            target.insert("polishLevel".into(), Value::String("refined".into()));
        }
        "annotateElementIntent" | "annotate-element-intent" | "annotate_element_intent" => {
            annotate_element_intent(&mut updated)?;
        }
        "normalizeRootLayerOrder" | "normalize-root-layer-order" | "normalize_root_layer_order" => {
            normalize_scene_children_order(&mut updated)?;
        }
        "addStaggeredIntro" | "add-staggered-intro" | "add_staggered_intro" => {
            add_staggered_intro_timeline(&mut updated, command)?;
        }
        other => return Err(format!("Error: unsupported visual command op '{other}'")),
    }
    Ok(updated)
}

fn elements_need_intent(visual: &Value) -> bool {
    visual
        .get("elements")
        .and_then(|v| v.as_object())
        .is_some_and(|elements| {
            elements.values().any(|element| {
                let id = element.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let role = element.pointer("/intent/role").and_then(|v| v.as_str());
                is_important_element_id(id) && role.is_none()
            })
        })
}

fn annotate_element_intent(visual: &mut Value) -> Result<(), String> {
    let elements = visual
        .get_mut("elements")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "Error: elements must be an object".to_string())?;
    for (key, element) in elements {
        let Some(element) = element.as_object_mut() else {
            return Err(format!("Error: elements.{key} must be an object"));
        };
        let id = element
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or(key)
            .to_string();
        let element_type = element
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("element")
            .to_string();
        let (role, importance) = infer_element_intent(&id, &element_type);
        let entry = element
            .entry("intent")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        let Some(intent) = entry.as_object_mut() else {
            return Err(format!("Error: elements.{key}.intent must be an object"));
        };
        intent
            .entry("role")
            .or_insert_with(|| Value::String(role.into()));
        intent
            .entry("importance")
            .or_insert_with(|| Value::String(importance.into()));
    }
    Ok(())
}

fn is_important_element_id(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    id == "title"
        || id == "subtitle"
        || id.contains("hero")
        || id.contains("step")
        || id.contains("stage")
        || id.contains("label")
        || id.contains("card")
}

fn infer_element_intent(id: &str, element_type: &str) -> (&'static str, &'static str) {
    let id = id.to_ascii_lowercase();
    if id == "title" || id.ends_with("-title") {
        ("title", "primary")
    } else if id == "subtitle" || id.contains("subtitle") {
        ("subtitle", "secondary")
    } else if id.contains("hero") || id.contains("focus") || id.contains("center") {
        ("hero", "primary")
    } else if id.contains("step") || id.contains("stage") {
        ("step", "secondary")
    } else if id.contains("arrow")
        || id.contains("connector")
        || element_type == "arrow"
        || element_type == "line"
    {
        ("connector", "supporting")
    } else if id.contains("label") || element_type == "text" {
        ("label", "supporting")
    } else if id.contains("card") || id.contains("panel") || element_type == "rect" {
        ("container", "secondary")
    } else {
        ("decoration", "decorative")
    }
}

fn scene_children_need_layer_order(visual: &Value) -> bool {
    let Some(children) = visual.pointer("/scene/children").and_then(|v| v.as_array()) else {
        return false;
    };
    children.iter().enumerate().any(|(index, child)| {
        child
            .as_str()
            .is_some_and(|id| v2_element_z_index(visual, id) != Some(index as i64))
    })
}

fn normalize_scene_children_order(visual: &mut Value) -> Result<(), String> {
    let root_children = visual
        .pointer("/scene/children")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Error: scene.children must be an array".to_string())?
        .iter()
        .enumerate()
        .filter_map(|(index, child)| child.as_str().map(|id| (index, id.to_string())))
        .collect::<Vec<_>>();
    let elements = visual
        .get_mut("elements")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "Error: elements must be an object".to_string())?;
    for (index, id) in root_children {
        let Some(element) = elements.get_mut(&id).and_then(|v| v.as_object_mut()) else {
            continue;
        };
        let layout = element
            .entry("layout")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        let Some(layout) = layout.as_object_mut() else {
            return Err(format!("Error: elements.{id}.layout must be an object"));
        };
        layout.insert("zIndex".into(), Value::Number((index as i64).into()));
    }
    Ok(())
}

fn v2_element_z_index(visual: &Value, id: &str) -> Option<i64> {
    visual
        .pointer(&format!("/elements/{id}/layout/zIndex"))
        .and_then(|v| v.as_i64())
}

fn add_staggered_intro_timeline(visual: &mut Value, command: &Value) -> Result<(), String> {
    let targets = visual
        .pointer("/scene/children")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Error: scene.children must be an array".to_string())?
        .iter()
        .filter_map(|v| v.as_str())
        .filter(|id| visual.pointer(&format!("/elements/{id}")).is_some())
        .take(8)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Err("Error: addStaggeredIntro requires at least one scene child".into());
    }
    let timeline_id = command
        .get("timelineId")
        .or_else(|| command.get("timeline_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("auto-intro");
    let stagger = command
        .get("staggerFrames")
        .or_else(|| command.get("stagger_frames"))
        .and_then(|v| v.as_i64())
        .unwrap_or(6)
        .max(1);
    let duration = command
        .get("durationFrames")
        .or_else(|| command.get("duration_frames"))
        .and_then(|v| v.as_i64())
        .unwrap_or(18)
        .max(2);
    let scene_duration = visual
        .pointer("/scene/durationInFrames")
        .and_then(|v| v.as_i64())
        .unwrap_or(120)
        .max(1);
    let timeline_duration = scene_duration
        .min(duration.max((targets.len().saturating_sub(1) as i64) * stagger + duration));
    let tracks = targets
        .iter()
        .enumerate()
        .map(|(index, id)| {
            let start = ((index as i64) * stagger).min((timeline_duration - duration).max(0));
            let end = timeline_duration.min(start + duration);
            json!({
                "target": id,
                "property": "opacity",
                "keyframes": [
                    { "frame": start, "value": 0 },
                    { "frame": end, "value": 1, "easing": "easeOutCubic" }
                ]
            })
        })
        .collect::<Vec<_>>();
    let doc = visual
        .as_object_mut()
        .ok_or_else(|| "Error: visual document must be an object".to_string())?;
    let timelines = doc
        .entry("timelines")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(timelines) = timelines.as_object_mut() else {
        return Err("Error: document timelines must be an object".into());
    };
    timelines.insert(
        timeline_id.into(),
        json!({
            "id": timeline_id,
            "duration": timeline_duration,
            "tracks": tracks
        }),
    );
    let elements = doc
        .get_mut("elements")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| "Error: elements must be an object".to_string())?;
    for (index, id) in targets.iter().enumerate() {
        let Some(element) = elements.get_mut(id).and_then(|v| v.as_object_mut()) else {
            continue;
        };
        let props = element
            .entry("props")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        let Some(props) = props.as_object_mut() else {
            return Err(format!("Error: elements.{id}.props must be an object"));
        };
        let fade_in = (index as i64) * stagger;
        if fade_in > 0 {
            props
                .entry("fadeIn")
                .or_insert_with(|| Value::Number(fade_in.into()));
        }
    }
    Ok(())
}

fn count_changed_paths(before: &Value, after: &Value) -> usize {
    match (before, after) {
        (Value::Object(left), Value::Object(right)) => {
            let keys = left
                .keys()
                .chain(right.keys())
                .cloned()
                .collect::<std::collections::HashSet<_>>();
            keys.into_iter()
                .map(|key| {
                    count_changed_paths(
                        left.get(&key).unwrap_or(&Value::Null),
                        right.get(&key).unwrap_or(&Value::Null),
                    )
                })
                .sum()
        }
        (Value::Array(left), Value::Array(right)) => {
            let max_len = left.len().max(right.len());
            (0..max_len)
                .map(|index| {
                    count_changed_paths(
                        left.get(index).unwrap_or(&Value::Null),
                        right.get(index).unwrap_or(&Value::Null),
                    )
                })
                .sum()
        }
        _ if before == after => 0,
        _ => 1,
    }
}

fn validate_dsl_node(node: &Value, path: &str, errors: &mut Vec<String>) {
    let obj = match node.as_object() {
        Some(o) => o,
        None => {
            errors.push(format!(
                "{path}: expected object, got {}",
                node_type_name(node)
            ));
            return;
        }
    };

    if let Some(t) = obj.get("type").and_then(|v| v.as_str()) {
        if !VALID_ROOT_TYPES.contains(&t) && !VALID_NODE_TYPES.contains(&t) {
            errors.push(format!(
                "{path}.type: unknown node type \"{t}\". Valid types: {}",
                VALID_NODE_TYPES.join(", ")
            ));
        }
        // scene/player require width, height
        if (t == "scene" || t == "player")
            && path == "root"
            && (!obj.contains_key("width") || !obj.contains_key("height"))
        {
            errors.push(format!("{path}: {t} requires width and height"));
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
        if t == "text" && !obj.contains_key("content") {
            if obj.contains_key("text") {
                errors.push(format!(
                    "{path}: text node uses \"content\" not \"text\" for the string value"
                ));
            } else {
                errors.push(format!("{path}: text node requires a \"content\" string"));
            }
        }
        // polygon requires points array with ≥ 3 entries, each [number, number]
        if t == "polygon" {
            match obj.get("points").and_then(|v| v.as_array()) {
                Some(pts) => {
                    if pts.len() < 3 {
                        errors.push(format!(
                            "{path}.points: polygon requires at least 3 points (got {})",
                            pts.len()
                        ));
                    }
                    for (i, pt) in pts.iter().enumerate() {
                        if let Some(arr) = pt.as_array() {
                            if arr.len() != 2 || !arr[0].is_number() || !arr[1].is_number() {
                                errors.push(format!(
                                    "{path}.points[{i}]: each point must be [number, number]"
                                ));
                            }
                        } else {
                            errors.push(format!(
                                "{path}.points[{i}]: each point must be [number, number], got {}",
                                node_type_name(pt)
                            ));
                        }
                    }
                }
                None => {
                    if obj.contains_key("points") {
                        errors.push(format!(
                            "{path}.points: must be an array of [number, number] pairs"
                        ));
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
                            errors.push(format!(
                                "{path}.points[{i}]: each point must be [number, number]"
                            ));
                        }
                    } else {
                        errors.push(format!(
                            "{path}.points[{i}]: each point must be [number, number], got {}",
                            node_type_name(pt)
                        ));
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
    if visual.get("version").and_then(|v| v.as_str()) == Some("2.0") {
        if let Err(e) = validate_v2_doc(visual) {
            errors.push(e);
            return;
        }
        match visual_to_renderable_v1(visual) {
            Ok(renderable) => validate_dsl_doc(&renderable, errors),
            Err(e) => errors.push(e),
        }
        return;
    }

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

fn exec_write_note(root: &Path, args: &Value) -> String {
    let rel = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return "Error: missing 'path' argument (e.g. 'my-note.md')".into(),
    };
    // Enforce .md extension and safe path
    let safe_rel = {
        let trimmed = rel.trim().replace(['\\'], "/");
        if trimmed.ends_with(".md") {
            trimmed
        } else {
            format!("{trimmed}.md")
        }
    };
    let path = match project::safe_resolve(root, &safe_rel) {
        Ok(p) => p,
        Err(_) => return format!("Error: invalid path '{safe_rel}' — path traversal not allowed"),
    };
    let content = match args.get("content").and_then(|v| v.as_str()) {
        Some(c) => c,
        None => return "Error: missing 'content' argument".into(),
    };
    if let Err(e) = project::ensure_note_unlocked(root, &safe_rel) {
        return format!("Error: {e}");
    }

    if let Some(parent) = path.parent() {
        if !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return format!("Error creating directories: {e}");
            }
        }
    }

    let created = !path.exists();
    match project::write_note(&path, content) {
        Ok(()) => {
            if created {
                format!("Created note '{safe_rel}'")
            } else {
                format!("Updated note '{safe_rel}'")
            }
        }
        Err(e) => format!("Error writing note: {e}"),
    }
}

fn exec_read_storyboard(root: &Path, args: &Value) -> String {
    let rel = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return "Error: missing 'path' argument".into(),
    };
    let path = resolve_path(root, rel);
    match project::read_storyboard(&path) {
        Ok(sb) => format_storyboard_for_agent(root, &sb),
        Err(e) => format!("Error reading storyboard: {e}"),
    }
}

fn exec_write_storyboard(root: &Path, args: &Value) -> String {
    let rel = match args.get("path").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return "Error: missing 'path' argument".into(),
    };
    let safe_rel = {
        let trimmed = rel.trim().replace(['\\'], "/");
        if trimmed.ends_with(".sb") {
            trimmed
        } else {
            format!("{trimmed}.sb")
        }
    };
    let path = match project::safe_resolve(root, &safe_rel) {
        Ok(p) => p,
        Err(_) => return format!("Error: invalid path '{safe_rel}' — path traversal not allowed"),
    };

    // Load existing or create new
    let mut sb = match project::read_storyboard(&path) {
        Ok(existing) => {
            if let Err(e) = project::ensure_storyboard_unlocked(&existing) {
                return format!("Error writing storyboard: {e}");
            }
            existing
        }
        Err(_) => crate::models::sketch::Storyboard::new(
            args.get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled"),
        ),
    };

    if let Some(title) = args.get("title").and_then(|v| v.as_str()) {
        sb.title = title.to_string();
    }
    if let Some(desc) = args.get("description").and_then(|v| v.as_str()) {
        sb.description = desc.to_string();
    }

    // Replace items only when explicitly provided
    if let Some(items_val) = args.get("items").and_then(|v| v.as_array()) {
        let mut new_items = Vec::new();
        for (i, item) in items_val.iter().enumerate() {
            let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match item_type {
                "sketch_ref" => {
                    let sketch_path = match item.get("path").and_then(|v| v.as_str()) {
                        Some(p) => p.to_string(),
                        None => return format!("Error: items[{i}] sketch_ref is missing 'path'"),
                    };
                    if !sketch_path.ends_with(".sk") {
                        return format!("Error: items[{i}] sketch_ref path must end with .sk (got '{sketch_path}')");
                    }
                    new_items.push(crate::models::sketch::StoryboardItem::SketchRef {
                        path: sketch_path,
                    });
                }
                "section" => {
                    let title = match item.get("title").and_then(|v| v.as_str()) {
                        Some(t) if !t.trim().is_empty() => t.to_string(),
                        _ => return format!("Error: items[{i}] section is missing 'title'"),
                    };
                    let sketches: Vec<String> =
                        match item.get("sketches").and_then(|v| v.as_array()) {
                            Some(arr) if !arr.is_empty() => arr
                                .iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect(),
                            Some(_) => {
                                return format!(
                                "Error: items[{i}] section '{title}' must have at least one sketch"
                            )
                            }
                            None => {
                                return format!(
                                "Error: items[{i}] section '{title}' is missing 'sketches' array"
                            )
                            }
                        };
                    for sp in &sketches {
                        if !sp.ends_with(".sk") {
                            return format!("Error: items[{i}] section sketch path must end with .sk (got '{sp}')");
                        }
                    }
                    new_items
                        .push(crate::models::sketch::StoryboardItem::Section { title, sketches });
                }
                other => {
                    return format!(
                    "Error: items[{i}] unknown type '{other}' — must be 'sketch_ref' or 'section'"
                )
                }
            }
        }
        sb.items = new_items;
    }

    sb.updated_at = chrono::Utc::now();

    match project::write_storyboard(&sb, &path, root) {
        Ok(()) => format!(
            "Saved storyboard \"{}\" at '{safe_rel}' ({} items)",
            sb.title,
            sb.items.len()
        ),
        Err(e) => format!("Error writing storyboard: {e}"),
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
        Some(other) => {
            return format!("Error: unknown category '{other}'. Use 'core' or 'insight'.")
        }
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
        if ox > 0.0 && oy > 0.0 {
            ox * oy
        } else {
            0.0
        }
    }
}

/// Extract approximate bounding boxes from a flat list of nodes.
fn extract_bboxes(children: &[Value], offset_x: f64, offset_y: f64) -> Vec<BBox> {
    let mut boxes = Vec::new();
    for node in children {
        let obj = match node.as_object() {
            Some(o) => o,
            None => continue,
        };
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
                let anchor = obj
                    .get("textAnchor")
                    .and_then(|v| v.as_str())
                    .unwrap_or("start");
                let bx = match anchor {
                    "middle" => x - text_w / 2.0,
                    "end" => x - text_w,
                    _ => x,
                };
                let by = y - fs; // text y is baseline
                boxes.push(BBox {
                    x: bx,
                    y: by,
                    w: text_w,
                    h: text_h,
                    label: format!("text '{}'", truncate(content, 20)),
                });
            }
            "rect" => {
                let x = obj.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_x;
                let y = obj.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_y;
                let w = obj.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = obj.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                boxes.push(BBox {
                    x,
                    y,
                    w,
                    h,
                    label: "rect".into(),
                });
            }
            "circle" => {
                let cx = obj.get("cx").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_x;
                let cy = obj.get("cy").and_then(|v| v.as_f64()).unwrap_or(0.0) + offset_y;
                let r = obj.get("r").and_then(|v| v.as_f64()).unwrap_or(0.0);
                boxes.push(BBox {
                    x: cx - r,
                    y: cy - r,
                    w: 2.0 * r,
                    h: 2.0 * r,
                    label: "circle".into(),
                });
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
    if chars.len() < s.len() {
        format!("{chars}…")
    } else {
        chars
    }
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
    let bg = root
        .get("background")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut issues: Vec<String> = Vec::new();
    let mut suggestions: Vec<String> = Vec::new();

    // Flatten children (including group contents) for analysis
    let all_nodes = flatten_nodes(children);
    let text_nodes = collect_text_nodes(children, 0.0, 0.0);
    let bboxes = extract_bboxes(children, 0.0, 0.0);
    let mut type_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for node in &all_nodes {
        if let Some(t) = node.get("type").and_then(|v| v.as_str()) {
            *type_counts.entry(t.to_string()).or_insert(0) += 1;
        }
    }

    // ── Issue checks ──────────────────────────────────────────────────

    // 1. Element count. Count flattened nodes so group wrappers cannot hide
    // crowded slides from critique.
    let nested_node_count = all_nodes.len().saturating_sub(children.len());
    if nested_node_count > 30 {
        issues.push(format!(
            "GROUPED_COMPLEXITY: {nested_node_count} nested elements. Groups should only move 2-5 related children; flatten decorative wrappers and remove hidden micro-detail."
        ));
    } else if nested_node_count > 20 {
        suggestions.push(format!(
            "GROUPED_COMPLEXITY: {nested_node_count} nested elements. Keep groups small and flatten simple shapes directly into the scene."
        ));
    }

    if all_nodes.len() > 55 {
        issues.push(format!(
            "TOO_MANY_ELEMENTS: {} flattened elements (max: 55). Simplify the slide by showing fewer steps, merging repeated token chips/bars, or replacing detailed internals with one stronger visual metaphor. Group wrappers do not reduce visual density.",
            all_nodes.len()
        ));
    } else if all_nodes.len() > 45 {
        suggestions.push(format!(
            "ELEMENT_COUNT: {} elements — this may feel crowded as a slide. Trim to ~40 by merging repeated boxes, removing secondary labels, or showing fewer steps.",
            all_nodes.len()
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
        if is_rect && rw >= canvas_w * 0.85 && rh >= canvas_h * 0.85 && (rx > 10.0 || ry > 10.0) {
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
                truncate(&tn.content, 25),
                tn.font_size
            ));
        }
    }

    // 3. Token usage — mandatory tokens
    if !bg.starts_with('$') && !bg.is_empty() {
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
    if total_texts > 22 {
        issues.push(format!(
            "TEXT_DENSITY: {total_texts} text labels (max: 22). Reduce labels or combine copy so the visual reads like a presentation slide, not a dense worksheet."
        ));
    } else if total_texts > 14 {
        suggestions.push(format!(
            "TEXT_DENSITY: {total_texts} text labels — target 10-14. Keep title, subtitle, and 3-4 short labels; remove captions, duplicate labels, legends, and worksheet-like microcopy."
        ));
    }
    if total_texts > 0 && text_fills_without_token == total_texts {
        issues.push(
            "NO_TEXT_TOKENS: ALL text uses hardcoded colors — use $title for titles, $subtitle for framing lines, $foreground for labels/body text, and $muted for annotations.".into()
        );
    } else if total_texts > 2 && text_fills_without_token as f64 / total_texts as f64 > 0.7 {
        suggestions.push(format!(
            "LOW_TOKEN_USAGE: {text_fills_without_token}/{total_texts} text fills are hardcoded hex — use $title/$subtitle for slide hierarchy and $foreground/$muted for labels and annotations."
        ));
    }
    let uses_title_or_subtitle = text_nodes
        .iter()
        .any(|tn| tn.fill == "$title" || tn.fill == "$subtitle");
    if total_texts >= 2 && !uses_title_or_subtitle {
        suggestions.push(
            "TITLE_TOKENS: use $title for the main slide title and $subtitle for the framing line so visuals match CutReady's presentation theme.".into()
        );
    }

    // 3b. Repeated-mark anti-patterns. Keep blockers conservative so real charts
    // survive, but reject obvious token strips and chip rows.
    let arrow_count = *type_counts.get("arrow").unwrap_or(&0);
    if arrow_count > 8 {
        issues.push(format!(
            "TOO_MANY_ARROWS: {arrow_count} arrows (max: 8). Use fewer directional connectors or replace the detailed flow with one hero metaphor plus 3-4 labeled stages."
        ));
    } else if arrow_count > 5 {
        suggestions.push(format!(
            "TOO_MANY_ARROWS: {arrow_count} arrows may feel busy. Prefer fewer connectors and a clearer hero composition."
        ));
    }

    let mut small_marks = 0usize;
    let mut chip_rows: std::collections::HashMap<i64, usize> = std::collections::HashMap::new();
    let mut max_hero_area = 0.0f64;
    for node in &all_nodes {
        let t = node.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "rect" => {
                let w = node.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = node.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = node.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                max_hero_area = max_hero_area.max(w * h);
                if w <= 36.0 && h <= 36.0 {
                    small_marks += 1;
                }
                if (20.0..=96.0).contains(&w) && (10.0..=36.0).contains(&h) {
                    *chip_rows.entry((y / 12.0).round() as i64).or_insert(0) += 1;
                }
            }
            "circle" => {
                let r = node.get("r").and_then(|v| v.as_f64()).unwrap_or(0.0);
                max_hero_area = max_hero_area.max(std::f64::consts::PI * r * r);
                if r <= 16.0 {
                    small_marks += 1;
                }
            }
            "image" => {
                let w = node.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = node.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                max_hero_area = max_hero_area.max(w * h);
            }
            _ => {}
        }
    }
    let has_chart_like_node = ["axes", "graph", "matrix", "barChart"]
        .iter()
        .any(|t| type_counts.contains_key(*t));
    if small_marks >= 30 && !has_chart_like_node {
        issues.push(format!(
            "REPEATED_SMALL_MARKS: {small_marks} tiny repeated marks. Replace token strips, mini grids, or dot fields with one larger visual metaphor and a few labeled stages."
        ));
    } else if small_marks >= 12 {
        suggestions.push(format!(
            "REPEATED_SMALL_MARKS: {small_marks} tiny marks may read as clutter. Consider merging them into larger grouped shapes."
        ));
    }
    if let Some(max_chip_row) = chip_rows.values().max() {
        if *max_chip_row >= 12 && !has_chart_like_node {
            issues.push(format!(
                "REPEATED_CHIP_ROW: {max_chip_row} small chip-like rectangles share one row. Avoid token-strip layouts unless this row is specifically about tokenization."
            ));
        } else if *max_chip_row >= 8 {
            suggestions.push(format!(
                "REPEATED_CHIP_ROW: {max_chip_row} small chip-like rectangles share one row. Avoid token-strip layouts unless this row is specifically about tokenization."
            ));
        }
    }
    if all_nodes.len() > 18 && max_hero_area > 0.0 && max_hero_area < canvas_w * canvas_h * 0.08 {
        suggestions.push(
            "NO_HERO_OBJECT: no dominant object covers at least 8% of the canvas. Prefer one large hero metaphor plus 3-4 labeled stages over literal micro-detail.".into()
        );
    }

    // 4. Overlap detection (text-on-text only — non-blocking suggestion since
    // LLMs struggle to fix coordinate math reliably)
    let text_bboxes: Vec<&BBox> = bboxes
        .iter()
        .filter(|b| b.label.starts_with("text"))
        .collect();
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
        if bbox.label.starts_with("text")
            && (bbox.x < margin
                || bbox.y < margin
                || bbox.x + bbox.w > canvas_w - margin
                || bbox.y + bbox.h > canvas_h - margin)
        {
            suggestions.push(format!(
                "MARGIN_VIOLATION: {} extends beyond {}px margin (at {:.0},{:.0} size {:.0}x{:.0}). Keep content inside the safe area.",
                bbox.label, margin, bbox.x, bbox.y, bbox.w, bbox.h
            ));
        }
    }

    // 6. Text overflow — text inside a container rect that exceeds rect bounds
    let rect_bboxes: Vec<&BBox> = bboxes.iter().filter(|b| b.label == "rect").collect();
    let text_bboxes_all: Vec<&BBox> = bboxes
        .iter()
        .filter(|b| b.label.starts_with("text"))
        .collect();
    for tb in &text_bboxes_all {
        // Check if text's center is inside any rect (= text is meant to be in that rect)
        let text_cx = tb.x + tb.w / 2.0;
        let text_cy = tb.y + tb.h / 2.0;
        let mut best_rect: Option<&BBox> = None;
        let mut best_area = f64::MAX;
        for rb in &rect_bboxes {
            if text_cx >= rb.x
                && text_cx <= rb.x + rb.w
                && text_cy >= rb.y
                && text_cy <= rb.y + rb.h
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
            suggestions.push(
                "TOP_HEAVY: content is concentrated in the upper third — use more vertical space."
                    .into(),
            );
        } else if avg_y > canvas_h * 0.65 {
            suggestions.push(
                "BOTTOM_HEAVY: content is concentrated in the lower third — balance the layout."
                    .into(),
            );
        }
        if avg_x < canvas_w * 0.35 {
            suggestions.push(
                "LEFT_HEAVY: content is clustered on the left — spread across the width.".into(),
            );
        } else if avg_x > canvas_w * 0.65 {
            suggestions.push(
                "RIGHT_HEAVY: content is clustered on the right — balance the layout.".into(),
            );
        }
    }

    // 9. Color variety
    let mut accent_colors: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut hardcoded_brand_like_colors = 0usize;
    for node in &all_nodes {
        for key in &["fill", "stroke"] {
            if let Some(c) = node.get(*key).and_then(|v| v.as_str()) {
                if c.starts_with('#') || c.starts_with("rgb") {
                    accent_colors.insert(c.to_string());
                }
                let lower = c.to_ascii_lowercase();
                if lower.contains("#38bdf8")
                    || lower.contains("56,189,248")
                    || lower.contains("#a78bfa")
                    || lower.contains("167,139,250")
                {
                    hardcoded_brand_like_colors += 1;
                }
            }
        }
    }
    if hardcoded_brand_like_colors > 0 {
        suggestions.push(format!(
            "SEMANTIC_ACCENTS: {hardcoded_brand_like_colors} fill/stroke value(s) use hardcoded blue/purple accents. Prefer $accent, $secondary, or $tertiary so generated visuals inherit CutReady branding."
        ));
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
        let obj = match node.as_object() {
            Some(o) => o,
            None => continue,
        };
        let t = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if t == "text" {
            result.push(TextNodeInfo {
                content: obj
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                font_size: obj.get("fontSize").and_then(|v| v.as_f64()).unwrap_or(16.0),
                fill: obj
                    .get("fill")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
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
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::sketch::Sketch;
    use serde_json::json;
    use tempfile::TempDir;

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
                for issue in &issues {
                    parts.push(issue.clone());
                }
                for sug in &suggestions {
                    parts.push(sug.clone());
                }
                parts.join("\n")
            }
            Err(e) => e,
        }
    }

    fn write_test_sketch(root: &Path, rel: &str, row: PlanningRow) {
        let mut sketch = Sketch::new("Locked Tool Test");
        sketch.rows = vec![row];
        project::write_sketch(&sketch, &root.join(rel), root).unwrap();
    }

    #[test]
    fn web_search_parser_extracts_sources() {
        let html = r#"
            <a rel="nofollow" class="result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Fdocs">Example &amp; Docs</a>
            <a class="result__snippet">Current release notes and examples.</a>
        "#;

        let output = format_search_results("example docs", html, 5);

        assert!(output.contains("[Example & Docs](https://example.com/docs)"));
        assert!(output.contains("Current release notes and examples."));
        assert!(output.contains("source URLs"));
    }

    #[test]
    fn storyboard_context_includes_sketch_rows_and_missing_sketches() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut row = PlanningRow::new();
        row.time = "0:10".into();
        row.narrative = "Introduce the dashboard".into();
        row.demo_actions = "Open the dashboard".into();
        let mut sketch = Sketch::new("Intro");
        sketch.description = Value::String("Set up the product story".into());
        sketch.rows = vec![row];
        project::write_sketch(&sketch, &root.join("intro.sk"), root).unwrap();

        let mut storyboard = crate::models::sketch::Storyboard::new("Launch Demo");
        storyboard.description = "Full story".into();
        storyboard.items = vec![
            crate::models::sketch::StoryboardItem::SketchRef {
                path: "intro.sk".into(),
            },
            crate::models::sketch::StoryboardItem::SketchRef {
                path: "missing.sk".into(),
            },
        ];

        let context = format_storyboard_for_agent(root, &storyboard);

        assert!(context.contains("# Launch Demo"));
        assert!(context.contains("Locked: no"));
        assert!(context.contains("Sketch: \"Intro\" (intro.sk)"));
        assert!(context.contains(
            "Row 1 [0:10]: narrative=\"Introduce the dashboard\" actions=\"Open the dashboard\""
        ));
        assert!(context.contains("missing.sk"));
        assert!(context.contains("missing or unreadable"));
    }

    #[test]
    fn write_storyboard_tool_rejects_locked_storyboard() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let rel = "locked.sb";
        let mut storyboard = crate::models::sketch::Storyboard::new("Locked Story");
        storyboard.locked = true;
        project::write_storyboard(&storyboard, &root.join(rel), root).unwrap();

        let result = exec_write_storyboard(
            root,
            &json!({
                "path": rel,
                "description": "AI rewrite"
            }),
        );

        assert!(result.starts_with("Error writing storyboard:"), "{result}");
        assert!(result.contains("storyboard is locked"), "{result}");
        let saved = project::read_storyboard(&root.join(rel)).unwrap();
        assert!(saved.description.is_empty());
    }

    #[test]
    fn write_sketch_tool_rejects_locked_cell_change() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let rel = "demo.sk";
        let mut row = PlanningRow::new();
        row.narrative = "Keep this narrative".into();
        row.demo_actions = "Allowed old action".into();
        row.locks.narrative = true;
        write_test_sketch(root, rel, row);

        let result = exec_write_sketch(
            root,
            &json!({
                "path": rel,
                "rows": [{
                    "time": "",
                    "narrative": "AI rewrite",
                    "demo_actions": "Allowed new action"
                }]
            }),
        );

        assert!(
            result.starts_with("Error:"),
            "locked write should fail at the tool boundary: {result}"
        );
        assert!(
            result.contains("narrative cell is locked"),
            "error should identify the locked cell: {result}"
        );
        let saved = project::read_sketch(&root.join(rel)).unwrap();
        assert_eq!(saved.rows[0].narrative, "Keep this narrative");
        assert_eq!(saved.rows[0].demo_actions, "Allowed old action");
    }

    #[test]
    fn update_planning_row_tool_rejects_locked_cell_change() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let rel = "demo.sk";
        let mut row = PlanningRow::new();
        row.time = "0:10".into();
        row.locks.time = true;
        write_test_sketch(root, rel, row);

        let result = exec_update_planning_row(
            root,
            &json!({
                "path": rel,
                "index": 0,
                "time": "0:20"
            }),
        );

        assert!(result.starts_with("Error:"), "{result}");
        assert!(result.contains("time cell is locked"), "{result}");
        let saved = project::read_sketch(&root.join(rel)).unwrap();
        assert_eq!(saved.rows[0].time, "0:10");
    }

    #[test]
    fn set_row_visual_tool_rejects_locked_media_cell() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let rel = "demo.sk";
        let mut row = PlanningRow::new();
        row.locks.visual = true;
        write_test_sketch(root, rel, row);

        let result = exec_set_row_visual(
            root,
            &json!({
                "path": rel,
                "index": 0,
                "visual": null
            }),
        );

        assert!(result.starts_with("Error:"), "{result}");
        assert!(result.contains("media cell is locked"), "{result}");
    }

    #[test]
    fn set_row_visual_tool_persists_v2_visuals() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let rel = "demo.sk";
        write_test_sketch(root, rel, PlanningRow::new());

        let result = exec_set_row_visual(
            root,
            &json!({
                "path": rel,
                "index": 0,
                "visual": {
                    "version": "2.0",
                    "scene": {
                        "type": "player",
                        "width": 960,
                        "height": 540,
                        "fps": 30,
                        "durationInFrames": 90,
                        "background": "$background",
                        "children": ["title"]
                    },
                    "elements": {
                        "title": {
                            "id": "title",
                            "type": "text",
                            "props": {
                                "type": "text",
                                "content": "Hello",
                                "x": 480,
                                "y": 120,
                                "fontSize": 44,
                                "fill": "$title",
                                "textAnchor": "middle"
                            }
                        }
                    }
                }
            }),
        );

        assert!(result.contains("Visual saved"), "{result}");
        let saved = project::read_sketch(&root.join(rel)).unwrap();
        let visual_path = saved.rows[0].visual.as_ref().unwrap().as_str().unwrap();
        let visual = project::read_visual(root, visual_path).unwrap();
        assert_eq!(visual.get("version").and_then(|v| v.as_str()), Some("2.0"));
        assert!(visual.get("scene").is_some());
        assert!(visual.get("elements").is_some());
    }

    #[test]
    fn set_row_visual_tool_migrates_v1_visuals_to_v2() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let rel = "demo.sk";
        write_test_sketch(root, rel, PlanningRow::new());

        let result = exec_set_row_visual(
            root,
            &json!({
                "path": rel,
                "index": 0,
                "visual": {
                    "version": "1.0",
                    "root": {
                        "type": "player",
                        "width": 960,
                        "height": 540,
                        "fps": 30,
                        "durationInFrames": 90,
                        "background": "$background",
                        "children": [
                            {
                                "type": "text",
                                "id": "title",
                                "content": "Hello",
                                "x": 480,
                                "y": 120,
                                "fontSize": 44,
                                "fill": "$title",
                                "textAnchor": "middle"
                            }
                        ]
                    }
                }
            }),
        );

        assert!(result.contains("Visual saved"), "{result}");
        let saved = project::read_sketch(&root.join(rel)).unwrap();
        let visual_path = saved.rows[0].visual.as_ref().unwrap().as_str().unwrap();
        let visual = project::read_visual(root, visual_path).unwrap();
        assert_eq!(visual.get("version").and_then(|v| v.as_str()), Some("2.0"));
        assert!(visual.pointer("/elements/title/props/content").is_some());
    }

    #[test]
    fn review_row_visual_reports_agentic_nudges() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let visual_path =
            project::write_visual(root, &sample_v2_visual_for_agentic_tools()).unwrap();
        let mut row = PlanningRow::new();
        row.visual = Some(Value::String(visual_path));
        write_test_sketch(root, "demo.sk", row);

        let result = exec_review_row_visual(root, &json!({ "path": "demo.sk", "index": 0 }));

        assert!(result.contains("Elucim visual review"), "{result}");
        assert!(result.contains("Valid: yes"), "{result}");
        assert!(result.contains("mark-refined"), "{result}");
        assert!(result.contains("annotate-element-intent"), "{result}");
        assert!(result.contains("normalize-root-layer-order"), "{result}");
        assert!(result.contains("add-staggered-intro"), "{result}");
    }

    #[test]
    fn apply_row_visual_nudge_updates_and_saves_v2() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let visual_path =
            project::write_visual(root, &sample_v2_visual_for_agentic_tools()).unwrap();
        let mut row = PlanningRow::new();
        row.visual = Some(Value::String(visual_path));
        write_test_sketch(root, "demo.sk", row);

        let result = exec_apply_row_visual_nudge(
            root,
            &json!({
                "path": "demo.sk",
                "index": 0,
                "nudge_id": "mark-refined"
            }),
        );

        assert!(result.contains("Applied visual nudge"), "{result}");
        let saved = project::read_sketch(&root.join("demo.sk")).unwrap();
        let visual_path = saved.rows[0].visual.as_ref().unwrap().as_str().unwrap();
        let visual = project::read_visual(root, visual_path).unwrap();
        assert_eq!(
            visual
                .pointer("/metadata/polishLevel")
                .and_then(|v| v.as_str()),
            Some("refined")
        );
    }

    #[test]
    fn apply_row_visual_command_adds_intro_timeline() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let visual_path =
            project::write_visual(root, &sample_v2_visual_for_agentic_tools()).unwrap();
        let mut row = PlanningRow::new();
        row.visual = Some(Value::String(visual_path));
        write_test_sketch(root, "demo.sk", row);

        let result = exec_apply_row_visual_command(
            root,
            &json!({
                "path": "demo.sk",
                "index": 0,
                "command": {
                    "op": "addStaggeredIntro",
                    "timelineId": "intro",
                    "staggerFrames": 4,
                    "durationFrames": 20
                }
            }),
        );

        assert!(result.contains("Applied visual command"), "{result}");
        let saved = project::read_sketch(&root.join("demo.sk")).unwrap();
        let visual_path = saved.rows[0].visual.as_ref().unwrap().as_str().unwrap();
        let visual = project::read_visual(root, visual_path).unwrap();
        assert!(visual.pointer("/timelines/intro/tracks").is_some());
        assert_eq!(
            visual
                .pointer("/elements/title/props/fadeIn")
                .and_then(|v| v.as_i64()),
            Some(4)
        );
    }

    #[test]
    fn apply_row_visual_nudge_annotates_element_intent() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let visual_path =
            project::write_visual(root, &sample_v2_visual_for_agentic_tools()).unwrap();
        let mut row = PlanningRow::new();
        row.visual = Some(Value::String(visual_path));
        write_test_sketch(root, "demo.sk", row);

        let result = exec_apply_row_visual_nudge(
            root,
            &json!({
                "path": "demo.sk",
                "index": 0,
                "nudge_id": "annotate-element-intent"
            }),
        );

        assert!(result.contains("Applied visual nudge"), "{result}");
        let saved = project::read_sketch(&root.join("demo.sk")).unwrap();
        let visual_path = saved.rows[0].visual.as_ref().unwrap().as_str().unwrap();
        let visual = project::read_visual(root, visual_path).unwrap();
        assert_eq!(
            visual
                .pointer("/elements/title/intent/role")
                .and_then(|v| v.as_str()),
            Some("title")
        );
        assert_eq!(
            visual
                .pointer("/elements/title/intent/importance")
                .and_then(|v| v.as_str()),
            Some("primary")
        );
    }

    #[test]
    fn validate_v2_rejects_bad_timeline_target() {
        let mut visual = sample_v2_visual_for_agentic_tools();
        visual["timelines"] = json!({
            "intro": {
                "id": "intro",
                "duration": 20,
                "tracks": [{
                    "target": "missing",
                    "property": "opacity",
                    "keyframes": [{ "frame": 0, "value": 0 }, { "frame": 20, "value": 1 }]
                }]
            }
        });

        let mut errors = Vec::new();
        validate_dsl_doc(&visual, &mut errors);

        assert!(
            errors.iter().any(|error| error.contains("unknown target")),
            "Expected timeline target validation error: {errors:?}"
        );
    }

    #[test]
    fn validate_v2_rejects_bad_state_machine_reference() {
        let mut visual = sample_v2_visual_for_agentic_tools();
        visual["stateMachines"] = json!({
            "deck": {
                "id": "deck",
                "initial": "idle",
                "states": {
                    "idle": { "on": { "start": "missing" } }
                }
            }
        });

        let mut errors = Vec::new();
        validate_dsl_doc(&visual, &mut errors);

        assert!(
            errors
                .iter()
                .any(|error| error.contains("unknown target state")),
            "Expected state machine validation error: {errors:?}"
        );
    }

    #[test]
    fn migrate_v1_scene_defaults_duration_for_v2() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "scene",
                "width": 960,
                "height": 540,
                "background": "$background",
                "children": [{
                    "type": "text",
                    "id": "title",
                    "content": "Scene",
                    "x": 480,
                    "y": 100,
                    "fontSize": 40,
                    "fill": "$title"
                }]
            }
        });

        let migrated = normalize_visual_to_v2(&visual).unwrap();

        assert_eq!(
            migrated
                .pointer("/scene/durationInFrames")
                .and_then(|v| v.as_i64()),
            Some(120)
        );
    }

    fn sample_v2_visual_for_agentic_tools() -> Value {
        json!({
            "version": "2.0",
            "scene": {
                "type": "player",
                "width": 960,
                "height": 540,
                "fps": 30,
                "durationInFrames": 90,
                "background": "$background",
                "children": ["foreground", "title"]
            },
            "elements": {
                "title": {
                    "id": "title",
                    "type": "text",
                    "layout": { "zIndex": 0 },
                    "props": {
                        "type": "text",
                        "content": "Hello",
                        "x": 480,
                        "y": 100,
                        "fontSize": 40,
                        "fill": "$title",
                        "textAnchor": "middle"
                    }
                },
                "foreground": {
                    "id": "foreground",
                    "type": "rect",
                    "layout": { "zIndex": 10 },
                    "props": {
                        "type": "rect",
                        "x": 300,
                        "y": 210,
                        "width": 360,
                        "height": 160,
                        "fill": "$surface",
                        "stroke": "$border",
                        "rx": 18
                    }
                }
            }
        })
    }

    #[test]
    fn design_plan_tool_rejects_locked_design_plan_cell() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let rel = "demo.sk";
        let mut row = PlanningRow::new();
        row.locks.design_plan = true;
        write_test_sketch(root, rel, row);

        let result = exec_design_plan(
            root,
            &json!({
                "path": rel,
                "index": 0,
                "plan": "New plan"
            }),
        );

        assert!(result.starts_with("Error:"), "{result}");
        assert!(result.contains("design plan cell is locked"), "{result}");
    }

    #[test]
    fn write_note_tool_rejects_locked_note() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let note = project::safe_resolve(root, "notes/a.md").unwrap();
        std::fs::create_dir_all(note.parent().unwrap()).unwrap();
        std::fs::write(&note, "Keep this note").unwrap();
        project::set_note_lock(root, "notes/a.md", true).unwrap();

        let result = exec_write_note(
            root,
            &json!({
                "path": "notes/a.md",
                "content": "AI rewrite"
            }),
        );

        assert!(result.starts_with("Error:"), "{result}");
        assert!(result.contains("This note is locked"), "{result}");
        assert_eq!(std::fs::read_to_string(note).unwrap(), "Keep this note");
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
        assert!(
            result.contains("TINY_FONT"),
            "Should flag fontSize 8 as too small: {result}"
        );
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
        assert!(
            result.contains("MISSING_BG_TOKEN"),
            "Should flag hardcoded background: {result}"
        );
        assert!(
            result.contains("NO_TEXT_TOKENS"),
            "Should flag all-hex text fills: {result}"
        );
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
        assert!(
            result.contains("TEXT_OVERLAP"),
            "Should detect overlapping text at y=100 and y=105: {result}"
        );
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
        assert!(
            result.starts_with("✓ PASS"),
            "Clean visual should pass: {result}"
        );
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
        assert!(
            result.contains("LOW_VARIETY"),
            "Should suggest shape variety: {result}"
        );
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
        assert!(
            result.contains("TEXT_OVERFLOW"),
            "Should detect text overflowing container: {result}"
        );
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
        assert!(
            result.contains("REDUNDANT_BG_RECT"),
            "Should catch redundant background rect: {result}"
        );
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
        assert!(
            result.contains("INNER_CARD_RECT"),
            "Should catch inner card rect with margins: {result}"
        );
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
        assert!(
            result.contains("point must be [number, number]"),
            "Should catch object points: {result}"
        );
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
        assert!(
            result.contains("Valid"),
            "Should accept valid polygon: {result}"
        );
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
        assert!(
            result.contains("at least 3 points"),
            "Should require 3+ points: {result}"
        );
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
        assert!(
            result.contains("requires \"x2\""),
            "Should catch missing x2: {result}"
        );
        assert!(
            result.contains("requires \"y2\""),
            "Should catch missing y2: {result}"
        );
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
        assert!(
            result.contains("requires \"x1\""),
            "Should catch missing x1: {result}"
        );
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
        assert!(
            result.contains("point must be [number, number]"),
            "Should catch bad bezier point: {result}"
        );
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
        assert!(
            errors.is_empty(),
            "Parsed visual should be valid: {errors:?}"
        );
    }

    #[test]
    fn extract_json_object_rejects_bad_string() {
        let args = json!({ "visual": "not valid json {" });
        let result = extract_json_object(&args, "visual");
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("not valid JSON"),
            "Should report parse error"
        );
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
        assert!(
            errors.is_empty(),
            "Flattened DSL should be valid: {errors:?}"
        );
    }

    #[test]
    fn extract_json_object_detects_flattened_v2_dsl() {
        let args = json!({
            "version": "2.0",
            "scene": {
                "type": "player",
                "width": 960,
                "height": 540,
                "fps": 30,
                "durationInFrames": 90,
                "background": "$background",
                "children": ["title"]
            },
            "elements": {
                "title": {
                    "id": "title",
                    "type": "text",
                    "props": {
                        "type": "text",
                        "content": "Hello",
                        "x": 480,
                        "y": 120,
                        "fontSize": 44,
                        "fill": "$title"
                    }
                }
            }
        });
        let result = extract_json_object(&args, "visual");
        assert!(result.is_ok(), "Should auto-detect flattened v2 DSL");
        let visual = result.unwrap();
        let mut errors = Vec::new();
        validate_dsl_doc(&visual, &mut errors);
        assert!(
            errors.is_empty(),
            "Flattened v2 DSL should be valid: {errors:?}"
        );
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

    #[test]
    fn critique_suggests_title_tokens_for_slide_text() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "text", "content": "Main Idea", "x": 480, "y": 70, "fontSize": 40, "fill": "$foreground", "textAnchor": "middle" },
                    { "type": "text", "content": "supporting context", "x": 480, "y": 110, "fontSize": 20, "fill": "$muted", "textAnchor": "middle" }
                ]
            }
        });
        let output = run_critique(&visual);
        assert!(
            output.contains("TITLE_TOKENS"),
            "Expected title/subtitle token suggestion, got:\n{output}"
        );
    }

    #[test]
    fn critique_suggests_semantic_accents_for_hardcoded_cyan() {
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "text", "content": "Main Idea", "x": 480, "y": 70, "fontSize": 40, "fill": "$title", "textAnchor": "middle" },
                    { "type": "rect", "x": 360, "y": 190, "width": 240, "height": 120, "fill": "rgba(56,189,248,0.12)", "stroke": "#38bdf8", "rx": 16 }
                ]
            }
        });
        let output = run_critique(&visual);
        assert!(
            output.contains("SEMANTIC_ACCENTS"),
            "Expected semantic accent suggestion, got:\n{output}"
        );
    }

    #[test]
    fn critique_blocks_text_density_for_label_heavy_slide() {
        let labels: Vec<Value> = (0..23)
            .map(|i| {
                json!({
                    "type": "text",
                    "content": format!("Label {}", i + 1),
                    "x": 80 + (i % 7) * 120,
                    "y": 160 + (i / 7) * 64,
                    "fontSize": 18,
                    "fill": "$foreground"
                })
            })
            .collect();
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": labels
            }
        });
        let output = run_critique(&visual);
        assert!(
            output.contains("TEXT_DENSITY"),
            "Expected text density issue, got:\n{output}"
        );
        assert!(
            output.starts_with("✗ FAIL"),
            "Text-heavy slides should be rejected, got:\n{output}"
        );
    }

    #[test]
    fn critique_suggests_repeated_chip_rows() {
        let chips: Vec<Value> = (0..8)
            .map(|i| {
                json!({
                    "type": "rect",
                    "x": 80 + i * 92,
                    "y": 250,
                    "width": 72,
                    "height": 24,
                    "fill": "$surface",
                    "stroke": "$border",
                    "rx": 12
                })
            })
            .collect();
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": chips
            }
        });
        let output = run_critique(&visual);
        assert!(
            output.contains("REPEATED_CHIP_ROW"),
            "Expected repeated chip row suggestion, got:\n{output}"
        );
        assert!(
            output.starts_with("✓ PASS"),
            "Moderate chip rows should warn without blocking, got:\n{output}"
        );
    }

    #[test]
    fn critique_blocks_extreme_repeated_chip_rows() {
        let chips: Vec<Value> = (0..12)
            .map(|i| {
                json!({
                    "type": "rect",
                    "x": 40 + i * 74,
                    "y": 250,
                    "width": 58,
                    "height": 24,
                    "fill": "$surface",
                    "stroke": "$border",
                    "rx": 12
                })
            })
            .collect();
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": chips
            }
        });
        let output = run_critique(&visual);
        assert!(
            output.contains("REPEATED_CHIP_ROW"),
            "Expected repeated chip row issue, got:\n{output}"
        );
        assert!(
            output.starts_with("✗ FAIL"),
            "Extreme chip-strip slides should be rejected, got:\n{output}"
        );
    }

    #[test]
    fn design_plan_response_includes_row_context() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let rel = "demo.sk";
        let mut previous = PlanningRow::new();
        previous.narrative = "Open with the big idea".into();
        previous.demo_actions = "Show the landing page".into();
        let mut target = PlanningRow::new();
        target.narrative = "Explain the agent handoff".into();
        target.demo_actions = "Highlight the planner and designer rows".into();
        target.screenshot = Some(".cutready/screenshots/handoff.png".into());
        let mut next = PlanningRow::new();
        next.narrative = "Show the final output".into();
        next.demo_actions = "Open the generated timeline".into();
        let mut sketch = Sketch::new("Agent Story");
        sketch.rows = vec![previous, target, next];
        project::write_sketch(&sketch, &root.join(rel), root).unwrap();

        let result = exec_design_plan(
            root,
            &json!({
                "path": rel,
                "index": 1,
                "plan": "Use one hero handoff metaphor with three labeled stages."
            }),
        );

        assert!(result.contains("Row context:"), "{result}");
        assert!(
            result.contains("Target row narrative: Explain the agent handoff"),
            "{result}"
        );
        assert!(
            result.contains("Existing screenshot: .cutready/screenshots/handoff.png"),
            "{result}"
        );
        assert!(
            result.contains("Previous row: narrative=\"Open with the big idea\""),
            "{result}"
        );
        assert!(
            result.contains("Next row: narrative=\"Show the final output\""),
            "{result}"
        );
    }

    #[test]
    fn critique_blocks_grouped_element_density() {
        let groups: Vec<Value> = (0..6)
            .map(|group_index| {
                let chips: Vec<Value> = (0..9)
                    .map(|chip_index| {
                        json!({
                            "type": "rect",
                            "x": chip_index * 18,
                            "y": 0,
                            "width": 12,
                            "height": 28,
                            "fill": "$surface",
                            "stroke": "$border"
                        })
                    })
                    .collect();
                json!({
                    "type": "group",
                    "x": 80,
                    "y": 120 + group_index * 44,
                    "children": chips
                })
            })
            .collect();
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": groups
            }
        });
        let output = run_critique(&visual);
        assert!(
            output.contains("TOO_MANY_ELEMENTS"),
            "Expected grouped density issue, got:\n{output}"
        );
        assert!(
            output.starts_with("✗ FAIL"),
            "Grouped dense slides should be rejected, got:\n{output}"
        );
    }

    #[test]
    fn critique_suggests_grouped_complexity() {
        let group_children: Vec<Value> = (0..21)
            .map(|i| {
                json!({
                    "type": "circle",
                    "cx": 80 + (i % 7) * 24,
                    "cy": 170 + (i / 7) * 28,
                    "r": 8,
                    "fill": "$accent"
                })
            })
            .collect();
        let visual = json!({
            "version": "1.0",
            "root": {
                "type": "player", "width": 960, "height": 540, "fps": 30, "durationInFrames": 60,
                "background": "$background",
                "children": [
                    { "type": "text", "content": "Grouped idea", "x": 480, "y": 70, "fontSize": 40, "fill": "$title", "textAnchor": "middle" },
                    { "type": "text", "content": "keep groups small", "x": 480, "y": 108, "fontSize": 20, "fill": "$subtitle", "textAnchor": "middle" },
                    { "type": "group", "x": 280, "y": 140, "children": group_children },
                    { "type": "rect", "x": 620, "y": 210, "width": 160, "height": 120, "fill": "$surface", "stroke": "$border", "rx": 16 }
                ]
            }
        });
        let output = run_critique(&visual);
        assert!(
            output.contains("GROUPED_COMPLEXITY"),
            "Expected grouped complexity suggestion, got:\n{output}"
        );
    }
}
