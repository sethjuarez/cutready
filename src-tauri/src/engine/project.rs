//! Project storage engine — folder-based projects with .sk/.sb files.
//!
//! A project is any folder containing `.sk` (sketch) and/or `.sb` (storyboard)
//! files. There is no central registry — projects are opened by path.
//!
//!   My Demo/
//!     ├── intro.sk             (sketch JSON)
//!     ├── flows/
//!     │   └── login.sk         (sketches in subfolders)
//!     ├── full-demo.sb         (storyboard, references .sk by path)
//!     ├── assets/              (screenshots, images)
//!     └── .git/                (version history via gix)

use std::path::{Path, PathBuf};

use crate::engine::versioning;
use crate::models::script::ProjectView;
use crate::models::sketch::{
    NoteSummary, Sketch, SketchSummary, Storyboard, StoryboardSummary,
};

/// Sidebar ordering manifest stored in `.cutready-order.json`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct SidebarOrder {
    #[serde(default)]
    pub storyboards: Vec<String>,
    #[serde(default)]
    pub sketches: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

// ── Path safety ────────────────────────────────────────────────────

/// Resolve a user-provided relative path against a project root,
/// ensuring the result stays within the project directory.
///
/// Rejects absolute paths, `..` traversal, and any result that escapes root.
pub fn safe_resolve(root: &Path, relative_path: &str) -> Result<PathBuf, ProjectError> {
    let rel = Path::new(relative_path);

    // Reject absolute paths
    if rel.is_absolute() {
        return Err(ProjectError::PathTraversal(relative_path.to_string()));
    }

    // Reject any component that is ".." or has a prefix (e.g., C:)
    for component in rel.components() {
        match component {
            std::path::Component::ParentDir | std::path::Component::Prefix(_) => {
                return Err(ProjectError::PathTraversal(relative_path.to_string()));
            }
            _ => {}
        }
    }

    let resolved = root.join(rel);

    // Belt-and-suspenders: when the file or its parent exists on disk,
    // canonicalize and verify containment within root.
    if let Ok(canonical_root) = root.canonicalize() {
        let check = if resolved.exists() {
            resolved.canonicalize().ok()
        } else if let Some(parent) = resolved.parent() {
            parent.canonicalize().ok().map(|p| p.join(resolved.file_name().unwrap_or_default()))
        } else {
            None
        };

        if let Some(canonical_resolved) = check {
            if !canonical_resolved.starts_with(&canonical_root) {
                return Err(ProjectError::PathTraversal(relative_path.to_string()));
            }
        }
        // If neither file nor parent exist, we rely on the component check above
    }

    Ok(resolved)
}

// ── Project folder operations ──────────────────────────────────────

/// Initialize a new project in the given folder.
///
/// Creates the folder if it doesn't exist, inits git, and returns a ProjectView.
pub fn init_project_folder(root: &Path) -> Result<ProjectView, ProjectError> {
    std::fs::create_dir_all(root).map_err(|e| ProjectError::Io(e.to_string()))?;

    // Init git if not already a repo
    if !root.join(".git").exists() {
        versioning::init_project_repo(root).map_err(|e| ProjectError::Io(e.to_string()))?;
        let _ = versioning::commit_snapshot(root, "Initialize project", None);
    }

    Ok(ProjectView::new(root.to_path_buf()))
}

/// Open an existing project folder by scanning for .sk/.sb files.
/// Initializes git if not already a repo (needed for snapshots).
pub fn open_project_folder(root: &Path) -> Result<ProjectView, ProjectError> {
    if !root.exists() || !root.is_dir() {
        return Err(ProjectError::NotFound(
            root.to_string_lossy().into_owned(),
        ));
    }

    // Init git if not already a repo so snapshots work
    if !root.join(".git").exists() {
        versioning::init_project_repo(root).map_err(|e| ProjectError::Io(e.to_string()))?;
        let _ = versioning::commit_snapshot(root, "Initialize project", None);
    }

    Ok(ProjectView::new(root.to_path_buf()))
}

// ── Sketch file I/O (.sk) ─────────────────────────────────────────
//
// Sketches are stored as `.sk` files anywhere in the project tree.
// The relative path from project root is the sketch's identity.

// ── Visual file I/O ───────────────────────────────────────────────
//
// Visuals are elucim DSL documents stored as separate JSON files in
// `.cutready/visuals/<hash>.json`. Rows reference them by relative path.

/// Write an elucim visual to `.cutready/visuals/<hash>.json`.
/// Returns the relative path from project root (e.g., ".cutready/visuals/a1b2c3d4e5f6.json").
pub fn write_visual(project_root: &Path, visual: &serde_json::Value) -> Result<String, ProjectError> {
    use sha2::{Digest, Sha256};

    let json = serde_json::to_string_pretty(visual)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;

    let digest = Sha256::digest(json.as_bytes());
    let short_hash: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let rel_path = format!(".cutready/visuals/{short_hash}.json");
    let abs_path = project_root.join(&rel_path);

    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    std::fs::write(&abs_path, &json).map_err(|e| ProjectError::Io(e.to_string()))?;
    Ok(rel_path)
}

/// Read an elucim visual from a relative path.
pub fn read_visual(project_root: &Path, visual_path: &str) -> Result<serde_json::Value, ProjectError> {
    let abs_path = safe_resolve(project_root, visual_path)?;
    if !abs_path.exists() {
        return Err(ProjectError::NotFound(visual_path.to_owned()));
    }
    let data = std::fs::read_to_string(&abs_path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))
}

/// Write a sketch to a `.sk` file.
pub fn write_sketch(sketch: &Sketch, path: &Path, _project_root: &Path) -> Result<(), ProjectError> {
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    let json = serde_json::to_string_pretty(sketch)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| ProjectError::Io(e.to_string()))?;

    Ok(())
}

/// Read a sketch from a `.sk` file, migrating any inline visuals to external files.
///
/// If a row's `visual` field contains a JSON object (legacy inline format),
/// it is written to `.cutready/visuals/<hash>.json` and replaced with the path string.
/// The `.sk` file is rewritten after migration.
pub fn read_sketch(path: &Path) -> Result<Sketch, ProjectError> {
    read_sketch_inner(path, None)
}

/// Read a sketch with optional migration of inline visuals.
/// When `project_root` is provided, inline visuals are externalized to files.
pub fn read_sketch_with_migration(path: &Path, project_root: &Path) -> Result<Sketch, ProjectError> {
    read_sketch_inner(path, Some(project_root))
}

fn read_sketch_inner(path: &Path, project_root: Option<&Path>) -> Result<Sketch, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(
            path.to_string_lossy().into_owned(),
        ));
    }
    let data = std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    let mut sketch: Sketch =
        serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))?;

    // Migrate inline visuals to external files when project root is available
    if let Some(root) = project_root {
        let mut migrated = false;
        for row in &mut sketch.rows {
            if let Some(ref visual) = row.visual {
                if visual.is_object() {
                    match write_visual(root, visual) {
                        Ok(rel_path) => {
                            row.visual = Some(serde_json::Value::String(rel_path));
                            migrated = true;
                        }
                        Err(e) => {
                            eprintln!("[read_sketch] Failed to migrate inline visual: {e}");
                        }
                    }
                }
            }
        }
        if migrated {
            // Rewrite .sk file with path references instead of inline blobs
            if let Err(e) = write_sketch(&sketch, path, root) {
                eprintln!("[read_sketch] Failed to rewrite migrated sketch: {e}");
            }
        }
    }

    Ok(sketch)
}

/// Delete a sketch file and auto-commit.
pub fn delete_sketch(path: &Path, _project_root: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    Ok(())
}

/// Rename/move a sketch file and auto-commit.
pub fn rename_sketch(
    old_path: &Path,
    new_path: &Path,
    project_root: &Path,
) -> Result<(), ProjectError> {
    if !old_path.exists() {
        return Err(ProjectError::NotFound(
            old_path.to_string_lossy().into_owned(),
        ));
    }
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    std::fs::rename(old_path, new_path).map_err(|e| ProjectError::Io(e.to_string()))?;

    if project_root.join(".git").exists() {
        let _ = versioning::commit_snapshot(project_root, "Rename sketch", None);
    }
    Ok(())
}

// ── Storyboard file I/O (.sb) ─────────────────────────────────────

/// Write a storyboard to a `.sb` file.
pub fn write_storyboard(
    sb: &Storyboard,
    path: &Path,
    _project_root: &Path,
) -> Result<(), ProjectError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    let json = serde_json::to_string_pretty(sb)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| ProjectError::Io(e.to_string()))?;

    Ok(())
}

/// Read a storyboard from a `.sb` file.
pub fn read_storyboard(path: &Path) -> Result<Storyboard, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(
            path.to_string_lossy().into_owned(),
        ));
    }
    let data = std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))
}

/// Delete a storyboard file and auto-commit.
pub fn delete_storyboard(path: &Path, _project_root: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    Ok(())
}

// ── Folder scanning ────────────────────────────────────────────────

/// Recursively scan a project folder for all `.sk` files.
/// Returns summaries with relative paths from project root.
pub fn scan_sketches(project_root: &Path) -> Result<Vec<SketchSummary>, ProjectError> {
    let mut summaries = Vec::new();
    scan_files_recursive(project_root, project_root, "sk", &mut |rel_path, abs_path| {
        if let Ok(data) = std::fs::read_to_string(abs_path) {
            if let Ok(sketch) = serde_json::from_str::<Sketch>(&data) {
                summaries.push(SketchSummary::from_sketch(&sketch, rel_path));
            }
        }
    })?;
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Recursively scan a project folder for all `.sb` files.
/// Returns summaries with relative paths from project root.
pub fn scan_storyboards(project_root: &Path) -> Result<Vec<StoryboardSummary>, ProjectError> {
    let mut summaries = Vec::new();
    scan_files_recursive(project_root, project_root, "sb", &mut |rel_path, abs_path| {
        if let Ok(data) = std::fs::read_to_string(abs_path) {
            if let Ok(sb) = serde_json::from_str::<Storyboard>(&data) {
                summaries.push(StoryboardSummary::from_storyboard(&sb, rel_path));
            }
        }
    })?;
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Return titles of storyboards that reference the given sketch path.
pub fn storyboards_referencing_sketch(
    project_root: &Path,
    sketch_rel_path: &str,
) -> Result<Vec<String>, ProjectError> {
    let mut titles = Vec::new();
    scan_files_recursive(project_root, project_root, "sb", &mut |_rel_path, abs_path| {
        if let Ok(data) = std::fs::read_to_string(abs_path) {
            if let Ok(sb) = serde_json::from_str::<Storyboard>(&data) {
                let refs_sketch = sb.items.iter().any(|item| match item {
                    crate::models::sketch::StoryboardItem::SketchRef { path } => {
                        path == sketch_rel_path
                    }
                    crate::models::sketch::StoryboardItem::Section { sketches, .. } => {
                        sketches.iter().any(|s| s == sketch_rel_path)
                    }
                });
                if refs_sketch {
                    titles.push(sb.title.clone());
                }
            }
        }
    })?;
    Ok(titles)
}
//
// Notes are plain markdown files anywhere in the project tree.

/// Recursively scan a project folder for all `.md` files.
pub fn scan_notes(project_root: &Path) -> Result<Vec<NoteSummary>, ProjectError> {
    let mut summaries = Vec::new();
    scan_files_recursive(project_root, project_root, "md", &mut |rel_path, abs_path| {
        if let Ok(meta) = std::fs::metadata(abs_path) {
            let updated_at = meta
                .modified()
                .ok()
                .and_then(|t| {
                    let duration = t.duration_since(std::time::UNIX_EPOCH).ok()?;
                    chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                })
                .unwrap_or_else(chrono::Utc::now);
            let title = Path::new(rel_path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| rel_path.to_string());
            summaries.push(NoteSummary {
                path: rel_path.to_string(),
                title,
                size: meta.len(),
                updated_at,
            });
        }
    })?;
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Read a note file as plain text.
pub fn read_note(path: &Path) -> Result<String, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(path.to_string_lossy().into_owned()));
    }
    std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Write a note file (plain text).
pub fn write_note(path: &Path, content: &str) -> Result<(), ProjectError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    std::fs::write(path, content).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Delete a note file and clean up any images that become orphaned.
///
/// Parses the note's markdown for `![...](path)` image references in
/// `.cutready/screenshots/`. If no other note references the same image,
/// the image file is deleted to prevent orphaned files accumulating.
pub fn delete_note(path: &Path, project_root: &Path) -> Result<(), ProjectError> {
    if !path.exists() {
        return Ok(());
    }

    // Read the note to find image references before deleting
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let images_in_note = extract_screenshot_refs(&content);

    // Delete the note file
    std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;

    // If the note had no screenshot references, we're done
    if images_in_note.is_empty() {
        return Ok(());
    }

    // Scan all remaining notes for image references
    let mut all_referenced = std::collections::HashSet::new();
    let _ = scan_files_recursive(project_root, project_root, "md", &mut |_rel, abs| {
        if abs != path {
            if let Ok(other_content) = std::fs::read_to_string(abs) {
                for img in extract_screenshot_refs(&other_content) {
                    all_referenced.insert(img);
                }
            }
        }
    });
    // Also check sketch files for screenshot references
    let _ = scan_files_recursive(project_root, project_root, "sk", &mut |_rel, abs| {
        if let Ok(other_content) = std::fs::read_to_string(abs) {
            for img in extract_sketch_screenshot_refs(&other_content) {
                all_referenced.insert(img);
            }
        }
    });

    // Delete images only referenced by the deleted note
    for img_path in &images_in_note {
        if !all_referenced.contains(img_path) {
            let abs_img = project_root.join(img_path);
            if abs_img.exists() {
                let _ = std::fs::remove_file(&abs_img);
            }
        }
    }

    Ok(())
}

/// Extract `.cutready/screenshots/...` image paths from markdown content.
/// Matches both markdown `![...](path)` and HTML `<img src="path">` syntax.
fn extract_screenshot_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();

    // Match markdown image/link syntax: [...](.cutready/screenshots/...)
    let mut rest = content;
    while let Some(pos) = rest.find("](") {
        let after = &rest[pos + 2..];
        if let Some(end) = after.find(')') {
            let img_path = after[..end].trim();
            if img_path.contains(".cutready/screenshots/") {
                refs.push(img_path.replace('\\', "/"));
            }
        }
        rest = &rest[pos + 2..];
    }

    // Match HTML img tags: <img ... src="path" ...>
    rest = content;
    while let Some(pos) = rest.find("<img ") {
        let tag_rest = &rest[pos..];
        if let Some(tag_end) = tag_rest.find('>') {
            let tag = &tag_rest[..tag_end];
            // Extract src attribute value (single or double quotes)
            for prefix in &["src=\"", "src='"] {
                if let Some(src_start) = tag.find(prefix) {
                    let val_start = src_start + prefix.len();
                    let quote = prefix.as_bytes()[prefix.len() - 1] as char;
                    if let Some(val_end) = tag[val_start..].find(quote) {
                        let src = tag[val_start..val_start + val_end].trim();
                        if src.contains(".cutready/screenshots/") {
                            refs.push(src.replace('\\', "/"));
                        }
                    }
                    break;
                }
            }
        }
        rest = &rest[pos + 5..];
    }

    refs
}

/// Extract `.cutready/screenshots/...` image paths from sketch JSON content.
///
/// Parses the `"screenshot"` field from each planning row in the sketch.
fn extract_sketch_screenshot_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(rows) = val.get("rows").and_then(|r| r.as_array()) {
            for row in rows {
                if let Some(ss) = row.get("screenshot").and_then(|s| s.as_str()) {
                    let ss = ss.replace('\\', "/");
                    if ss.contains(".cutready/screenshots/") {
                        refs.push(ss);
                    }
                }
            }
        }
    }
    refs
}

/// List all images in .cutready/screenshots/ with their reference info.
///
/// For each image, scans all .md notes and .sk sketches to find which ones reference it.
pub fn list_images_with_refs(project_root: &Path) -> Result<Vec<ImageRefInfo>, ProjectError> {
    let ss_dir = project_root.join(".cutready").join("screenshots");
    if !ss_dir.exists() {
        return Ok(Vec::new());
    }

    // Collect all image files
    let mut images: Vec<(String, u64)> = Vec::new();
    for entry in std::fs::read_dir(&ss_dir).map_err(|e| ProjectError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();
        if path.is_file() {
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = format!(".cutready/screenshots/{name}");
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            images.push((rel, size));
        }
    }

    if images.is_empty() {
        return Ok(Vec::new());
    }

    // Build a map of image path → list of files that reference it
    let mut ref_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (img, _) in &images {
        ref_map.insert(img.clone(), Vec::new());
    }

    // Scan markdown notes for image references
    scan_files_recursive(project_root, project_root, "md", &mut |rel_path, abs_path| {
        if let Ok(content) = std::fs::read_to_string(abs_path) {
            let refs = extract_screenshot_refs(&content);
            for img_ref in refs {
                if let Some(referrers) = ref_map.get_mut(&img_ref) {
                    referrers.push(rel_path.to_string());
                }
            }
        }
    })?;

    // Scan sketch files for screenshot field references
    scan_files_recursive(project_root, project_root, "sk", &mut |rel_path, abs_path| {
        if let Ok(content) = std::fs::read_to_string(abs_path) {
            let refs = extract_sketch_screenshot_refs(&content);
            for img_ref in refs {
                if let Some(referrers) = ref_map.get_mut(&img_ref) {
                    referrers.push(rel_path.to_string());
                }
            }
        }
    })?;

    let mut result: Vec<ImageRefInfo> = images
        .into_iter()
        .map(|(path, size)| {
            let referenced_by = ref_map.remove(&path).unwrap_or_default();
            ImageRefInfo {
                path,
                size,
                referenced_by,
            }
        })
        .collect();

    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

/// Image reference info returned by list_images_with_refs.
pub struct ImageRefInfo {
    pub path: String,
    pub size: u64,
    pub referenced_by: Vec<String>,
}

/// Check if a sketch file exists given a relative path from project root.
pub fn sketch_file_exists(relative_path: &str, project_root: &Path) -> bool {
    project_root.join(relative_path).exists()
}

// ── Chat sessions (.chat JSON files) ────────────────────────────────

/// Summary of a saved chat session.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatSessionSummary {
    pub path: String,
    pub title: String,
    pub message_count: usize,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// A persisted chat session.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatSession {
    pub title: String,
    pub messages: Vec<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// Scan for .chat files in the project.
pub fn scan_chat_sessions(project_root: &Path) -> Result<Vec<ChatSessionSummary>, ProjectError> {
    let mut summaries = Vec::new();
    let chats_dir = project_root.join(".chats");
    if chats_dir.exists() {
        let entries = std::fs::read_dir(&chats_dir).map_err(|e| ProjectError::Io(e.to_string()))?;
        for entry in entries {
            let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "chat") {
                if let Ok(data) = std::fs::read_to_string(&path) {
                    if let Ok(session) = serde_json::from_str::<ChatSession>(&data) {
                        if let Ok(rel) = path.strip_prefix(project_root) {
                            summaries.push(ChatSessionSummary {
                                path: rel.to_string_lossy().replace('\\', "/"),
                                title: session.title,
                                message_count: session.messages.len(),
                                updated_at: session.updated_at,
                            });
                        }
                    }
                }
            }
        }
    }
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Read a chat session file.
pub fn read_chat_session(path: &Path) -> Result<ChatSession, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(path.to_string_lossy().into_owned()));
    }
    let data = std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data).map_err(|e| ProjectError::Io(format!("Invalid chat session: {e}")))
}

/// Write a chat session file.
pub fn write_chat_session(path: &Path, session: &ChatSession) -> Result<(), ProjectError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    let json = serde_json::to_string_pretty(session)
        .map_err(|e| ProjectError::Io(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Delete a chat session file.
pub fn delete_chat_session(path: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    Ok(())
}

// ── Sidebar order manifest ──────────────────────────────────────────

const ORDER_FILE: &str = ".cutready-order.json";
const WORKSPACE_FILE: &str = ".cutready/workspace.json";

/// Workspace state persisted across app restarts.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct WorkspaceState {
    #[serde(default)]
    pub open_tabs: Vec<WorkspaceTab>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub chat_session_path: Option<String>,
}

/// A persisted editor tab.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceTab {
    pub id: String,
    #[serde(rename = "type")]
    pub tab_type: String,
    pub path: String,
    pub title: String,
}

/// Read workspace state. Returns default (empty) if missing.
pub fn read_workspace_state(project_root: &Path) -> WorkspaceState {
    let path = project_root.join(WORKSPACE_FILE);
    if let Ok(data) = std::fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        WorkspaceState::default()
    }
}

/// Write workspace state.
pub fn write_workspace_state(
    project_root: &Path,
    ws: &WorkspaceState,
) -> Result<(), ProjectError> {
    let path = project_root.join(WORKSPACE_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    let data =
        serde_json::to_string_pretty(ws).map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(&path, data).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Read the sidebar ordering manifest. Returns default (empty) if missing.
pub fn read_sidebar_order(project_root: &Path) -> SidebarOrder {
    let path = project_root.join(ORDER_FILE);
    if let Ok(data) = std::fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        SidebarOrder::default()
    }
}

/// Write the sidebar ordering manifest.
pub fn write_sidebar_order(
    project_root: &Path,
    order: &SidebarOrder,
) -> Result<(), ProjectError> {
    let path = project_root.join(ORDER_FILE);
    let data =
        serde_json::to_string_pretty(order).map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(&path, data).map_err(|e| ProjectError::Io(e.to_string()))
}

// ── Versioning helpers ─────────────────────────────────────────────

/// Save with a user-provided label (for named versions).
pub fn save_with_label(
    project_root: &Path,
    label: &str,
    fork_label: Option<&str>,
) -> Result<String, ProjectError> {
    // Auto-init git if missing so snapshots always work
    if !project_root.join(".git").exists() {
        versioning::init_project_repo(project_root)
            .map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    versioning::commit_snapshot(project_root, label, fork_label)
        .map_err(|e| ProjectError::Io(e.to_string()))
}

// ── Internal helpers ────────────────────────────────────────────────

/// Recursively find files with a given extension, skipping `.git` and hidden dirs.
fn scan_files_recursive(
    dir: &Path,
    project_root: &Path,
    extension: &str,
    callback: &mut dyn FnMut(&str, &Path),
) -> Result<(), ProjectError> {
    if !dir.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    for entry in entries {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // Skip hidden directories and .git
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            scan_files_recursive(&path, project_root, extension, callback)?;
        } else if path.extension().is_some_and(|ext| ext == extension) {
            // Compute relative path using forward slashes for portability
            if let Ok(rel) = path.strip_prefix(project_root) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                callback(&rel_str, &path);
            }
        }
    }

    Ok(())
}

/// Errors that can occur during project operations.
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("I/O error: {0}")]
    Io(String),
    #[error("Serialization error: {0}")]
    Serialize(String),
    #[error("Deserialization error: {0}")]
    Deserialize(String),
    #[error("Project not found: {0}")]
    NotFound(String),
    #[error("Path traversal rejected: {0}")]
    PathTraversal(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn init_project_folder_creates_git() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("My Demo");

        let view = init_project_folder(&root).unwrap();
        assert_eq!(view.name, "My Demo");
        assert!(root.join(".git").exists());
    }

    #[test]
    fn open_project_folder_returns_view() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("Test Project");
        std::fs::create_dir_all(&root).unwrap();

        let view = open_project_folder(&root).unwrap();
        assert_eq!(view.name, "Test Project");
    }

    #[test]
    fn open_nonexistent_folder_errors() {
        let result = open_project_folder(Path::new("/nonexistent/path"));
        assert!(result.is_err());
    }

    #[test]
    fn write_and_read_sketch() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("My Sketch");
        let path = root.join("intro.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());

        let loaded = read_sketch(&path).unwrap();
        assert_eq!(loaded.title, "My Sketch");
    }

    #[test]
    fn write_sketch_creates_subdirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Nested");
        let path = root.join("flows").join("login.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn delete_sketch_removes_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Delete Me");
        let path = root.join("temp.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());

        delete_sketch(&path, root).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn rename_sketch_moves_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Rename Me");
        let old_path = root.join("old.sk");
        let new_path = root.join("new.sk");

        write_sketch(&sketch, &old_path, root).unwrap();
        rename_sketch(&old_path, &new_path, root).unwrap();

        assert!(!old_path.exists());
        assert!(new_path.exists());
        let loaded = read_sketch(&new_path).unwrap();
        assert_eq!(loaded.title, "Rename Me");
    }

    #[test]
    fn read_nonexistent_sketch_errors() {
        let result = read_sketch(Path::new("/nonexistent/sketch.sk"));
        assert!(result.is_err());
    }

    #[test]
    fn scan_sketches_finds_all() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_sketch(&Sketch::new("A"), &root.join("a.sk"), root).unwrap();
        write_sketch(&Sketch::new("B"), &root.join("b.sk"), root).unwrap();
        write_sketch(
            &Sketch::new("C"),
            &root.join("sub").join("c.sk"),
            root,
        )
        .unwrap();

        let summaries = scan_sketches(root).unwrap();
        assert_eq!(summaries.len(), 3);

        let paths: Vec<&str> = summaries.iter().map(|s| s.path.as_str()).collect();
        assert!(paths.contains(&"a.sk"));
        assert!(paths.contains(&"b.sk"));
        assert!(paths.contains(&"sub/c.sk"));
    }

    #[test]
    fn scan_sketches_skips_hidden_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_sketch(&Sketch::new("Visible"), &root.join("visible.sk"), root).unwrap();
        // Put a sketch in .git — should be skipped
        let hidden = root.join(".git").join("hidden.sk");
        std::fs::create_dir_all(hidden.parent().unwrap()).unwrap();
        std::fs::write(&hidden, r#"{"title":"Hidden","state":"draft","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}"#).unwrap();

        let summaries = scan_sketches(root).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "Visible");
    }

    #[test]
    fn scan_sketches_empty_dir() {
        let tmp = TempDir::new().unwrap();
        let summaries = scan_sketches(tmp.path()).unwrap();
        assert!(summaries.is_empty());
    }

    #[test]
    fn write_and_read_storyboard() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sb = Storyboard::new("Full Demo");
        let path = root.join("demo.sb");

        write_storyboard(&sb, &path, root).unwrap();
        let loaded = read_storyboard(&path).unwrap();
        assert_eq!(loaded.title, "Full Demo");
    }

    #[test]
    fn scan_storyboards_finds_all() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_storyboard(&Storyboard::new("A"), &root.join("a.sb"), root).unwrap();
        write_storyboard(&Storyboard::new("B"), &root.join("b.sb"), root).unwrap();

        let summaries = scan_storyboards(root).unwrap();
        assert_eq!(summaries.len(), 2);
    }

    #[test]
    fn sketch_file_exists_checks_correctly() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        assert!(!sketch_file_exists("intro.sk", root));
        write_sketch(&Sketch::new("Intro"), &root.join("intro.sk"), root).unwrap();
        assert!(sketch_file_exists("intro.sk", root));
    }

    #[test]
    fn save_with_label_creates_named_version() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        init_project_folder(root).unwrap();
        write_sketch(&Sketch::new("Test"), &root.join("test.sk"), root).unwrap();

        let commit_id = save_with_label(root, "v1.0 release", None).unwrap();
        assert!(!commit_id.is_empty());

        let versions = versioning::list_versions(root).unwrap();
        assert!(versions.iter().any(|v| v.message == "v1.0 release"));
    }

    // ── safe_resolve tests ─────────────────────────────────

    #[test]
    fn safe_resolve_accepts_normal_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let result = safe_resolve(root, "intro.sk").unwrap();
        assert_eq!(result, root.join("intro.sk"));

        let result = safe_resolve(root, "flows/login.sk").unwrap();
        assert_eq!(result, root.join("flows/login.sk"));
    }

    #[test]
    fn safe_resolve_rejects_parent_traversal() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        assert!(safe_resolve(root, "../escape.sk").is_err());
        assert!(safe_resolve(root, "sub/../../escape.sk").is_err());
        assert!(safe_resolve(root, "..").is_err());
    }

    #[test]
    fn safe_resolve_rejects_absolute_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        #[cfg(target_os = "windows")]
        assert!(safe_resolve(root, "C:\\Windows\\System32\\cmd.exe").is_err());

        #[cfg(not(target_os = "windows"))]
        assert!(safe_resolve(root, "/etc/passwd").is_err());
    }

    // ── extract_screenshot_refs tests ─────────────────────────

    #[test]
    fn extract_refs_finds_screenshot_paths() {
        let md = "Some text\n![screenshot](.cutready/screenshots/pasted-123.png)\nMore text";
        let refs = extract_screenshot_refs(md);
        assert_eq!(refs, vec![".cutready/screenshots/pasted-123.png"]);
    }

    #[test]
    fn extract_refs_finds_multiple() {
        let md = "![a](.cutready/screenshots/a.png) and ![b](.cutready/screenshots/b.jpg)";
        let refs = extract_screenshot_refs(md);
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn extract_refs_ignores_non_screenshot_images() {
        let md = "![logo](assets/logo.png)";
        let refs = extract_screenshot_refs(md);
        assert!(refs.is_empty());
    }

    #[test]
    fn extract_refs_empty_content() {
        assert!(extract_screenshot_refs("").is_empty());
        assert!(extract_screenshot_refs("no images here").is_empty());
    }

    // ── delete_note with image cleanup tests ──────────────────

    #[test]
    fn delete_note_removes_orphaned_images() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Create screenshots dir and an image
        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        let img = ss_dir.join("pasted-123.png");
        std::fs::write(&img, b"fake image").unwrap();

        // Create a note referencing the image
        let note = root.join("test.md");
        std::fs::write(&note, "![screenshot](.cutready/screenshots/pasted-123.png)").unwrap();

        delete_note(&note, root).unwrap();
        assert!(!note.exists(), "note should be deleted");
        assert!(!img.exists(), "orphaned image should be deleted");
    }

    #[test]
    fn delete_note_keeps_shared_images() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Create screenshots dir and an image
        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        let img = ss_dir.join("shared.png");
        std::fs::write(&img, b"fake image").unwrap();

        // Two notes reference the same image
        let note1 = root.join("note1.md");
        let note2 = root.join("note2.md");
        std::fs::write(&note1, "![a](.cutready/screenshots/shared.png)").unwrap();
        std::fs::write(&note2, "![b](.cutready/screenshots/shared.png)").unwrap();

        delete_note(&note1, root).unwrap();
        assert!(!note1.exists(), "note1 should be deleted");
        assert!(img.exists(), "shared image should be kept (note2 still references it)");
    }

    #[test]
    fn delete_note_no_images_works() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let note = root.join("simple.md");
        std::fs::write(&note, "Just some text").unwrap();

        delete_note(&note, root).unwrap();
        assert!(!note.exists());
    }

    // ── list_images_with_refs tests ─────────────────────────────

    #[test]
    fn list_images_with_refs_finds_references() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Create screenshots dir and images
        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        std::fs::write(ss_dir.join("pasted-001.png"), b"img1").unwrap();
        std::fs::write(ss_dir.join("pasted-002.png"), b"img2").unwrap();

        // Create a note at root level referencing one image
        std::fs::write(
            root.join("my-note.md"),
            "# Hello\n\n![screenshot](.cutready/screenshots/pasted-001.png)\n",
        ).unwrap();

        let result = list_images_with_refs(root).unwrap();
        assert_eq!(result.len(), 2);

        let img1 = result.iter().find(|i| i.path.contains("pasted-001")).unwrap();
        assert_eq!(img1.referenced_by.len(), 1, "pasted-001 should be referenced by my-note.md");
        assert!(img1.referenced_by[0].contains("my-note.md"));

        let img2 = result.iter().find(|i| i.path.contains("pasted-002")).unwrap();
        assert_eq!(img2.referenced_by.len(), 0, "pasted-002 should be orphaned");
    }

    #[test]
    fn list_images_with_refs_no_false_orphans() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Create screenshots dir and an image
        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        std::fs::write(ss_dir.join("pasted-100.png"), b"img").unwrap();

        // Create a note referencing the image
        std::fs::write(
            root.join("script-draft.md"),
            "Some text\n\n![pic](.cutready/screenshots/pasted-100.png)\n\nMore text",
        ).unwrap();

        let result = list_images_with_refs(root).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].referenced_by.len(),
            1,
            "Image should NOT be reported as orphaned when referenced by a note"
        );
    }

    #[test]
    fn extract_refs_finds_html_img_tags() {
        let content = r#"Some text
<img src=".cutready/screenshots/pasted-500.png" alt="test" />
More text"#;
        let refs = extract_screenshot_refs(content);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0], ".cutready/screenshots/pasted-500.png");
    }

    #[test]
    fn extract_refs_finds_both_markdown_and_html() {
        let content = r#"# Doc
![pic](.cutready/screenshots/pasted-001.png)
Some text
<img src=".cutready/screenshots/pasted-002.png" />
"#;
        let refs = extract_screenshot_refs(content);
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|r| r.contains("pasted-001")));
        assert!(refs.iter().any(|r| r.contains("pasted-002")));
    }

    #[test]
    fn list_images_with_refs_detects_html_img_refs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        std::fs::write(ss_dir.join("pasted-html.png"), b"img").unwrap();

        // Note uses HTML img tag instead of markdown syntax
        std::fs::write(
            root.join("html-note.md"),
            "# Note\n\n<img src=\".cutready/screenshots/pasted-html.png\" alt=\"test\" />\n",
        ).unwrap();

        let result = list_images_with_refs(root).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].referenced_by.len(),
            1,
            "HTML img tag references should be detected"
        );
    }

    // ── extract_sketch_screenshot_refs tests ─────────────────

    #[test]
    fn extract_sketch_refs_finds_screenshot_paths() {
        let sk = r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"intro","demo_actions":"click","screenshot":".cutready/screenshots/step1.png"}]}"#;
        let refs = extract_sketch_screenshot_refs(sk);
        assert_eq!(refs, vec![".cutready/screenshots/step1.png"]);
    }

    #[test]
    fn extract_sketch_refs_skips_null_screenshots() {
        let sk = r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"intro","demo_actions":"click","screenshot":null}]}"#;
        let refs = extract_sketch_screenshot_refs(sk);
        assert!(refs.is_empty());
    }

    #[test]
    fn extract_sketch_refs_multiple_rows() {
        let sk = r#"{"title":"Demo","rows":[
            {"time":"~10s","narrative":"a","demo_actions":"a","screenshot":".cutready/screenshots/a.png"},
            {"time":"~10s","narrative":"b","demo_actions":"b","screenshot":null},
            {"time":"~10s","narrative":"c","demo_actions":"c","screenshot":".cutready/screenshots/c.png"}
        ]}"#;
        let refs = extract_sketch_screenshot_refs(sk);
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|r| r.contains("a.png")));
        assert!(refs.iter().any(|r| r.contains("c.png")));
    }

    #[test]
    fn list_images_with_refs_includes_sketch_references() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        std::fs::write(ss_dir.join("step1.png"), b"img").unwrap();

        // Only a sketch references this image (no notes)
        std::fs::write(
            root.join("intro.sk"),
            r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"x","demo_actions":"y","screenshot":".cutready/screenshots/step1.png"}]}"#,
        ).unwrap();

        let result = list_images_with_refs(root).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].referenced_by.len(),
            1,
            "Image referenced by a sketch should NOT be reported as orphaned"
        );
        assert!(result[0].referenced_by[0].contains("intro.sk"));
    }

    #[test]
    fn delete_note_keeps_images_referenced_by_sketches() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        let img = ss_dir.join("shared.png");
        std::fs::write(&img, b"fake image").unwrap();

        // A note references the image
        let note = root.join("test.md");
        std::fs::write(&note, "![pic](.cutready/screenshots/shared.png)").unwrap();

        // A sketch also references it
        std::fs::write(
            root.join("demo.sk"),
            r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"x","demo_actions":"y","screenshot":".cutready/screenshots/shared.png"}]}"#,
        ).unwrap();

        delete_note(&note, root).unwrap();
        assert!(!note.exists(), "note should be deleted");
        assert!(img.exists(), "image referenced by sketch should be kept");
    }
}
