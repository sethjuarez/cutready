//! Credential vault location for the frontend Stronghold client.

use tauri::{AppHandle, Manager};
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::secret_vault;

/// Returns the Stronghold vault path, moving a vault left by older builds into place.
#[auditaur_command(skip_all, err)]
pub async fn secret_vault_path(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let path = secret_vault::resolve_and_migrate(&dir).map_err(|error| error.to_string())?;
    path.into_os_string()
        .into_string()
        .map_err(|_| "credential vault path is not valid Unicode".to_string())
}
