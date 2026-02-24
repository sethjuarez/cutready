use std::path::PathBuf;
use std::sync::Mutex;

use models::script::Project;

mod commands;
mod engine;
mod llm;
mod models;
mod util;

/// Global application state shared across Tauri commands.
pub struct AppState {
    /// Directory where `.cutready` project files are stored.
    pub projects_dir: PathBuf,
    /// The currently open project (if any).
    pub current_project: Mutex<Option<Project>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState {
        projects_dir: default_projects_dir(),
        current_project: Mutex::new(None),
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
        .invoke_handler(tauri::generate_handler![
            commands::project::create_project,
            commands::project::open_project,
            commands::project::save_project,
            commands::project::list_projects,
            commands::project::get_current_project,
            commands::project::delete_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Resolve the default projects directory (~/.cutready/projects).
fn default_projects_dir() -> PathBuf {
    dirs::document_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("CutReady")
        .join("projects")
}
