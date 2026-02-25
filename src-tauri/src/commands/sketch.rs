//! Tauri commands for sketch CRUD operations.
//!
//! Sketches are stored as individual files: `sketches/{uuid}.json`.

use tauri::State;

use crate::engine::project;
use crate::models::sketch::{Sketch, SketchSummary};
use crate::AppState;

#[tauri::command]
pub async fn create_sketch(title: String, state: State<'_, AppState>) -> Result<Sketch, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let proj = current.as_ref().ok_or("No project is currently open")?;
    let project_dir = project::project_dir_path(&state.projects_dir, &proj.id.to_string());

    let sketch = Sketch::new(title);
    project::save_sketch(&sketch, &project_dir).map_err(|e| e.to_string())?;

    Ok(sketch)
}

#[tauri::command]
pub async fn update_sketch(
    id: String,
    description: Option<serde_json::Value>,
    rows: Option<Vec<crate::models::sketch::PlanningRow>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let proj = current.as_ref().ok_or("No project is currently open")?;
    let project_dir = project::project_dir_path(&state.projects_dir, &proj.id.to_string());

    let mut sketch = project::load_sketch(&id, &project_dir).map_err(|e| e.to_string())?;

    if let Some(desc) = description {
        sketch.description = desc;
    }
    if let Some(r) = rows {
        sketch.rows = r;
    }
    sketch.updated_at = chrono::Utc::now();

    project::save_sketch(&sketch, &project_dir).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_sketch_title(
    id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let proj = current.as_ref().ok_or("No project is currently open")?;
    let project_dir = project::project_dir_path(&state.projects_dir, &proj.id.to_string());

    let mut sketch = project::load_sketch(&id, &project_dir).map_err(|e| e.to_string())?;
    sketch.title = title;
    sketch.updated_at = chrono::Utc::now();

    project::save_sketch(&sketch, &project_dir).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_sketch(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let proj = current.as_ref().ok_or("No project is currently open")?;
    let project_dir = project::project_dir_path(&state.projects_dir, &proj.id.to_string());

    project::delete_sketch_file(&id, &project_dir).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_sketches(state: State<'_, AppState>) -> Result<Vec<SketchSummary>, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let proj = current.as_ref().ok_or("No project is currently open")?;
    let project_dir = project::project_dir_path(&state.projects_dir, &proj.id.to_string());

    project::list_sketches(&project_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_sketch(id: String, state: State<'_, AppState>) -> Result<Sketch, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let proj = current.as_ref().ok_or("No project is currently open")?;
    let project_dir = project::project_dir_path(&state.projects_dir, &proj.id.to_string());

    project::load_sketch(&id, &project_dir).map_err(|e| e.to_string())
}
