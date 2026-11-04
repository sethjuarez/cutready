//! Product-facing names: CutReady's branch namespace and user-entered version names.

use draftline::tauri_contract::TauriCommandError;

/// Branch namespace CutReady owns inside a developer's code repository. Only
/// applied to hybrid projects so standalone projects keep their existing variations.
pub const CUTREADY_VARIATION_NAMESPACE: &str = "cutready/";

/// Prefix a user-supplied variation name with CutReady's namespace when the
/// project is hybrid and the name isn't already namespaced.
pub fn namespaced_variation_name(hybrid: bool, name: &str) -> String {
    let trimmed = name.trim();
    if !hybrid || trimmed.starts_with(CUTREADY_VARIATION_NAMESPACE) {
        return name.to_string();
    }
    format!("{CUTREADY_VARIATION_NAMESPACE}{trimmed}")
}
/// Longest version name a person can save. Mirrors `MAX_VERSION_NAME` in the frontend.
pub const MAX_VERSION_NAME: usize = 72;

/// The trimmed name to save, or why a user-entered version name is invalid.
pub fn validate_version_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name the version".into());
    }
    if trimmed.chars().count() > MAX_VERSION_NAME {
        return Err(format!("Keep it to {MAX_VERSION_NAME} characters or fewer"));
    }
    Ok(trimmed.to_string())
}

/// A version message is the name on its first line, optionally followed by a
/// blank line and a comment (Draftline reads the commit body as the comment).
/// Validates the name and returns `"Name"` or `"Name\n\nComment"`.
pub fn validate_version_message(message: &str) -> Result<String, String> {
    let (first, rest) = message.split_once('\n').unwrap_or((message, ""));
    let name = validate_version_name(first)?;
    let comment = rest.trim();
    Ok(if comment.is_empty() {
        name
    } else {
        format!("{name}\n\n{comment}")
    })
}

/// [`validate_version_message`] as the command envelope, with the `invalid_version_name` code.
pub fn version_name_for_command(message: &str) -> Result<String, TauriCommandError> {
    validate_version_message(message).map_err(|message| TauriCommandError {
        code: "invalid_version_name".into(),
        message,
        details: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_names_are_required_and_at_most_72_characters() {
        assert_eq!(
            validate_version_name("  Tighten intro  "),
            Ok("Tighten intro".into())
        );
        assert!(validate_version_name("   ").is_err());
        assert!(validate_version_name(&"x".repeat(MAX_VERSION_NAME)).is_ok());
        assert!(validate_version_name(&"x".repeat(MAX_VERSION_NAME + 1)).is_err());
        // Counts characters, not bytes.
        assert!(validate_version_name(&"🎬".repeat(MAX_VERSION_NAME)).is_ok());
    }

    #[test]
    fn messages_keep_a_comment_after_the_name() {
        assert_eq!(
            validate_version_message("Intro\n\n  Tightened it.  "),
            Ok("Intro\n\nTightened it.".into())
        );
        assert_eq!(
            validate_version_message("Intro\r\n\r\nWhy\r\n"),
            Ok("Intro\n\nWhy".into())
        );
        assert_eq!(
            validate_version_message(" Intro \n\n  "),
            Ok("Intro".into())
        );
        // Only the first line counts towards the name limit.
        let long_comment = format!("Intro\n\n{}", "x".repeat(500));
        assert!(validate_version_message(&long_comment).is_ok());
        assert!(validate_version_message("\n\nOnly a comment").is_err());
    }

    #[test]
    fn invalid_names_carry_the_command_error_code() {
        let error = version_name_for_command("").unwrap_err();
        assert_eq!(error.code, "invalid_version_name");
        assert_eq!(error.message, "Name the version");
    }
}
