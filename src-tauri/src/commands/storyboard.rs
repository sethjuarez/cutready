//! Tauri commands for storyboard CRUD and sketch management.
//!
//! Storyboards are `.sb` files, identified by relative path from project root.

use chrono::Utc;
use std::collections::BTreeSet;
use std::path::Path;
use tauri::State;

use crate::engine::project;
use crate::models::sketch::{Storyboard, StoryboardItem, StoryboardSummary};
use crate::AppState;

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

fn storyboard_sketch_paths(storyboard: &Storyboard) -> BTreeSet<String> {
    storyboard
        .items
        .iter()
        .flat_map(|item| match item {
            StoryboardItem::SketchRef { path } => vec![path.clone()],
            StoryboardItem::Section { sketches, .. } => sketches.clone(),
        })
        .collect()
}

fn set_referenced_sketches_lock(
    root: &Path,
    storyboard: &Storyboard,
    locked: bool,
) -> Result<(), String> {
    for sketch_path in storyboard_sketch_paths(storyboard) {
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

        let mut sketch = project::read_sketch(&abs_path).map_err(|e| e.to_string())?;
        sketch.set_locked_recursive(locked);
        sketch.updated_at = Utc::now();
        project::write_sketch(&sketch, &abs_path, root).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn create_storyboard(
    relative_path: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<Storyboard, String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    if abs_path.exists() {
        return Err(format!("File already exists: {relative_path}"));
    }

    let storyboard = Storyboard::new(title);
    project::write_storyboard(&storyboard, &abs_path, &root).map_err(|e| e.to_string())?;

    Ok(storyboard)
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

#[tauri::command]
pub async fn update_storyboard(
    relative_path: String,
    title: Option<String>,
    description: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    let mut sb = project::read_storyboard(&abs_path).map_err(|e| e.to_string())?;
    project::ensure_storyboard_unlocked(&sb).map_err(|e| e.to_string())?;

    if let Some(t) = title {
        sb.title = t;
    }
    if let Some(d) = description {
        sb.description = d;
    }
    sb.updated_at = Utc::now();

    project::write_storyboard(&sb, &abs_path, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_storyboard_lock(
    relative_path: String,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<Storyboard, String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    let mut sb = project::read_storyboard(&abs_path).map_err(|e| e.to_string())?;
    sb.locked = locked;
    sb.updated_at = Utc::now();
    set_referenced_sketches_lock(&root, &sb, locked)?;
    project::write_storyboard(&sb, &abs_path, &root).map_err(|e| e.to_string())?;
    Ok(sb)
}

#[tauri::command]
pub async fn delete_storyboard(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
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
    let old_abs = project::safe_resolve(&root, &old_path).map_err(|e| e.to_string())?;
    let new_abs = project::safe_resolve(&root, &new_path).map_err(|e| e.to_string())?;
    let sb = project::read_storyboard(&old_abs).map_err(|e| e.to_string())?;
    project::ensure_storyboard_unlocked(&sb).map_err(|e| e.to_string())?;

    project::rename_file(&old_abs, &new_abs, &root, "storyboard").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_storyboards(
    state: State<'_, AppState>,
) -> Result<Vec<StoryboardSummary>, String> {
    let root = project_root(&state)?;
    project::scan_storyboards(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_sketch_to_storyboard(
    storyboard_path: String,
    sketch_path: String,
    position: Option<usize>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let sb_abs = project::safe_resolve(&root, &storyboard_path).map_err(|e| e.to_string())?;
    // Validate sketch_path too (even though it's stored as a reference)
    project::safe_resolve(&root, &sketch_path).map_err(|e| e.to_string())?;

    // Gracefully check if sketch exists (warn but don't block)
    if !project::sketch_file_exists(&sketch_path, &root) {
        log::warn!("Sketch file not found: {}", sketch_path);
    }

    let mut sb = project::read_storyboard(&sb_abs).map_err(|e| e.to_string())?;
    project::ensure_storyboard_unlocked(&sb).map_err(|e| e.to_string())?;

    let item = StoryboardItem::SketchRef { path: sketch_path };
    match position {
        Some(pos) if pos < sb.items.len() => sb.items.insert(pos, item),
        _ => sb.items.push(item),
    }

    sb.updated_at = Utc::now();
    project::write_storyboard(&sb, &sb_abs, &root).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn remove_sketch_from_storyboard(
    storyboard_path: String,
    position: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let sb_abs = project::safe_resolve(&root, &storyboard_path).map_err(|e| e.to_string())?;

    let mut sb = project::read_storyboard(&sb_abs).map_err(|e| e.to_string())?;
    project::ensure_storyboard_unlocked(&sb).map_err(|e| e.to_string())?;

    if position >= sb.items.len() {
        return Err("Position out of range".into());
    }

    sb.items.remove(position);
    sb.updated_at = Utc::now();

    project::write_storyboard(&sb, &sb_abs, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn add_section_to_storyboard(
    storyboard_path: String,
    title: String,
    position: Option<usize>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let sb_abs = project::safe_resolve(&root, &storyboard_path).map_err(|e| e.to_string())?;

    let mut sb = project::read_storyboard(&sb_abs).map_err(|e| e.to_string())?;
    project::ensure_storyboard_unlocked(&sb).map_err(|e| e.to_string())?;

    let item = StoryboardItem::Section {
        title,
        sketches: Vec::new(),
    };

    match position {
        Some(pos) if pos < sb.items.len() => sb.items.insert(pos, item),
        _ => sb.items.push(item),
    }

    sb.updated_at = Utc::now();
    project::write_storyboard(&sb, &sb_abs, &root).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn reorder_storyboard_items(
    storyboard_path: String,
    items: Vec<StoryboardItem>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let sb_abs = project::safe_resolve(&root, &storyboard_path).map_err(|e| e.to_string())?;

    let mut sb = project::read_storyboard(&sb_abs).map_err(|e| e.to_string())?;
    project::ensure_storyboard_unlocked(&sb).map_err(|e| e.to_string())?;
    sb.items = items;
    sb.updated_at = Utc::now();

    project::write_storyboard(&sb, &sb_abs, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::sketch::{PlanningRow, Sketch};

    #[test]
    fn storyboard_lock_cascades_to_referenced_sketches() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let mut sketch = Sketch::new("Intro");
        sketch.rows.push(PlanningRow::new());
        project::write_sketch(&sketch, &root.join("intro.sk"), root).unwrap();

        let storyboard = Storyboard {
            title: "Demo".into(),
            description: String::new(),
            locked: false,
            items: vec![StoryboardItem::Section {
                title: "Section".into(),
                sketches: vec!["intro.sk".into()],
            }],
            created_at: Utc::now(),
            updated_at: Utc::now(),
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
}
