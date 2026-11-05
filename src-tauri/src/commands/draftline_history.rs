//! Read-only history commands: graph, per-document history, diffs, file previews and version file bytes.

use draftline::tauri_contract as contract;
use draftline::{PreviewFile, VersionDiff};
use tauri::AppHandle;
use tauri_plugin_auditaur::auditaur_command;

use super::draftline::context_for_workspace;

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_for_variation(
    request: contract::WorkspaceGraphVariationRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraph> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_for_variation_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_path_history(
    request: contract::PathHistoryRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::PathHistory> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_path_history_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn diff_versions(
    request: contract::DiffVersionsRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<VersionDiff> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::diff_versions_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn diff_version_to_workspace(
    request: contract::VersionRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<VersionDiff> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::diff_version_to_workspace_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn preview_version_file(
    request: contract::PreviewVersionFileRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Option<PreviewFile>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preview_version_file_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn preview_workspace_file(
    request: contract::CurrentFileRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Option<draftline::CurrentFilePreview>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preview_workspace_file_with_context(
        &context, request,
    ))
}

/// A version's copy of one file as base64, capped at `max_bytes` (Draftline
/// defaults to 20 MiB) so images can be compared without writing them out.
#[auditaur_command(skip_all)]
pub async fn read_version_file_bytes(
    request: contract::ReadVersionFileBytesRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Option<contract::VersionFileBytes>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::read_version_file_bytes_with_context(
        &context, request,
    ))
}
