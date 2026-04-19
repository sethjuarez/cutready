//! Tauri commands for sketch CRUD operations.
//!
//! Sketches are `.sk` files in the project folder, identified by relative path.

use tauri::State;

use crate::engine::project;
use crate::models::sketch::{PlanningCellLocks, Sketch, SketchSummary};
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
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    if abs_path.exists() {
        return Err(format!("File already exists: {relative_path}"));
    }

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
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    let mut sketch = project::read_sketch(&abs_path).map_err(|e| e.to_string())?;

    if let Some(desc) = description {
        project::ensure_sketch_unlocked(&sketch).map_err(|e| e.to_string())?;
        sketch.description = desc;
    }
    if let Some(r) = rows {
        project::ensure_sketch_unlocked(&sketch).map_err(|e| e.to_string())?;
        project::validate_rows_update_allowed(&sketch.rows, &r).map_err(|e| e.to_string())?;
        let mut updated_rows = r;
        project::apply_locked_row_metadata(&sketch.rows, &mut updated_rows);
        sketch.rows = updated_rows;
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
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    let mut sketch = project::read_sketch(&abs_path).map_err(|e| e.to_string())?;
    project::ensure_sketch_unlocked(&sketch).map_err(|e| e.to_string())?;
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
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    project::delete_sketch(&abs_path, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sketch_used_by_storyboards(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let root = project_root(&state)?;
    project::storyboards_referencing_sketch(&root, &relative_path).map_err(|e| e.to_string())
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
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    // Use migration-aware read: inline visuals → external files
    project::read_sketch_with_migration(&abs_path, &root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_sketch_lock(
    relative_path: String,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<Sketch, String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    let mut sketch = project::read_sketch(&abs_path).map_err(|e| e.to_string())?;
    sketch.locked = locked;
    sketch.updated_at = chrono::Utc::now();
    project::write_sketch(&sketch, &abs_path, &root).map_err(|e| e.to_string())?;
    Ok(sketch)
}

#[tauri::command]
pub async fn set_planning_row_lock(
    relative_path: String,
    index: usize,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<Sketch, String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    let mut sketch = project::read_sketch(&abs_path).map_err(|e| e.to_string())?;
    if index >= sketch.rows.len() {
        return Err(format!("Row {} does not exist", index + 1));
    }
    sketch.rows[index].locked = locked;
    sketch.updated_at = chrono::Utc::now();
    project::write_sketch(&sketch, &abs_path, &root).map_err(|e| e.to_string())?;
    Ok(sketch)
}

#[tauri::command]
pub async fn set_planning_cell_lock(
    relative_path: String,
    index: usize,
    field: String,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<Sketch, String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    let mut sketch = project::read_sketch(&abs_path).map_err(|e| e.to_string())?;
    if index >= sketch.rows.len() {
        return Err(format!("Row {} does not exist", index + 1));
    }
    let mut locks: PlanningCellLocks = sketch.rows[index].locks.clone();
    if !locks.set(&field, locked) {
        return Err(format!("Unknown planning cell field: {field}"));
    }
    sketch.rows[index].locks = locks;
    sketch.updated_at = chrono::Utc::now();
    project::write_sketch(&sketch, &abs_path, &root).map_err(|e| e.to_string())?;
    Ok(sketch)
}

/// Read a visual JSON file and return its content.
#[tauri::command]
pub async fn get_visual(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let root = project_root(&state)?;
    project::read_visual(&root, &relative_path).map_err(|e| e.to_string())
}

/// Write an updated visual document back to its existing path.
#[tauri::command]
pub async fn write_visual_doc(
    relative_path: String,
    document: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let abs = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&document)
        .map_err(|e| format!("Failed to serialize visual: {e}"))?;
    std::fs::write(&abs, json).map_err(|e| format!("Failed to write visual: {e}"))
}

#[tauri::command]
pub async fn rename_sketch(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let old_abs = project::safe_resolve(&root, &old_path).map_err(|e| e.to_string())?;
    let new_abs = project::safe_resolve(&root, &new_path).map_err(|e| e.to_string())?;

    project::rename_sketch(&old_abs, &new_abs, &root).map_err(|e| e.to_string())?;
    Ok(())
}
