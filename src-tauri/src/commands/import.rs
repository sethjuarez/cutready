//! Tauri commands for importing documents (.docx, .pdf, .pptx).

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

/// Import a .docx file as a markdown note.
/// Returns the relative path of the created note.
#[tauri::command]
pub async fn import_docx(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let data = fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    let markdown = import::docx_to_markdown(&data, &root)?;

    let filename = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-doc");
    let slug = filename
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();
    let relative_path = format!("{}.md", if slug.is_empty() { "imported-doc" } else { &slug });

    // Find a non-conflicting path and save
    let final_path = find_available_path(&root, &relative_path, "md");
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    project::write_note(&abs_final, &markdown).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .pdf file as a markdown note.
/// Returns the relative path of the created note.
#[tauri::command]
pub async fn import_pdf(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let data = fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    let markdown = import::pdf_to_markdown(&data)?;

    let filename = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-pdf");
    let slug = filename
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();
    let relative_path = format!("{}.md", if slug.is_empty() { "imported-pdf" } else { &slug });

    let final_path = find_available_path(&root, &relative_path, "md");
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    project::write_note(&abs_final, &markdown).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .pptx file as a markdown note.
/// Returns the relative path of the created note.
#[tauri::command]
pub async fn import_pptx(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let data = fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    let markdown = import::pptx_to_markdown(&data, &root)?;

    let filename = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-presentation");
    let slug = filename
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();
    let relative_path = format!("{}.md", if slug.is_empty() { "imported-presentation" } else { &slug });

    let final_path = find_available_path(&root, &relative_path, "md");
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    project::write_note(&abs_final, &markdown).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .md (markdown) file as a note.
/// Copies referenced screenshots, returns the relative path.
#[tauri::command]
pub async fn import_markdown(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let source_path = Path::new(&file_path);
    let content = fs::read_to_string(source_path).map_err(|e| format!("Failed to read file: {e}"))?;

    // Copy referenced screenshots from source workspace
    if let Some(source_root) = infer_source_root(source_path) {
        copy_note_assets(&content, &source_root, &root);
    }

    let filename = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-note");
    let slug = filename
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();
    let relative_path = format!("{}.md", if slug.is_empty() { "imported-note" } else { &slug });

    let final_path = find_available_path(&root, &relative_path, "md");
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    project::write_note(&abs_final, &content).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .sk (sketch) file into the current project.
/// Validates JSON structure, copies referenced assets, returns the relative path.
#[tauri::command]
pub async fn import_sketch(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let source_path = Path::new(&file_path);
    let data = fs::read_to_string(source_path).map_err(|e| format!("Failed to read file: {e}"))?;

    let mut sketch: crate::models::sketch::Sketch =
        serde_json::from_str(&data).map_err(|e| format!("Invalid sketch file: {e}"))?;

    // Copy referenced screenshots and visuals from source workspace
    if let Some(source_root) = infer_source_root(source_path) {
        copy_sketch_assets(&mut sketch, &source_root, &root);
    }

    let filename = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-sketch");
    let slug = filename
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();
    let relative_path = format!("{}.sk", if slug.is_empty() { "imported-sketch" } else { &slug });

    let final_path = find_available_path(&root, &relative_path, "sk");
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    project::write_sketch(&sketch, &abs_final, &root).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Import a .sb (storyboard) file into the current project.
/// Validates JSON structure, copies to project, returns the relative path.
#[tauri::command]
pub async fn import_storyboard(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let source_path = Path::new(&file_path);
    let data = fs::read_to_string(source_path).map_err(|e| format!("Failed to read file: {e}"))?;

    let storyboard: crate::models::sketch::Storyboard =
        serde_json::from_str(&data).map_err(|e| format!("Invalid storyboard file: {e}"))?;

    let filename = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-storyboard");
    let slug = filename
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();
    let relative_path = format!("{}.sb", if slug.is_empty() { "imported-storyboard" } else { &slug });

    let final_path = find_available_path(&root, &relative_path, "sb");
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

/// Copy a single asset file from source root to dest root if it exists.
/// Creates parent directories as needed. Silently skips missing files.
fn copy_asset(source_root: &Path, dest_root: &Path, relative_path: &str) {
    let src = source_root.join(relative_path);
    if !src.exists() {
        return;
    }
    let dest = dest_root.join(relative_path);
    if dest.exists() {
        return; // already present
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
) {
    for row in &mut sketch.rows {
        // Copy screenshot
        if let Some(ref ss) = row.screenshot {
            copy_asset(source_root, dest_root, ss);
        }
        // Handle visual
        if let Some(ref visual) = row.visual {
            if let Some(vis_path) = visual.as_str() {
                // External visual file — copy it
                copy_asset(source_root, dest_root, vis_path);
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
fn copy_note_assets(content: &str, source_root: &Path, dest_root: &Path) {
    // Match markdown image refs and HTML img src referencing .cutready/screenshots/
    for pattern in &["](", "src=\"", "src='"] {
        let mut rest = content;
        while let Some(pos) = rest.find(pattern) {
            let after = &rest[pos + pattern.len()..];
            let end_char = if *pattern == "](" { ')' } else { pattern.chars().last().unwrap() };
            if let Some(end) = after.find(end_char) {
                let path = after[..end].trim();
                if path.contains(".cutready/screenshots/") || path.contains(".cutready/visuals/") {
                    let normalized = path.replace('\\', "/");
                    copy_asset(source_root, dest_root, &normalized);
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
