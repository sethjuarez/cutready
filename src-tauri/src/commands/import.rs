//! Tauri commands for importing documents (.docx, .pdf, .pptx).
//!
//! Every import command accepts an optional `conflict` strategy:
//! - `"check"` (default) — if the target file already exists, return
//!   `FILE_EXISTS:<relative_path>` so the frontend can ask the user.
//! - `"overwrite"` — replace the existing file and its assets.
//! - `"rename"` — auto-rename with a `-2`, `-3` suffix (old behaviour).

use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::engine::{import, project};
use crate::AppState;

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

/// Resolve the final relative path for an import, honouring the conflict strategy.
///
/// * `"check"` — return `Err("FILE_EXISTS:<path>")` when the file already exists.
/// * `"overwrite"` — return the natural path even if it exists (caller will overwrite).
/// * `"rename"` — append `-2`, `-3` … to avoid a clash.
fn resolve_import_path(
    root: &Path,
    relative_path: &str,
    ext: &str,
    conflict: &str,
) -> Result<String, String> {
    let exists = root.join(relative_path).exists();

    match conflict {
        "overwrite" => Ok(relative_path.to_string()),
        "rename" => Ok(find_available_path(root, relative_path, ext)),
        // "check" (default)
        _ => {
            if exists {
                Err(format!("FILE_EXISTS:{relative_path}"))
            } else {
                Ok(relative_path.to_string())
            }
        }
    }
}

/// Import a .docx file as a markdown note.
#[tauri::command]
pub async fn import_docx(
    file_path: String,
    conflict: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let conflict = conflict.as_deref().unwrap_or("check");
    let data = fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    let markdown = import::docx_to_markdown(&data, &root)?;

    let filename = Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-doc");
    let slug = slugify(filename);
    let relative_path = format!("{}.md", if slug.is_empty() { "imported-doc" } else { &slug });

    let final_path = resolve_import_path(&root, &relative_path, "md", conflict)?;
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    project::write_note(&abs_final, &markdown).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .pdf file as a markdown note.
#[tauri::command]
pub async fn import_pdf(
    file_path: String,
    conflict: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let conflict = conflict.as_deref().unwrap_or("check");
    let data = fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    let markdown = import::pdf_to_markdown(&data)?;

    let filename = Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-pdf");
    let slug = slugify(filename);
    let relative_path = format!("{}.md", if slug.is_empty() { "imported-pdf" } else { &slug });

    let final_path = resolve_import_path(&root, &relative_path, "md", conflict)?;
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    project::write_note(&abs_final, &markdown).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .pptx file as a markdown note.
#[tauri::command]
pub async fn import_pptx(
    file_path: String,
    conflict: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let conflict = conflict.as_deref().unwrap_or("check");
    let data = fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    let markdown = import::pptx_to_markdown(&data, &root)?;

    let filename = Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-presentation");
    let slug = slugify(filename);
    let relative_path = format!(
        "{}.md",
        if slug.is_empty() { "imported-presentation" } else { &slug }
    );

    let final_path = resolve_import_path(&root, &relative_path, "md", conflict)?;
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    project::write_note(&abs_final, &markdown).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .md (markdown) file as a note. Copies referenced screenshots.
#[tauri::command]
pub async fn import_markdown(
    file_path: String,
    conflict: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let conflict = conflict.as_deref().unwrap_or("check");
    let overwrite = conflict == "overwrite";
    let source_path = Path::new(&file_path);
    let content =
        fs::read_to_string(source_path).map_err(|e| format!("Failed to read file: {e}"))?;

    let filename = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-note");
    let slug = slugify(filename);
    let relative_path = format!("{}.md", if slug.is_empty() { "imported-note" } else { &slug });

    let final_path = resolve_import_path(&root, &relative_path, "md", conflict)?;

    // Copy referenced screenshots from source workspace
    if let Some(source_root) = infer_source_root(source_path) {
        copy_note_assets(&content, &source_root, &root, overwrite);
    }

    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;
    project::write_note(&abs_final, &content).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .sk (sketch) file. Copies referenced screenshots and visuals.
#[tauri::command]
pub async fn import_sketch(
    file_path: String,
    conflict: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let conflict = conflict.as_deref().unwrap_or("check");
    let overwrite = conflict == "overwrite";
    let source_path = Path::new(&file_path);
    let data =
        fs::read_to_string(source_path).map_err(|e| format!("Failed to read file: {e}"))?;

    let mut sketch: crate::models::sketch::Sketch =
        serde_json::from_str(&data).map_err(|e| format!("Invalid sketch file: {e}"))?;

    let filename = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-sketch");
    let slug = slugify(filename);
    let relative_path = format!("{}.sk", if slug.is_empty() { "imported-sketch" } else { &slug });

    let final_path = resolve_import_path(&root, &relative_path, "sk", conflict)?;

    // Copy referenced screenshots and visuals from source workspace
    if let Some(source_root) = infer_source_root(source_path) {
        copy_sketch_assets(&mut sketch, &source_root, &root, overwrite);
    }

    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;
    project::write_sketch(&sketch, &abs_final, &root).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .sb (storyboard) file.
#[tauri::command]
pub async fn import_storyboard(
    file_path: String,
    conflict: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let conflict = conflict.as_deref().unwrap_or("check");
    let source_path = Path::new(&file_path);
    let data =
        fs::read_to_string(source_path).map_err(|e| format!("Failed to read file: {e}"))?;

    let storyboard: crate::models::sketch::Storyboard =
        serde_json::from_str(&data).map_err(|e| format!("Invalid storyboard file: {e}"))?;

    let filename = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-storyboard");
    let slug = slugify(filename);
    let relative_path = format!(
        "{}.sb",
        if slug.is_empty() { "imported-storyboard" } else { &slug }
    );

    let final_path = resolve_import_path(&root, &relative_path, "sb", conflict)?;
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    project::write_storyboard(&storyboard, &abs_final, &root).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Infer the project root from a file path by walking up to find `.git` or `.cutready`.
fn infer_source_root(file_path: &Path) -> Option<PathBuf> {
    let mut dir = file_path.parent()?;
    loop {
        if dir.join(".git").exists() || dir.join(".cutready").exists() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

/// Turn a filename into a URL-safe slug.
fn slugify(name: &str) -> String {
    name.to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string()
}

/// Copy a single asset file from source root to dest root if it exists.
/// When `overwrite` is true, replaces existing files.
fn copy_asset(source_root: &Path, dest_root: &Path, relative_path: &str, overwrite: bool) {
    let src = source_root.join(relative_path);
    if !src.exists() {
        return;
    }
    let dest = dest_root.join(relative_path);
    if dest.exists() && !overwrite {
        return;
    }
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::copy(&src, &dest);
}

/// Copy all screenshots and visuals referenced by a sketch's planning rows.
fn copy_sketch_assets(
    sketch: &mut crate::models::sketch::Sketch,
    source_root: &Path,
    dest_root: &Path,
    overwrite: bool,
) {
    for row in &mut sketch.rows {
        if let Some(ref ss) = row.screenshot {
            copy_asset(source_root, dest_root, ss, overwrite);
        }
        if let Some(ref visual) = row.visual {
            if let Some(vis_path) = visual.as_str() {
                copy_asset(source_root, dest_root, vis_path, overwrite);
            } else if visual.is_object() {
                // Inline visual (legacy) — migrate to external file
                if let Ok(path) = project::write_visual(dest_root, visual) {
                    row.visual = Some(serde_json::Value::String(path));
                }
            }
        }
    }
}

/// Copy all screenshots referenced by markdown content (![...](.cutready/screenshots/...)).
fn copy_note_assets(content: &str, source_root: &Path, dest_root: &Path, overwrite: bool) {
    for pattern in &["](", "src=\"", "src='"] {
        let mut rest = content;
        while let Some(pos) = rest.find(pattern) {
            let after = &rest[pos + pattern.len()..];
            let end_char = if *pattern == "](" { ')' } else { pattern.chars().last().unwrap() };
            if let Some(end) = after.find(end_char) {
                let path = after[..end].trim();
                if path.contains(".cutready/screenshots/") || path.contains(".cutready/visuals/") {
                    let normalized = path.replace('\\', "/");
                    copy_asset(source_root, dest_root, &normalized, overwrite);
                }
            }
            rest = &rest[pos + pattern.len()..];
        }
    }
}

/// Find a non-conflicting filename by appending -2, -3, etc.
fn find_available_path(root: &Path, relative_path: &str, ext: &str) -> String {
    let base = relative_path.trim_end_matches(&format!(".{ext}"));
    let first = root.join(relative_path);
    if !first.exists() {
        return relative_path.to_string();
    }
    for i in 2..100 {
        let candidate = format!("{base}-{i}.{ext}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}.{ext}", chrono::Utc::now().timestamp())
}
