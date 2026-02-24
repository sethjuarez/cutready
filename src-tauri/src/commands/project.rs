//! Tauri commands for project CRUD operations.

use tauri::State;

use crate::engine::project;
use crate::models::script::{Project, ProjectSummary};
use crate::AppState;

#[tauri::command]
pub async fn create_project(name: String, state: State<'_, AppState>) -> Result<Project, String> {
    let projects_dir = state.projects_dir.clone();
    let new_project =
        project::create_project(&name, &projects_dir).map_err(|e| e.to_string())?;

    // Set as the current project
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(new_project.clone());

    Ok(new_project)
}

#[tauri::command]
pub async fn open_project(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let projects_dir = state.projects_dir.clone();
    let loaded =
        project::load_project(&project_id, &projects_dir).map_err(|e| e.to_string())?;

    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(loaded.clone());

    Ok(loaded)
}

#[tauri::command]
pub async fn save_project(state: State<'_, AppState>) -> Result<(), String> {
    let projects_dir = state.projects_dir.clone();
    let current = state.current_project.lock().map_err(|e| e.to_string())?;

    match current.as_ref() {
        Some(p) => project::save_project(p, &projects_dir).map_err(|e| e.to_string()),
        None => Err("No project is currently open".into()),
    }
}

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectSummary>, String> {
    let projects_dir = state.projects_dir.clone();
    project::list_projects(&projects_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_current_project(state: State<'_, AppState>) -> Result<Option<Project>, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    Ok(current.clone())
}

#[tauri::command]
pub async fn delete_project(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let projects_dir = state.projects_dir.clone();
    project::delete_project(&project_id, &projects_dir).map_err(|e| e.to_string())
}
