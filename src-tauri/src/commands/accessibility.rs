//! OS accessibility display preferences (increase contrast, differentiate
//! without color). macOS reads them from NSWorkspace; other platforms have no
//! equivalent the app can read, so they report `false` and the frontend falls
//! back to `prefers-contrast` and the user's explicit choice.

use serde::Serialize;
use tauri_plugin_auditaur::auditaur_command;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAccessibilityDisplay {
    pub increase_contrast: bool,
    pub differentiate_without_color: bool,
}

/// Sync on purpose: Tauri runs sync commands on the main thread, which is
/// where AppKit expects to be queried.
#[auditaur_command(skip_all)]
pub fn get_system_accessibility_display() -> SystemAccessibilityDisplay {
    read_system_accessibility_display()
}

#[cfg(target_os = "macos")]
fn read_system_accessibility_display() -> SystemAccessibilityDisplay {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    // SAFETY: `sharedWorkspace` returns the process-wide NSWorkspace singleton
    // (never nil), and both selectors are BOOL getters available since 10.10.
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return SystemAccessibilityDisplay::default();
        }
        SystemAccessibilityDisplay {
            increase_contrast: msg_send![workspace, accessibilityDisplayShouldIncreaseContrast],
            differentiate_without_color: msg_send![
                workspace,
                accessibilityDisplayShouldDifferentiateWithoutColor
            ],
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn read_system_accessibility_display() -> SystemAccessibilityDisplay {
    SystemAccessibilityDisplay::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_reports_no_system_preferences() {
        assert_eq!(
            read_system_accessibility_display(),
            SystemAccessibilityDisplay {
                increase_contrast: false,
                differentiate_without_color: false,
            }
        );
    }

    #[test]
    fn serializes_camel_case_for_the_frontend() {
        let json = serde_json::to_value(SystemAccessibilityDisplay {
            increase_contrast: true,
            differentiate_without_color: false,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "increaseContrast": true, "differentiateWithoutColor": false })
        );
    }
}
