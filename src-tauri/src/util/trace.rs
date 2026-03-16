//! Dev-mode structured trace logger.
//!
//! Writes JSON-lines to `dev-trace.jsonl` in the app log directory.
//! Each line is a self-contained JSON object with `ts`, `event`, `module`,
//! and `data` fields. Only active in debug builds.
//!
//! Usage from Copilot CLI:
//!   Get-Content "$env:LOCALAPPDATA\com.cutready.app\logs\dev-trace.jsonl" -Wait
//!
//! Filter for errors:
//!   Get-Content ... -Wait | Select-String '"event":"error"'

use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Mutex, OnceLock};

static TRACE: OnceLock<Mutex<std::io::BufWriter<std::fs::File>>> = OnceLock::new();

/// Initialize the trace file. Call once at app startup.
/// No-ops in release builds.
pub fn init() {
    if !cfg!(debug_assertions) {
        return;
    }
    let log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.cutready.app")
        .join("logs");
    std::fs::create_dir_all(&log_dir).ok();
    let path = log_dir.join("dev-trace.jsonl");

    // Truncate on startup for a clean session
    match std::fs::File::create(&path) {
        Ok(f) => {
            let writer = std::io::BufWriter::new(f);
            TRACE.set(Mutex::new(writer)).ok();
            log::info!("[trace] dev trace → {}", path.display());
        }
        Err(e) => {
            log::warn!("[trace] failed to create trace file: {}", e);
        }
    }
}

/// Emit a structured trace event (dev builds only).
pub fn emit(event: &str, module: &str, data: Value) {
    if let Some(writer) = TRACE.get() {
        let ts = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let entry = json!({
            "ts": ts,
            "event": event,
            "module": module,
            "data": data,
        });
        if let Ok(mut w) = writer.lock() {
            writeln!(w, "{}", entry).ok();
            w.flush().ok();
        }
    }
}

/// Convenience: emit with a simple message string.
#[allow(dead_code)]
pub fn msg(event: &str, module: &str, message: &str) {
    emit(event, module, json!({ "message": message }));
}

/// Truncate a string to max_len chars, appending "…" if truncated.
pub fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        let end = s.char_indices()
            .nth(max_len)
            .map(|(i, _)| i)
            .unwrap_or(s.len());
        format!("{}…", &s[..end])
    }
}
