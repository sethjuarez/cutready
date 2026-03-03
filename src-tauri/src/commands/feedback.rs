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
