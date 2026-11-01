//! Hand-written conveniences for the generated [`CmdError`] envelope, so Tauri
//! commands can return it as tersely as they returned `String` errors.

use crate::model::{CmdError, CmdErrorCode, CmdErrorDetails, LoadContext};

impl CmdError {
    /// A `command_failed` error carrying `message` verbatim.
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            code: CmdErrorCode::CommandFailed,
            message: message.into(),
            details: None,
        }
    }

    /// A `file_exists` refusal for `path`. The message keeps the legacy
    /// `FILE_EXISTS:<path>` text; `details.path` carries the path for callers
    /// that branch on the code.
    pub fn file_exists(path: &str) -> Self {
        Self {
            code: CmdErrorCode::FileExists,
            message: format!("FILE_EXISTS:{path}"),
            details: Some(CmdErrorDetails {
                path: Some(path.to_string()),
                ..Default::default()
            }),
        }
    }
}

/// A plain message becomes `command_failed` with that exact text. A message
/// that is itself a serialized envelope (`{"code":…,"message":…}`), which
/// some engine refusals still return as `String`, keeps its code, message
/// and details instead of being wrapped as opaque text.
impl From<String> for CmdError {
    fn from(message: String) -> Self {
        envelope(&message).unwrap_or_else(|| Self::failed(message))
    }
}

impl From<&str> for CmdError {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CmdError {}

fn envelope(message: &str) -> Option<CmdError> {
    if !message.trim_start().starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(message).ok()?;
    let object = value.as_object()?;
    if !object.get("code")?.is_string() || !object.get("message")?.is_string() {
        return None;
    }
    CmdError::try_load_from_value(&value, &LoadContext::default()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_messages_become_command_failed_verbatim() {
        let error = CmdError::from("No project is currently open");
        assert_eq!(error.code, CmdErrorCode::CommandFailed);
        assert_eq!(error.message, "No project is currently open");
        assert!(error.details.is_none());
        assert_eq!(error.to_string(), "No project is currently open");
        assert_eq!(
            CmdError::from(" {not json".to_string()).message,
            " {not json"
        );
        assert_eq!(
            CmdError::from(r#"{"code":1}"#.to_string()).message,
            r#"{"code":1}"#
        );
    }

    #[test]
    fn serialized_envelopes_keep_their_code_and_details() {
        let error = CmdError::from(
            r#"{"code":"folder_is_elsewhere","message":"Elsewhere","details":{"folder":"cutready","repository":null}}"#
                .to_string(),
        );
        assert_eq!(
            error.code,
            CmdErrorCode::Other("folder_is_elsewhere".into())
        );
        assert_eq!(error.message, "Elsewhere");
        let details = error.details.expect("details");
        assert_eq!(details.additional_properties["folder"], "cutready");
        assert!(details.additional_properties["repository"].is_null());
    }
}
