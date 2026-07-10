//! Tauri commands for sketch CRUD operations.
//!
//! Sketches are `.sk` files in the project folder, identified by relative path.

use tauri::State;
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::{agent::tools::normalize_visual_document_for_save, project};
use crate::models::script::ProjectView;
use crate::models::sketch::{DocumentMetadata, PlanningCellLocks, Sketch, SketchSummary};
use crate::AppState;

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(document_root_from_project_view(view))
}

fn document_root_from_project_view(view: &ProjectView) -> std::path::PathBuf {
    view.root.clone()
}

#[auditaur_command(skip_all, err)]
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

#[auditaur_command(skip_all, err)]
pub async fn update_sketch(
    relative_path: String,
    description: Option<serde_json::Value>,
    rows: Option<Vec<crate::models::sketch::PlanningRow>>,
    metadata: Option<DocumentMetadata>,
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
    if let Some(metadata) = metadata {
        project::ensure_sketch_unlocked(&sketch).map_err(|e| e.to_string())?;
        sketch.metadata = metadata;
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

#[auditaur_command(skip_all, err)]
pub async fn list_sketches(state: State<'_, AppState>) -> Result<Vec<SketchSummary>, String> {
    let root = project_root(&state)?;
    project::scan_sketches(&root).map_err(|e| e.to_string())
}

#[auditaur_command(skip_all, err)]
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
    sketch.set_locked_recursive(locked);
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
    sketch.rows[index].set_locked_recursive(locked);
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
    let visual = project::read_visual(&root, &relative_path).map_err(|e| e.to_string())?;
    normalize_visual_document_for_save(&visual)
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
    let document = normalize_visual_document_for_save(&document)?;
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
    project::rename_project_asset(&root, &old_path, &new_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sketch_document_io_scopes_to_project_root_for_nested_projects() {
        let view = ProjectView::in_repo(
            std::path::PathBuf::from("D:/workspace"),
            "demos/product-tour",
            "Product tour".to_string(),
        );

        assert_eq!(
            document_root_from_project_view(&view),
            std::path::PathBuf::from("D:/workspace/demos/product-tour")
        );
        assert_ne!(document_root_from_project_view(&view), view.repo_root);
    }
}
