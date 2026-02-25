//! Tauri commands for document versioning operations.

use tauri::State;

use crate::engine::{project, versioning};
use crate::models::sketch::VersionEntry;
use crate::AppState;

#[tauri::command]
pub async fn save_with_label(label: String, state: State<'_, AppState>) -> Result<String, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let proj = current.as_ref().ok_or("No project is currently open")?;
    let projects_dir = state.projects_dir.clone();

    project::save_with_label(proj, &label, &projects_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_versions(state: State<'_, AppState>) -> Result<Vec<VersionEntry>, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let proj = current.as_ref().ok_or("No project is currently open")?;
    let projects_dir = state.projects_dir.clone();
    let project_dir = project::project_dir_path(&projects_dir, &proj.id.to_string());

    if !project_dir.join(".git").exists() {
        return Ok(Vec::new());
    }

    versioning::list_versions(&project_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_version(
    commit_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let proj = current.as_ref().ok_or("No project is currently open")?;
    let projects_dir = state.projects_dir.clone();
    let project_dir = project::project_dir_path(&projects_dir, &proj.id.to_string());

    let data = versioning::get_file_at_version(&project_dir, &commit_id, "project.json")
        .map_err(|e| e.to_string())?;

    String::from_utf8(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_version(
    commit_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let projects_dir = state.projects_dir.clone();

    let project_id = {
        let current = state.current_project.lock().map_err(|e| e.to_string())?;
        let proj = current.as_ref().ok_or("No project is currently open")?;
        proj.id.to_string()
    };

    let project_dir = project::project_dir_path(&projects_dir, &project_id);
    versioning::restore_version(&project_dir, &commit_id).map_err(|e| e.to_string())?;

    // Reload the project into state
    let reloaded = project::load_project(&project_id, &projects_dir).map_err(|e| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(reloaded);

    Ok(())
}
