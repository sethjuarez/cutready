//! Tauri commands for storyboard CRUD and sketch management.
//!
//! Storyboards are `.sb` files, identified by relative path from project root.

use chrono::Utc;
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

    let item = StoryboardItem::SketchRef {
        path: sketch_path,
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
pub async fn remove_sketch_from_storyboard(
    storyboard_path: String,
    position: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let sb_abs = project::safe_resolve(&root, &storyboard_path).map_err(|e| e.to_string())?;

    let mut sb = project::read_storyboard(&sb_abs).map_err(|e| e.to_string())?;

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
    sb.items = items;
    sb.updated_at = Utc::now();

    project::write_storyboard(&sb, &sb_abs, &root).map_err(|e| e.to_string())?;
    Ok(())
}
