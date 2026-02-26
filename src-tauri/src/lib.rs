use std::sync::{Arc, Mutex};

use tauri::Emitter;

use models::script::ProjectView;
use models::session::CapturedAction;
use util::sidecar::SidecarManager;

mod commands;
mod engine;
mod llm;
mod models;
mod util;

/// Inner state shared between the forwarding task and command handlers.
pub struct RecordingInner {
    /// Whether we're currently recording (forwarding events to frontend).
    pub active: bool,
    /// The frontend channel to forward captured events to.
    pub channel: Option<tauri::ipc::Channel<CapturedAction>>,
    /// Actions accumulated during the current recording take.
    pub actions: Vec<CapturedAction>,
    /// The current recording session.
    pub session: Option<models::session::RecordedSession>,
}

/// A browser that has been prepared for recording.
///
/// The browser stays open across multiple recording takes.
/// Dropped when the user disconnects.
pub struct BrowserConnection {
    /// The Playwright sidecar managing the browser.
    pub sidecar: SidecarManager,
    /// Which browser channel was used ("chrome", "msedge", "chromium").
    pub browser_channel: String,
    /// Shared recording state — mutated by both the forwarding task and commands.
    pub recording: Arc<tokio::sync::Mutex<RecordingInner>>,
    /// Background task that reads sidecar events and forwards them.
    _forwarding_handle: tokio::task::JoinHandle<()>,
}

impl Drop for BrowserConnection {
    fn drop(&mut self) {
        self._forwarding_handle.abort();
    }
}

/// Global application state shared across Tauri commands.
pub struct AppState {
    /// The currently open project folder (if any).
    pub current_project: Mutex<Option<ProjectView>>,
    /// The prepared browser connection (if any).
    /// Uses `tokio::sync::Mutex` because it's held across await points.
    pub browser: Arc<tokio::sync::Mutex<Option<BrowserConnection>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState {
        current_project: Mutex::new(None),
        browser: Arc::new(tokio::sync::Mutex::new(None)),
    };

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            use tauri_plugin_global_shortcut::{
                Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
            };

            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyR);

            app.global_shortcut()
                .on_shortcut(shortcut, |app_handle, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app_handle.emit("toggle-recording", ());
                    }
                })?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::project::create_project_folder,
            commands::project::open_project_folder,
            commands::project::get_current_project,
            commands::project::close_project,
            commands::project::get_recent_projects,
            commands::project::add_recent_project,
            commands::project::remove_recent_project,
            commands::project::get_last_parent_folder,
            commands::sketch::create_sketch,
            commands::sketch::update_sketch,
            commands::sketch::update_sketch_title,
            commands::sketch::delete_sketch,
            commands::sketch::list_sketches,
            commands::sketch::get_sketch,
            commands::sketch::rename_sketch,
            commands::storyboard::create_storyboard,
            commands::storyboard::get_storyboard,
            commands::storyboard::update_storyboard,
            commands::storyboard::delete_storyboard,
            commands::storyboard::list_storyboards,
            commands::storyboard::add_sketch_to_storyboard,
            commands::storyboard::remove_sketch_from_storyboard,
            commands::storyboard::add_section_to_storyboard,
            commands::storyboard::reorder_storyboard_items,
            commands::versioning::save_with_label,
            commands::versioning::list_versions,
            commands::versioning::preview_version,
            commands::versioning::restore_version,
            commands::versioning::checkout_version,
            commands::versioning::has_unsaved_changes,
            commands::versioning::stash_changes,
            commands::versioning::pop_stash,
            commands::versioning::create_timeline,
            commands::versioning::list_timelines,
            commands::versioning::switch_timeline,
            commands::versioning::delete_timeline,
            commands::versioning::get_timeline_graph,
            commands::versioning::navigate_to_snapshot,
            commands::versioning::has_stash,
            commands::interaction::detect_browser_profiles,
            commands::interaction::check_browsers_running,
            commands::interaction::prepare_browser,
            commands::interaction::disconnect_browser,
            commands::interaction::start_recording_session,
            commands::interaction::stop_recording_session,
            commands::interaction::get_session_actions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
