//! Tauri commands for project operations (folder-based).

use std::path::PathBuf;

use chrono::Utc;
use tauri::State;
use tauri_plugin_store::StoreExt;

use crate::engine::project;
use crate::models::script::{ProjectEntry, ProjectView, RecentProject, RepoView};
use crate::AppState;

const STORE_FILE: &str = "recent-projects.json";

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

/// Helper: get both project root and repo root from current state.
fn project_and_repo_root(state: &AppState) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok((view.root.clone(), view.repo_root.clone()))
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

    // Set repo view (new project = repo root is project root)
    {
        let mut repo_lock = state.current_repo.lock().map_err(|e| e.to_string())?;
        *repo_lock = Some(RepoView::new(root.clone()));
    }
    {
        let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
        *current = Some(view.clone());
    }

    // Auto-add to recent projects
    let _ = add_to_recent_projects(&app, &path, None);

    Ok(view)
}

/// Open an existing project folder.
/// In multi-project repos, restores the last-used project (or falls back to the first).
/// In single-project repos, behaves exactly as before (repo root = project root).
#[tauri::command]
pub async fn open_project_folder(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectView, String> {
    let root = PathBuf::from(&path);

    // Always set repo view
    let (repo, projects) = project::open_repo(&root).map_err(|e| e.to_string())?;
    {
        let mut repo_lock = state.current_repo.lock().map_err(|e| e.to_string())?;
        *repo_lock = Some(repo);
    }

    // Activate the last-used project, falling back to the first project
    let last_active = get_last_active_for_repo(&app, &path);
    let entry = last_active
        .as_ref()
        .and_then(|lp| projects.iter().find(|p| p.path == *lp))
        .or(projects.first())
        .ok_or("No projects found")?;
    let view = if entry.path == "." {
        // Single-project mode: root IS the project
        ProjectView::new(root.clone())
    } else {
        ProjectView::in_repo(root.clone(), &entry.path, entry.name.clone())
    };

    {
        let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
        *current = Some(view.clone());
    }

    // Auto-add to recent projects, preserving the active project
    let active_project = if entry.path != "." {
        Some(entry.path.clone())
    } else {
        None
    };
    let _ = add_to_recent_projects(&app, &path, active_project);

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

/// Close the current project and repo.
#[tauri::command]
pub async fn close_project(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
        *current = None;
    }
    {
        let mut repo = state.current_repo.lock().map_err(|e| e.to_string())?;
        *repo = None;
    }
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
    add_to_recent_projects(&app, &path, None).map_err(|e| e.to_string())
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
fn add_to_recent_projects(
    app: &tauri::AppHandle,
    path: &str,
    last_active_project: Option<String>,
) -> Result<(), String> {
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
            last_active_project,
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

/// Look up the last active project path for a given repo from the recent projects store.
fn get_last_active_for_repo(app: &tauri::AppHandle, repo_path: &str) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    let recent: Vec<RecentProject> = store
        .get("recent_projects")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    recent
        .iter()
        .find(|r| r.path == repo_path)
        .and_then(|r| r.last_active_project.clone())
}

/// Update just the `last_active_project` field for a repo in the recent projects store.
fn update_last_active_project(
    app: &tauri::AppHandle,
    repo_path: &str,
    project_path: Option<String>,
) -> Result<(), String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let mut recent: Vec<RecentProject> = store
        .get("recent_projects")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    if let Some(entry) = recent.iter_mut().find(|r| r.path == repo_path) {
        entry.last_active_project = project_path;
    }

    store.set(
        "recent_projects",
        serde_json::to_value(&recent).unwrap_or_default(),
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}
// ── Sidebar order commands ─────────────────────────────────────────

/// Get the sidebar ordering manifest for the current project.
#[tauri::command]
pub async fn get_sidebar_order(
    state: State<'_, AppState>,
) -> Result<project::SidebarOrder, String> {
    let (proj_root, rp_root) = project_and_repo_root(&state)?;
    Ok(project::read_sidebar_order(&rp_root, &proj_root))
}

/// Save the sidebar ordering manifest for the current project.
#[tauri::command]
pub async fn set_sidebar_order(
    order: project::SidebarOrder,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (proj_root, rp_root) = project_and_repo_root(&state)?;
    project::write_sidebar_order(&rp_root, &proj_root, &order).map_err(|e| e.to_string())
}

/// Get workspace state (open tabs, active tab, chat session) for the current project.
#[tauri::command]
pub async fn get_workspace_state(
    state: State<'_, AppState>,
) -> Result<project::WorkspaceState, String> {
    let (proj_root, rp_root) = project_and_repo_root(&state)?;
    Ok(project::read_workspace_state(&rp_root, &proj_root))
}

/// Save workspace state for the current project.
#[tauri::command]
pub async fn set_workspace_state(
    workspace: project::WorkspaceState,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (proj_root, rp_root) = project_and_repo_root(&state)?;
    project::write_workspace_state(&rp_root, &proj_root, &workspace).map_err(|e| e.to_string())
}

/// List all files and directories in the project folder.
#[tauri::command]
pub async fn list_all_files(
    state: State<'_, AppState>,
) -> Result<Vec<project::FileEntry>, String> {
    let root = project_root(&state)?;
    project::scan_all_files(&root).map_err(|e| e.to_string())
}

// ── Multi-project commands ────────────────────────────────────────

/// Helper: get the repo root from current state.
fn repo_root(state: &AppState) -> Result<PathBuf, String> {
    let repo = state.current_repo.lock().map_err(|e| e.to_string())?;
    let view = repo.as_ref().ok_or("No repo is currently open")?;
    Ok(view.root.clone())
}

/// List all projects in the current repo.
#[tauri::command]
pub async fn list_projects(
    state: State<'_, AppState>,
) -> Result<Vec<ProjectEntry>, String> {
    let root = repo_root(&state)?;
    Ok(project::list_projects(&root))
}

/// Whether the current repo has multiple projects.
#[tauri::command]
pub async fn is_multi_project(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let root = repo_root(&state)?;
    Ok(project::is_multi_project(&root))
}

/// Switch to a different project within the current repo.
#[tauri::command]
pub async fn switch_project(
    project_path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ProjectView, String> {
    let root = repo_root(&state)?;

    // Validate the project exists in the manifest
    let projects = project::list_projects(&root);
    let entry = projects
        .iter()
        .find(|p| p.path == project_path)
        .ok_or_else(|| format!("Project '{}' not found in repo", project_path))?;

    let view = if entry.path == "." {
        ProjectView::new(root.clone())
    } else {
        ProjectView::in_repo(root.clone(), &entry.path, entry.name.clone())
    };

    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view.clone());

    // Persist the active project so it's restored on next open
    let repo_path = root.to_string_lossy().to_string();
    let active = if project_path != "." {
        Some(project_path)
    } else {
        None
    };
    let _ = update_last_active_project(&app, &repo_path, active);

    Ok(view)
}

/// Create a new project within the current repo.
#[tauri::command]
pub async fn create_project_in_repo(
    name: String,
    description: Option<String>,
    state: State<'_, AppState>,
) -> Result<ProjectEntry, String> {
    let root = repo_root(&state)?;
    project::create_project_in_repo(&root, &name, description.as_deref())
        .map_err(|e| e.to_string())
}

/// Delete a project from the current repo manifest.
/// If `delete_files` is true, also removes the project directory.
#[tauri::command]
pub async fn delete_project(
    project_path: String,
    delete_files: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = repo_root(&state)?;

    // Remove from manifest
    if let Some(mut manifest) = project::read_manifest(&root) {
        manifest.projects.retain(|p| p.path != project_path);
        project::write_manifest(&root, &manifest).map_err(|e| e.to_string())?;
    }

    // Optionally delete the files
    if delete_files && project_path != "." {
        let dir = root.join(&project_path);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
    }

    // If deleted project was active, clear it
    {
        let current = state.current_project.lock().map_err(|e| e.to_string())?;
        if let Some(ref view) = *current {
            let active_path = view
                .root
                .strip_prefix(&root)
                .unwrap_or(&view.root)
                .to_string_lossy();
            if active_path == project_path {
                drop(current);
                let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
                *current = None;
            }
        }
    }

    Ok(())
}

/// Rename a project. In single-project mode (path == "."), this migrates the
/// workspace to multi-project by moving files into a named subdirectory.
#[tauri::command]
pub async fn rename_project(
    project_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = repo_root(&state)?;

    // Single-project mode: renaming the sole project triggers migration
    if project_path == "." && !project::is_multi_project(&root) {
        let entry = project::migrate_to_multi_project(&root, &new_name)
            .map_err(|e| e.to_string())?;

        // Update current project to point at the new subdirectory
        let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
        *current = Some(ProjectView::in_repo(root, &entry.path, entry.name.clone()));

        return Ok(entry.path);
    }

    // Derive new folder-safe path from the new name
    let new_path = new_name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-")
        .trim_matches('-')
        .to_string();

    if new_path.is_empty() {
        return Err("Invalid project name".into());
    }

    // Rename the folder on disk if the path changed
    if new_path != project_path {
        let old_dir = root.join(&project_path);
        let new_dir = root.join(&new_path);
        if new_dir.exists() {
            return Err(format!("Directory '{}' already exists", new_path));
        }
        if old_dir.exists() {
            std::fs::rename(&old_dir, &new_dir).map_err(|e| e.to_string())?;
        }
    }

    // Update manifest: both name and path
    if let Some(mut manifest) = project::read_manifest(&root) {
        if let Some(entry) = manifest.projects.iter_mut().find(|p| p.path == project_path) {
            entry.name = new_name.clone();
            entry.path = new_path.clone();
        }
        project::write_manifest(&root, &manifest).map_err(|e| e.to_string())?;
    }

    // Update current project view if this is the active project
    {
        let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut view) = *current {
            if view.root.ends_with(&project_path) {
                *view = ProjectView::in_repo(root, &new_path, new_name);
            }
        }
    }

    Ok(new_path)
}

/// Migrate a single-project repo to multi-project mode.
/// Moves existing files into a named subdirectory and creates the manifest.
#[tauri::command]
pub async fn migrate_to_multi_project(
    existing_name: String,
    state: State<'_, AppState>,
) -> Result<ProjectEntry, String> {
    let root = repo_root(&state)?;
    let entry = project::migrate_to_multi_project(&root, &existing_name)
        .map_err(|e| e.to_string())?;

    // Update current project to point at the new subdirectory
    let view = ProjectView::in_repo(root, &entry.path, entry.name.clone());
    {
        let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
        *current = Some(view);
    }

    Ok(entry)
}

// ── Workspace (per-repo) settings ─────────────────────────────────

/// Read workspace settings from the current repo's .cutready/settings.json.
#[tauri::command]
pub async fn get_workspace_settings(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let root = repo_root(&state)?;
    Ok(project::read_repo_settings(&root))
}

/// Write workspace settings to the current repo's .cutready/settings.json.
#[tauri::command]
pub async fn set_workspace_settings(
    settings: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = repo_root(&state)?;
    project::write_repo_settings(&root, &settings).map_err(|e| e.to_string())
}
