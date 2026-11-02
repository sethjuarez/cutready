//! Tauri commands for storyboard CRUD and sketch management.
//!
//! Storyboards are `.sb` files, identified by relative path from project root.

use serde_json::{json, Value};
use std::path::Path;
use tauri::State;
use tauri_plugin_auditaur::auditaur_command;

use super::CmdError;
use crate::engine::document_writer::{self, Expected, SaveError, Versioned, WriteError};
use crate::engine::{document_reads, project};
use crate::AppState;
use cutready_core::edit_ops::{ContentEditError, OpRejection};
use cutready_core::models::sketch::{
    DocumentMetadata, Storyboard, StoryboardItem, StoryboardSummary,
};

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

fn set_referenced_sketches_lock(
    root: &Path,
    storyboard: &Storyboard,
    locked: bool,
) -> Result<(), String> {
    for sketch_path in storyboard.sketch_paths() {
        let abs_path = match project::safe_resolve(root, &sketch_path) {
            Ok(path) => path,
            Err(err) => {
                log::warn!("Skipping invalid storyboard sketch reference {sketch_path}: {err}");
                continue;
            }
        };
        if !abs_path.exists() {
            log::warn!("Skipping missing storyboard sketch reference {sketch_path}");
            continue;
        }

        let op = json!({ "kind": "set_lock", "locked": locked });
        let expected = document_writer::expected_on_disk(&abs_path)?;
        document_writer::edit(root, &sketch_path, expected, &[op])?;
    }
    Ok(())
}

/// An app save of storyboard ops made against `base`; see
/// `document_writer::save`.
fn save_storyboard(
    root: &Path,
    rel: &str,
    expected_version: &str,
    base: &str,
    ops: &[Value],
) -> Result<Versioned<Storyboard>, SaveError> {
    Ok(document_writer::save(root, rel, expected_version, base, ops)?.storyboard()?)
}

#[tauri::command]
pub async fn create_storyboard(
    relative_path: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<Storyboard, String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    if abs_path.exists() {
        return Err(format!("File already exists: {relative_path}"));
    }

    let storyboard = Storyboard::new(title, chrono::Utc::now());
    let op = json!({ "kind": "replace_storyboard", "storyboard": storyboard });
    document_writer::edit_storyboard(&root, &relative_path, Expected::Absent, &[op]).map_err(
        |err| match err {
            WriteError::Edit(ContentEditError::Stale(_)) => {
                format!("File already exists: {relative_path}")
            }
            other => other.to_string(),
        },
    )
}

#[tauri::command]
pub async fn get_storyboard(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<Storyboard, String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    project::read_storyboard(&abs_path).map_err(|e| e.to_string())
}

/// [`get_storyboard`] with the text and version an editor saves against.
#[tauri::command]
pub async fn get_storyboard_versioned(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<Versioned<Storyboard>, CmdError> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path)?;
    Ok(document_reads::read_storyboard_versioned(&abs_path, &root)?)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_storyboard(
    relative_path: String,
    expected_version: String,
    base: String,
    title: Option<String>,
    description: Option<String>,
    metadata: Option<DocumentMetadata>,
    state: State<'_, AppState>,
) -> Result<Versioned<Storyboard>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let ops = update_storyboard_ops(title, description, metadata);
    Ok(save_storyboard(
        &root,
        &relative_path,
        &expected_version,
        &base,
        &ops,
    )?)
}

/// The fields `update_storyboard` sets. Every update marks the storyboard
/// edited and, like any storyboard edit, needs it unlocked.
fn update_storyboard_ops(
    title: Option<String>,
    description: Option<String>,
    metadata: Option<DocumentMetadata>,
) -> Vec<Value> {
    let mut ops = vec![json!({ "kind": "touch" })];
    if let Some(title) = title {
        ops.push(json!({ "kind": "set_title", "title": title }));
    }
    if let Some(description) = description {
        ops.push(json!({ "kind": "set_description", "description": description }));
    }
    if let Some(metadata) = metadata {
        ops.push(json!({ "kind": "set_metadata", "metadata": metadata }));
    }
    ops
}

#[tauri::command]
pub async fn set_storyboard_lock(
    relative_path: String,
    expected_version: String,
    base: String,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<Versioned<Storyboard>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs_path = project::safe_resolve(&root, &relative_path)?;

    // Sketches first, then the storyboard, as before: one file per write
    // until multi-file edits land.
    let sb = project::read_storyboard(&abs_path)?;
    set_referenced_sketches_lock(&root, &sb, locked)?;
    let op = json!({ "kind": "set_lock", "locked": locked });
    Ok(save_storyboard(
        &root,
        &relative_path,
        &expected_version,
        &base,
        &[op],
    )?)
}

#[tauri::command]
pub async fn delete_storyboard(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    project::delete_storyboard(&abs_path, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn rename_storyboard(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    project::rename_project_asset(&root, &old_path, &new_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[auditaur_command(skip_all, err)]
pub async fn list_storyboards(
    state: State<'_, AppState>,
) -> Result<Vec<StoryboardSummary>, String> {
    let root = project_root(&state)?;
    project::scan_storyboards(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_sketch_to_storyboard(
    storyboard_path: String,
    expected_version: String,
    base: String,
    sketch_path: String,
    position: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Versioned<Storyboard>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    project::safe_resolve(&root, &storyboard_path)?;
    // Validate sketch_path too (even though it's stored as a reference)
    project::safe_resolve(&root, &sketch_path)?;

    // Gracefully check if sketch exists (warn but don't block)
    if !project::sketch_file_exists(&sketch_path, &root) {
        log::warn!("Sketch file not found: {}", sketch_path);
    }

    let item = StoryboardItem::SketchRef { path: sketch_path };
    let op = insert_item_op(position, &item);
    Ok(save_storyboard(
        &root,
        &storyboard_path,
        &expected_version,
        &base,
        &[op],
    )?)
}

#[tauri::command]
pub async fn remove_sketch_from_storyboard(
    storyboard_path: String,
    expected_version: String,
    base: String,
    position: usize,
    state: State<'_, AppState>,
) -> Result<Versioned<Storyboard>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    remove_item_at(&root, &storyboard_path, &expected_version, &base, position)
}

/// Any rejection other than the lock means the position was out of range.
fn remove_item_at(
    root: &Path,
    rel: &str,
    expected_version: &str,
    base: &str,
    position: usize,
) -> Result<Versioned<Storyboard>, CmdError> {
    let op = json!({ "kind": "remove_storyboard_item", "index": position });
    match save_storyboard(root, rel, expected_version, base, &[op]) {
        Err(SaveError::Write(WriteError::Edit(ContentEditError::Op(err))))
            if err.rejection != OpRejection::LockedStoryboard =>
        {
            Err("Position out of range".into())
        }
        other => Ok(other?),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn add_section_to_storyboard(
    storyboard_path: String,
    expected_version: String,
    base: String,
    title: String,
    description: Option<String>,
    position: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Versioned<Storyboard>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let item = StoryboardItem::Section {
        title,
        description: description.unwrap_or_default(),
        sketches: Vec::new(),
    };
    let op = insert_item_op(position, &item);
    Ok(save_storyboard(
        &root,
        &storyboard_path,
        &expected_version,
        &base,
        &[op],
    )?)
}

/// Insert at `position`, or append when it's missing or past the end.
fn insert_item_op(position: Option<usize>, item: &StoryboardItem) -> Value {
    json!({ "kind": "insert_storyboard_item", "index": position, "item": item })
}

#[tauri::command]
pub async fn reorder_storyboard_items(
    storyboard_path: String,
    expected_version: String,
    base: String,
    items: Vec<StoryboardItem>,
    state: State<'_, AppState>,
) -> Result<Versioned<Storyboard>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let op = json!({ "kind": "set_storyboard_items", "items": items });
    Ok(save_storyboard(
        &root,
        &storyboard_path,
        &expected_version,
        &base,
        &[op],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use cutready_core::models::sketch::{PlanningRow, Sketch};

    #[test]
    fn storyboard_lock_cascades_to_referenced_sketches() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let mut sketch = Sketch::new("Intro", chrono::Utc::now());
        sketch.rows.push(PlanningRow::new());
        project::write_sketch(&sketch, &root.join("intro.sk"), root).unwrap();

        let storyboard = Storyboard {
            title: "Demo".into(),
            description: String::new(),
            locked: false,
            metadata: DocumentMetadata::default(),
            items: vec![StoryboardItem::Section {
                title: "Section".into(),
                description: String::new(),
                sketches: vec!["intro.sk".into()],
            }],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            unknown_fields: Default::default(),
        };

        set_referenced_sketches_lock(root, &storyboard, true).unwrap();
        let locked = project::read_sketch(&root.join("intro.sk")).unwrap();
        assert!(locked.locked);
        assert!(locked.rows[0].locked);
        assert!(locked.rows[0].locks.any());

        set_referenced_sketches_lock(root, &storyboard, false).unwrap();
        let unlocked = project::read_sketch(&root.join("intro.sk")).unwrap();
        assert!(!unlocked.locked);
        assert!(!unlocked.rows[0].locked);
        assert!(!unlocked.rows[0].locks.any());
    }

    fn new_storyboard(root: &Path) -> Storyboard {
        let storyboard = Storyboard::new("Demo", Utc::now());
        let op = json!({ "kind": "replace_storyboard", "storyboard": storyboard });
        document_writer::edit_storyboard(root, "demo.sb", Expected::Absent, &[op]).unwrap()
    }

    /// An app save against the storyboard on disk now.
    fn edit_storyboard(root: &Path, rel: &str, ops: &[Value]) -> Result<Storyboard, SaveError> {
        let base = std::fs::read_to_string(root.join(rel)).unwrap();
        let version = cutready_core::edit_ops::document_version(base.as_bytes());
        save_storyboard(root, rel, &version, &base, ops).map(|saved| saved.document)
    }

    fn remove_at(root: &Path, position: usize) -> Result<(), String> {
        let base = std::fs::read_to_string(root.join("demo.sb")).unwrap();
        let version = cutready_core::edit_ops::document_version(base.as_bytes());
        remove_item_at(root, "demo.sb", &version, &base, position)
            .map(drop)
            .map_err(|err| err.message)
    }

    fn sketch_ref(path: &str) -> StoryboardItem {
        StoryboardItem::SketchRef { path: path.into() }
    }

    #[test]
    fn items_insert_at_a_position_or_append() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        new_storyboard(root);

        edit_storyboard(
            root,
            "demo.sb",
            &[insert_item_op(None, &sketch_ref("a.sk"))],
        )
        .unwrap();
        edit_storyboard(
            root,
            "demo.sb",
            &[insert_item_op(Some(0), &sketch_ref("b.sk"))],
        )
        .unwrap();
        let sb = edit_storyboard(
            root,
            "demo.sb",
            &[insert_item_op(Some(9), &sketch_ref("c.sk"))],
        )
        .unwrap();

        let paths: Vec<_> = sb
            .items
            .iter()
            .map(|item| match item {
                StoryboardItem::SketchRef { path } => path.as_str(),
                _ => "",
            })
            .collect();
        assert_eq!(paths, ["b.sk", "a.sk", "c.sk"]);
    }

    #[test]
    fn removing_past_the_end_reports_out_of_range() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        new_storyboard(root);
        edit_storyboard(
            root,
            "demo.sb",
            &[insert_item_op(None, &sketch_ref("a.sk"))],
        )
        .unwrap();

        assert_eq!(remove_at(root, 1).unwrap_err(), "Position out of range");
        remove_at(root, 0).unwrap();
        let sb = project::read_storyboard(&root.join("demo.sb")).unwrap();
        assert!(sb.items.is_empty());
    }

    #[test]
    fn a_locked_storyboard_rejects_edits_with_the_lock_message() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        new_storyboard(root);
        edit_storyboard(
            root,
            "demo.sb",
            &[insert_item_op(None, &sketch_ref("a.sk"))],
        )
        .unwrap();
        edit_storyboard(
            root,
            "demo.sb",
            &[json!({ "kind": "set_lock", "locked": true })],
        )
        .unwrap();
        let before = std::fs::read(root.join("demo.sb")).unwrap();

        let locked = project::ensure_storyboard_unlocked(
            &project::read_storyboard(&root.join("demo.sb")).unwrap(),
        )
        .unwrap_err()
        .to_string();
        assert_eq!(remove_at(root, 0).unwrap_err(), locked);
        let update = update_storyboard_ops(Some("New".into()), None, None);
        assert_eq!(
            edit_storyboard(root, "demo.sb", &update)
                .unwrap_err()
                .to_string(),
            locked
        );
        assert_eq!(std::fs::read(root.join("demo.sb")).unwrap(), before);
    }

    #[test]
    fn update_sets_only_the_given_fields_and_marks_the_storyboard_edited() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let created = new_storyboard(root);

        let sb = edit_storyboard(
            root,
            "demo.sb",
            &update_storyboard_ops(None, Some("About".into()), None),
        )
        .unwrap();

        assert_eq!(sb.title, "Demo");
        assert_eq!(sb.description, "About");
        assert!(sb.updated_at >= created.updated_at);
    }

    #[test]
    fn creating_over_an_existing_storyboard_fails() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        new_storyboard(root);
        let storyboard = Storyboard::new("Again", Utc::now());
        let op = json!({ "kind": "replace_storyboard", "storyboard": storyboard });

        let err =
            document_writer::edit_storyboard(root, "demo.sb", Expected::Absent, &[op]).unwrap_err();

        assert!(matches!(err, WriteError::Edit(ContentEditError::Stale(_))));
    }
}
