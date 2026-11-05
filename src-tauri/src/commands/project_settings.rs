//! The settings a hybrid project's `.draftline` marker records: the branch
//! its saves go into and the template its version labels follow.

use draftline::tauri_contract as contract;
use tauri::AppHandle;
use tauri_plugin_auditaur::auditaur_command;

use super::draftline::{context_error, context_for_commit, context_for_workspace};
use crate::engine::write_lock;

#[auditaur_command(skip_all)]
pub async fn project_settings(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::ProjectSettings> {
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::project_settings_with_context(
        &mut context,
        request,
    ))
}

/// Saves new settings into `.draftline` as its own version. Null clears a
/// setting; nothing is saved when they already match.
#[auditaur_command(skip_all)]
pub async fn update_project_settings(
    request: contract::UpdateProjectSettingsRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::ProjectSettings> {
    let _guard = write_lock::lock(&request.workspace_path).map_err(context_error)?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::update_project_settings_with_context(
        &mut context,
        request,
    ))
}
