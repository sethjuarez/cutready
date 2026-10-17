//! Internal Tauri commands for CutReady's Draftline-backed versioning service.

use std::path::{Path, PathBuf};

use draftline::tauri_contract as contract;
#[cfg(test)]
use draftline::VersionId;
use draftline::{
    ApplyIncomingReport, ChangeSet, Contributor, ContributorProfile, HistoryEntry,
    MergeIncomingReport, MilestoneMergeReport, PreflightReport, PreviewFile, RemoteCredential,
    RemoteCredentialRequest, RemoteEndpoint, Shelf, Variation, VariationId, VariationRenamePreflight,
    VariationSummary, Version, VersionDiff, VersionPreview,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_auditaur::auditaur_command;

use crate::commands::github::github_credential_token;
use crate::engine::agent_state::{AgentStateStore, HistoryCleanupLedgerOperation};
use crate::engine::draftline_adapter::{
    cutready_content_policy, cutready_remote_options, is_github_remote_url,
    CutReadyDraftlineAdapter,
};
use crate::{AppState, ProjectLock};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineRemoteEndpointDto {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct DraftlineVariationRequest {
    pub workspace_path: PathBuf,
    pub variation: VariationId,
}

#[derive(Debug, Deserialize)]
pub struct DraftlineSwitchVariationRequest {
    pub workspace_path: PathBuf,
    #[serde(alias = "variation")]
    pub variation_id: VariationId,
    #[serde(default)]
    pub policy: DraftlineSwitchPolicyInput,
}

#[derive(Debug, Deserialize)]
pub struct DraftlineAddRemoteRequest {
    pub workspace_path: PathBuf,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct DraftlineSquashVersionsRequest {
    pub workspace_path: PathBuf,
    pub count: usize,
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
#[derive(Default)]
pub enum DraftlineSwitchPolicyInput {
    #[default]
    AbortIfDirty,
    SaveFirst {
        label: String,
    },
}

#[cfg(test)]
fn draftline_root_from_project_view(view: &crate::models::script::ProjectView) -> PathBuf {
    view.repo_root.clone()
}

/// Error code returned when a command would record a change without knowing
/// who made it. The frontend keys its "add your name and email" prompt on it.
pub const CONTRIBUTOR_IDENTITY_REQUIRED: &str = "contributor_identity_required";
const CONTRIBUTOR_IDENTITY_REQUIRED_MESSAGE: &str =
    "Add your name and email in Settings › Profile so collaborators can see who made this change.";

fn contributor_profile_for(author: crate::engine::identity::ResolvedIdentity) -> ContributorProfile {
    ContributorProfile::new(
        Contributor {
            name: author.name,
            email: author.email,
        },
        Contributor {
            name: "CutReady".to_string(),
            email: Some("app@cutready.local".to_string()),
        },
    )
}

fn cutready_contributor_profile(
    project_root: &Path,
    app: Option<&AppHandle>,
) -> ContributorProfile {
    contributor_profile_for(crate::commands::identity::resolve_identity(
        app,
        Some(project_root),
    ))
}

fn contributor_identity_required_error() -> contract::TauriCommandError {
    contract::TauriCommandError {
        code: CONTRIBUTOR_IDENTITY_REQUIRED.into(),
        message: CONTRIBUTOR_IDENTITY_REQUIRED_MESSAGE.into(),
        details: None,
    }
}

fn contributor_identity_unreadable_error(reason: String) -> contract::TauriCommandError {
    contract::TauriCommandError {
        code: CONTRIBUTOR_IDENTITY_REQUIRED.into(),
        message: format!("{reason}. {CONTRIBUTOR_IDENTITY_REQUIRED_MESSAGE}"),
        details: None,
    }
}

/// Resolve who is acting and refuse when no email is known (or the saved
/// profile can't be read), so commits never fall back to a placeholder author.
fn require_contributor_profile(
    project_root: &Path,
    app: &AppHandle,
) -> contract::TauriCommandResult<ContributorProfile> {
    let author = crate::commands::identity::try_resolve_identity(Some(app), Some(project_root))
        .map_err(contributor_identity_unreadable_error)?;
    commit_profile_for(author)
}

fn commit_profile_for(
    author: crate::engine::identity::ResolvedIdentity,
) -> contract::TauriCommandResult<ContributorProfile> {
    if author.needs_setup {
        return Err(contributor_identity_required_error());
    }
    Ok(contributor_profile_for(author))
}

fn resolve_remote_credential(
    request: RemoteCredentialRequest<'_>,
) -> draftline::Result<RemoteCredential> {
    if request.allows_username_password && is_github_remote_url(request.url) {
        if let Some(credential) = github_credential_token() {
            tracing::trace!(
                source = credential.source,
                "Using GitHub token credential for Draftline remote operation"
            );
            return Ok(RemoteCredential::UsernamePassword {
                username: "x-access-token".to_string(),
                password: credential.token,
            });
        }
    }

    if request.allows_ssh_key {
        return Ok(RemoteCredential::SshAgent {
            username: request.username_from_url.unwrap_or("git").to_string(),
        });
    }

    Ok(RemoteCredential::Default)
}

/// Policy and credentials shared by every Draftline command, without any Tauri
/// handle so tests can drive the contract directly.
fn core_draftline_context(
    profile: ContributorProfile,
) -> Result<contract::DraftlineCommandContext<'static>, String> {
    Ok(contract::DraftlineCommandContext::new()
        .with_content_policy(cutready_content_policy().map_err(|error| error.to_string())?)
        .with_contributor_profile(profile)
        .with_credentials(resolve_remote_credential))
}

fn build_draftline_context(
    project_root: &Path,
    app: Option<AppHandle>,
) -> Result<contract::DraftlineCommandContext<'static>, String> {
    let profile = cutready_contributor_profile(project_root, app.as_ref());
    Ok(with_workspace_events(core_draftline_context(profile)?, app))
}

fn with_workspace_events(
    mut context: contract::DraftlineCommandContext<'static>,
    app: Option<AppHandle>,
) -> contract::DraftlineCommandContext<'static> {
    if let Some(app) = app {
        context = context.with_event_sink(move |event| {
            let _ = app.emit("draftline://workspace_event", event);
        });
    }
    context
}

fn remote_endpoint_to_dto(remote: RemoteEndpoint) -> DraftlineRemoteEndpointDto {
    DraftlineRemoteEndpointDto {
        name: remote.name,
        url: redact_remote_url_credentials(&remote.url),
    }
}

fn current_project_roots(state: &AppState) -> Option<(PathBuf, PathBuf)> {
    state.current_project.lock().ok().and_then(|project| {
        project
            .as_ref()
            .map(|view| (view.repo_root.clone(), view.root.clone()))
    })
}

fn reject_remote_url_credentials(url: &str) -> Result<(), String> {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return Ok(());
    };

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(
            "Remote URLs must not include credentials. Connect GitHub in CutReady settings or use your system credential helper."
                .to_string(),
        );
    }

    Ok(())
}

#[auditaur_command(skip_all, err)]
pub async fn clone_from_url(url: String, dest: String) -> Result<(), String> {
    reject_remote_url_credentials(&url)?;
    let dest_path = PathBuf::from(&dest);
    let credential = is_github_remote_url(&url)
        .then(github_credential_token)
        .flatten();
    if let Some(credential) = credential.as_ref() {
        tracing::debug!(
            source = credential.source,
            "Using GitHub token credential for Draftline clone"
        );
    }
    let mut options = cutready_remote_options(credential.map(|credential| credential.token));
    CutReadyDraftlineAdapter::clone_project_with_options(&url, &dest_path, &mut options)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn context_for_workspace(
    workspace_path: &Path,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::DraftlineCommandContext<'static>> {
    build_draftline_context(workspace_path, Some(app)).map_err(context_error)
}

/// Context for commands that record a new version under the acting contributor.
fn context_for_commit(
    workspace_path: &Path,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::DraftlineCommandContext<'static>> {
    let profile = require_contributor_profile(workspace_path, &app)?;
    core_draftline_context(profile)
        .map(|context| with_workspace_events(context, Some(app)))
        .map_err(context_error)
}

fn context_error(message: String) -> contract::TauriCommandError {
    contract::TauriCommandError {
        code: "cutready_context_error".into(),
        message,
        details: None,
    }
}

#[auditaur_command(skip_all)]
pub async fn open_workspace(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::WorkspaceOpenResult> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::open_workspace_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn clone_workspace(
    request: contract::CloneWorkspaceRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::WorkspaceOpenResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::clone_workspace_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn adopt_workspace(
    request: contract::WorkspaceRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::AdoptWorkspaceResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::adopt_workspace_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn inspect_workspace(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::WorkspaceDiagnostics> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::inspect_workspace_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn verify_workspace(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceVerification> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::verify_workspace_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn list_variations(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Vec<VariationSummary>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::list_variations_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn preflight_rename_variation(
    request: contract::RenameVariationRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<VariationRenamePreflight> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_rename_variation_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn rename_variation(
    request: contract::RenameVariationRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::RenameVariationResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::rename_variation_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all, err)]
pub async fn delete_variation(
    request: DraftlineVariationRequest,
    lock: State<'_, ProjectLock>,
) -> Result<(), String> {
    let _guard = lock.0.lock().map_err(|error| error.to_string())?;
    let adapter = CutReadyDraftlineAdapter::open_project(&request.workspace_path)
        .map_err(|error| error.to_string())?;
    adapter
        .delete_variation(&request.variation)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn preflight_switch_variation(
    request: DraftlineSwitchVariationRequest,
) -> Result<PreflightReport, String> {
    let adapter = CutReadyDraftlineAdapter::open_project(&request.workspace_path)
        .map_err(|error| error.to_string())?;
    adapter
        .preflight_switch_variation(&request.variation_id)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn switch_variation(
    request: DraftlineSwitchVariationRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<Variation, String> {
    let _guard = lock.0.lock().map_err(|error| error.to_string())?;
    let adapter = CutReadyDraftlineAdapter::open_project(&request.workspace_path)
        .map_err(|error| error.to_string())?;
    let policy = match request.policy {
        DraftlineSwitchPolicyInput::AbortIfDirty => draftline::SwitchPolicy::AbortIfDirty,
        // Draftline's SaveFirst commits under git config, so save with the acting
        // user's profile here. A clean workspace saves nothing and needs no author.
        DraftlineSwitchPolicyInput::SaveFirst { label } => {
            let preflight = adapter
                .preflight_switch_variation(&request.variation_id)
                .map_err(|error| error.to_string())?;
            if !preflight.dirty_files.is_empty() {
                let profile = require_contributor_profile(&request.workspace_path, &app)
                    .map_err(|error| error.message)?;
                adapter
                    .save_version_with_profile(&label, &profile)
                    .map_err(|error| error.to_string())?;
            }
            draftline::SwitchPolicy::AbortIfDirty
        }
    };
    adapter
        .switch_variation_with_policy(&request.variation_id, policy)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn add_remote(
    request: DraftlineAddRemoteRequest,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineRemoteEndpointDto, String> {
    reject_remote_url_credentials(&request.url)?;
    let _guard = lock.0.lock().map_err(|error| error.to_string())?;
    let adapter = CutReadyDraftlineAdapter::open_project(&request.workspace_path)
        .map_err(|error| error.to_string())?;
    adapter
        .add_remote(&request.name, &request.url)
        .map(remote_endpoint_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn squash_versions(
    request: DraftlineSquashVersionsRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<Version, String> {
    let _guard = lock.0.lock().map_err(|error| error.to_string())?;
    require_contributor_profile(&request.workspace_path, &app).map_err(|error| error.message)?;
    let adapter = CutReadyDraftlineAdapter::open_project(&request.workspace_path)
        .map_err(|error| error.to_string())?;
    adapter
        .squash_versions(request.count, &request.label)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all)]
pub async fn list_support_refs(
    request: contract::ListSupportRefsRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Vec<draftline::SupportRef>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::list_support_refs_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn get_changes(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<ChangeSet> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_changes_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn get_history(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Vec<HistoryEntry>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_history_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn get_full_history(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Vec<HistoryEntry>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_full_history_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn get_history_compaction_candidates(
    request: contract::HistoryCompactionCandidatesCommandRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::HistoryCompactionCandidates> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_history_compaction_candidates_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn preview_history_cleanup(
    request: contract::PreviewHistoryCleanupRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::HistoryCleanupPreview> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preview_history_cleanup_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn apply_history_cleanup(
    request: contract::ApplyHistoryCleanupRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
    state: State<'_, AppState>,
) -> contract::TauriCommandResult<draftline::TimelineCleanupResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let workspace_path = request.workspace_path.clone();
    let mut context = context_for_commit(&request.workspace_path, app)?;
    let result = contract::into_tauri_result(contract::apply_history_cleanup_with_context(
        &mut context,
        request,
    ))?;
    let (repo_root, project_root) =
        current_project_roots(&state).unwrap_or_else(|| (workspace_path.clone(), workspace_path));
    if let Err(error) = AgentStateStore::record_history_cleanup_result(
        &repo_root,
        &project_root,
        HistoryCleanupLedgerOperation::Apply,
        &result,
    ) {
        tracing::warn!(
            error = %error,
            "Applied Draftline history cleanup but could not record the CutReady agent-state ledger"
        );
    }
    Ok(result)
}

#[auditaur_command(skip_all)]
pub async fn preflight_history_cleanup_remote_impact(
    request: contract::HistoryCleanupRemoteImpactRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::HistoryCleanupRemoteImpact> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(
        contract::preflight_history_cleanup_remote_impact_with_context(&context, request),
    )
}

#[auditaur_command(skip_all)]
pub async fn preflight_publish_history_cleanup(
    request: contract::PublishHistoryCleanupPreflightRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::HistoryCleanupPublishPreflight> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_publish_history_cleanup_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn publish_history_cleanup(
    request: contract::PublishHistoryCleanupRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<draftline::HistoryCleanupPublishResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::publish_history_cleanup_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn resolve_rewritten_version(
    request: contract::ResolveRewrittenVersionRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::StaleVersionResolution> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::resolve_rewritten_version_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn preflight_undo_history_cleanup(
    request: contract::UndoHistoryCleanupPreflightRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::HistoryCleanupUndoPreflight> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_undo_history_cleanup_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn undo_history_cleanup(
    request: contract::UndoHistoryCleanupRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
    state: State<'_, AppState>,
) -> contract::TauriCommandResult<draftline::TimelineCleanupResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let workspace_path = request.workspace_path.clone();
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    let result = contract::into_tauri_result(contract::undo_history_cleanup_with_context(
        &mut context,
        request,
    ))?;
    let (repo_root, project_root) =
        current_project_roots(&state).unwrap_or_else(|| (workspace_path.clone(), workspace_path));
    if let Err(error) = AgentStateStore::record_history_cleanup_result(
        &repo_root,
        &project_root,
        HistoryCleanupLedgerOperation::Undo,
        &result,
    ) {
        tracing::warn!(
            error = %error,
            "Undid Draftline history cleanup but could not record the CutReady agent-state ledger"
        );
    }
    Ok(result)
}

#[auditaur_command(skip_all)]
pub async fn list_pending_history_cleanups(
    request: contract::ListPendingHistoryCleanupsRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Vec<draftline::PendingHistoryCleanup>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::list_pending_history_cleanups_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn publish_pending_history_cleanup(
    request: contract::PublishPendingHistoryCleanupRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<draftline::HistoryCleanupPublishResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::publish_pending_history_cleanup_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn undo_pending_history_cleanup(
    request: contract::UndoPendingHistoryCleanupRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
    state: State<'_, AppState>,
) -> contract::TauriCommandResult<draftline::TimelineCleanupResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let workspace_path = request.workspace_path.clone();
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    let result = contract::into_tauri_result(contract::undo_pending_history_cleanup_with_context(
        &mut context,
        request,
    ))?;
    let (repo_root, project_root) =
        current_project_roots(&state).unwrap_or_else(|| (workspace_path.clone(), workspace_path));
    if let Err(error) = AgentStateStore::record_history_cleanup_result(
        &repo_root,
        &project_root,
        HistoryCleanupLedgerOperation::Undo,
        &result,
    ) {
        tracing::warn!(
            error = %error,
            "Undid pending Draftline history cleanup but could not record the CutReady agent-state ledger"
        );
    }
    Ok(result)
}

#[auditaur_command(skip_all)]
pub async fn abandon_pending_history_cleanup(
    request: contract::AbandonPendingHistoryCleanupRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<draftline::PendingHistoryCleanup> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::abandon_pending_history_cleanup_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph(
    request: contract::WorkspaceGraphRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraph> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_refs(
    request: contract::WorkspaceGraphRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraphRefs> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_refs_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_summary(
    request: contract::WorkspaceGraphRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraphSummary> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_summary_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_overview(
    request: contract::WorkspaceGraphOverviewRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraph> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_overview_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_around_version(
    request: contract::WorkspaceGraphAroundVersionRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraph> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_around_version_with_context(
        &context, request,
    ))
}

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
pub async fn get_workspace_graph_agent_summary(
    request: contract::WorkspaceGraphRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraphAgentSummary> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_agent_summary_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_neighborhood(
    request: contract::WorkspaceGraphNeighborhoodRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraph> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_neighborhood_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn search_workspace_graph(
    request: contract::WorkspaceGraphSearchRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraphSearchResult> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::search_workspace_graph_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_path(
    request: contract::WorkspaceGraphPairRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraphPath> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_path_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_common_ancestor(
    request: contract::WorkspaceGraphPairRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraphCommonAncestor> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_common_ancestor_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_node(
    request: contract::VersionRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraphNodeDetail> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_node_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn get_workspace_graph_compare_summary(
    request: contract::WorkspaceGraphPairRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::WorkspaceGraphCompareSummary> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::get_workspace_graph_compare_summary_with_context(
        &context, request,
    ))
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
pub async fn diff_workspace_file(
    request: contract::CurrentFileRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Option<draftline::CurrentFileDiff>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::diff_workspace_file_with_context(
        &context, request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn preview_version(
    request: contract::VersionRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<VersionPreview> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preview_version_with_context(&context, request))
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

#[auditaur_command(skip_all)]
pub async fn restore_version_as_new_save(
    request: contract::RestoreVersionRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::RestoreVersionResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::restore_version_as_new_save_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn restore_version_as_new_save_to_variation(
    request: contract::TargetedRestoreVersionRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::TargetedRestoreVersionCommandResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(
        contract::restore_version_as_new_save_to_variation_with_context(&mut context, request),
    )
}

#[auditaur_command(skip_all)]
pub async fn save(
    request: contract::SaveRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::SaveResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::save_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn list_shelves(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Vec<Shelf>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::list_shelves_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn apply_shelf(
    request: contract::ShelfRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::ApplyShelfCommandResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::apply_shelf_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn delete_shelf(
    request: contract::ShelfRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::DeleteShelfResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::delete_shelf_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn selected_save(
    request: contract::SelectedSaveRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::SelectedSaveResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::selected_save_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn selected_shelve(
    request: contract::SelectedShelveRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::SelectedShelveResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::selected_shelve_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn selected_discard(
    request: contract::SelectedDiscardRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::SelectedDiscardResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::selected_discard_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn list_remotes(
    request: contract::WorkspaceRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Vec<RemoteEndpoint>> {
    let context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::list_remotes_with_context(&context, request))
}

#[auditaur_command(skip_all)]
pub async fn list_remote_variations(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<Vec<draftline::RemoteVariation>> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::list_remote_variations_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn remote_variation_diagnostics(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<draftline::RemoteVariationDiagnostics> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::remote_variation_diagnostics_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn adopt_remote_variation(
    request: contract::RemoteVariationRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::AdoptRemoteVariationResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::adopt_remote_variation_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn fetch_remote(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::FetchRemoteResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::fetch_remote_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn publish_current_variation(
    request: contract::PublishCurrentVariationRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::PublishCurrentVariationResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::publish_current_variation_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn preflight_apply_incoming(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<ApplyIncomingReport> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_apply_incoming_with_context(
        &mut context,
        request,
    ))
}

/// Ahead/behind counts for the current variation. Unlike the apply-incoming
/// preflight, Draftline does not block this while a history cleanup is
/// pending, so the sync bar can still offer to publish it.
#[auditaur_command(skip_all)]
pub async fn get_sync_status(
    request: contract::RemoteRequest,
) -> contract::TauriCommandResult<draftline::SyncStatus> {
    let adapter = contract::into_tauri_result(CutReadyDraftlineAdapter::open_project(
        &request.workspace_path,
    ))?;
    contract::into_tauri_result(adapter.sync_status(&request.remote))
}

#[auditaur_command(skip_all)]
pub async fn apply_incoming(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::ApplyIncomingCommandResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::apply_incoming_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn preflight_merge_incoming(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<MergeIncomingReport> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_merge_incoming_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn merge_incoming(
    request: contract::MergeIncomingRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::MergeIncomingCommandResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::merge_incoming_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn preflight_milestone_merge(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<MilestoneMergeReport> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_milestone_merge_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn create_milestone_merge(
    request: contract::MilestoneMergeRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::MilestoneMergeCommandResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::create_milestone_merge_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn merge_incoming_with_resolutions(
    request: contract::MergeIncomingWithResolutionsRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::MergeIncomingCommandResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::merge_incoming_with_resolutions_with_context(
        &mut context,
        request,
    ))
}

fn redact_remote_url_credentials(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return url.to_string();
    };

    if parsed.username().is_empty() && parsed.password().is_none() {
        return url.to_string();
    }

    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::script::ProjectView;

    #[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct TypedIdBoundary {
        version: VersionId,
        variation: VariationId,
    }

    #[test]
    fn draftline_commands_scope_to_repo_root_for_nested_projects() {
        let view = ProjectView::in_repo(
            PathBuf::from("D:/workspace"),
            "demos/product-tour",
            "Product tour".to_string(),
        );

        assert_eq!(
            draftline_root_from_project_view(&view),
            PathBuf::from("D:/workspace")
        );
        assert_ne!(draftline_root_from_project_view(&view), view.root);
    }

    #[test]
    fn typed_id_boundary_uses_draftline_serde() {
        let dto: TypedIdBoundary = serde_json::from_value(serde_json::json!({
            "version": "0123456789abcdef0123456789abcdef01234567",
            "variation": "draftline-spike-alt"
        }))
        .unwrap();

        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "version": "0123456789abcdef0123456789abcdef01234567",
                "variation": "draftline-spike-alt"
            })
        );
    }

    #[test]
    fn remote_urls_reject_and_redact_embedded_credentials() {
        assert!(reject_remote_url_credentials("https://github.com/owner/repo.git").is_ok());
        assert!(reject_remote_url_credentials("git@github.com:owner/repo.git").is_ok());
        assert!(reject_remote_url_credentials("https://token@github.com/owner/repo.git").is_err());
        assert!(
            reject_remote_url_credentials("https://user:token@github.com/owner/repo.git").is_err()
        );

        assert_eq!(
            redact_remote_url_credentials("https://user:token@github.com/owner/repo.git"),
            "https://github.com/owner/repo.git"
        );
    }

    #[test]
    fn commits_require_a_known_contributor_email() {
        use crate::engine::identity::{IdentitySource, ResolvedIdentity};
        let anonymous = ResolvedIdentity {
            name: "grace".into(),
            email: None,
            name_source: IdentitySource::System,
            email_source: None,
            profile: None,
            needs_setup: true,
        };
        let error = commit_profile_for(anonymous).unwrap_err();
        assert_eq!(error.code, CONTRIBUTOR_IDENTITY_REQUIRED);
        assert!(error.message.contains("Settings › Profile"));

        let known = ResolvedIdentity {
            name: "Grace Hopper".into(),
            email: Some("grace@example.com".into()),
            name_source: IdentitySource::GitConfig,
            email_source: Some(IdentitySource::GitConfig),
            profile: None,
            needs_setup: false,
        };
        let profile = commit_profile_for(known).unwrap();
        assert_eq!(profile.author.email.as_deref(), Some("grace@example.com"));
        assert_eq!(profile.saved_by.name, "CutReady");
    }

    fn init_bare_remote(path: &Path) {
        let output = git_command()
            .args(["init", "--bare", "--initial-branch=main"])
            .arg(path)
            .output()
            .expect("git init --bare");
        assert!(output.status.success(), "{output:?}");
    }

    fn git_command() -> std::process::Command {
        let mut command = std::process::Command::new("git");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }

    fn last_commit_author(root: &Path) -> String {
        let output = git_command()
            .current_dir(root)
            .args(["log", "-1", "--format=%an <%ae>"])
            .output()
            .expect("git log");
        assert!(output.status.success(), "{output:?}");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn remote_request(root: &Path) -> contract::RemoteRequest {
        contract::RemoteRequest {
            workspace_path: root.to_path_buf(),
            remote: "origin".to_string(),
        }
    }

    fn context(root: &Path) -> contract::DraftlineCommandContext<'static> {
        let name = root.file_name().unwrap().to_string_lossy().to_string();
        let contributor = Contributor {
            email: Some(format!("{name}@collab.test")),
            name,
        };
        core_draftline_context(ContributorProfile::new(
            contributor,
            Contributor {
                name: "CutReady".to_string(),
                email: Some("app@cutready.local".to_string()),
            },
        ))
        .unwrap()
    }

    fn save(root: &Path, label: &str) {
        contract::save_with_context(
            &mut context(root),
            contract::SaveRequest {
                workspace_path: root.to_path_buf(),
                label: label.to_string(),
            },
        )
        .unwrap_or_else(|error| panic!("save {label}: {error}"));
    }

    fn publish(root: &Path) {
        contract::publish_current_variation_with_context(
            &mut context(root),
            contract::PublishCurrentVariationRequest {
                workspace_path: root.to_path_buf(),
                remote: "origin".to_string(),
            },
        )
        .unwrap_or_else(|error| panic!("publish {}: {error}", root.display()));
    }

    fn fetch(root: &Path) {
        contract::fetch_remote_with_context(&mut context(root), remote_request(root))
            .unwrap_or_else(|error| panic!("fetch {}: {error}", root.display()));
    }

    /// Mirrors the desktop sync flow (appStore `syncWithRemote`): two
    /// collaborators diverge, one fetches, merges incoming, and publishes; the
    /// other applies the merged history.
    #[test]
    fn collaborators_merge_and_publish_diverged_saves_through_contract() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        init_bare_remote(&remote);
        let remote_url = remote.to_string_lossy().to_string();

        let first = temp.path().join("first");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::write(first.join("intro.sk"), r#"{"title":"Base"}"#).unwrap();
        CutReadyDraftlineAdapter::open_project(&first)
            .unwrap()
            .add_remote("origin", &remote_url)
            .unwrap();
        save(&first, "Base");
        publish(&first);

        let second = temp.path().join("second");
        contract::clone_workspace_with_context(
            &mut context(&second),
            contract::CloneWorkspaceRequest {
                remote_url: remote_url.clone(),
                workspace_path: second.clone(),
            },
        )
        .expect("clone");

        std::fs::write(second.join("remote.md"), "# From second\n").unwrap();
        save(&second, "Second edit");
        publish(&second);

        std::fs::write(first.join("local.md"), "# From first\n").unwrap();
        save(&first, "First edit");
        fetch(&first);

        let mut first_context = context(&first);
        let preflight = contract::preflight_apply_incoming_with_context(
            &mut first_context,
            remote_request(&first),
        )
        .expect("preflight apply");
        assert!(
            !preflight.can_proceed,
            "diverged history should need a merge: {preflight:?}"
        );

        let merge_report = contract::preflight_merge_incoming_with_context(
            &mut first_context,
            remote_request(&first),
        )
        .expect("preflight merge");
        assert!(merge_report.can_merge_cleanly, "{merge_report:?}");

        contract::merge_incoming_with_context(
            &mut first_context,
            contract::MergeIncomingRequest {
                workspace_path: first.clone(),
                remote: "origin".to_string(),
                label: "Merge incoming saves".to_string(),
            },
        )
        .expect("merge incoming");
        assert!(first.join("remote.md").exists());
        assert_eq!(
            last_commit_author(&first),
            "first <first@collab.test>",
            "merge commits must carry the contributor identity"
        );
        publish(&first);

        fetch(&second);
        contract::apply_incoming_with_context(&mut context(&second), remote_request(&second))
            .expect("apply incoming");
        assert!(second.join("local.md").exists());
    }
}
