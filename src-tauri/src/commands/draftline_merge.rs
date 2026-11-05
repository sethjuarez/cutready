//! Merges pinned to the token the user previewed, so a merge never includes
//! versions the preview didn't show.

use draftline::tauri_contract as contract;
use tauri::AppHandle;
use tauri_plugin_auditaur::auditaur_command;

use super::draftline::{context_error, context_for_commit};
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
