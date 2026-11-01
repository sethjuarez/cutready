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

    /// Lifts a serialized Draftline `TauriCommandError` back into the envelope,
    /// keeping its code, message and details. Call this only where the text is
    /// known to be such a refusal; anything that doesn't load as one stays
    /// `command_failed` with the text verbatim.
    pub fn from_draftline_envelope(message: impl Into<String>) -> Self {
        let message = message.into();
        envelope(&message).unwrap_or_else(|| Self::failed(message))
    }
}

/// Any message becomes `command_failed` with that exact text, even when it
/// happens to look like JSON. See [`CmdError::from_draftline_envelope`].
impl From<String> for CmdError {
    fn from(message: String) -> Self {
        Self::failed(message)
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
    fn json_shaped_messages_stay_command_failed_verbatim() {
        let raw = r#"{"code":"rate_limit","message":"Retry later","request_id":"abc"}"#;
        for error in [CmdError::from(raw), CmdError::from(raw.to_string())] {
            assert_eq!(error.code, CmdErrorCode::CommandFailed);
            assert_eq!(error.message, raw);
            assert!(error.details.is_none());
        }
        let not_an_envelope = CmdError::from_draftline_envelope(r#"{"code":1}"#);
        assert_eq!(not_an_envelope.code, CmdErrorCode::CommandFailed);
        assert_eq!(not_an_envelope.message, r#"{"code":1}"#);
    }

    #[test]
    fn serialized_envelopes_keep_their_code_and_details() {
        let error = CmdError::from_draftline_envelope(
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
