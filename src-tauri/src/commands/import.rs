//! Tauri commands for importing documents (.docx, .pdf, .pptx).

use std::fs;

use tauri::State;

use crate::engine::{import, project};
use crate::models::sketch::Sketch;
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
    let markdown = import::docx_to_markdown(&data)?;

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

/// Import a .pptx file as a sketch with planning rows.
/// Returns the relative path of the created sketch.
#[tauri::command]
pub async fn import_pptx(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let data = fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    let (title, rows) = import::pptx_to_planning_rows(&data)?;

    let filename = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("imported-presentation");
    let slug = filename
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();
    let relative_path = format!("{}.sk", if slug.is_empty() { "imported-presentation" } else { &slug });

    let final_path = find_available_path(&root, &relative_path, "sk");
    let abs_final = project::safe_resolve(&root, &final_path).map_err(|e| e.to_string())?;

    let mut sketch = Sketch::new(title);
    sketch.rows = rows;

    project::write_sketch(&sketch, &abs_final, &root).map_err(|e| e.to_string())?;
    Ok(final_path)
}

/// Find a non-conflicting filename by appending -2, -3, etc.
fn find_available_path(root: &std::path::Path, relative_path: &str, ext: &str) -> String {
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
