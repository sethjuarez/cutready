//! Tauri commands for sketch CRUD operations.

use chrono::Utc;
use tauri::State;
use uuid::Uuid;

use crate::engine::project;
use crate::models::sketch::{Sketch, SketchSummary};
use crate::AppState;

#[tauri::command]
pub async fn create_sketch(title: String, state: State<'_, AppState>) -> Result<Sketch, String> {
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let sketch = Sketch::new(title);
    project.sketches.push(sketch.clone());
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(sketch)
}

#[tauri::command]
pub async fn update_sketch(
    id: String,
    description: Option<serde_json::Value>,
    rows: Option<Vec<crate::models::sketch::PlanningRow>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sketch_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let sketch = project
        .sketches
        .iter_mut()
        .find(|s| s.id == sketch_id)
        .ok_or("Sketch not found")?;

    if let Some(desc) = description {
        sketch.description = desc;
    }
    if let Some(r) = rows {
        sketch.rows = r;
    }
    sketch.updated_at = Utc::now();
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn update_sketch_title(
    id: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sketch_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let sketch = project
        .sketches
        .iter_mut()
        .find(|s| s.id == sketch_id)
        .ok_or("Sketch not found")?;

    sketch.title = title;
    sketch.updated_at = Utc::now();
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn delete_sketch(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let sketch_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let idx = project
        .sketches
        .iter()
        .position(|s| s.id == sketch_id)
        .ok_or("Sketch not found")?;

    project.sketches.remove(idx);
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn list_sketches(state: State<'_, AppState>) -> Result<Vec<SketchSummary>, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_ref().ok_or("No project is currently open")?;

    Ok(project.sketches.iter().map(SketchSummary::from).collect())
}

#[tauri::command]
pub async fn get_sketch(id: String, state: State<'_, AppState>) -> Result<Sketch, String> {
    let sketch_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_ref().ok_or("No project is currently open")?;

    project
        .sketches
        .iter()
        .find(|s| s.id == sketch_id)
        .cloned()
        .ok_or_else(|| "Sketch not found".into())
}
