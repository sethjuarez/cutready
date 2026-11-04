//! Commands that record a new version. Names are validated here (≤ 72 characters).

use cutready_versioning::naming::version_name_for_command;
use draftline::tauri_contract as contract;
use tauri::AppHandle;
use tauri_plugin_auditaur::auditaur_command;

use super::draftline::{context_error, context_for_commit};
use crate::engine::write_lock;

#[auditaur_command(skip_all)]
pub async fn save(
    mut request: contract::SaveRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::SaveResult> {
    request.label = version_name_for_command(&request.label)?;
    let _guard = write_lock::lock(&request.workspace_path).map_err(context_error)?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::save_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn selected_save(
    mut request: contract::SelectedSaveRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::SelectedSaveResult> {
    request.label = version_name_for_command(&request.label)?;
    let _guard = write_lock::lock(&request.workspace_path).map_err(context_error)?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::selected_save_with_context(&mut context, request))
}

/// Restores the whole project from an earlier version as a new version.
#[auditaur_command(skip_all)]
pub async fn restore_version_as_new_save(
    mut request: contract::RestoreVersionRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::RestoreVersionResult> {
    request.label = version_name_for_command(&request.label)?;
    let _guard = write_lock::lock(&request.workspace_path).map_err(context_error)?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::restore_version_as_new_save_with_context(
        &mut context,
        request,
    ))
}

/// Restores selected documents from an earlier version as a new version.
#[auditaur_command(skip_all)]
pub async fn restore_version_paths_as_new_save(
    mut request: contract::RestoreVersionPathsRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::RestoreVersionResult> {
    request.label = version_name_for_command(&request.label)?;
    let _guard = write_lock::lock(&request.workspace_path).map_err(context_error)?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::restore_version_paths_as_new_save_with_context(
        &mut context,
        request,
    ))
}
