//! Interaction recorder — capture user interactions during demo walkthroughs.
//!
//! Two-phase architecture:
//!   1. **Prepare** — Launch a browser (user's profile or fresh Chromium),
//!      user navigates and preps their demo.
//!   2. **Observe** — Inject the DOM observer, start capturing actions.
//!      Can start/stop multiple times (multiple takes) without relaunching.
//!
//! The browser lifecycle is separate from the recording lifecycle.

use std::path::{Path, PathBuf};

use crate::util::sidecar::SidecarManager;

// ── Browser Profile Detection ───────────────────────────────────────────────

/// A browser profile detected on the system.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserProfile {
    /// Browser identifier ("msedge" or "chrome").
    pub browser: String,
    /// Friendly browser name ("Edge" or "Chrome").
    pub browser_name: String,
    /// Profile directory name ("Default", "Profile 1", etc.).
    pub profile_directory: String,
    /// User's display name for this profile.
    pub display_name: String,
    /// Full path to the browser's User Data directory.
    pub user_data_dir: String,
}

/// Which browser processes are currently running.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserRunningStatus {
    pub msedge: bool,
    pub chrome: bool,
}

/// Detect browser profiles from Edge and Chrome `Local State` files.
///
/// Reads `%LOCALAPPDATA%\Microsoft\Edge\User Data\Local State` and
/// `%LOCALAPPDATA%\Google\Chrome\User Data\Local State`, parsing the
/// `profile.info_cache` to extract profile names and directories.
pub fn detect_browser_profiles() -> Vec<BrowserProfile> {
    let mut profiles = Vec::new();

    let local_app_data = match std::env::var("LOCALAPPDATA") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => return profiles,
    };

    let browsers = [
        (
            "msedge",
            "Edge",
            local_app_data
                .join("Microsoft")
                .join("Edge")
                .join("User Data"),
        ),
        (
            "chrome",
            "Chrome",
            local_app_data
                .join("Google")
                .join("Chrome")
                .join("User Data"),
        ),
    ];

    for (browser_id, browser_name, user_data_dir) in &browsers {
        let local_state_path = user_data_dir.join("Local State");
        if !local_state_path.exists() {
            continue;
        }

        let content = match std::fs::read_to_string(&local_state_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let json: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(info_cache) = json
            .pointer("/profile/info_cache")
            .and_then(|v| v.as_object())
        {
            for (profile_dir, profile_info) in info_cache {
                let display_name = profile_info
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        profile_info
                            .get("gaia_name")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                    })
                    .unwrap_or(profile_dir)
                    .to_string();

                profiles.push(BrowserProfile {
                    browser: browser_id.to_string(),
                    browser_name: browser_name.to_string(),
                    profile_directory: profile_dir.clone(),
                    display_name,
                    user_data_dir: user_data_dir.to_string_lossy().to_string(),
                });
            }
        }
    }

    profiles
}

/// Check which browsers have visible windows open (profile lock).
///
/// Edge and Chrome keep background processes running even when all windows
/// are closed (service workers, updaters, etc.). Those don't lock the profile.
/// We only care about processes with a visible main window — that means the
/// browser UI is open and the profile directory is locked.
///
/// Uses PowerShell's `Get-Process` with `MainWindowTitle` filter (Windows only).
#[cfg(target_os = "windows")]
pub fn check_browsers_running() -> BrowserRunningStatus {
    use std::os::windows::process::CommandExt;

    let has_visible_window = |process_name: &str| -> bool {
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "(Get-Process '{}' -ErrorAction SilentlyContinue | Where-Object {{ $_.MainWindowTitle -ne '' }}).Count",
                    process_name
                ),
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map(|out| {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                stdout.parse::<u32>().unwrap_or(0) > 0
            })
            .unwrap_or(false)
    };

    BrowserRunningStatus {
        msedge: has_visible_window("msedge"),
        chrome: has_visible_window("chrome"),
    }
}

/// On non-Windows platforms, return false for both browsers (not implemented).
#[cfg(not(target_os = "windows"))]
pub fn check_browsers_running() -> BrowserRunningStatus {
    BrowserRunningStatus {
        msedge: false,
        chrome: false,
    }
}

/// Options for preparing a browser.
#[derive(Debug, Default)]
pub struct PrepareBrowserOptions {
    /// User data directory for a persistent context (real profile).
    pub user_data_dir: Option<String>,
    /// Profile directory name (e.g., "Default", "Profile 1").
    pub profile_directory: Option<String>,
    /// Browser channel to use (e.g., "msedge", "chrome").
    /// Only relevant when launching with a profile.
    pub browser_channel: Option<String>,
}

/// Resolve the playwright-sidecar directory.
///
/// In development, this is relative to the Cargo manifest (i.e. the project root).
/// In production, this would resolve from the app's bundled resources.
pub fn resolve_sidecar_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .expect("Cargo manifest dir should have a parent")
        .join("playwright-sidecar")
}

/// Resolve the screenshots directory for a recording session.
pub fn resolve_screenshots_dir(project_root: &Path, _project_id: &str, session_id: &str) -> PathBuf {
    project_root
        .join(".sessions")
        .join(session_id)
        .join("screenshots")
}

/// Prepare a browser for recording.
///
/// When `options` includes a profile, launches with `launchPersistentContext`
/// using the user's real browser profile (with extensions, passwords, etc.).
/// Otherwise tries Edge → Chrome → bundled Chromium in fresh mode.
///
/// Returns the sidecar, event receiver, and which browser channel was used.
pub async fn prepare_browser(
    sidecar_dir: &Path,
    options: PrepareBrowserOptions,
) -> anyhow::Result<(
    SidecarManager,
    tokio::sync::mpsc::UnboundedReceiver<crate::models::session::CapturedAction>,
    String,
)> {
    let (sidecar, event_rx) = SidecarManager::spawn(sidecar_dir).await?;

    sidecar
        .ping()
        .await
        .map_err(|e| anyhow::anyhow!("Sidecar ping failed: {e}"))?;

    let params = match (&options.user_data_dir, &options.profile_directory, &options.browser_channel) {
        (Some(udd), Some(pd), Some(ch)) => serde_json::json!({
            "user_data_dir": udd,
            "profile_directory": pd,
            "browser_channel": ch,
        }),
        _ => serde_json::json!({}),
    };

    let result = sidecar
        .request("browser.prepare", params)
        .await
        .map_err(|e| anyhow::anyhow!("Browser prepare failed: {e}"))?;

    let browser_channel = result
        .get("browser_channel")
        .and_then(|v| v.as_str())
        .unwrap_or("chromium")
        .to_string();

    Ok((sidecar, event_rx, browser_channel))
}

/// Start observing the active page in a prepared browser.
///
/// Injects the DOM observer and begins forwarding captured actions.
pub async fn start_observing(
    sidecar: &SidecarManager,
    screenshots_dir: &Path,
) -> anyhow::Result<()> {
    sidecar
        .request(
            "browser.startObserving",
            serde_json::json!({
                "screenshots_dir": screenshots_dir.to_string_lossy(),
            }),
        )
        .await
        .map_err(|e| anyhow::anyhow!("Start observing failed: {e}"))?;

    Ok(())
}

/// Stop observing. The browser stays open for another take.
pub async fn stop_observing(sidecar: &SidecarManager) -> anyhow::Result<()> {
    let _ = sidecar
        .request("browser.stopObserving", serde_json::json!({}))
        .await;
    Ok(())
}

/// Disconnect from the browser — close it and shut down the sidecar.
pub async fn disconnect_browser(sidecar: &SidecarManager) -> anyhow::Result<()> {
    let _ = sidecar
        .request("browser.close", serde_json::json!({}))
        .await;
    sidecar.shutdown().await?;
    Ok(())
}

/// Save a recorded session to disk as a JSON file.
pub fn save_session(
    session: &crate::models::session::RecordedSession,
    project_root: &Path,
    _project_id: &str,
) -> anyhow::Result<PathBuf> {
    let session_dir = project_root.join(".sessions");
    std::fs::create_dir_all(&session_dir)?;

    let path = session_dir.join(format!("{}.session.json", session.id));
    let json = serde_json::to_string_pretty(session)?;
    std::fs::write(&path, json)?;

    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::action::{Action, ActionMetadata, SelectorStrategy};
    use crate::models::session::{CapturedAction, RecordedSession, RecordingMode};
    use tempfile::TempDir;

    #[test]
    fn resolve_sidecar_dir_exists() {
        let dir = resolve_sidecar_dir();
        assert!(dir.ends_with("playwright-sidecar"));
    }

    #[test]
    fn resolve_screenshots_dir_format() {
        let dir = resolve_screenshots_dir(Path::new("/my-project"), "", "session-456");
        assert!(dir.to_string_lossy().contains(".sessions"));
        assert!(dir.to_string_lossy().contains("session-456"));
        assert!(dir.to_string_lossy().contains("screenshots"));
    }

    #[test]
    fn save_session_creates_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let project_id = "test-project";

        let mut session = RecordedSession::new(RecordingMode::FreeForm);
        session.actions.push(CapturedAction {
            action: Action::BrowserClick {
                selectors: vec![SelectorStrategy::CssSelector("#btn".into())],
            },
            metadata: ActionMetadata {
                captured_screenshot: None,
                selector_strategies: vec![],
                timestamp_ms: 1000,
                confidence: 0.9,
                context_snapshot: None,
            },
            raw_event: None,
        });

        let path = save_session(&session, dir, project_id).unwrap();
        assert!(path.exists());

        let data = std::fs::read_to_string(&path).unwrap();
        let loaded: RecordedSession = serde_json::from_str(&data).unwrap();
        assert_eq!(loaded.id, session.id);
        assert_eq!(loaded.actions.len(), 1);
    }
}
