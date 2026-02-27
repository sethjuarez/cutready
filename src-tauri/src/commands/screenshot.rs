//! Tauri commands for screen capture.

use tauri::State;

use crate::util::screenshot;
use crate::AppState;

fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

#[tauri::command]
pub async fn list_monitors() -> Result<Vec<screenshot::MonitorInfo>, String> {
    screenshot::list_monitors()
}

#[tauri::command]
pub async fn capture_region(
    monitor_id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    screenshot::capture_region(&root, monitor_id, x, y, width, height)
}

#[tauri::command]
pub async fn capture_fullscreen(
    monitor_id: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    screenshot::capture_fullscreen(&root, monitor_id)
}
