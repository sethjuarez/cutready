//! Tauri commands for note CRUD operations.
//!
//! Notes are `.md` files in the project folder, identified by relative path.

use tauri::State;

use crate::engine::project;
use crate::models::sketch::NoteSummary;
use crate::AppState;

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

#[tauri::command]
pub async fn create_note(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    if abs_path.exists() {
        return Err(format!("File already exists: {relative_path}"));
    }

    project::write_note(&abs_path, "").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_note(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    project::read_note(&abs_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_note(
    relative_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    project::write_note(&abs_path, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_note(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    project::delete_note(&abs_path, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_notes(state: State<'_, AppState>) -> Result<Vec<NoteSummary>, String> {
    let root = project_root(&state)?;
    project::scan_notes(&root).map_err(|e| e.to_string())
}

/// Save a base64-encoded image to the project's screenshots directory.
/// Returns the relative path (e.g. ".cutready/screenshots/pasted-1234.png").
#[tauri::command]
pub async fn save_pasted_image(
    base64_data: String,
    extension: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let dir = root.join(".cutready").join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create screenshots dir: {e}"))?;

    let data = base64_decode(&base64_data)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let ext = match extension.as_str() {
        "jpeg" | "jpg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        _ => "png",
    };
    let filename = format!("pasted-{ts}.{ext}");
    let abs_path = dir.join(&filename);
    std::fs::write(&abs_path, &data).map_err(|e| format!("Failed to write image: {e}"))?;
    Ok(format!(".cutready/screenshots/{filename}"))
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| format!("Invalid base64: {e}"))
}
