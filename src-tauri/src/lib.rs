use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

use models::script::{ProjectView, RepoView};
use models::session::CapturedAction;
use util::sidecar::SidecarManager;

mod commands;
mod engine;
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
    /// The currently open repository (if any).
    pub current_repo: Mutex<Option<RepoView>>,
    /// The active project within the repo. In single-project mode, root == repo root.
    /// All existing `project_root()` callers read from this field — no changes needed.
    pub current_project: Mutex<Option<ProjectView>>,
    /// The prepared browser connection (if any).
    /// Uses `tokio::sync::Mutex` because it's held across await points.
    pub browser: Arc<tokio::sync::Mutex<Option<BrowserConnection>>>,
    /// Pending chat messages queued by the user while the agent loop is running.
    pub pending_chat_messages: Arc<Mutex<Vec<String>>>,
    /// Last chat session summary (updated by frontend, archived on window close).
    pub last_chat_summary: Mutex<Option<(String, String)>>, // (session_id, summary)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState {
        current_repo: Mutex::new(None),
        current_project: Mutex::new(None),
        browser: Arc::new(tokio::sync::Mutex::new(None)),
        pending_chat_messages: Arc::new(Mutex::new(Vec::new())),
        last_chat_summary: Mutex::new(None),
    };

    tauri::Builder::default()
        .manage(app_state)
        .manage(commands::screenshot::CaptureState(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&["capture", "preview"])
                .build(),
        )
        .plugin({
            let mut builder = tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .filter(|metadata| {
                    !metadata.target().starts_with("tao::")
                        && !metadata.target().starts_with("tauri_plugin_updater")
                        && !metadata.target().starts_with("reqwest::connect")
                });

            #[cfg(debug_assertions)]
            {
                builder = builder
                    .level(log::LevelFilter::Debug)
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("dev-trace".into()),
                        }),
                    ]);
            }
            #[cfg(not(debug_assertions))]
            {
                builder = builder.targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ]);
            }

            builder.build()
        })
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // On Windows/Linux, deep link URLs arrive as CLI args via single-instance
            for arg in &args {
                if arg.starts_with("cutready://") {
                    let _ = app.emit("deep-link-received", arg.clone());
                }
            }
            // Focus the main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Initialize dev trace logger (no-op in release builds)
            crate::util::trace::init();

            // Deep link: register URL scheme handler on Windows/Linux
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                let _ = app.deep_link().register_all();
            }

            // Deep link: check if app was launched via a deep link URL
            {
                let handle = app.handle().clone();
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        let url_str: String = url.to_string();
                        let _ = handle.emit("deep-link-received", url_str);
                    }
                }
            }

            // Deep link: listen for URLs arriving while app is running (macOS)
            {
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let _ = handle.emit("deep-link-received", url.to_string());
                    }
                });
            }

            // Stronghold: encrypted vault for secrets (API keys, tokens).
            // Salt file auto-created in app_local_data_dir on first run.
            let salt_path = app
                .path()
                .app_local_data_dir()
                .expect("could not resolve app local data path")
                .join("salt.txt");
            app.handle()
                .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())?;

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
            commands::project::get_sidebar_order,
            commands::project::set_sidebar_order,
            commands::project::get_workspace_state,
            commands::project::set_workspace_state,
            commands::project::list_all_files,
            commands::project::list_projects,
            commands::project::is_multi_project,
            commands::project::switch_project,
            commands::project::create_project_in_repo,
            commands::project::delete_project,
            commands::project::rename_project,
            commands::project::migrate_to_multi_project,
            commands::project::get_workspace_settings,
            commands::project::set_workspace_settings,
            commands::project::resolve_deep_link,
            commands::sketch::create_sketch,
            commands::sketch::update_sketch,
            commands::sketch::update_sketch_title,
            commands::sketch::delete_sketch,
            commands::sketch::sketch_used_by_storyboards,
            commands::sketch::list_sketches,
            commands::sketch::get_sketch,
            commands::sketch::get_visual,
            commands::sketch::write_visual_doc,
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
            commands::versioning::check_git_identity,
            commands::versioning::set_git_identity,
            commands::versioning::list_versions,
            commands::versioning::preview_version,
            commands::versioning::restore_version,
            commands::versioning::checkout_version,
            commands::versioning::has_unsaved_changes,
            commands::versioning::discard_changes,
            commands::versioning::stash_changes,
            commands::versioning::pop_stash,
            commands::versioning::create_timeline,
            commands::versioning::list_timelines,
            commands::versioning::switch_timeline,
            commands::versioning::delete_timeline,
            commands::versioning::promote_timeline,
            commands::versioning::get_timeline_graph,
            commands::versioning::navigate_to_snapshot,
            commands::versioning::has_stash,
            commands::versioning::save_editor_state,
            commands::versioning::load_editor_state,
            commands::versioning::is_rewound,
            commands::versioning::diff_snapshots,
            commands::versioning::diff_working_tree,
            commands::versioning::check_large_files,
            commands::versioning::clone_from_url,
            commands::versioning::merge_timelines,
            commands::versioning::apply_merge_resolution,
            commands::versioning::add_git_remote,
            commands::versioning::remove_git_remote,
            commands::versioning::list_git_remotes,
            commands::versioning::detect_git_remote,
            commands::versioning::fetch_git_remote,
            commands::versioning::push_git_remote,
            commands::versioning::get_sync_status,
            commands::versioning::get_github_token,
            commands::versioning::pull_git_remote,
            commands::versioning::list_remote_branches,
            commands::versioning::checkout_remote_branch,
            commands::interaction::detect_browser_profiles,
            commands::interaction::check_browsers_running,
            commands::interaction::prepare_browser,
            commands::interaction::disconnect_browser,
            commands::interaction::start_recording_session,
            commands::interaction::stop_recording_session,
            commands::interaction::get_session_actions,
            commands::screenshot::list_monitors,
            commands::screenshot::capture_region,
            commands::screenshot::capture_fullscreen,
            commands::screenshot::capture_all_monitors,
            commands::screenshot::open_capture_window,
            commands::screenshot::close_capture_window,
            commands::screenshot::crop_screenshot,
            commands::screenshot::get_capture_params,
            commands::screenshot::open_preview_window,
            commands::screenshot::close_preview_window,
            commands::note::create_note,
            commands::note::get_note,
            commands::note::update_note,
            commands::note::delete_note,
            commands::note::list_notes,
            commands::note::save_pasted_image,
            commands::note::list_project_images,
            commands::note::delete_project_image,
            commands::note::delete_orphaned_images,
            commands::note::import_image,
            commands::import::import_docx,
            commands::import::import_pdf,
            commands::import::import_pptx,
            commands::import::import_markdown,
            commands::import::import_sketch,
            commands::import::import_storyboard,
            commands::agent::list_models,
            commands::agent::agent_chat,
            commands::agent::agent_chat_with_tools,
            commands::agent::push_pending_chat_message,
            commands::agent::fetch_url_content,
            commands::agent::check_copilot_available,
            commands::agent::list_copilot_models,
            commands::agent::agent_chat_with_copilot,
            commands::agent::agent_chat_copilot_simple,
            commands::agent::list_chat_sessions,
            commands::agent::get_chat_session,
            commands::agent::save_chat_session,
            commands::agent::delete_chat_session,
            commands::agent::get_memory_context,
            commands::agent::archive_chat_session,
            commands::agent::update_chat_summary,
            commands::agent::list_memories,
            commands::agent::delete_memory,
            commands::agent::update_memory,
            commands::agent::clear_memories,
            commands::agent::azure_device_code_start,
            commands::agent::azure_device_code_poll,
            commands::agent::azure_token_refresh,
            commands::agent::azure_browser_auth_start,
            commands::agent::azure_browser_auth_complete,
            commands::feedback::save_feedback,
            commands::feedback::list_feedback,
            commands::feedback::clear_feedback,
            commands::feedback::delete_feedback,
            commands::feedback::export_logs,
            commands::feedback::create_github_issue,
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { .. } if window.label() == "main" => {
                    // Archive any pending chat summary before the window closes
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<AppState>() {
                        let summary = state.last_chat_summary.lock().unwrap().take();
                        let root = state.current_project.lock().unwrap()
                            .as_ref().map(|p| p.root.clone());
                        if let (Some((session_id, text)), Some(root)) = (summary, root) {
                            let _ = crate::engine::memory::archive_session(&root, &text, &session_id);
                        }
                    }
                }
                tauri::WindowEvent::Destroyed if window.label() == "main" => {
                    // Close preview and capture windows when main window closes
                    let app = window.app_handle();
                    for label in &["preview", "capture"] {
                        if let Some(w) = app.get_webview_window(label) {
                            let _ = w.destroy();
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
