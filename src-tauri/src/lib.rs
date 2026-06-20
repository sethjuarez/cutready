use std::{
    collections::HashSet,
    fs,
    sync::{Arc, Mutex},
};

use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tracing::{Level, Metadata};
use tracing_subscriber::{filter::filter_fn, layer::SubscriberExt, Layer};

use models::script::{ProjectView, RepoView};
use models::session::CapturedAction;
use util::sidecar::SidecarManager;

mod commands;
mod engine;
mod models;
mod util;

const CUTREADY_DIAGNOSTICS_ENV: &str = "CUTREADY_DIAGNOSTICS";
const AUDITAUR_ENV: &str = "AUDITAUR";
const SETTINGS_FILE: &str = "settings.json";
const AUDITAUR_DIAGNOSTICS_SETTING: &str = "auditaurDiagnosticsEnabled";
const MACOS_WINDOW_CORNER_RADIUS: f64 = 12.0;

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct AuditaurDiagnosticsPolicy {
    pub enabled: bool,
    pub release_build: bool,
    pub source: &'static str,
    pub startup_flag_enabled: bool,
    pub auditaur_flag_enabled: bool,
    pub persisted_setting_enabled: Option<bool>,
    pub settings_path: Option<String>,
}

fn configure_auditaur_startup() -> AuditaurDiagnosticsPolicy {
    let startup_flag_enabled = env_flag(CUTREADY_DIAGNOSTICS_ENV);
    let auditaur_flag_enabled = env_flag(AUDITAUR_ENV);
    let (persisted_setting_enabled, settings_path) = read_persisted_auditaur_setting();
    let debug_build = cfg!(debug_assertions);
    let enabled = debug_build
        || startup_flag_enabled
        || auditaur_flag_enabled
        || persisted_setting_enabled == Some(true);
    let source = if debug_build {
        "debug-build"
    } else if startup_flag_enabled {
        "CUTREADY_DIAGNOSTICS"
    } else if auditaur_flag_enabled {
        "AUDITAUR"
    } else if persisted_setting_enabled == Some(true) {
        "feedback-setting"
    } else {
        "disabled"
    };

    if enabled {
        std::env::set_var(AUDITAUR_ENV, "1");
    }

    AuditaurDiagnosticsPolicy {
        enabled,
        release_build: !debug_build,
        source,
        startup_flag_enabled,
        auditaur_flag_enabled,
        persisted_setting_enabled,
        settings_path: settings_path.map(|path| path.display().to_string()),
    }
}

#[cfg(target_os = "macos")]
fn apply_macos_window_rounding(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSColor, NSView, NSWindow};

    let Ok(ns_window_ptr) = window.ns_window() else {
        tracing::warn!("Could not get NSWindow handle for rounded macOS chrome");
        return;
    };
    let Ok(ns_view_ptr) = window.ns_view() else {
        tracing::warn!("Could not get NSView handle for rounded macOS chrome");
        return;
    };

    unsafe {
        let ns_window = &*ns_window_ptr.cast::<NSWindow>();
        ns_window.setOpaque(false);
        ns_window.setBackgroundColor(Some(&NSColor::clearColor()));

        let ns_view = &*ns_view_ptr.cast::<NSView>();
        ns_view.setWantsLayer(true);
        let Some(layer) = ns_view.layer() else {
            tracing::warn!("Could not get NSView layer for rounded macOS chrome");
            return;
        };

        layer.setCornerRadius(MACOS_WINDOW_CORNER_RADIUS);
        layer.setMasksToBounds(true);
        ns_window.invalidateShadow();
    }
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn read_persisted_auditaur_setting() -> (Option<bool>, Option<std::path::PathBuf>) {
    let settings_path =
        dirs::data_dir().map(|data_dir| data_dir.join("com.cutready.app").join(SETTINGS_FILE));
    let Some(settings_path) = settings_path else {
        return (None, None);
    };
    let setting = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|settings| {
            settings
                .get(AUDITAUR_DIAGNOSTICS_SETTING)
                .and_then(|value| value.as_bool())
        });
    (setting, Some(settings_path))
}

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
    /// Steering handle for injecting messages into a running agent loop.
    pub steering: agentive::Steering,
    /// Agent-state run IDs that are actively owned by this process.
    pub active_agent_runs: Arc<Mutex<HashSet<String>>>,
    /// Last chat session summary (updated by frontend, archived on window close).
    pub last_chat_summary: Mutex<Option<(String, String)>>, // (session_id, summary)
}

/// Serializes access to project-level operations that mutate the filesystem or git state.
/// Prevents concurrent git operations, snapshot + checkout races, and write-during-read corruption.
pub struct ProjectLock(pub tokio::sync::Mutex<()>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let auditaur_policy = configure_auditaur_startup();
    let auditaur_enabled = auditaur_policy.enabled;
    if let Err(error) = tracing_log::LogTracer::init() {
        eprintln!("Auditaur log bridge was not installed: {error}");
    }
    let subscriber = tracing_subscriber::registry().with(
        tauri_plugin_auditaur::tracing_layer().with_filter(filter_fn(should_capture_telemetry)),
    );
    if let Err(error) = tracing::subscriber::set_global_default(subscriber) {
        eprintln!("Auditaur tracing subscriber was not installed: {error}");
    }

    fn should_capture_telemetry(metadata: &Metadata<'_>) -> bool {
        let target = metadata.target();
        target.starts_with("cutready")
            || target.starts_with("cutready_lib")
            || target.starts_with("agentive")
            || metadata.level() <= &Level::WARN
    }

    let app_state = AppState {
        current_repo: Mutex::new(None),
        current_project: Mutex::new(None),
        browser: Arc::new(tokio::sync::Mutex::new(None)),
        steering: agentive::Steering::new(),
        active_agent_runs: Arc::new(Mutex::new(HashSet::new())),
        last_chat_summary: Mutex::new(None),
    };

    tauri::Builder::default()
        .manage(app_state)
        .manage(auditaur_policy)
        .manage(ProjectLock(tokio::sync::Mutex::new(())))
        .manage(commands::screenshot::CaptureState(Mutex::new(None)))
        .manage(commands::screenshot::RecordingCountdownState(Mutex::new(
            None,
        )))
        .manage(commands::screenshot::RecordingControlState(Mutex::new(
            None,
        )))
        .manage(commands::screenshot::RecordingPrompterState(Mutex::new(
            None,
        )))
        .manage(commands::terminal::TerminalState::default())
        .manage(commands::recording::RecordingCaptureState(
            tokio::sync::Mutex::new(None),
        ))
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
        .plugin(
            tauri_plugin_auditaur::Builder::new()
                .service_name("cutready")
                .session_name("cutready-app")
                .redact_defaults(true)
                .max_session_bytes(256 * 1024 * 1024)
                .allow_release_builds(auditaur_enabled)
                .build(),
        )
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
            // Deep link: register URL scheme handler on Windows/Linux
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                let _ = app.deep_link().register_all();
            }

            // Deep link: check if app was launched via a deep link URL.
            // Defer the emit so the webview JS event system is initialized first.
            {
                let handle = app.handle().clone();
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let url_strings: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
                    if !url_strings.is_empty() {
                        tauri::async_runtime::spawn(async move {
                            // Give the webview time to initialize its event listeners
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            for url_str in url_strings {
                                let _ = handle.emit("deep-link-received", url_str);
                            }
                        });
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

            // On macOS, use META (Cmd); on Windows/Linux, use CONTROL
            let primary_mod = if cfg!(target_os = "macos") {
                Modifiers::META
            } else {
                Modifiers::CONTROL
            };

            let shortcut = Shortcut::new(Some(primary_mod | Modifiers::SHIFT), Code::KeyR);

            app.global_shortcut()
                .on_shortcut(shortcut, |app_handle, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app_handle.emit("toggle-recording", ());
                    }
                })?;

            let prompter_shortcuts = [
                (
                    Shortcut::new(Some(primary_mod | Modifiers::ALT), Code::ArrowRight),
                    "recording-prompter-next",
                ),
                (
                    Shortcut::new(Some(primary_mod | Modifiers::ALT), Code::ArrowLeft),
                    "recording-prompter-previous",
                ),
                (
                    Shortcut::new(Some(primary_mod | Modifiers::ALT), Code::KeyH),
                    "recording-prompter-toggle-visibility",
                ),
                (
                    Shortcut::new(Some(primary_mod | Modifiers::ALT), Code::KeyT),
                    "recording-prompter-toggle-mode",
                ),
            ];

            for (shortcut, event_name) in prompter_shortcuts {
                app.global_shortcut().on_shortcut(
                    shortcut,
                    move |app_handle, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            let _ = app_handle.emit(event_name, ());
                        }
                    },
                )?;
            }

            // Desktop builds use the React titlebar for deterministic cross-platform chrome.
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    #[cfg(target_os = "macos")]
                    apply_macos_window_rounding(&window);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::project::create_project_folder,
            commands::project::open_project_folder,
            commands::project::get_startup_project_path,
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
            commands::project::get_database_preview,
            commands::project::get_agent_state_database_preview,
            commands::project::list_projects,
            commands::project::is_multi_project,
            commands::project::switch_project,
            commands::project::create_project_in_repo,
            commands::project::delete_project,
            commands::project::rename_project,
            commands::project::migrate_to_multi_project,
            commands::project::transfer_asset,
            commands::project::open_in_terminal,
            commands::project::get_workspace_settings,
            commands::project::set_workspace_settings,
            commands::project::resolve_deep_link,
            commands::diagnostics::dump_diagnostics,
            commands::diagnostics::get_diagnostics_policy,
            commands::diagnostics::get_auditaur_diagnostics,
            commands::diagnostics::clear_auditaur_logs,
            commands::sketch::create_sketch,
            commands::sketch::update_sketch,
            commands::sketch::update_sketch_title,
            commands::sketch::delete_sketch,
            commands::sketch::sketch_used_by_storyboards,
            commands::sketch::list_sketches,
            commands::sketch::get_sketch,
            commands::sketch::set_sketch_lock,
            commands::sketch::set_planning_row_lock,
            commands::sketch::set_planning_cell_lock,
            commands::sketch::get_visual,
            commands::sketch::write_visual_doc,
            commands::sketch::rename_sketch,
            commands::storyboard::create_storyboard,
            commands::storyboard::get_storyboard,
            commands::storyboard::update_storyboard,
            commands::storyboard::set_storyboard_lock,
            commands::storyboard::delete_storyboard,
            commands::storyboard::rename_storyboard,
            commands::storyboard::list_storyboards,
            commands::storyboard::add_sketch_to_storyboard,
            commands::storyboard::remove_sketch_from_storyboard,
            commands::storyboard::add_section_to_storyboard,
            commands::storyboard::reorder_storyboard_items,
            commands::versioning::save_with_label,
            commands::versioning::squash_snapshots,
            commands::versioning::check_git_identity,
            commands::versioning::set_git_identity,
            commands::versioning::list_versions,
            commands::versioning::preview_version,
            commands::versioning::restore_version,
            commands::versioning::checkout_version,
            commands::versioning::has_unsaved_changes,
            commands::versioning::discard_changes,
            commands::versioning::discard_file,
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
            commands::versioning::get_file_diff_content,
            commands::versioning::check_large_files,
            commands::versioning::clone_from_url,
            commands::versioning::merge_timelines,
            commands::versioning::apply_merge_resolution,
            commands::versioning::resolve_merge_conflict,
            commands::versioning::add_git_remote,
            commands::versioning::remove_git_remote,
            commands::versioning::list_git_remotes,
            commands::versioning::detect_git_remote,
            commands::versioning::fetch_git_remote,
            commands::versioning::push_git_remote,
            commands::versioning::get_sync_status,
            commands::versioning::get_github_token,
            commands::versioning::pull_git_remote,
            commands::versioning::list_incoming_commits,
            commands::versioning::list_remote_branches,
            commands::versioning::checkout_remote_branch,
            commands::interaction::detect_browser_profiles,
            commands::interaction::check_browsers_running,
            commands::interaction::prepare_browser,
            commands::interaction::disconnect_browser,
            commands::interaction::start_recording_session,
            commands::interaction::stop_recording_session,
            commands::interaction::get_session_actions,
            commands::recording::initialize_recording_storage,
            commands::recording::clear_local_recordings,
            commands::recording::check_ffmpeg_status,
            commands::recording::discover_recording_devices,
            commands::recording::get_recording_platform_capabilities,
            commands::recording::discover_camera_formats,
            commands::recording::get_recording_prompter_script,
            commands::recording::create_recording_take,
            commands::recording::start_recording_take,
            commands::recording::stop_recording_take,
            commands::recording::discard_recording_take,
            commands::recording::get_recording_audio_level,
            commands::recording::open_recording_take_folder,
            commands::screenshot::list_monitors,
            commands::screenshot::capture_region,
            commands::screenshot::capture_fullscreen,
            commands::screenshot::capture_all_monitors,
            commands::screenshot::open_capture_window,
            commands::screenshot::close_capture_window,
            commands::screenshot::crop_screenshot,
            commands::screenshot::get_capture_params,
            commands::screenshot::get_recording_countdown_params,
            commands::screenshot::open_recording_countdown_window,
            commands::screenshot::close_recording_countdown_window,
            commands::screenshot::get_recording_control_params,
            commands::screenshot::open_recorder_window,
            commands::screenshot::open_recording_control_window,
            commands::screenshot::close_recording_control_window,
            commands::screenshot::get_recording_prompter_params,
            commands::screenshot::open_recording_prompter_window,
            commands::screenshot::close_recording_prompter_window,
            commands::screenshot::save_recording_control_position,
            commands::screenshot::open_preview_window,
            commands::screenshot::close_preview_window,
            commands::note::create_note,
            commands::note::get_note,
            commands::note::get_note_lock,
            commands::note::set_note_lock,
            commands::note::update_note,
            commands::note::delete_note,
            commands::note::rename_note,
            commands::note::list_notes,
            commands::note::save_pasted_image,
            commands::note::list_project_images,
            commands::note::delete_project_image,
            commands::note::delete_orphaned_images,
            commands::note::import_image,
            commands::note::read_project_image,
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
            commands::agent::list_agent_runs,
            commands::agent::get_agent_run,
            commands::agent::has_active_agent_run,
            commands::agent::delete_agent_run,
            commands::agent::prune_agent_runs,
            commands::agent::compact_agent_state_database,
            commands::agent::fetch_url_content,
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
            commands::agent::list_azure_subscriptions,
            commands::agent::list_azure_ai_resources,
            commands::agent::list_foundry_projects,
            commands::feedback::save_feedback,
            commands::feedback::list_feedback,
            commands::feedback::clear_feedback,
            commands::feedback::delete_feedback,
            commands::feedback::export_logs,
            commands::feedback::create_github_issue,
            commands::terminal::terminal_open,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { .. } if window.label() == "main" => {
                    // Archive any pending chat summary before the window closes
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<AppState>() {
                        let summary = state.last_chat_summary.lock().unwrap().take();
                        let root = state
                            .current_project
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|p| p.root.clone());
                        if let (Some((session_id, text)), Some(root)) = (summary, root) {
                            let _ =
                                crate::engine::memory::archive_session(&root, &text, &session_id);
                        }
                    }
                }
                tauri::WindowEvent::Destroyed if window.label() == "main" => {
                    // Close preview and capture windows when main window closes
                    let app = window.app_handle();
                    if let Some(terminals) = app.try_state::<commands::terminal::TerminalState>() {
                        terminals.close_all();
                    }
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
