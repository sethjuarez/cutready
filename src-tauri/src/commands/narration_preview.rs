use tauri::Manager;
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::narration_preview;

fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))
}

#[auditaur_command(skip_all, err)]
pub fn get_narration_voice_preview(
    voice_name: String,
    output_format: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    narration_preview::cached_voice_preview(&app_data_dir(&app)?, &voice_name, &output_format)
        .map_err(|e| e.to_string())
}

#[auditaur_command(skip_all, err)]
pub fn save_narration_voice_preview(
    voice_name: String,
    output_format: String,
    audio_data: Vec<u8>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    narration_preview::save_voice_preview(
        &app_data_dir(&app)?,
        &voice_name,
        &output_format,
        &audio_data,
    )
    .map_err(|e| e.to_string())
}
