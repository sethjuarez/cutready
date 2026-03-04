//! Tauri commands for project versioning operations.

use tauri::State;

use crate::engine::{project, versioning, versioning_remote};
use crate::models::script::ProjectView;
use crate::models::sketch::VersionEntry;
use crate::AppState;

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

#[tauri::command]
pub async fn save_with_label(
    label: String,
    fork_label: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    project::save_with_label(&root, &label, fork_label.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_versions(state: State<'_, AppState>) -> Result<Vec<VersionEntry>, String> {
    let root = project_root(&state)?;

    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }

    versioning::list_versions(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_version(
    commit_id: String,
    file_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;

    // Default to listing changed files if no specific file requested
    let target = file_path.as_deref().unwrap_or("");
    if target.is_empty() {
        return Err("File path required for preview".into());
    }

    let data = versioning::get_file_at_version(&root, &commit_id, target)
        .map_err(|e| e.to_string())?;

    String::from_utf8(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn restore_version(
    commit_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::restore_version(&root, &commit_id).map_err(|e| e.to_string())?;

    // Re-scan the project folder after restore
    let view = ProjectView::new(root);
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view);

    Ok(())
}

#[tauri::command]
pub async fn checkout_version(
    commit_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::checkout_version(&root, &commit_id).map_err(|e| e.to_string())?;

    // Re-scan the project folder after checkout
    let view = ProjectView::new(root);
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view);

    Ok(())
}

#[tauri::command]
pub async fn discard_changes(state: State<'_, AppState>) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::discard_changes(&root).map_err(|e| e.to_string())?;

    // Re-scan project after discard
    let view = ProjectView::new(root);
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view);

    Ok(())
}

#[tauri::command]
pub async fn has_unsaved_changes(state: State<'_, AppState>) -> Result<bool, String> {
    let root = project_root(&state)?;
    if !root.join(".git").exists() {
        return Ok(false);
    }
    versioning::has_unsaved_changes(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stash_changes(state: State<'_, AppState>) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::stash_working_tree(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pop_stash(state: State<'_, AppState>) -> Result<bool, String> {
    let root = project_root(&state)?;
    versioning::pop_stash(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_timeline(
    from_commit_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::create_timeline(&root, &from_commit_id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_timelines(
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::sketch::TimelineInfo>, String> {
    let root = project_root(&state)?;
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }
    versioning::list_timelines(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn switch_timeline(
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::switch_timeline(&root, &name).map_err(|e| e.to_string())?;
    // Re-scan project
    let view = crate::models::script::ProjectView::new(root);
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view);
    Ok(())
}

#[tauri::command]
pub async fn delete_timeline(
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::delete_timeline(&root, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn promote_timeline(
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::promote_timeline(&root, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_timeline_graph(
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::sketch::GraphNode>, String> {
    let root = project_root(&state)?;
    if !root.join(".git").exists() {
        return Ok(Vec::new());
    }
    versioning::get_timeline_graph(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn navigate_to_snapshot(
    commit_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning::navigate_to_snapshot(&root, &commit_id).map_err(|e| e.to_string())?;

    // Re-scan the project folder
    let view = ProjectView::new(root);
    let mut current = state.current_project.lock().map_err(|e| e.to_string())?;
    *current = Some(view);
    Ok(())
}

#[tauri::command]
pub async fn has_stash(state: State<'_, AppState>) -> Result<bool, String> {
    let root = project_root(&state)?;
    Ok(versioning::has_stash(&root))
}

// ─── Remote operations ──────────────────────────────────────────

#[tauri::command]
pub async fn add_git_remote(
    name: String,
    url: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning_remote::add_remote(&root, &name, &url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_git_remote(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning_remote::remove_remote(&root, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_git_remotes(
    state: State<'_, AppState>,
) -> Result<Vec<versioning_remote::RemoteInfo>, String> {
    let root = project_root(&state)?;
    versioning_remote::list_remotes(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn detect_git_remote(
    state: State<'_, AppState>,
) -> Result<Option<versioning_remote::RemoteInfo>, String> {
    let root = project_root(&state)?;
    versioning_remote::detect_remote(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_git_remote(
    remote_name: String,
    token: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning_remote::fetch_remote(&root, &remote_name, token.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn push_git_remote(
    remote_name: String,
    branch: String,
    token: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning_remote::push_remote(&root, &remote_name, &branch, token.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_sync_status(
    branch: String,
    remote_name: String,
    state: State<'_, AppState>,
) -> Result<versioning_remote::SyncStatus, String> {
    let root = project_root(&state)?;
    versioning_remote::get_ahead_behind(&root, &branch, &remote_name)
        .map_err(|e| e.to_string())
}

/// Try to get a GitHub token from the `gh` CLI.
#[tauri::command]
pub async fn get_github_token() -> Result<Option<String>, String> {
    match std::process::Command::new("gh")
        .args(["auth", "token"])
        .output()
    {
        Ok(output) if output.status.success() => {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if token.is_empty() {
                Ok(None)
            } else {
                Ok(Some(token))
            }
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn pull_git_remote(
    remote_name: String,
    branch: String,
    token: Option<String>,
    state: State<'_, AppState>,
) -> Result<versioning_remote::PullResult, String> {
    let root = project_root(&state)?;
    versioning_remote::pull_remote(&root, &remote_name, &branch, token.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_remote_branches(
    remote_name: String,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let root = project_root(&state)?;
    versioning_remote::list_remote_branches(&root, &remote_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn checkout_remote_branch(
    remote_name: String,
    branch: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    versioning_remote::checkout_remote_branch(&root, &remote_name, &branch)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_editor_state(
    commit_id: String,
    editor_state: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let dir = root.join(".git").join("cutready-editor-state");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.json", commit_id)), editor_state)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_editor_state(
    commit_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let root = project_root(&state)?;
    let path = root.join(".git").join("cutready-editor-state").join(format!("{}.json", commit_id));
    if path.exists() {
        std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn is_rewound(state: State<'_, AppState>) -> Result<bool, String> {
    let root = project_root(&state)?;
    Ok(versioning::is_rewound(&root))
}

#[tauri::command]
pub async fn diff_snapshots(
    from_commit: String,
    to_commit: String,
    state: State<'_, AppState>,
) -> Result<Vec<versioning::DiffEntry>, String> {
    let root = project_root(&state)?;
    versioning::diff_snapshots(&root, &from_commit, &to_commit)
        .map_err(|e| e.to_string())
}

/// Check for large files (>50MB) in the working tree.
#[tauri::command]
pub async fn check_large_files(
    threshold_mb: u64,
    state: State<'_, AppState>,
) -> Result<Vec<(String, u64)>, String> {
    let root = project_root(&state)?;
    let threshold_bytes = threshold_mb * 1024 * 1024;
    let mut large: Vec<(String, u64)> = Vec::new();
    fn walk(dir: &std::path::Path, root: &std::path::Path, threshold: u64, out: &mut Vec<(String, u64)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            if path.is_dir() {
                walk(&path, root, threshold, out);
            } else if let Ok(meta) = path.metadata() {
                if meta.len() > threshold {
                    let rel = path.strip_prefix(root).unwrap_or(&path);
                    out.push((rel.to_string_lossy().to_string(), meta.len()));
                }
            }
        }
    }
    walk(&root, &root, threshold_bytes, &mut large);
    Ok(large)
}

#[tauri::command]
pub async fn clone_from_url(
    url: String,
    dest: String,
    token: Option<String>,
) -> Result<(), String> {
    let dest_path = std::path::PathBuf::from(&dest);
    versioning_remote::clone_from_url(&url, &dest_path, token.as_deref())
        .map_err(|e| e.to_string())
}
