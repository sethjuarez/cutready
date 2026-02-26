//! Tauri commands for project versioning operations.

use tauri::State;

use crate::engine::{project, versioning};
use crate::models::script::ProjectView;
use crate::models::sketch::VersionEntry;
use crate::AppState;

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

#[tauri::command]
pub async fn save_with_label(label: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = project_root(&state)?;
    project::save_with_label(&root, &label).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_versions(state: State<'_, AppState>) -> Result<Vec<VersionEntry>, String> {
    let root = project_root(&state)?;

    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    versioning::list_versions(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_version(
    commit_id: String,
    file_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;

    // Default to listing changed files if no specific file requested
    let target = file_path.as_deref().unwrap_or("");
    if target.is_empty() {
        return Err("File path required for preview".into());
    }

    let data = versioning::get_file_at_version(&root, &commit_id, target)
        .map_err(|e| e.to_string())?;

    String::from_utf8(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_version(
    commit_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::restore_version(&root, &commit_id).map_err(|e| e.to_string())?;

    // Re-scan the project folder after restore
    let view = ProjectView::new(root);
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view);

    Ok(())
}

#[tauri::command]
pub async fn checkout_version(
    commit_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::checkout_version(&root, &commit_id).map_err(|e| e.to_string())?;

    // Re-scan the project folder after checkout
    let view = ProjectView::new(root);
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view);

    Ok(())
}

#[tauri::command]
pub async fn has_unsaved_changes(state: State<'_, AppState>) -> Result<bool, String> {
    let root = project_root(&state)?;
    if !root.join(".git").exists() {
        return Ok(false);
    }
    versioning::has_unsaved_changes(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stash_changes(state: State<'_, AppState>) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::stash_working_tree(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pop_stash(state: State<'_, AppState>) -> Result<bool, String> {
    let root = project_root(&state)?;
    versioning::pop_stash(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_timeline(
    from_commit_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::create_timeline(&root, &from_commit_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_timelines(
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::sketch::TimelineInfo>, String> {
    let root = project_root(&state)?;
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }
    versioning::list_timelines(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn switch_timeline(
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::switch_timeline(&root, &name).map_err(|e| e.to_string())?;
    // Re-scan project
    let view = crate::models::script::ProjectView::new(root);
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view);
    Ok(())
}

#[tauri::command]
pub async fn delete_timeline(
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::delete_timeline(&root, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_timeline_graph(
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::sketch::GraphNode>, String> {
    let root = project_root(&state)?;
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }
    versioning::get_timeline_graph(&root).map_err(|e| e.to_string())
}
