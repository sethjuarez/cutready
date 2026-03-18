//! Tauri command for persisting user feedback to the app data directory.

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
pub struct FeedbackEntry {
    pub category: String,
    pub feedback: String,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_log: Option<String>,
}

/// Append a feedback entry to `<app_data>/feedback.json`.
#[tauri::command]
pub fn save_feedback(app: tauri::AppHandle, entry: FeedbackEntry) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("Could not create data dir: {e}"))?;

    let path = data_dir.join("feedback.json");
    let mut entries: Vec<FeedbackEntry> = if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_else(|_| "[]".into());
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    entries.push(entry);

    let json = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("Serialization error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Could not write feedback: {e}"))?;

    Ok(())
}

/// Read all feedback entries from `<app_data>/feedback.json`.
#[tauri::command]
pub fn list_feedback(app: tauri::AppHandle) -> Result<Vec<FeedbackEntry>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    let path = data_dir.join("feedback.json");

    if !path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("Read error: {e}"))?;
    let entries: Vec<FeedbackEntry> =
        serde_json::from_str(&content).map_err(|e| format!("Parse error: {e}"))?;
    Ok(entries)
}

/// Clear all feedback entries.
#[tauri::command]
pub fn clear_feedback(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    let path = data_dir.join("feedback.json");
    if path.exists() {
        fs::write(&path, "[]").map_err(|e| format!("Could not clear feedback: {e}"))?;
    }
    Ok(())
}

/// Delete a single feedback entry by index.
#[tauri::command]
pub fn delete_feedback(app: tauri::AppHandle, index: usize) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    let path = data_dir.join("feedback.json");
    if !path.exists() {
        return Err("No feedback file found".into());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Read error: {e}"))?;
    let mut entries: Vec<FeedbackEntry> =
        serde_json::from_str(&content).map_err(|e| format!("Parse error: {e}"))?;
    if index >= entries.len() {
        return Err(format!("Index {} out of bounds ({})", index, entries.len()));
    }
    entries.remove(index);
    let json = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("Serialization error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Could not write feedback: {e}"))?;
    Ok(())
}

/// Collect all log files into a zip archive at the given destination path.
#[tauri::command]
pub fn export_logs(app: tauri::AppHandle, dest: String, debug_log: Option<String>) -> Result<(), String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    let log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.cutready.app")
        .join("logs");

    let dest_path = std::path::PathBuf::from(&dest);
    let file = fs::File::create(&dest_path)
        .map_err(|e| format!("Could not create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // Collect backend log files
    if log_dir.exists() {
        if let Ok(entries) = fs::read_dir(&log_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if let Ok(data) = fs::read(&path) {
                            zip.start_file(name, options)
                                .map_err(|e| format!("Zip error: {e}"))?;
                            zip.write_all(&data)
                                .map_err(|e| format!("Write error: {e}"))?;
                        }
                    }
                }
            }
        }
    }

    // Include frontend debug log if provided
    if let Some(log_text) = debug_log {
        zip.start_file("frontend-debug.log", options)
            .map_err(|e| format!("Zip error: {e}"))?;
        zip.write_all(log_text.as_bytes())
            .map_err(|e| format!("Write error: {e}"))?;
    }

    // Include basic system info
    let info = format!(
        "app_version: {}\nos: {}\narch: {}\ntimestamp: {}",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        chrono::Utc::now().to_rfc3339(),
    );
    zip.start_file("system-info.txt", options)
        .map_err(|e| format!("Zip error: {e}"))?;
    zip.write_all(info.as_bytes())
        .map_err(|e| format!("Write error: {e}"))?;

    zip.finish().map_err(|e| format!("Zip finalize error: {e}"))?;
    Ok(())
}
