//! Tauri commands for project operations (folder-based).

use std::path::PathBuf;

use chrono::Utc;
use tauri::State;
use tauri_plugin_store::StoreExt;

use crate::engine::project;
use crate::models::script::{ProjectView, RecentProject};
use crate::AppState;

const STORE_FILE: &str = "recent-projects.json";

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

/// Initialize a new project in the given folder.
#[tauri::command]
pub async fn create_project_folder(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectView, String> {
    let root = PathBuf::from(&path);
    let view = project::init_project_folder(&root).map_err(|e| e.to_string())?;

    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view.clone());

    // Auto-add to recent projects
    let _ = add_to_recent_projects(&app, &path);

    Ok(view)
}

/// Open an existing project folder.
#[tauri::command]
pub async fn open_project_folder(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectView, String> {
    let root = PathBuf::from(&path);
    let view = project::open_project_folder(&root).map_err(|e| e.to_string())?;

    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view.clone());

    // Auto-add to recent projects
    let _ = add_to_recent_projects(&app, &path);

    Ok(view)
}

/// Get the currently open project (if any).
#[tauri::command]
pub async fn get_current_project(
    state: State<'_, AppState>,
) -> Result<Option<ProjectView>, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    Ok(current.clone())
}

/// Close the current project.
#[tauri::command]
pub async fn close_project(state: State<'_, AppState>) -> Result<(), String> {
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = None;
    Ok(())
}

/// Get recent projects from the store.
#[tauri::command]
pub async fn get_recent_projects(
    app: tauri::AppHandle,
) -> Result<Vec<RecentProject>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    let recent: Vec<RecentProject> = store
        .get("recent_projects")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    Ok(recent)
}

/// Add a project to the recent projects list.
#[tauri::command]
pub async fn add_recent_project(
    path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    add_to_recent_projects(&app, &path).map_err(|e| e.to_string())
}

/// Remove a project from the recent projects list.
#[tauri::command]
pub async fn remove_recent_project(
    path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    let mut recent: Vec<RecentProject> = store
        .get("recent_projects")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    recent.retain(|r| r.path != path);

    store.set(
        "recent_projects",
        serde_json::to_value(&recent).unwrap_or_default(),
    );

    Ok(())
}

/// Get the last parent folder used (for file dialogs).
#[tauri::command]
pub async fn get_last_parent_folder(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    let folder: Option<String> = store
        .get("last_parent_folder")
        .and_then(|v| v.as_str().map(|s| s.to_string()));

    Ok(folder)
}

/// Internal helper: add a project path to the recent list and update last parent folder.
fn add_to_recent_projects(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    let mut recent: Vec<RecentProject> = store
        .get("recent_projects")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    // Remove existing entry for same path
    recent.retain(|r| r.path != path);

    // Add at front
    recent.insert(
        0,
        RecentProject {
            path: path.to_string(),
            last_opened: Utc::now(),
        },
    );

    // Keep at most 20 recent projects
    recent.truncate(20);

    store.set(
        "recent_projects",
        serde_json::to_value(&recent).unwrap_or_default(),
    );

    // Also store the parent folder for "remember last folder"
    if let Some(parent) = PathBuf::from(path).parent() {
        store.set(
            "last_parent_folder",
            serde_json::Value::String(parent.to_string_lossy().into_owned()),
        );
    }

    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Sidebar order commands ─────────────────────────────────────────

/// Get the sidebar ordering manifest for the current project.
#[tauri::command]
pub async fn get_sidebar_order(
    state: State<'_, AppState>,
) -> Result<project::SidebarOrder, String> {
    let root = project_root(&state)?;
    Ok(project::read_sidebar_order(&root))
}

/// Save the sidebar ordering manifest for the current project.
#[tauri::command]
pub async fn set_sidebar_order(
    order: project::SidebarOrder,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    project::write_sidebar_order(&root, &order).map_err(|e| e.to_string())
}
