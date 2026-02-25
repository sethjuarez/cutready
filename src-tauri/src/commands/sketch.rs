//! Tauri commands for sketch CRUD operations.
//!
//! Sketches are `.sk` files in the project folder, identified by relative path.

use tauri::State;

use crate::engine::project;
use crate::models::sketch::{Sketch, SketchSummary};
use crate::AppState;

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

#[tauri::command]
pub async fn create_sketch(
    relative_path: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<Sketch, String> {
    let root = project_root(&state)?;
    let abs_path = root.join(&relative_path);

    let sketch = Sketch::new(title);
    project::write_sketch(&sketch, &abs_path, &root).map_err(|e| e.to_string())?;

    Ok(sketch)
}

#[tauri::command]
pub async fn update_sketch(
    relative_path: String,
    description: Option<serde_json::Value>,
    rows: Option<Vec<crate::models::sketch::PlanningRow>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let abs_path = root.join(&relative_path);

    let mut sketch = project::read_sketch(&abs_path).map_err(|e| e.to_string())?;

    if let Some(desc) = description {
        sketch.description = desc;
    }
    if let Some(r) = rows {
        sketch.rows = r;
    }
    sketch.updated_at = chrono::Utc::now();

    project::write_sketch(&sketch, &abs_path, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_sketch_title(
    relative_path: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let abs_path = root.join(&relative_path);

    let mut sketch = project::read_sketch(&abs_path).map_err(|e| e.to_string())?;
    sketch.title = title;
    sketch.updated_at = chrono::Utc::now();

    project::write_sketch(&sketch, &abs_path, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_sketch(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let abs_path = root.join(&relative_path);

    project::delete_sketch(&abs_path, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_sketches(state: State<'_, AppState>) -> Result<Vec<SketchSummary>, String> {
    let root = project_root(&state)?;
    project::scan_sketches(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_sketch(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<Sketch, String> {
    let root = project_root(&state)?;
    let abs_path = root.join(&relative_path);

    project::read_sketch(&abs_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rename_sketch(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let old_abs = root.join(&old_path);
    let new_abs = root.join(&new_path);

    project::rename_sketch(&old_abs, &new_abs, &root).map_err(|e| e.to_string())?;
    Ok(())
}
