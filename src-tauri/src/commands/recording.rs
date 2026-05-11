//! Tauri commands for the recording engine (FFmpeg screen/audio capture).

use tauri::State;

use crate::{engine::recording, AppState};

fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    current
        .as_ref()
        .map(|p| std::path::PathBuf::from(&p.root))
        .ok_or_else(|| "No project open".to_string())
}

#[tauri::command]
pub async fn initialize_recording_storage(state: State<'_, AppState>) -> Result<String, String> {
    let root = project_root(&state)?;
    let dir = recording::initialize_recording_storage(&root).map_err(|e| e.to_string())?;
    dir.strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_recording_take(
    scope: recording::RecordingScope,
    settings: recording::RecorderSettings,
    state: State<'_, AppState>,
) -> Result<recording::RecordingTake, String> {
    let root = project_root(&state)?;
    recording::create_recording_take(&root, scope, settings).map_err(|e| e.to_string())
}
