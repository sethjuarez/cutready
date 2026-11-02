//! Tauri commands for sketch CRUD operations.
//!
//! Sketches are `.sk` files in the project folder, identified by relative path.

use std::path::Path;

use tauri::State;
use tauri_plugin_auditaur::auditaur_command;

use serde_json::{json, Value};

use super::CmdError;
use crate::engine::document_writer::{self, Expected, Versioned, WriteError};
use crate::engine::{document_reads, project};
use crate::models::script::ProjectView;
use crate::AppState;
use cutready_core::edit_ops::ContentEditError;
use cutready_core::models::sketch::{
    DocumentMetadata, PlanningCellLocks, PlanningRow, Sketch, SketchSummary,
};
use cutready_core::visual_document::normalize_visual_document_for_save;

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
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    if abs_path.exists() {
        return Err(format!("File already exists: {relative_path}"));
    }

    create_sketch_at(&root, &relative_path, title)
}

fn create_sketch_at(root: &Path, rel: &str, title: String) -> Result<Sketch, String> {
    let sketch = Sketch::new(title, chrono::Utc::now());
    let op = json!({ "kind": "replace_sketch", "sketch": sketch });
    document_writer::edit_sketch(root, rel, Expected::Absent, &[op]).map_err(|err| match err {
        WriteError::Edit(ContentEditError::Stale(_)) => format!("File already exists: {rel}"),
        other => other.to_string(),
    })
}

/// App saves send the version and text of the document the editor last
/// loaded or saved (`base`); see `document_writer::save`.
#[auditaur_command(skip_all, err)]
#[allow(clippy::too_many_arguments)]
pub async fn update_sketch(
    relative_path: String,
    expected_version: String,
    base: String,
    description: Option<serde_json::Value>,
    rows: Option<Vec<cutready_core::models::sketch::PlanningRow>>,
    metadata: Option<DocumentMetadata>,
    state: State<'_, AppState>,
) -> Result<Versioned<Sketch>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let ops = update_sketch_ops(description, rows, metadata);
    save_sketch(&root, &relative_path, &expected_version, &base, &ops)
}

fn save_sketch(
    root: &Path,
    rel: &str,
    expected_version: &str,
    base: &str,
    ops: &[Value],
) -> Result<Versioned<Sketch>, CmdError> {
    let saved = document_writer::save(root, rel, expected_version, base, ops)?;
    Ok(saved.sketch()?)
}

/// The fields `update_sketch` sets, in the legacy order. Every update marks
/// the sketch edited, even one that changes nothing.
fn update_sketch_ops(
    description: Option<Value>,
    rows: Option<Vec<PlanningRow>>,
    metadata: Option<DocumentMetadata>,
) -> Vec<Value> {
    let mut ops = Vec::new();
    if let Some(description) = description {
        ops.push(json!({ "kind": "set_description", "description": description }));
    }
    if let Some(rows) = rows {
        ops.push(json!({ "kind": "replace_rows", "rows": rows }));
    }
    if let Some(metadata) = metadata {
        ops.push(json!({ "kind": "set_metadata", "metadata": metadata }));
    }
    if ops.is_empty() {
        ops.push(json!({ "kind": "touch" }));
    }
    ops
}

#[tauri::command]
pub async fn update_sketch_title(
    relative_path: String,
    expected_version: String,
    base: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<Versioned<Sketch>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let op = json!({ "kind": "set_title", "title": title });
    save_sketch(&root, &relative_path, &expected_version, &base, &[op])
}

#[tauri::command]
pub async fn delete_sketch(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
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
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    // Use migration-aware read: inline visuals → external files
    project::read_sketch_with_migration(&abs_path, &root).map_err(|e| e.to_string())
}

/// [`get_sketch`] with the text and version an editor saves against.
#[auditaur_command(skip_all, err)]
pub async fn get_sketch_versioned(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<Versioned<Sketch>, CmdError> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path)?;
    Ok(document_reads::read_sketch_versioned(&abs_path, &root)?)
}

/// Write a conflict copy of a document: `content` at a new path. Refuses with
/// `file_exists` when the path is taken.
#[tauri::command]
pub async fn create_document_copy(
    relative_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<Versioned<String>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    create_document_copy_at(&root, &relative_path, &content)
}

fn create_document_copy_at(
    root: &Path,
    rel: &str,
    content: &str,
) -> Result<Versioned<String>, CmdError> {
    document_writer::create_from_text(root, rel, content).map_err(|err| match err {
        WriteError::Edit(ContentEditError::Stale(_)) => CmdError::file_exists(rel),
        other => other.into(),
    })
}

#[tauri::command]
pub async fn set_sketch_lock(
    relative_path: String,
    expected_version: String,
    base: String,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<Versioned<Sketch>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let op = json!({ "kind": "set_lock", "locked": locked });
    save_sketch(&root, &relative_path, &expected_version, &base, &[op])
}

#[tauri::command]
pub async fn set_planning_row_lock(
    relative_path: String,
    expected_version: String,
    base: String,
    index: usize,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<Versioned<Sketch>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let row_id = row_id_at(&base, index)?;
    let op = json!({ "kind": "set_lock", "row_id": row_id, "locked": locked });
    save_sketch(&root, &relative_path, &expected_version, &base, &[op])
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn set_planning_cell_lock(
    relative_path: String,
    expected_version: String,
    base: String,
    index: usize,
    field: String,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<Versioned<Sketch>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let row_id = row_id_at(&base, index)?;
    if !PlanningCellLocks::default().set(&field, locked) {
        return Err(format!("Unknown planning cell field: {field}").into());
    }
    let op = json!({ "kind": "set_lock", "row_id": row_id, "field": field, "locked": locked });
    save_sketch(&root, &relative_path, &expected_version, &base, &[op])
}

/// The stable id of the row at a legacy row index in `base`, the sketch the
/// editor shows.
fn row_id_at(base: &str, index: usize) -> Result<String, String> {
    let sketch = cutready_core::document::sketch_from_json(base)
        .map_err(|e| project::ProjectError::from(e).to_string())?;
    sketch
        .rows
        .get(index)
        .map(|row| row.id.clone())
        .ok_or_else(|| format!("Row {} does not exist", index + 1))
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
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
    let document = normalize_visual_document_for_save(&document)?;
    let json = serde_json::to_string_pretty(&document)
        .map_err(|e| format!("Failed to serialize visual: {e}"))?;
    // asset write: visual JSON, not a document
    std::fs::write(&abs, json).map_err(|e| format!("Failed to write visual: {e}"))
}

#[tauri::command]
pub async fn rename_sketch(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
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

    fn read(root: &Path) -> Sketch {
        project::read_sketch(&root.join("intro.sk")).unwrap()
    }

    fn edit(root: &Path, ops: &[Value]) -> Result<Sketch, WriteError> {
        document_writer::edit_sketch(root, "intro.sk", Expected::Unchecked, ops)
    }

    #[test]
    fn creating_over_an_existing_sketch_reports_it_exists() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        create_sketch_at(root, "intro.sk", "Intro".into()).unwrap();
        let before = std::fs::read(root.join("intro.sk")).unwrap();

        assert_eq!(
            create_sketch_at(root, "intro.sk", "Again".into()).unwrap_err(),
            "File already exists: intro.sk"
        );
        assert_eq!(std::fs::read(root.join("intro.sk")).unwrap(), before);
    }

    #[test]
    fn an_empty_update_still_marks_the_sketch_edited() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let created = create_sketch_at(root, "intro.sk", "Intro".into()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));

        let updated = edit(root, &update_sketch_ops(None, None, None)).unwrap();

        assert!(updated.updated_at > created.updated_at);
        assert_eq!(updated.title, "Intro");
    }

    #[test]
    fn update_replaces_rows_and_description() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        create_sketch_at(root, "intro.sk", "Intro".into()).unwrap();
        let mut row = PlanningRow::new();
        row.narrative = "Hello".into();

        edit(
            root,
            &update_sketch_ops(Some(json!("About")), Some(vec![row]), None),
        )
        .unwrap();

        let sketch = read(root);
        assert_eq!(sketch.description, json!("About"));
        assert_eq!(sketch.rows.len(), 1);
        assert_eq!(sketch.rows[0].narrative, "Hello");
    }

    #[test]
    fn row_and_cell_locks_address_rows_by_index() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        create_sketch_at(root, "intro.sk", "Intro".into()).unwrap();
        edit(
            root,
            &update_sketch_ops(
                None,
                Some(vec![PlanningRow::new(), PlanningRow::new()]),
                None,
            ),
        )
        .unwrap();
        let base = std::fs::read_to_string(root.join("intro.sk")).unwrap();

        let second = row_id_at(&base, 1).unwrap();
        let op =
            json!({ "kind": "set_lock", "row_id": second, "field": "narrative", "locked": true });
        edit(root, &[op]).unwrap();
        let sketch = read(root);
        assert!(!sketch.rows[0].locks.any());
        assert!(sketch.rows[1].locks.narrative);

        assert_eq!(row_id_at(&base, 2).unwrap_err(), "Row 3 does not exist");
    }

    #[test]
    fn locking_the_sketch_locks_every_row() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        create_sketch_at(root, "intro.sk", "Intro".into()).unwrap();
        edit(
            root,
            &update_sketch_ops(None, Some(vec![PlanningRow::new()]), None),
        )
        .unwrap();

        let locked = edit(root, &[json!({ "kind": "set_lock", "locked": true })]).unwrap();

        assert!(locked.locked);
        assert!(locked.rows[0].locked);
        assert!(read(root).locked);
    }

    #[test]
    fn delete_removes_the_sketch() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        create_sketch_at(root, "intro.sk", "Intro".into()).unwrap();

        project::delete_sketch(&root.join("intro.sk"), root).unwrap();

        assert!(!root.join("intro.sk").exists());
    }
}
