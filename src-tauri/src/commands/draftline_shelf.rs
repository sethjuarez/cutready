//! Read-only shelf checks, so a refused restore never closes editors.

use draftline::tauri_contract as contract;
use tauri::AppHandle;
use tauri_plugin_auditaur::auditaur_command;

use super::draftline::context_for_workspace;

/// Which unsaved files would block applying a shelf (`overlapping_files`).
#[auditaur_command(skip_all)]
pub async fn preflight_apply_shelf(
    request: contract::ShelfRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::ShelfApplyReport> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_apply_shelf_with_context(
        &context, request,
    ))
}
