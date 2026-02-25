//! Tauri commands for storyboard CRUD and sketch management.

use chrono::Utc;
use tauri::State;
use uuid::Uuid;

use crate::engine::project;
use crate::models::sketch::{Storyboard, StoryboardItem, StoryboardSummary};
use crate::AppState;

#[tauri::command]
pub async fn create_storyboard(
    title: String,
    state: State<'_, AppState>,
) -> Result<Storyboard, String> {
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let storyboard = Storyboard::new(title);
    project.storyboards.push(storyboard.clone());
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(storyboard)
}

#[tauri::command]
pub async fn get_storyboard(id: String, state: State<'_, AppState>) -> Result<Storyboard, String> {
    let sb_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_ref().ok_or("No project is currently open")?;

    project
        .storyboards
        .iter()
        .find(|sb| sb.id == sb_id)
        .cloned()
        .ok_or_else(|| "Storyboard not found".into())
}

#[tauri::command]
pub async fn update_storyboard(
    id: String,
    title: Option<String>,
    description: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sb_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let sb = project
        .storyboards
        .iter_mut()
        .find(|sb| sb.id == sb_id)
        .ok_or("Storyboard not found")?;

    if let Some(t) = title {
        sb.title = t;
    }
    if let Some(d) = description {
        sb.description = d;
    }
    sb.updated_at = Utc::now();
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn delete_storyboard(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let sb_id: Uuid = id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let idx = project
        .storyboards
        .iter()
        .position(|sb| sb.id == sb_id)
        .ok_or("Storyboard not found")?;

    project.storyboards.remove(idx);
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn list_storyboards(
    state: State<'_, AppState>,
) -> Result<Vec<StoryboardSummary>, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_ref().ok_or("No project is currently open")?;

    Ok(project
        .storyboards
        .iter()
        .map(StoryboardSummary::from)
        .collect())
}

#[tauri::command]
pub async fn add_sketch_to_storyboard(
    storyboard_id: String,
    sketch_id: String,
    position: Option<usize>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sb_id: Uuid = storyboard_id
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    let sk_id: Uuid = sketch_id.parse().map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    // Verify sketch exists as individual file
    let project_dir =
        project::project_dir_path(&state.projects_dir, &project.id.to_string());
    if !project::sketch_exists(&sk_id.to_string(), &project_dir) {
        return Err("Sketch not found".into());
    }

    let sb = project
        .storyboards
        .iter_mut()
        .find(|sb| sb.id == sb_id)
        .ok_or("Storyboard not found")?;

    let item = StoryboardItem::SketchRef { sketch_id: sk_id };
    match position {
        Some(pos) if pos < sb.items.len() => sb.items.insert(pos, item),
        _ => sb.items.push(item),
    }

    sb.updated_at = Utc::now();
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn remove_sketch_from_storyboard(
    storyboard_id: String,
    position: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sb_id: Uuid = storyboard_id
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let sb = project
        .storyboards
        .iter_mut()
        .find(|sb| sb.id == sb_id)
        .ok_or("Storyboard not found")?;

    if position >= sb.items.len() {
        return Err("Position out of range".into());
    }

    sb.items.remove(position);
    sb.updated_at = Utc::now();
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn add_section_to_storyboard(
    storyboard_id: String,
    title: String,
    position: Option<usize>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let sb_id: Uuid = storyboard_id
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let sb = project
        .storyboards
        .iter_mut()
        .find(|sb| sb.id == sb_id)
        .ok_or("Storyboard not found")?;

    let section_id = Uuid::new_v4();
    let item = StoryboardItem::Section {
        id: section_id,
        title,
        sketch_ids: Vec::new(),
    };

    match position {
        Some(pos) if pos < sb.items.len() => sb.items.insert(pos, item),
        _ => sb.items.push(item),
    }

    sb.updated_at = Utc::now();
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(section_id.to_string())
}

#[tauri::command]
pub async fn reorder_storyboard_items(
    storyboard_id: String,
    items: Vec<StoryboardItem>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sb_id: Uuid = storyboard_id
        .parse()
        .map_err(|e: uuid::Error| e.to_string())?;
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    let project = current.as_mut().ok_or("No project is currently open")?;

    let sb = project
        .storyboards
        .iter_mut()
        .find(|sb| sb.id == sb_id)
        .ok_or("Storyboard not found")?;

    sb.items = items;
    sb.updated_at = Utc::now();
    project.updated_at = Utc::now();

    let projects_dir = state.projects_dir.clone();
    project::save_project(project, &projects_dir).map_err(|e| e.to_string())?;

    Ok(())
}
