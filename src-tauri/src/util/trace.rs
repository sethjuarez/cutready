//! Structured trace compatibility helpers.
//!
//! Older CutReady code emits domain trace events through this module. Auditaur
//! now captures them from `tracing` instead of a separate JSONL file.

use serde_json::Value;

/// Emit a structured trace event.
pub fn emit(event: &str, module: &str, data: Value) {
    tracing::info!(
        target: "cutready.trace",
        cutready_trace_event = %event,
        cutready_trace_module = %module,
        cutready_trace_data = %data,
        "cutready trace event"
    );
}

/// Convenience: emit with a simple message string.
#[allow(dead_code)]
pub fn msg(event: &str, module: &str, message: &str) {
    emit(event, module, serde_json::json!({ "message": message }));
}

/// Truncate a string to max_len chars, appending "…" if truncated.
pub fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        let end = s
            .char_indices()
            .nth(max_len)
            .map(|(i, _)| i)
            .unwrap_or(s.len());
        format!("{}…", &s[..end])
    }
}
