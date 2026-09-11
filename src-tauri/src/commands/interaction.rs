//! Tauri commands for the interaction recorder.
//!
//! Two-phase workflow:
//!   1. `prepare_browser` — Launch a recording browser. User preps their demo.
//!   2. `start_recording_session` / `stop_recording_session` — Start/stop observing.
//!      Can be called multiple times (multiple takes) without relaunching.
//!   3. `disconnect_browser` — Close the browser when done.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use chrono::Utc;
use tauri::State;

use crate::engine::interaction;
use crate::models::session::{CapturedAction, RecordedSession, RecordingMode};
use crate::util::sidecar::{SidecarStreamEvent, SidecarTermination};
use crate::{AppState, BrowserConnection, RecordingInner};

/// Monotonic source of per-connection identities. Lets a connection's
/// terminal-event handler prove it is still the current connection before
/// clearing readiness, so a stale event cannot clear its replacement.
static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

/// Decide whether a terminal event originating from connection `event_id`
/// should clear the currently-stored connection `current_id`.
///
/// A terminal event only clears the connection it belongs to; an event from a
/// superseded connection must never clear the connection that replaced it, and
/// an already-empty slot is left untouched.
fn terminal_should_clear(current_id: Option<u64>, event_id: u64) -> bool {
    current_id == Some(event_id)
}

/// Detect browser profiles available on the system.
///
/// Reads Edge and Chrome `Local State` files to find all profiles.
#[tauri::command]
pub fn detect_browser_profiles() -> Vec<interaction::BrowserProfile> {
    interaction::detect_browser_profiles()
}

/// Check which browsers are currently running.
///
/// Returns `{ msedge: bool, chrome: bool }`.
#[tauri::command]
pub fn check_browsers_running() -> interaction::BrowserRunningStatus {
    interaction::check_browsers_running()
}

/// Launch a recording browser.
///
/// When `user_data_dir` and `profile_directory` are provided, launches with
/// the user's real browser profile (extensions, passwords, bookmarks).
/// Otherwise tries Edge → Chrome → bundled Chromium in fresh mode.
///
/// Returns the browser channel used ("chrome", "msedge", or "chromium").
#[tauri::command]
pub async fn prepare_browser(
    state: State<'_, AppState>,
    user_data_dir: Option<String>,
    profile_directory: Option<String>,
    browser_channel: Option<String>,
) -> Result<String, String> {
    // Check no browser already connected
    {
        let browser = state.browser.lock().await;
        if browser.is_some() {
            return Err("Browser already prepared".to_string());
        }
    }

    let sidecar_dir = interaction::resolve_sidecar_dir();
    let options = interaction::PrepareBrowserOptions {
        user_data_dir,
        profile_directory,
        browser_channel,
    };
    let (sidecar, event_rx, resolved_channel) = interaction::prepare_browser(&sidecar_dir, options)
        .await
        .map_err(|e| e.to_string())?;

    let recording = Arc::new(tokio::sync::Mutex::new(RecordingInner {
        active: false,
        channel: None,
        actions: Vec::new(),
        session: None,
    }));

    let connection_id = NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);

    // Spawn a long-lived forwarding task that reads the sidecar event stream.
    // Actions are forwarded to the frontend only while a recording is active; a
    // terminal event (browser closed or sidecar EOF) clears readiness so a new
    // prepare is possible — but only if this connection is still the current
    // one, so a superseded connection cannot clear its replacement.
    let fwd_recording = recording.clone();
    let fwd_browser = state.browser.clone();

    // Hold the browser lock across task spawn AND storage so a terminal event
    // racing ahead of storage blocks on the lock until the connection is
    // installed, then observes it and clears readiness correctly. The task is
    // spawned inside the locked region: if it receives a terminal event before
    // storage, its `fwd_browser.lock()` blocks until the connection is stored
    // below and the guard is dropped.
    let mut browser = state.browser.lock().await;
    let fwd_handle = tokio::spawn(async move {
        let mut rx = event_rx;
        while let Some(event) = rx.recv().await {
            match event {
                SidecarStreamEvent::Action(captured) => {
                    let mut inner = fwd_recording.lock().await;
                    if inner.active {
                        inner.actions.push(captured.clone());
                        if let Some(ch) = &inner.channel {
                            let _ = ch.send(captured);
                        }
                    }
                }
                SidecarStreamEvent::Terminated(reason) => {
                    if reason == SidecarTermination::BrowserDisconnected {
                        // The browser is gone; a lingering active recording must
                        // not keep reporting itself as running.
                        let mut inner = fwd_recording.lock().await;
                        inner.active = false;
                        inner.channel = None;
                    }
                    let mut guard = fwd_browser.lock().await;
                    let current_id = guard.as_ref().map(|c| c.id);
                    if terminal_should_clear(current_id, connection_id) {
                        let taken = guard.take();
                        // Release the lock before dropping the connection: the
                        // drop kills the sidecar and aborts this very task's
                        // handle, so it must not happen while holding the lock.
                        drop(guard);
                        drop(taken);
                    }
                    break;
                }
            }
        }
    });

    // Store the connection while still holding the lock acquired above, then
    // release it so any terminal event blocked in the forwarding task can now
    // observe the installed connection.
    *browser = Some(BrowserConnection {
        id: connection_id,
        sidecar,
        browser_channel: resolved_channel.clone(),
        recording,
        _forwarding_handle: fwd_handle,
    });
    drop(browser);

    Ok(resolved_channel)
}

/// Disconnect and close the recording browser.
#[tauri::command]
pub async fn disconnect_browser(state: State<'_, AppState>) -> Result<(), String> {
    let browser = {
        let mut guard = state.browser.lock().await;
        guard.take().ok_or("No browser to disconnect")?
    };

    // Stop recording if active
    {
        let inner = browser.recording.lock().await;
        if inner.active {
            let _ = interaction::stop_observing(&browser.sidecar).await;
        }
    }

    interaction::disconnect_browser(&browser.sidecar)
        .await
        .map_err(|e| e.to_string())?;

    // BrowserConnection is dropped here → forwarding task is aborted
    Ok(())
}

/// Start recording (observing) in the prepared browser.
///
/// Injects the DOM observer into the active page and begins streaming
/// captured actions to the frontend via the provided channel.
///
/// Returns the session ID.
#[tauri::command]
pub async fn start_recording_session(
    on_action: tauri::ipc::Channel<CapturedAction>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Require an open project
    let project_root = {
        let current = state.current_project.lock().map_err(|e| e.to_string())?;
        match current.as_ref() {
            Some(p) => p.root.clone(),
            None => return Err("No project is currently open".to_string()),
        }
    };

    let browser_guard = state.browser.lock().await;
    let browser = browser_guard.as_ref().ok_or("No browser prepared")?;

    // Check not already recording
    {
        let inner = browser.recording.lock().await;
        if inner.active {
            return Err("Already recording".to_string());
        }
    }

    // Create a new session
    let session = RecordedSession::new(RecordingMode::FreeForm);
    let session_id = session.id.to_string();

    let screenshots_dir = interaction::resolve_screenshots_dir(&project_root, "", &session_id);
    std::fs::create_dir_all(&screenshots_dir).map_err(|e| e.to_string())?;

    // Tell the sidecar to start observing
    interaction::start_observing(&browser.sidecar, &screenshots_dir)
        .await
        .map_err(|e| e.to_string())?;

    // Activate the forwarding task
    {
        let mut inner = browser.recording.lock().await;
        inner.active = true;
        inner.channel = Some(on_action);
        inner.actions.clear();
        inner.session = Some(session);
    }

    Ok(session_id)
}

/// Stop the active recording. The browser stays open for another take.
///
/// Saves the session to disk and returns it.
#[tauri::command]
pub async fn stop_recording_session(state: State<'_, AppState>) -> Result<RecordedSession, String> {
    // Scope: hold browser lock, extract session, release lock
    let session = {
        let browser_guard = state.browser.lock().await;
        let browser = browser_guard.as_ref().ok_or("No browser prepared")?;

        // Stop observing in the sidecar
        interaction::stop_observing(&browser.sidecar)
            .await
            .map_err(|e| e.to_string())?;

        // Deactivate forwarding and extract the session
        let mut inner = browser.recording.lock().await;
        inner.active = false;
        inner.channel = None;

        let actions = std::mem::take(&mut inner.actions);
        let mut session = inner.session.take().ok_or("No recording session")?;
        session.actions = actions;
        session.ended_at = Some(Utc::now());
        session
    };

    // Save to disk (browser lock is released)
    let project_root = {
        let current = state.current_project.lock().map_err(|e| e.to_string())?;
        current
            .as_ref()
            .map(|p| p.root.clone())
            .ok_or("No project open")?
    };

    let _ = interaction::save_session(&session, &project_root, "").map_err(|e| e.to_string())?;

    Ok(session)
}

/// Get the currently captured actions from the active recording.
#[tauri::command]
pub async fn get_session_actions(
    state: State<'_, AppState>,
) -> Result<Vec<CapturedAction>, String> {
    let browser_guard = state.browser.lock().await;
    let browser = browser_guard.as_ref().ok_or("No browser prepared")?;
    let inner = browser.recording.lock().await;
    Ok(inner.actions.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_event_clears_only_its_own_connection() {
        // The current connection's own terminal event clears readiness.
        assert!(terminal_should_clear(Some(7), 7));
    }

    #[test]
    fn stale_terminal_event_cannot_clear_replacement() {
        // A terminal event from a superseded connection (id 1) must not clear
        // the connection that replaced it (id 2).
        assert!(!terminal_should_clear(Some(2), 1));
    }

    #[test]
    fn terminal_event_on_empty_slot_is_noop() {
        assert!(!terminal_should_clear(None, 1));
    }

    #[test]
    fn connection_ids_are_unique_and_monotonic() {
        let a = NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
        let b = NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
        assert!(b > a);
    }
}
