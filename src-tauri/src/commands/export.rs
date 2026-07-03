//! Tauri commands for the export engine.

use tauri::State;
use tauri_plugin_auditaur::auditaur_command;

use crate::{engine::export, AppState};

fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    current
        .as_ref()
        .map(|p| std::path::PathBuf::from(&p.root))
        .ok_or_else(|| "No project open".to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn export_sketch_video(
    relative_path: String,
    output_path: Option<String>,
    settings: Option<export::SketchVideoExportSettings>,
    on_progress: tauri::ipc::Channel<export::SketchVideoExportProgress>,
    state: State<'_, AppState>,
) -> Result<export::SketchVideoExport, String> {
    let root = project_root(&state)?;
    let output_path = output_path.map(std::path::PathBuf::from);
    let settings = settings.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let result = export::export_sketch_video_with_progress(
            &root,
            &relative_path,
            output_path.as_deref(),
            settings,
            |event| {
                if let Err(error) = on_progress.send(event) {
                    tracing::warn!(
                        target: "cutready::export",
                        error = %error,
                        "could not send sketch video export progress"
                    );
                }
            },
        );
        if let Err(error) = &result {
            let _ = on_progress.send(export::SketchVideoExportProgress {
                phase: "failed".to_string(),
                current: 0,
                total: 1,
                message: error.to_string(),
            });
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
