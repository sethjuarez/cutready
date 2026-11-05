//! Merges pinned to the token the user previewed, so a merge never includes
//! versions the preview didn't show.

use draftline::tauri_contract as contract;
use tauri::AppHandle;
use tauri_plugin_auditaur::auditaur_command;

use super::draftline::{
    canonicalize_sketch_resolutions, context_error, context_for_commit, context_for_workspace,
};
use crate::engine::write_lock;

/// Clean incoming or base merge; refuses with `local_state_changed` or
/// `remote_race` if either head moved since the preview.
#[auditaur_command(skip_all)]
pub async fn merge_incoming_with_token(
    request: contract::MergeIncomingWithTokenRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::MergeIncomingCommandResult> {
    let _guard = write_lock::lock(&request.workspace_path).map_err(context_error)?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::merge_incoming_with_token_with_context(
        &mut context,
        request,
    ))
}

/// Previews merging another local timeline into the current one. Read-only;
/// the token it returns (`local: true`) pins the merge to these heads.
#[auditaur_command(skip_all)]
pub async fn preflight_merge_variation(
    request: contract::PreflightMergeVariationRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::MergeIncomingReport> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_merge_variation_with_context(
        &context, request,
    ))
}

/// Merges a local timeline into the current one as a two-parent named
/// version: clean with no resolutions, or with the user's resolutions.
#[auditaur_command(skip_all)]
pub async fn merge_variation_with_resolutions(
    mut request: contract::MergeVariationWithResolutionsRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::MergeIncomingCommandResult> {
    let _guard = write_lock::lock(&request.workspace_path).map_err(context_error)?;
    canonicalize_sketch_resolutions(&mut request.resolutions)?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::merge_variation_with_resolutions_with_context(
        &mut context,
        request,
    ))
}
