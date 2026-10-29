//! Internal Tauri commands for CutReady's Draftline-backed versioning service.

use std::path::{Path, PathBuf};

use draftline::tauri_contract as contract;
#[cfg(test)]
use draftline::VersionId;
use draftline::{
    ApplyIncomingReport, ChangeSet, ContributorProfile, HistoryEntry, MergeIncomingReport,
    OutgoingFileKind, PreflightReport, PreviewFile, PullRequestProvider, RemoteCredential,
    RemoteCredentialRequest, RemoteEndpoint, RemoteOptions, SendRequest, SendResult, Shelf,
    Variation, VariationId, VariationRenamePreflight, VariationSummary, VersionDiff,
    VersionPreview,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_auditaur::auditaur_command;

use crate::commands::github::github_credential_token;
use crate::engine::draftline_adapter::{
    contributor_profile_for, cutready_content_policy, cutready_remote_options,
    is_github_remote_url, namespaced_variation_name, CutReadyDraftlineAdapter,
    CUTREADY_VARIATION_NAMESPACE,
};
use crate::engine::github_pull_requests::GitHubPullRequestProvider;
use crate::ProjectLock;

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
/// Hybrid projects (a folder inside a code repository) only see CutReady's
/// `cutready/*` variations plus the default and current branch.
fn core_draftline_context(
    workspace_path: &Path,
    profile: ContributorProfile,
) -> Result<contract::DraftlineCommandContext<'static>, String> {
    let context = contract::DraftlineCommandContext::new()
        .with_content_policy(cutready_content_policy().map_err(|error| error.to_string())?)
        .with_contributor_profile(profile)
        .with_credentials(resolve_remote_credential);
    if is_hybrid_workspace(workspace_path) {
        context
            .with_variation_namespace(CUTREADY_VARIATION_NAMESPACE)
            .map_err(|error| error.to_string())
    } else {
        Ok(context)
    }
}

fn is_hybrid_workspace(workspace_path: &Path) -> bool {
    crate::engine::project::hybrid_git_root(workspace_path).is_some()
}

/// Names for new or renamed variations land under `cutready/` in hybrid
/// projects so they stay visible and never collide with developer branches.
fn hybrid_variation_name(workspace_path: &Path, name: &str) -> String {
    namespaced_variation_name(is_hybrid_workspace(workspace_path), name)
}

fn namespace_rename_request(
    mut request: contract::RenameVariationRequest,
) -> contract::RenameVariationRequest {
    request.target_variation_id =
        hybrid_variation_name(&request.workspace_path, &request.target_variation_id);
    request
}

fn namespace_create_request(
    mut request: contract::PreflightCreateVariationFromVersionRequest,
) -> contract::PreflightCreateVariationFromVersionRequest {
    request.name = hybrid_variation_name(&request.workspace_path, &request.name);
    request
}

fn namespace_restore_request(
    mut request: contract::TargetedRestoreVersionRequest,
) -> contract::TargetedRestoreVersionRequest {
    if let draftline::RestoreVersionTarget::New { name, .. } = &mut request.target {
        *name = hybrid_variation_name(&request.workspace_path, name);
    }
    request
}

fn build_draftline_context(
    project_root: &Path,
    app: Option<AppHandle>,
) -> Result<contract::DraftlineCommandContext<'static>, String> {
    let profile = cutready_contributor_profile(project_root, app.as_ref());
    Ok(with_workspace_events(
        core_draftline_context(project_root, profile)?,
        app,
    ))
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
    core_draftline_context(workspace_path, profile)
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
pub async fn clear_stale_lock(
    request: contract::WorkspaceRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::CommandPostconditions> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::clear_stale_lock_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn repair_recovery(
    request: contract::RecoveryRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<draftline::RecoveryRepairResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::repair_recovery_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn rollback_recovery(
    request: contract::RecoveryRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<draftline::RecoveryRepairResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::rollback_recovery_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn acknowledge_recovery(
    request: contract::WorkspaceRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::CommandPostconditions> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::acknowledge_recovery_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn filtered_files(
    request: contract::FilteredFilesRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<Vec<draftline::FilteredFile>> {
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::filtered_files_with_context(&mut context, request))
}

/// Writes the real content of managed files that still hold an LFS pointer
/// (for example after a stopped or offline download). True when anything
/// was written.
#[auditaur_command(skip_all)]
pub async fn retry_content_download(
    request: contract::WorkspaceRequest,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<bool> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let adapter = CutReadyDraftlineAdapter::open_project(&request.workspace_path)
        .map_err(contract::TauriCommandError::from)?;
    adapter
        .smudge_pointer_files()
        .map_err(contract::TauriCommandError::from)
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
    let request = namespace_rename_request(request);
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
    let request = namespace_rename_request(request);
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

/// Preflights a new branch from a version. In hybrid projects the requested
/// name is prefixed with `cutready/`; the returned token carries that name so
/// the guarded create below needs no further rewriting.
#[auditaur_command(skip_all)]
pub async fn preflight_create_variation_from_version(
    request: contract::PreflightCreateVariationFromVersionRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::VariationCreatePreflight> {
    let request = namespace_create_request(request);
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(
        contract::preflight_create_variation_from_version_with_context(&mut context, request),
    )
}

#[auditaur_command(skip_all)]
pub async fn create_variation_from_version_guarded(
    request: contract::GuardedCreateVariationFromVersionRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::GuardedCreateVariationFromVersionResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(
        contract::create_variation_from_version_guarded_with_context(&mut context, request),
    )
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
    let request = namespace_restore_request(request);
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

#[derive(Debug, Clone, Deserialize)]
pub struct MoveProjectFolderRequest {
    pub workspace_path: PathBuf,
    /// Destination relative to the repository root; empty or `.` for the root.
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveProjectFolderResult {
    /// Where the project lives now; reopen it here.
    pub project_root: PathBuf,
    /// Old and new folder, relative to the repository root (empty = root).
    pub from: String,
    pub to: String,
    /// True when the project is now a folder inside a larger repository.
    pub hybrid: bool,
    /// Untracked files that stayed at the old location, repository-relative.
    pub left_behind: Vec<String>,
}

/// A destination folder relative to the repository root, using plain names
/// only. Hidden names are refused so the project never lands in `.git`,
/// `.cutready`, or another tool's metadata.
fn destination_folder(to: &str) -> Result<PathBuf, String> {
    let to = to.trim().replace('\\', "/");
    let mut folder = PathBuf::new();
    for part in to
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
    {
        if part == ".." || part.starts_with('.') || part.contains(':') {
            return Err(format!(
                "\"{part}\" can't be part of the destination; use a folder inside the repository"
            ));
        }
        folder.push(part);
    }
    Ok(folder)
}

fn folder_label(folder: &Path) -> String {
    folder.to_string_lossy().replace('\\', "/")
}

/// Move the CutReady folder to another place in its repository as one save.
/// Local runtime state (chat and run history, tabs, sidebar order) moves first
/// so a live run refuses the move before any content changes; it moves back if
/// Draftline refuses.
#[auditaur_command(skip_all)]
pub async fn move_project_folder(
    request: MoveProjectFolderRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
    state: State<'_, crate::AppState>,
) -> contract::TauriCommandResult<MoveProjectFolderResult> {
    let _guard = lock
        .0
        .lock()
        .map_err(|error| context_error(error.to_string()))?;
    let mut context = context_for_commit(&request.workspace_path, app)?;
    let result = move_project_folder_with_context(&mut context, &request)?;

    // The old path is gone; nothing may keep writing there until the frontend
    // reopens the project at its new home.
    if let Ok(mut current) = state.current_project.lock() {
        *current = None;
    }
    if let Ok(mut repo) = state.current_repo.lock() {
        *repo = None;
    }
    Ok(result)
}

fn move_project_folder_with_context(
    context: &mut contract::DraftlineCommandContext<'_>,
    request: &MoveProjectFolderRequest,
) -> contract::TauriCommandResult<MoveProjectFolderResult> {
    let to = destination_folder(&request.to).map_err(|message| contract::TauriCommandError {
        code: "invalid_destination".into(),
        message,
        details: None,
    })?;
    let root = request.workspace_path.clone();
    let (git_dir, from) = crate::engine::project::folder_git_location(&root).ok_or_else(|| {
        context_error(format!("{} isn't inside a Git repository", root.display()))
    })?;
    let work_tree = crate::engine::project::hybrid_git_root(&root).unwrap_or_else(|| root.clone());

    let old_state = crate::engine::project::folder_state_dir(&git_dir, &from);
    let new_state = crate::engine::project::folder_state_dir(&git_dir, &to);
    if cfg!(any(windows, target_os = "macos"))
        && from != to
        && folder_label(&from).eq_ignore_ascii_case(&folder_label(&to))
    {
        return Err(contract::TauriCommandError {
            code: "folder_move_refused".into(),
            message: "cannot move the Draftline folder: changing only the letter case isn't supported here; pick a different name".into(),
            details: None,
        });
    }
    if from != to {
        crate::engine::project::move_folder_state(&old_state, &new_state).map_err(|error| {
            contract::TauriCommandError {
                code: "project_state_busy".into(),
                message: format!(
                    "CutReady couldn't move this project's chat and run history: {error}. Stop any running agent and try again."
                ),
                details: None,
            }
        })?;
    }
    let moved = contract::into_tauri_result(contract::move_folder_with_context(
        context,
        contract::MoveFolderRequest {
            workspace_path: root.clone(),
            to: to.clone(),
        },
    ));
    let moved = match moved {
        Ok(moved) => moved,
        Err(error) => {
            if from != to {
                if let Err(state_error) =
                    crate::engine::project::move_folder_state(&new_state, &old_state)
                {
                    tracing::warn!(%state_error, "could not move project state back after a refused folder move");
                    // Content stayed put but local history didn't; say so instead of "nothing moved".
                    return Err(contract::TauriCommandError {
                        code: "project_state_stranded".into(),
                        message: format!(
                            "CutReady didn't move the project ({}), but couldn't put its chat and run history back ({state_error}). Close CutReady and move {} back to {} to restore it.",
                            error.message,
                            new_state.display(),
                            old_state.display()
                        ),
                        details: None,
                    });
                }
            }
            return Err(error);
        }
    };

    let project_root = if to.as_os_str().is_empty() {
        work_tree.clone()
    } else {
        work_tree.join(&to)
    };
    let mut left_behind: Vec<String> = moved
        .moved
        .left_behind
        .iter()
        .map(|path| folder_label(path))
        .collect();
    if from.as_os_str().is_empty() {
        left_behind.extend(
            crate::engine::project::carry_root_metadata(&root, &project_root)
                .iter()
                .map(|path| folder_label(path)),
        );
    }

    Ok(MoveProjectFolderResult {
        hybrid: !to.as_os_str().is_empty(),
        project_root,
        from: folder_label(&from),
        to: folder_label(&to),
        left_behind,
    })
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

/// Send for review (hybrid projects only): push the current `cutready/*`
/// branch, or move saves off the base branch onto a new one, and open or reuse
/// a GitHub pull request.
#[derive(Debug, Deserialize)]
pub struct SendForReviewRequest {
    pub workspace_path: PathBuf,
    pub remote: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
}

pub const SEND_REQUIRES_HYBRID: &str = "send_requires_hybrid";
pub const SEND_HAS_LFS_POINTERS: &str = "send_has_lfs_pointers";

fn send_error(code: &str, message: impl Into<String>) -> contract::TauriCommandError {
    contract::TauriCommandError {
        code: code.into(),
        message: message.into(),
        details: None,
    }
}

/// Runs Send with an injectable pull request provider so tests can avoid the
/// network. Blocks on git and HTTP I/O.
fn send_for_review_with(
    request: SendForReviewRequest,
    provider_for: impl FnOnce(&str) -> draftline::Result<Box<dyn PullRequestProvider>>,
    options: &mut RemoteOptions<'_>,
) -> contract::TauriCommandResult<SendResult> {
    let title = request.title.trim();
    if title.is_empty() {
        return Err(send_error(
            "invalid_request",
            "A pull request title is required.",
        ));
    }
    let adapter = contract::into_tauri_result(CutReadyDraftlineAdapter::open_project(
        &request.workspace_path,
    ))?;
    if !adapter.is_hybrid() {
        return Err(send_error(
            SEND_REQUIRES_HYBRID,
            "Send for review is only available for CutReady projects inside a code repository.",
        ));
    }
    let remote_url = contract::into_tauri_result(adapter.remotes())?
        .into_iter()
        .find(|remote| remote.name == request.remote)
        .map(|remote| remote.url)
        .ok_or_else(|| {
            send_error(
                "remote_not_found",
                format!("Remote `{}` is not configured.", request.remote),
            )
        })?;
    let mut send_request = SendRequest {
        title: title.to_string(),
        body: request.body.unwrap_or_default(),
        base: request
            .base
            .map(|base| base.trim().to_string())
            .filter(|base| !base.is_empty()),
        branch: None,
        expected: None,
    };
    let preflight = contract::into_tauri_result(adapter.preflight_send(
        &request.remote,
        &send_request,
        options,
    ))?;
    // Draftline uploads LFS content before pushing (`uploaded`) only where it
    // runs the LFS filter; other pointers would reference content the remote
    // doesn't have.
    let lfs_pointers: Vec<String> = preflight
        .outgoing_files
        .iter()
        .filter(|file| file.kind == OutgoingFileKind::LfsPointer && !file.uploaded)
        .map(|file| file.path.to_string_lossy().replace('\\', "/"))
        .collect();
    if !lfs_pointers.is_empty() {
        return Err(contract::TauriCommandError {
            code: SEND_HAS_LFS_POINTERS.into(),
            message: format!(
                "Send would push Git LFS pointers without their content: {}",
                lfs_pointers.join(", ")
            ),
            details: Some(serde_json::json!({ "paths": lfs_pointers })),
        });
    }
    // Send refuses if anything it checked changed since this preflight.
    send_request.expected = Some(preflight.token);
    let mut provider = contract::into_tauri_result(provider_for(&remote_url))?;
    contract::into_tauri_result(adapter.send_for_review(
        &request.remote,
        &send_request,
        provider.as_mut(),
        options,
    ))
}

#[auditaur_command(skip_all)]
pub async fn send_for_review(
    request: SendForReviewRequest,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<SendResult> {
    let mutex = lock.0;
    // The GitHub provider uses a blocking HTTP client, which must not run on
    // the async runtime.
    tokio::task::spawn_blocking(move || {
        let _guard = mutex
            .lock()
            .map_err(|error| context_error(error.to_string()))?;
        let mut options = RemoteOptions::new().with_credentials(resolve_remote_credential);
        send_for_review_with(
            request,
            |remote_url| {
                let token = is_github_remote_url(remote_url)
                    .then(github_credential_token)
                    .flatten()
                    .map(|credential| credential.token);
                GitHubPullRequestProvider::for_remote_url(remote_url, token)
                    .map(|provider| Box::new(provider) as Box<dyn PullRequestProvider>)
            },
            &mut options,
        )
    })
    .await
    .map_err(|error| context_error(format!("Send for review stopped unexpectedly: {error}")))?
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

/// How the current branch compares with the remote base branch as of the last
/// fetch. `None` unless this is a hybrid project on a branch other than the
/// base (standalone projects and the base itself have nothing to bring in).
#[auditaur_command(skip_all)]
pub async fn get_base_status(
    request: contract::RemoteRequest,
) -> contract::TauriCommandResult<Option<draftline::SyncStatus>> {
    let adapter = contract::into_tauri_result(CutReadyDraftlineAdapter::open_project(
        &request.workspace_path,
    ))?;
    contract::into_tauri_result(adapter.base_status(&request.remote))
}

/// Fetches and preflights bringing the latest base into the current branch.
/// Conflicts outside the CutReady folder fail with `merge_needs_developer`;
/// conflicts inside it come back in the report for the merge conflict panel.
#[auditaur_command(skip_all)]
pub async fn preflight_merge_base(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<MergeIncomingReport> {
    let mutex = lock.0;
    // Fetching blocks on network I/O; keep it off the async runtime.
    tokio::task::spawn_blocking(move || {
        let _guard = mutex
            .lock()
            .map_err(|error| context_error(error.to_string()))?;
        let mut context = context_for_workspace(&request.workspace_path, app)?;
        preflight_merge_base_with(&mut context, request)
    })
    .await
    .map_err(|error| context_error(format!("Getting updates stopped unexpectedly: {error}")))?
}

fn preflight_merge_base_with(
    context: &mut contract::DraftlineCommandContext<'_>,
    request: contract::RemoteRequest,
) -> contract::TauriCommandResult<MergeIncomingReport> {
    let report = contract::into_tauri_result(contract::preflight_merge_base_with_context(
        context, request,
    ))?;
    if !report.developer_conflicts.is_empty() {
        return contract::into_tauri_result(Err(draftline::DraftlineError::MergeNeedsDeveloper(
            report.developer_conflicts,
        )));
    }
    Ok(report)
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
    use draftline::Contributor;

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
        core_draftline_context(
            root,
            ContributorProfile::new(
                contributor,
                Contributor {
                    name: "CutReady".to_string(),
                    email: Some("app@cutready.local".to_string()),
                },
            ),
        )
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

    #[test]
    fn hybrid_contract_namespaces_listing_and_new_variations() {
        let temp = tempfile::tempdir().unwrap();
        let code = temp.path().join("contoso-app");
        std::fs::create_dir_all(code.join("cutready")).unwrap();
        let mut options = git2::RepositoryInitOptions::new();
        options.initial_head("main");
        let repo = git2::Repository::init_opts(&code, &options).unwrap();
        std::fs::write(code.join("README.md"), "# Contoso\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Dev", "dev@example.com").unwrap();
        let tip = repo
            .commit(Some("HEAD"), &signature, &signature, "Code", &tree, &[])
            .unwrap();
        repo.branch("feature/x", &repo.find_commit(tip).unwrap(), false)
            .unwrap();

        let folder = code.join("cutready");
        std::fs::write(folder.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
        save(&folder, "Intro");
        assert!(!folder.join(".git").exists());

        let names = |root: &Path| -> Vec<String> {
            contract::list_variations_with_context(
                &context(root),
                contract::WorkspaceRequest {
                    workspace_path: root.to_path_buf(),
                },
            )
            .unwrap()
            .into_iter()
            .map(|summary| summary.variation.name)
            .collect()
        };
        assert_eq!(names(&folder), vec!["main".to_string()]);

        let version = CutReadyDraftlineAdapter::open_project(&folder)
            .unwrap()
            .versions()
            .unwrap()[0]
            .id()
            .to_string();
        let preflight = contract::preflight_create_variation_from_version_with_context(
            &mut context(&folder),
            namespace_create_request(contract::PreflightCreateVariationFromVersionRequest {
                workspace_path: folder.clone(),
                version_id: version,
                name: "alt".to_string(),
                remote: None,
            }),
        )
        .unwrap();
        assert!(preflight.can_create, "{preflight:?}");
        let created = contract::create_variation_from_version_guarded_with_context(
            &mut context(&folder),
            contract::GuardedCreateVariationFromVersionRequest {
                workspace_path: folder.clone(),
                token: preflight.token.unwrap(),
                metadata: Default::default(),
            },
        )
        .unwrap();
        assert_eq!(created.variation.name, "cutready/alt");
        let listed = names(&folder);
        assert!(listed.contains(&"cutready/alt".to_string()), "{listed:?}");
        assert!(!listed.contains(&"feature/x".to_string()), "{listed:?}");

        let renamed = namespace_rename_request(contract::RenameVariationRequest {
            workspace_path: folder.clone(),
            source_variation_id: "cutready/alt".to_string(),
            target_variation_id: "beta".to_string(),
            token: None,
        });
        assert_eq!(renamed.target_variation_id, "cutready/beta");
    }

    #[test]
    fn standalone_contract_keeps_unprefixed_names() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("demo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("intro.sk"), "{}").unwrap();
        CutReadyDraftlineAdapter::open_project(&root).unwrap();
        assert!(!is_hybrid_workspace(&root));
        let request =
            namespace_create_request(contract::PreflightCreateVariationFromVersionRequest {
                workspace_path: root.clone(),
                version_id: String::new(),
                name: "alt".to_string(),
                remote: None,
            });
        assert_eq!(request.name, "alt");
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
                from_base: false,
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

    #[derive(Default)]
    struct FakeHost {
        requests: std::sync::Arc<std::sync::Mutex<Vec<draftline::PullRequestRequest>>>,
    }

    impl PullRequestProvider for FakeHost {
        fn find_open(
            &mut self,
            _request: &draftline::PullRequestRequest,
        ) -> draftline::Result<Option<draftline::PullRequest>> {
            Ok(None)
        }

        fn create(
            &mut self,
            request: &draftline::PullRequestRequest,
        ) -> draftline::Result<draftline::PullRequest> {
            self.requests.lock().unwrap().push(request.clone());
            Ok(draftline::PullRequest {
                number: 9,
                url: "https://github.com/contoso/app/pull/9".to_string(),
            })
        }
    }

    fn send_request(root: &Path, title: &str) -> SendForReviewRequest {
        SendForReviewRequest {
            workspace_path: root.to_path_buf(),
            remote: "origin".to_string(),
            title: title.to_string(),
            body: Some("Please review".to_string()),
            base: Some("main".to_string()),
        }
    }

    #[test]
    fn send_for_review_rejects_standalone_projects() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("demo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("intro.sk"), "{}").unwrap();
        CutReadyDraftlineAdapter::open_project(&root).unwrap();

        let error = send_for_review_with(
            send_request(&root, "Ship it"),
            |_| panic!("standalone projects must not reach the provider"),
            &mut RemoteOptions::new(),
        )
        .unwrap_err();
        assert_eq!(error.code, SEND_REQUIRES_HYBRID);

        let error = send_for_review_with(
            send_request(&root, "   "),
            |_| panic!("blank titles must not reach the provider"),
            &mut RemoteOptions::new(),
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_request");
    }

    #[test]
    fn send_for_review_pushes_a_cutready_branch_and_opens_a_pull_request() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        init_bare_remote(&remote);
        let code = temp.path().join("contoso-app");
        std::fs::create_dir_all(code.join("cutready")).unwrap();
        let mut options = git2::RepositoryInitOptions::new();
        options.initial_head("main");
        let repo = git2::Repository::init_opts(&code, &options).unwrap();
        std::fs::write(code.join("README.md"), "# Contoso\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Dev", "dev@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "Code", &tree, &[])
            .unwrap();
        repo.remote("origin", remote.to_str().unwrap())
            .unwrap()
            .push(&["refs/heads/main:refs/heads/main"], None)
            .unwrap();

        let folder = code.join("cutready");
        std::fs::write(folder.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
        save(&folder, "Intro");

        let host = FakeHost::default();
        let requests = host.requests.clone();
        let mut seen_url = None;
        let result = send_for_review_with(
            send_request(&folder, "Launch demo"),
            |url| {
                seen_url = Some(url.to_string());
                Ok(Box::new(host))
            },
            &mut RemoteOptions::new(),
        )
        .unwrap();

        assert_eq!(seen_url.as_deref(), remote.to_str());
        assert_eq!(result.variation, "cutready/launch-demo");
        assert_eq!(result.base, "main");
        assert!(result.created_variation && result.created_pull_request);
        assert_eq!(result.pull_request.number, 9);
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].head, "cutready/launch-demo");
        assert_eq!(requests[0].body, "Please review");
        assert!(git2::Repository::open_bare(&remote)
            .unwrap()
            .find_branch("cutready/launch-demo", git2::BranchType::Local)
            .is_ok());
    }

    #[test]
    fn send_for_review_refuses_outgoing_lfs_pointers() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        init_bare_remote(&remote);
        let code = temp.path().join("contoso-app");
        std::fs::create_dir_all(code.join("cutready").join("screenshots")).unwrap();
        std::fs::write(code.join("README.md"), "# Contoso\n").unwrap();
        std::fs::write(
            code.join("cutready").join("intro.sk"),
            r#"{"title":"Intro"}"#,
        )
        .unwrap();
        git(
            temp.path(),
            &["init", "--initial-branch=main", "contoso-app"],
        );
        git(&code, &["add", "README.md", "cutready/intro.sk"]);
        git(&code, &["commit", "-m", "Code"]);
        // Blank any system LFS driver so Draftline can't upload the content.
        for key in ["process", "clean", "smudge"] {
            git(&code, &["config", &format!("filter.lfs.{key}"), ""]);
        }
        git(
            &code,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&code, &["push", "origin", "main"]);
        std::fs::write(
            code.join("cutready").join("screenshots").join("a.png"),
            "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n",
        )
        .unwrap();
        git(&code, &["add", "cutready/screenshots/a.png"]);
        git(&code, &["commit", "-m", "Screenshot"]);

        let folder = code.join("cutready");
        let error = send_for_review_with(
            send_request(&folder, "Launch demo"),
            |_| panic!("LFS pointers must be refused before the provider"),
            &mut RemoteOptions::new(),
        )
        .unwrap_err();
        assert_eq!(error.code, SEND_HAS_LFS_POINTERS);
        assert_eq!(
            error.details,
            Some(serde_json::json!({ "paths": ["cutready/screenshots/a.png"] }))
        );
        assert!(git2::Repository::open_bare(&remote)
            .unwrap()
            .find_branch("cutready/launch-demo", git2::BranchType::Local)
            .is_err());
    }

    #[test]
    fn send_for_review_lets_draftline_upload_lfs_content() {
        let lfs = git_command().args(["lfs", "version"]).output();
        if !lfs.is_ok_and(|output| output.status.success()) {
            eprintln!("skipping: git-lfs is not installed");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        init_bare_remote(&remote);
        let code = temp.path().join("contoso-app");
        std::fs::create_dir_all(code.join("cutready").join("screenshots")).unwrap();
        std::fs::write(code.join("README.md"), "# Contoso\n").unwrap();
        std::fs::write(
            code.join(".gitattributes"),
            "*.png filter=lfs diff=lfs merge=lfs -text\n",
        )
        .unwrap();
        std::fs::write(
            code.join("cutready").join("intro.sk"),
            r#"{"title":"Intro"}"#,
        )
        .unwrap();
        git(
            temp.path(),
            &["init", "--initial-branch=main", "contoso-app"],
        );
        git(&code, &["lfs", "install", "--local"]);
        git(
            &code,
            &["add", "README.md", ".gitattributes", "cutready/intro.sk"],
        );
        git(&code, &["commit", "-m", "Code"]);
        git(
            &code,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&code, &["push", "origin", "main"]);
        // A pointer whose content this checkout never had: Draftline's upload
        // fails, and nothing is pushed.
        std::fs::write(
            code.join("cutready").join("screenshots").join("a.png"),
            "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n",
        )
        .unwrap();
        git(&code, &["add", "cutready/screenshots/a.png"]);
        git(&code, &["commit", "-m", "Screenshot"]);

        let folder = code.join("cutready");
        let error = send_for_review_with(
            send_request(&folder, "Launch demo"),
            |_| Ok(Box::new(FakeHost::default()) as Box<dyn PullRequestProvider>),
            &mut RemoteOptions::new(),
        )
        .unwrap_err();
        assert_eq!(error.code, "git_filter_failed");
        assert!(git2::Repository::open_bare(&remote)
            .unwrap()
            .find_branch("cutready/launch-demo", git2::BranchType::Local)
            .is_err());
    }

    fn git(dir: &Path, args: &[&str]) {
        let output = git_command()
            .current_dir(dir)
            .args(["-c", "user.name=Dev", "-c", "user.email=dev@example.com"])
            .args(args)
            .output()
            .expect("git");
        assert!(output.status.success(), "git {args:?}: {output:?}");
    }

    /// A hybrid project sent for review (now on `cutready/launch-demo`) plus a
    /// developer clone that pushes to `main`. Returns `(code, folder, dev)`.
    fn hybrid_review_branch(temp: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let remote = temp.join("remote.git");
        init_bare_remote(&remote);
        let code = temp.join("contoso-app");
        std::fs::create_dir_all(code.join("cutready")).unwrap();
        std::fs::create_dir_all(code.join("src")).unwrap();
        std::fs::write(code.join("README.md"), "# Contoso\n").unwrap();
        std::fs::write(code.join("src").join("app.rs"), "fn main() {}\n").unwrap();
        std::fs::write(
            code.join("cutready").join("intro.sk"),
            r#"{"title":"Intro"}"#,
        )
        .unwrap();
        git(temp, &["init", "--initial-branch=main", "contoso-app"]);
        git(
            &code,
            &["add", "README.md", "src/app.rs", "cutready/intro.sk"],
        );
        git(&code, &["commit", "-m", "Code"]);
        git(
            &code,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&code, &["push", "origin", "main"]);

        let folder = code.join("cutready");
        std::fs::write(folder.join("intro.sk"), r#"{"title":"Intro (branch)"}"#).unwrap();
        save(&folder, "Intro");
        fetch(&folder);
        // On the base itself there is nothing to bring in from it.
        assert!(CutReadyDraftlineAdapter::open_project(&folder)
            .unwrap()
            .base_status("origin")
            .unwrap()
            .is_none());

        send_for_review_with(
            send_request(&folder, "Launch demo"),
            |_| Ok(Box::new(FakeHost::default())),
            &mut RemoteOptions::new(),
        )
        .unwrap();

        git(temp, &["clone", remote.to_str().unwrap(), "dev"]);
        (code, folder, temp.join("dev"))
    }

    fn dev_push(dev: &Path, path: &str, content: &str, message: &str) {
        let file = dev.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
        git(dev, &["add", path]);
        git(dev, &["commit", "-m", message]);
        git(dev, &["push", "origin", "main"]);
    }

    /// File text with line endings normalized (git may check out CRLF).
    fn read_text(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap().replace("\r\n", "\n")
    }

    fn merge_from_base(folder: &Path) -> contract::TauriCommandResult<()> {
        contract::into_tauri_result(contract::merge_incoming_with_context(
            &mut context(folder),
            contract::MergeIncomingRequest {
                workspace_path: folder.to_path_buf(),
                remote: "origin".to_string(),
                label: "Bring in latest main".to_string(),
                from_base: true,
            },
        ))
        .map(|_| ())
    }

    #[test]
    fn base_merge_brings_developer_commits_into_the_review_branch() {
        let temp = tempfile::tempdir().unwrap();
        let (code, folder, dev) = hybrid_review_branch(temp.path());
        dev_push(&dev, "README.md", "# Contoso v2\n", "Docs");

        fetch(&folder);
        let status = CutReadyDraftlineAdapter::open_project(&folder)
            .unwrap()
            .base_status("origin")
            .unwrap()
            .expect("hybrid review branch has a base");
        assert_eq!(status.variation, "main");
        assert_eq!(status.behind, 1);

        let report =
            preflight_merge_base_with(&mut context(&folder), remote_request(&folder)).unwrap();
        assert!(report.can_merge_cleanly, "{report:?}");
        assert_eq!(
            report.token.as_ref().unwrap().source.as_deref(),
            Some("main")
        );

        merge_from_base(&folder).unwrap();
        assert_eq!(read_text(&code.join("README.md")), "# Contoso v2\n");
        let adapter = CutReadyDraftlineAdapter::open_project(&folder).unwrap();
        assert_eq!(adapter.current_variation().unwrap(), "cutready/launch-demo");
        assert_eq!(adapter.base_status("origin").unwrap().unwrap().behind, 0);
    }

    #[test]
    fn base_conflicts_outside_the_folder_need_a_developer() {
        let temp = tempfile::tempdir().unwrap();
        let (code, folder, dev) = hybrid_review_branch(temp.path());
        std::fs::write(code.join("README.md"), "# Contoso (branch)\n").unwrap();
        git(&code, &["commit", "-am", "Branch docs"]);
        dev_push(&dev, "README.md", "# Contoso (main)\n", "Main docs");

        let error =
            preflight_merge_base_with(&mut context(&folder), remote_request(&folder)).unwrap_err();
        assert_eq!(error.code, "merge_needs_developer");
        assert!(error.message.contains("README.md"), "{}", error.message);

        let error = merge_from_base(&folder).unwrap_err();
        assert_eq!(error.code, "merge_needs_developer");
        assert_eq!(read_text(&code.join("README.md")), "# Contoso (branch)\n");
    }

    #[test]
    fn base_conflicts_inside_the_folder_resolve_through_the_conflict_flow() {
        let temp = tempfile::tempdir().unwrap();
        let (_code, folder, dev) = hybrid_review_branch(temp.path());
        dev_push(
            &dev,
            "cutready/intro.sk",
            r#"{"title":"Developer intro"}"#,
            "Dev intro",
        );

        let report =
            preflight_merge_base_with(&mut context(&folder), remote_request(&folder)).unwrap();
        assert!(!report.can_merge_cleanly, "{report:?}");
        assert!(report.developer_conflicts.is_empty());
        assert!(!report.conflicts.is_empty());

        let token = report
            .token
            .clone()
            .expect("in-folder conflicts are resolvable");
        assert_eq!(token.source.as_deref(), Some("main"));
        assert!(merge_from_base(&folder).is_err());

        let resolutions = report
            .conflicts
            .iter()
            .map(|conflict| {
                let keep_ours = draftline::MergeResolutionChoice::UseContent {
                    content: r#"{"title":"Intro (branch)"}"#.to_string(),
                };
                match &conflict.field_path {
                    Some(field) => draftline::MergeConflictResolution::with_field_path(
                        conflict.path.clone(),
                        field.clone(),
                        keep_ours,
                    ),
                    None => {
                        draftline::MergeConflictResolution::new(conflict.path.clone(), keep_ours)
                    }
                }
            })
            .collect();
        contract::merge_incoming_with_resolutions_with_context(
            &mut context(&folder),
            contract::MergeIncomingWithResolutionsRequest {
                workspace_path: folder.clone(),
                remote: "origin".to_string(),
                label: "Bring in latest main".to_string(),
                token,
                resolutions,
            },
        )
        .unwrap();
        assert!(read_text(&folder.join("intro.sk")).contains("Intro (branch)"));
        let adapter = CutReadyDraftlineAdapter::open_project(&folder).unwrap();
        assert_eq!(adapter.base_status("origin").unwrap().unwrap().behind, 0);
    }

    #[test]
    fn standalone_projects_have_no_base_status() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("demo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("intro.sk"), "{}").unwrap();
        let adapter = CutReadyDraftlineAdapter::open_project(&root).unwrap();
        assert!(adapter.base_status("origin").unwrap().is_none());
    }

    fn seed_chat(repo_root: &Path, session_id: &str) {
        crate::engine::agent_state::AgentStateStore::save_chat_session(
            repo_root,
            repo_root,
            session_id,
            "Seeded",
            &[serde_json::json!({ "role": "user", "content": "remember me" })],
            serde_json::json!({}),
        )
        .unwrap();
    }

    fn chat_ids(repo_root: &Path) -> Vec<String> {
        crate::engine::agent_state::AgentStateStore::list_chat_sessions(repo_root, repo_root, 10, 0)
            .unwrap()
            .sessions
            .into_iter()
            .map(|session| session.session_id)
            .collect()
    }

    fn move_request(root: &Path, to: &str) -> MoveProjectFolderRequest {
        MoveProjectFolderRequest {
            workspace_path: root.to_path_buf(),
            to: to.to_string(),
        }
    }

    #[test]
    fn moving_the_project_folder_carries_history_metadata_and_chat() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("demo");
        std::fs::create_dir_all(root.join(".cutready")).unwrap();
        std::fs::write(root.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
        std::fs::write(root.join(".cutready/settings.json"), "{}").unwrap();
        CutReadyDraftlineAdapter::open_project(&root).unwrap();
        save(&root, "Intro");
        seed_chat(&root, "s1");

        // Root → subfolder: the project becomes a folder inside a code repo.
        let moved =
            move_project_folder_with_context(&mut context(&root), &move_request(&root, "cutready"))
                .unwrap_or_else(|error| panic!("move: {}", error.message));
        let folder = root.join("cutready");
        assert_eq!(moved.project_root, folder);
        assert_eq!((moved.from.as_str(), moved.to.as_str()), ("", "cutready"));
        assert!(moved.hybrid);
        assert!(moved.left_behind.is_empty(), "{:?}", moved.left_behind);
        assert!(folder.join("intro.sk").exists());
        assert!(!root.join("intro.sk").exists());
        assert!(folder.join(".cutready/settings.json").exists());
        assert!(!root.join(".cutready").exists());
        assert_eq!(chat_ids(&folder), vec!["s1"]);
        let adapter = CutReadyDraftlineAdapter::open_project(&folder).unwrap();
        assert!(adapter.is_hybrid());
        let labels: Vec<_> = adapter
            .versions()
            .unwrap()
            .into_iter()
            .map(|version| version.label)
            .collect();
        assert!(labels.iter().any(|label| label == "Intro"), "{labels:?}");

        // Subfolder → subfolder.
        let moved = move_project_folder_with_context(
            &mut context(&folder),
            &move_request(&folder, "demos/launch"),
        )
        .unwrap_or_else(|error| panic!("second move: {}", error.message));
        let launch = root.join("demos").join("launch");
        assert_eq!(moved.project_root, launch);
        assert_eq!(moved.to, "demos/launch");
        assert!(!folder.exists());
        assert!(launch.join("intro.sk").exists());
        assert!(launch.join(".cutready/settings.json").exists());
        assert_eq!(chat_ids(&launch), vec!["s1"]);
    }

    #[test]
    fn a_refused_move_leaves_content_and_chat_where_they_were() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("demo");
        std::fs::create_dir_all(root.join("occupied")).unwrap();
        std::fs::write(root.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
        std::fs::write(root.join("occupied/notes.txt"), "keep").unwrap();
        CutReadyDraftlineAdapter::open_project(&root).unwrap();
        save(&root, "Intro");
        seed_chat(&root, "s1");

        let error =
            move_project_folder_with_context(&mut context(&root), &move_request(&root, "occupied"))
                .unwrap_err();
        assert_eq!(error.code, "folder_move_refused", "{}", error.message);
        assert!(root.join("intro.sk").exists());
        assert_eq!(chat_ids(&root), vec!["s1"]);

        // Unsaved work must be saved first.
        std::fs::write(root.join("intro.sk"), r#"{"title":"Edited"}"#).unwrap();
        let error =
            move_project_folder_with_context(&mut context(&root), &move_request(&root, "cutready"))
                .unwrap_err();
        assert_ne!(error.code, "project_state_busy", "{}", error.message);
        assert!(!root.join("cutready").exists());
        assert_eq!(chat_ids(&root), vec!["s1"]);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn a_case_only_rename_is_refused_with_nothing_moved() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("demo");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
        CutReadyDraftlineAdapter::open_project(&root).unwrap();
        save(&root, "Intro");
        move_project_folder_with_context(&mut context(&root), &move_request(&root, "cutready"))
            .unwrap_or_else(|error| panic!("first move: {}", error.message));
        let folder = root.join("cutready");
        seed_chat(&folder, "s1");

        let error = move_project_folder_with_context(
            &mut context(&folder),
            &move_request(&folder, "CutReady"),
        )
        .unwrap_err();
        assert_eq!(error.code, "folder_move_refused", "{}", error.message);
        assert!(error.message.contains("letter case"), "{}", error.message);
        assert!(folder.join("intro.sk").exists());
        assert_eq!(chat_ids(&folder), vec!["s1"]);
    }

    #[test]
    fn move_destinations_stay_inside_the_repository() {
        assert_eq!(destination_folder(" . ").unwrap(), PathBuf::new());
        assert_eq!(
            destination_folder("demos\\launch/").unwrap(),
            PathBuf::from("demos").join("launch")
        );
        for bad in ["../elsewhere", ".git", "demos/.cutready", "C:/demo"] {
            assert!(destination_folder(bad).is_err(), "{bad}");
        }
    }
}
