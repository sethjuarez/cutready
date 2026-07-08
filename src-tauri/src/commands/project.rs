//! Tauri commands for project operations (folder-based).

use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use tauri::State;
use tauri_plugin_auditaur::auditaur_command;
use tauri_plugin_store::StoreExt;

use crate::engine::{
    agent_state::AgentStateStore, draftline_adapter::CutReadyDraftlineAdapter, project,
};
use crate::models::script::{ProjectEntry, ProjectView, RecentProject, RepoView};
use crate::AppState;

const STORE_FILE: &str = "recent-projects.json";
const STARTUP_PROJECT_ENV: &str = "CUTREADY_PROJECT";

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

/// Helper: get both project root and repo root from current state.
fn project_and_repo_root(
    state: &AppState,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok((view.root.clone(), view.repo_root.clone()))
}

/// Project folder requested on the command line.
///
/// Supports `--project <path>`, `--project=<path>`, `--open-project <path>`,
/// and `CUTREADY_PROJECT=<path>` for dev smoke tests and scripted launches.
#[auditaur_command(skip_all, err)]
pub async fn get_startup_project_path() -> Result<Option<String>, String> {
    Ok(
        startup_project_path_from_args(std::env::args_os()).or_else(|| {
            std::env::var(STARTUP_PROJECT_ENV)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        }),
    )
}

fn startup_project_path_from_args<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = std::ffi::OsString>,
{
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let value = arg.to_string_lossy();
        if value == "--project" || value == "--open-project" {
            return args
                .next()
                .map(|path| path.to_string_lossy().to_string())
                .filter(|path| !path.trim().is_empty());
        }
        if let Some(path) = value
            .strip_prefix("--project=")
            .or_else(|| value.strip_prefix("--open-project="))
        {
            let path = path.trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
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
    reconcile_abandoned_agent_runs(&state, &view);

    // Auto-add to recent projects
    let _ = add_to_recent_projects(&app, &path, None);

    Ok(view)
}

/// Open an existing project folder.
/// In multi-project repos, restores the last-used project (or falls back to the first).
/// In single-project repos, behaves exactly as before (repo root = project root).
#[auditaur_command(skip_all, err)]
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
    reconcile_abandoned_agent_runs(&state, &view);
    if let Err(err) = project::migrate_legacy_chat_sessions(&view.repo_root, &view.root) {
        log::warn!("[project] could not archive legacy chat sessions: {err}");
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
#[auditaur_command(skip_all, err)]
pub async fn get_recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    let recent: Vec<RecentProject> = store
        .get("recent_projects")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    Ok(recent)
}

/// Add a project to the recent projects list.
#[tauri::command]
pub async fn add_recent_project(path: String, app: tauri::AppHandle) -> Result<(), String> {
    add_to_recent_projects(&app, &path, None).map_err(|e| e.to_string())
}

/// Remove a project from the recent projects list.
#[tauri::command]
pub async fn remove_recent_project(path: String, app: tauri::AppHandle) -> Result<(), String> {
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
    store.save().map_err(|e| e.to_string())?;

    Ok(())
}

/// Get the last parent folder used (for file dialogs).
#[tauri::command]
pub async fn get_last_parent_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
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
#[auditaur_command(skip_all, err)]
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
#[auditaur_command(skip_all, err)]
pub async fn get_workspace_state(
    state: State<'_, AppState>,
) -> Result<project::WorkspaceState, String> {
    let (proj_root, rp_root) = project_and_repo_root(&state)?;
    Ok(project::read_workspace_state(&rp_root, &proj_root))
}

/// Save workspace state for the current project.
#[auditaur_command(skip_all, err)]
pub async fn set_workspace_state(
    workspace: project::WorkspaceState,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (proj_root, rp_root) = project_and_repo_root(&state)?;
    project::write_workspace_state(&rp_root, &proj_root, &workspace).map_err(|e| e.to_string())
}

/// List all files and directories in the project folder.
#[tauri::command]
pub async fn list_all_files(state: State<'_, AppState>) -> Result<Vec<project::FileEntry>, String> {
    let root = project_root(&state)?;
    project::scan_all_files(&root).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabasePreview {
    pub path: String,
    pub size: u64,
    pub tables: Vec<DatabaseTablePreview>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseTablePreview {
    pub name: String,
    pub table_type: String,
    pub row_count: u64,
    pub columns: Vec<DatabaseColumnPreview>,
    pub rows: Vec<Vec<DatabaseCellPreview>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseColumnPreview {
    pub name: String,
    pub data_type: String,
    pub not_null: bool,
    pub primary_key: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseCellPreview {
    pub kind: String,
    pub value: Option<String>,
}

/// Return a read-only preview of a project SQLite database.
#[tauri::command]
pub async fn get_database_preview(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<DatabasePreview, String> {
    let (project_root, repo_root) = project_and_repo_root(&state)?;
    let project_path =
        project::safe_resolve(&project_root, &relative_path).map_err(|e| e.to_string())?;
    let abs_path = if project_path.exists() {
        project_path
    } else {
        project::safe_resolve(&repo_root, &relative_path).map_err(|e| e.to_string())?
    };
    read_database_preview(abs_path, relative_path)
}

/// Return a read-only preview of the local agent-state database.
#[tauri::command]
pub async fn get_agent_state_database_preview(
    state: State<'_, AppState>,
) -> Result<DatabasePreview, String> {
    let (project_root, repo_root) = project_and_repo_root(&state)?;
    let abs_path = AgentStateStore::ensure_database_for_project(&repo_root, &project_root)?;
    read_database_preview(abs_path, "agent-state.db".to_string())
}

fn read_database_preview(
    abs_path: std::path::PathBuf,
    display_path: String,
) -> Result<DatabasePreview, String> {
    let metadata = std::fs::metadata(&abs_path).map_err(|e| e.to_string())?;

    let conn = Connection::open_with_flags(
        &abs_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Failed to open SQLite database: {e}"))?;

    let mut schema_stmt = conn
        .prepare(
            "SELECT name, type FROM sqlite_schema \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let schema_rows = schema_stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    let mut tables = Vec::new();
    for schema_row in schema_rows {
        let (name, table_type) = schema_row.map_err(|e| e.to_string())?;
        let quoted_name = quote_sqlite_identifier(&name);
        let columns = load_database_columns(&conn, &quoted_name)?;
        let row_count = conn
            .query_row(&format!("SELECT COUNT(*) FROM {quoted_name}"), [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|count| count.max(0) as u64)
            .map_err(|e| e.to_string())?;
        let rows = load_database_rows(&conn, &quoted_name)?;

        tables.push(DatabaseTablePreview {
            name,
            table_type,
            row_count,
            columns,
            rows,
        });
    }

    Ok(DatabasePreview {
        path: display_path,
        size: metadata.len(),
        tables,
    })
}

fn load_database_columns(
    conn: &Connection,
    quoted_name: &str,
) -> Result<Vec<DatabaseColumnPreview>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({quoted_name})"))
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| {
            Ok(DatabaseColumnPreview {
                name: row.get(1)?,
                data_type: row.get(2)?,
                not_null: row.get::<_, i64>(3)? != 0,
                primary_key: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for column in columns {
        result.push(column.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

fn load_database_rows(
    conn: &Connection,
    quoted_name: &str,
) -> Result<Vec<Vec<DatabaseCellPreview>>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {quoted_name} LIMIT 25"))
        .map_err(|e| e.to_string())?;
    let column_count = stmt.column_count();
    let rows = stmt
        .query_map([], |row| {
            let mut cells = Vec::with_capacity(column_count);
            for index in 0..column_count {
                cells.push(sqlite_value_to_preview(row.get_ref(index)?));
            }
            Ok(cells)
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

fn sqlite_value_to_preview(value: ValueRef<'_>) -> DatabaseCellPreview {
    match value {
        ValueRef::Null => DatabaseCellPreview {
            kind: "null".to_string(),
            value: None,
        },
        ValueRef::Integer(value) => DatabaseCellPreview {
            kind: "integer".to_string(),
            value: Some(value.to_string()),
        },
        ValueRef::Real(value) => DatabaseCellPreview {
            kind: "real".to_string(),
            value: Some(value.to_string()),
        },
        ValueRef::Text(value) => DatabaseCellPreview {
            kind: "text".to_string(),
            value: Some(String::from_utf8_lossy(value).into_owned()),
        },
        ValueRef::Blob(value) => DatabaseCellPreview {
            kind: "blob".to_string(),
            value: Some(format!("<blob: {} bytes>", value.len())),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::startup_project_path_from_args;

    #[test]
    fn startup_project_path_parses_space_separated_flag() {
        let path = startup_project_path_from_args([
            OsString::from("cutready.exe"),
            OsString::from("--project"),
            OsString::from("D:\\cutready\\start-2026"),
        ]);

        assert_eq!(path.as_deref(), Some("D:\\cutready\\start-2026"));
    }

    #[test]
    fn startup_project_path_parses_equals_flag() {
        let path = startup_project_path_from_args([
            OsString::from("cutready.exe"),
            OsString::from("--open-project=D:\\cutready\\build-2026"),
        ]);

        assert_eq!(path.as_deref(), Some("D:\\cutready\\build-2026"));
    }
}

fn quote_sqlite_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

// ── Multi-project commands ────────────────────────────────────────

/// Helper: get the repo root from current state.
fn repo_root(state: &AppState) -> Result<PathBuf, String> {
    let repo = state.current_repo.lock().map_err(|e| e.to_string())?;
    let view = repo.as_ref().ok_or("No repo is currently open")?;
    Ok(view.root.clone())
}

fn snapshot_workspace_structure(repo_root: &std::path::Path, message: &str) -> Result<(), String> {
    let adapter = CutReadyDraftlineAdapter::open_project(repo_root).map_err(|e| e.to_string())?;
    if !adapter
        .inspect_changes()
        .map_err(|e| e.to_string())?
        .is_empty()
    {
        adapter
            .save_version(message)
            .map(|_| ())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn safe_project_manifest_path(project_path: &str) -> Result<&Path, String> {
    if project_path == "." {
        return Ok(Path::new(project_path));
    }
    let path = Path::new(project_path);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("Invalid project path".into());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) | Component::CurDir
        )
    }) {
        return Err("Invalid project path".into());
    }
    Ok(path)
}

/// List all projects in the current repo.
#[auditaur_command(skip_all, err)]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectEntry>, String> {
    let root = repo_root(&state)?;
    Ok(project::list_projects(&root))
}

/// Whether the current repo has multiple projects.
#[auditaur_command(skip_all, err)]
pub async fn is_multi_project(state: State<'_, AppState>) -> Result<bool, String> {
    let root = repo_root(&state)?;
    Ok(project::is_multi_project(&root))
}

/// Switch to a different project within the current repo.
#[auditaur_command(skip_all, err)]
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
    drop(current);
    reconcile_abandoned_agent_runs(&state, &view);

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

fn reconcile_abandoned_agent_runs(state: &AppState, view: &ProjectView) {
    let active_run_ids = {
        let active_runs = match state.active_agent_runs.lock() {
            Ok(runs) => runs,
            Err(err) => {
                log::warn!("[project] could not inspect active agent runs: {err}");
                return;
            }
        };
        active_runs.iter().cloned().collect::<Vec<_>>()
    };
    match AgentStateStore::reconcile_abandoned_runs_for_project(
        &view.repo_root,
        &view.root,
        &active_run_ids,
    ) {
        Ok(count) if count > 0 => {
            log::info!(
                "[project] marked {count} abandoned agent run(s) interrupted for {}",
                view.root.display()
            );
        }
        Ok(_) => {}
        Err(err) => {
            log::warn!("[project] could not reconcile abandoned agent runs: {err}");
        }
    }
}

/// Create a new project within the current repo.
#[tauri::command]
pub async fn create_project_in_repo(
    name: String,
    description: Option<String>,
    state: State<'_, AppState>,
) -> Result<ProjectEntry, String> {
    let root = repo_root(&state)?;
    let entry = project::create_project_in_repo(&root, &name, description.as_deref())
        .map_err(|e| e.to_string())?;
    snapshot_workspace_structure(&root, &format!("Add {} to workspace", entry.name))?;
    Ok(entry)
}

/// Delete a project from the current repo manifest.
/// If `delete_files` is true, also removes the project directory.
#[auditaur_command(skip_all, err)]
pub async fn delete_project(
    project_path: String,
    delete_files: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = repo_root(&state)?;
    let safe_path = safe_project_manifest_path(&project_path)?;

    let mut manifest = project::read_manifest_result(&root).map_err(|e| e.to_string())?;
    let Some(existing_manifest) = manifest.as_ref() else {
        return Err(format!("Project '{}' not found in repo", project_path));
    };
    if !existing_manifest
        .projects
        .iter()
        .any(|p| p.path == project_path)
    {
        return Err(format!("Project '{}' not found in repo", project_path));
    }

    // Delete files before mutating the manifest so a filesystem failure does not
    // leave an orphaned project directory that is no longer listed.
    if delete_files && project_path != "." {
        let dir = root.join(safe_path);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
    }

    // Remove from manifest
    if let Some(mut manifest) = manifest.take() {
        manifest.projects.retain(|p| p.path != project_path);
        project::write_manifest(&root, &manifest).map_err(|e| e.to_string())?;
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

    snapshot_workspace_structure(&root, "Delete workspace project")
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
        let entry =
            project::migrate_to_multi_project(&root, &new_name).map_err(|e| e.to_string())?;
        snapshot_workspace_structure(&root, "Organize workspace projects")?;

        // Update current project to point at the new subdirectory
        let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
        *current = Some(ProjectView::in_repo(root, &entry.path, entry.name.clone()));

        return Ok(entry.path);
    }

    let mut manifest = project::read_manifest_result(&root).map_err(|e| e.to_string())?;

    // Derive new folder-safe path from the new name
    let new_path = new_name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-")
        .trim_matches('-')
        .to_string();

    if new_path.is_empty() {
        return Err("Invalid project name".into());
    }

    let existing_manifest = manifest
        .as_ref()
        .ok_or_else(|| format!("Project '{}' not found in repo", project_path))?;
    if !existing_manifest
        .projects
        .iter()
        .any(|p| p.path == project_path)
    {
        return Err(format!("Project '{}' not found in repo", project_path));
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
    if let Some(mut manifest) = manifest.take() {
        if let Some(entry) = manifest
            .projects
            .iter_mut()
            .find(|p| p.path == project_path)
        {
            entry.name = new_name.clone();
            entry.path = new_path.clone();
        }
        project::write_manifest(&root, &manifest).map_err(|e| e.to_string())?;
    }

    snapshot_workspace_structure(&root, "Rename workspace project")?;

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
    let entry =
        project::migrate_to_multi_project(&root, &existing_name).map_err(|e| e.to_string())?;
    snapshot_workspace_structure(&root, "Organize workspace projects")?;

    // Update current project to point at the new subdirectory
    let view = ProjectView::in_repo(root, &entry.path, entry.name.clone());
    {
        let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
        *current = Some(view);
    }

    Ok(entry)
}

/// Transfer (move or copy) an asset to another project within the same repo.
///
/// `source_rel`: path relative to the current project root (e.g. `"flows/login.sk"`).
/// `dest_project_path`: repo-relative manifest key of the destination project (e.g. `"login"` or `"."`).
/// `dest_rel`: path relative to the destination project root.
/// `remove_source`: if true, delete the source after copying (move semantics).
///
/// Returns `Err("FILE_EXISTS:<dest_rel>")` when the destination already exists,
/// so the frontend can offer a "Save As" rename flow.
#[tauri::command]
pub async fn transfer_asset(
    source_rel: String,
    dest_project_path: String,
    dest_rel: String,
    remove_source: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    const ALLOWED_EXTS: &[&str] = &[".sk", ".sb", ".md"];

    let (source_project_root, repo_root) = project_and_repo_root(&state)?;

    // Validate file extension on both source and dest
    if !ALLOWED_EXTS.iter().any(|ext| source_rel.ends_with(ext)) {
        return Err(format!(
            "Only .sk, .sb, and .md files can be transferred (got '{}')",
            source_rel
        ));
    }
    if !ALLOWED_EXTS.iter().any(|ext| dest_rel.ends_with(ext)) {
        return Err(format!(
            "Destination must end with .sk, .sb, or .md (got '{}')",
            dest_rel
        ));
    }

    // Resolve dest project root — validated against the manifest to prevent arbitrary paths
    let dest_project_root = if dest_project_path == "." {
        repo_root.clone()
    } else {
        let projects = project::list_projects(&repo_root);
        projects
            .iter()
            .find(|p| p.path == dest_project_path)
            .ok_or_else(|| format!("Project '{}' not found in repo manifest", dest_project_path))?;
        repo_root.join(&dest_project_path)
    };

    // Resolve both paths safely
    let source =
        project::safe_resolve(&source_project_root, &source_rel).map_err(|e| e.to_string())?;
    let dest = project::safe_resolve(&dest_project_root, &dest_rel).map_err(|e| e.to_string())?;

    if !source.exists() {
        return Err(format!("Source file not found: '{}'", source_rel));
    }
    if dest.exists() {
        return Err(format!("FILE_EXISTS:{}", dest_rel));
    }

    // Collect asset refs BEFORE moving (so we can read the source file)
    let file_ext = source_rel.rsplit('.').next().unwrap_or("");
    let asset_refs: Vec<String> = if let Ok(content) = std::fs::read_to_string(&source) {
        project::collect_asset_refs(&content, file_ext)
    } else {
        Vec::new()
    };

    // Copy all referenced assets to the dest project (always copy — assets may be shared)
    for asset_rel in &asset_refs {
        let Ok(asset_src) = project::safe_resolve(&source_project_root, asset_rel) else {
            continue;
        };
        if !asset_src.exists() {
            continue;
        }
        let Ok(asset_dest) = project::safe_resolve(&dest_project_root, asset_rel) else {
            continue;
        };
        if asset_dest.exists() {
            continue;
        } // already present at dest, skip
        if let Some(parent) = asset_dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&asset_src, &asset_dest).map_err(|e| e.to_string())?;
    }

    // Create parent directories at destination
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if remove_source {
        // Prefer atomic rename; fall back to copy+delete across devices
        if std::fs::rename(&source, &dest).is_err() {
            std::fs::copy(&source, &dest).map_err(|e| e.to_string())?;
            std::fs::remove_file(&source)
                .map_err(|e| format!("Copied but failed to remove source: {e}"))?;
        }
        // After the source file is gone, remove any assets now unreferenced in source
        for asset_rel in &asset_refs {
            let Ok(asset_src) = project::safe_resolve(&source_project_root, asset_rel) else {
                continue;
            };
            if !asset_src.exists() {
                continue;
            }
            if project::count_asset_refs(&source_project_root, asset_rel) == 0 {
                if let Err(error) = std::fs::remove_file(&asset_src) {
                    log::warn!(
                        "[project] could not remove now-unreferenced asset {}: {error}",
                        asset_src.display()
                    );
                }
            }
        }
    } else {
        std::fs::copy(&source, &dest).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Open a system terminal in the given directory.
///
/// On Windows: tries Windows Terminal (`wt`), falls back to PowerShell.
/// On macOS: opens Terminal.app via `open -a Terminal`.
/// On Linux: tries common terminal emulators in order.
#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    let dir = std::path::PathBuf::from(&path);
    if !dir.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Try Windows Terminal first, fall back to PowerShell
        let wt = std::process::Command::new("cmd")
            .args(["/c", "start", "wt", "-d", &path])
            .creation_flags(0x08000000)
            .spawn();
        if wt.is_err() {
            std::process::Command::new("cmd")
                .args([
                    "/c",
                    "start",
                    "powershell",
                    "-NoExit",
                    "-Command",
                    &format!("Set-Location '{}'", path.replace('\'', "''")),
                ])
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let found = [
            "x-terminal-emulator",
            "gnome-terminal",
            "konsole",
            "xfce4-terminal",
            "xterm",
        ]
        .iter()
        .find_map(|term| {
            std::process::Command::new(term)
                .args(["--working-directory", &path])
                .spawn()
                .ok()
        });
        if found.is_none() {
            return Err(
                "No terminal emulator found. Install gnome-terminal, konsole, or xterm."
                    .to_string(),
            );
        }
    }

    Ok(())
}

/// Read workspace settings from the current repo's .cutready/settings.json.
#[auditaur_command(skip_all, err)]
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
    project::write_repo_settings(&root, &settings).map_err(|e| e.to_string())?;
    snapshot_workspace_structure(&root, "Update workspace settings")
}

/// Check if any recent project was cloned from a given GitHub repo.
///
/// Uses Draftline remotes to match `github.com/{owner}/{repo}`. Returns the path
/// if found and the folder still exists on disk.
#[tauri::command]
pub async fn resolve_deep_link(
    owner: String,
    repo: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    let recent: Vec<crate::models::script::RecentProject> = store
        .get("recent_projects")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let target = format!("github.com/{}/{}", owner, repo).to_lowercase();

    for project in recent {
        let path = std::path::PathBuf::from(&project.path);
        if !path.exists() {
            continue;
        }
        match CutReadyDraftlineAdapter::open_project(&path) {
            Ok(adapter) => {
                let remotes = adapter.remotes().map_err(|error| error.to_string())?;
                if remotes.iter().any(|remote| {
                    remote
                        .url
                        .to_lowercase()
                        .trim_end_matches(".git")
                        .contains(&target)
                }) {
                    return Ok(Some(project.path));
                }
            }
            Err(error) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    "Skipping recent project during deep-link resolution because Draftline could not open it"
                );
            }
        }
    }

    Ok(None)
}
