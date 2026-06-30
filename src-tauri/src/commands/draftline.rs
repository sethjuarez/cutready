//! Internal Tauri commands for CutReady's Draftline-backed versioning service.

use std::path::{Path, PathBuf};

use draftline::tauri_contract as contract;
#[cfg(test)]
use draftline::VersionId;
use draftline::{
    ApplyIncomingReport, ChangeSet, Contributor, ContributorProfile, HistoryEntry, PreflightReport,
    MergeIncomingReport, PreviewFile, RemoteCredential, RemoteCredentialRequest, RemoteEndpoint,
    Shelf, Variation, VariationId, VariationRenamePreflight, VariationSummary, Version,
    VersionDiff, VersionPreview,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::agent_state::{AgentStateStore, HistoryCleanupLedgerOperation};
use crate::engine::draftline_adapter::{
    cutready_content_policy, cutready_remote_options, CutReadyDraftlineAdapter,
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
pub enum DraftlineSwitchPolicyInput {
    AbortIfDirty,
    SaveFirst { label: String },
}

impl Default for DraftlineSwitchPolicyInput {
    fn default() -> Self {
        Self::AbortIfDirty
    }
}

#[cfg(test)]
fn draftline_root_from_project_view(view: &crate::models::script::ProjectView) -> PathBuf {
    view.repo_root.clone()
}

fn cutready_contributor_profile(_project_root: &Path) -> ContributorProfile {
    ContributorProfile::new(
        Contributor {
            name: std::env::var("GIT_AUTHOR_NAME")
                .ok()
                .or_else(|| std::env::var("USERNAME").ok())
                .or_else(|| std::env::var("USER").ok())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "CutReady User".to_string()),
            email: std::env::var("GIT_AUTHOR_EMAIL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
        },
        Contributor {
            name: "CutReady".to_string(),
            email: Some("app@cutready.local".to_string()),
        },
    )
}

fn resolve_remote_credential(
    request: RemoteCredentialRequest<'_>,
) -> draftline::Result<RemoteCredential> {
    if request.allows_username_password {
        if let Some(token) = try_gh_token() {
            return Ok(RemoteCredential::UsernamePassword {
                username: "x-access-token".to_string(),
                password: token,
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

fn build_draftline_context(
    project_root: &Path,
    app: Option<AppHandle>,
) -> Result<contract::DraftlineCommandContext<'static>, String> {
    let mut context = contract::DraftlineCommandContext::new()
        .with_content_policy(cutready_content_policy().map_err(|error| error.to_string())?)
        .with_contributor_profile(cutready_contributor_profile(project_root))
        .with_credentials(resolve_remote_credential);

    if let Some(app) = app {
        context = context.with_event_sink(move |event| {
            let _ = app.emit("draftline://workspace_event", event);
        });
    }

    Ok(context)
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

fn switch_policy_from_input(policy: DraftlineSwitchPolicyInput) -> draftline::SwitchPolicy {
    match policy {
        DraftlineSwitchPolicyInput::AbortIfDirty => draftline::SwitchPolicy::AbortIfDirty,
        DraftlineSwitchPolicyInput::SaveFirst { label } => {
            draftline::SwitchPolicy::SaveFirst { label }
        }
    }
}

fn reject_remote_url_credentials(url: &str) -> Result<(), String> {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return Ok(());
    };

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(
            "Remote URLs must not include credentials. Authenticate with GitHub CLI or your system credential helper."
                .to_string(),
        );
    }

    Ok(())
}

fn try_gh_token() -> Option<String> {
    for candidate in gh_command_candidates() {
        let mut cmd = std::process::Command::new(&candidate);
        cmd.args(["auth", "token"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        match cmd.output() {
            Ok(output) if output.status.success() => {
                let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !token.is_empty() {
                    return Some(token);
                }
            }
            Ok(output) => {
                tracing::debug!(
                    gh = %candidate.display(),
                    status = ?output.status.code(),
                    "GitHub CLI token lookup failed"
                );
            }
            Err(error) => {
                tracing::debug!(
                    gh = %candidate.display(),
                    error = %error,
                    "GitHub CLI token lookup could not start"
                );
            }
        }
    }

    None
}

fn gh_command_candidates() -> Vec<PathBuf> {
    #[cfg(not(target_os = "macos"))]
    {
        vec![PathBuf::from("gh")]
    }

    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("gh"),
            PathBuf::from("/opt/homebrew/bin/gh"),
            PathBuf::from("/usr/local/bin/gh"),
            PathBuf::from("/usr/bin/gh"),
        ]
    }
}

#[auditaur_command(skip_all, err)]
pub async fn clone_from_url(url: String, dest: String) -> Result<(), String> {
    reject_remote_url_credentials(&url)?;
    let dest_path = PathBuf::from(&dest);
    let token = try_gh_token();
    let mut options = cutready_remote_options(token);
    CutReadyDraftlineAdapter::clone_project_with_options(&url, &dest_path, &mut options)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn context_for_workspace(
    workspace_path: &Path,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::DraftlineCommandContext<'static>> {
    build_draftline_context(workspace_path, Some(app)).map_err(|message| {
        contract::TauriCommandError {
            code: "cutready_context_error".into(),
            message,
            details: None,
        }
    })
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
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
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
    lock: State<'_, ProjectLock>,
) -> Result<Variation, String> {
    let _guard = lock.0.lock().await;
    let adapter = CutReadyDraftlineAdapter::open_project(&request.workspace_path)
        .map_err(|error| error.to_string())?;
    adapter
        .switch_variation_with_policy(&request.variation_id, switch_policy_from_input(request.policy))
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn add_remote(
    request: DraftlineAddRemoteRequest,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineRemoteEndpointDto, String> {
    reject_remote_url_credentials(&request.url)?;
    let _guard = lock.0.lock().await;
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
    lock: State<'_, ProjectLock>,
) -> Result<Version, String> {
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
    let workspace_path = request.workspace_path.clone();
    let mut context = context_for_workspace(&request.workspace_path, app)?;
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
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
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
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
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
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
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
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::apply_shelf_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn delete_shelf(
    request: contract::ShelfRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::DeleteShelfResult> {
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::delete_shelf_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn selected_save(
    request: contract::SelectedSaveRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::SelectedSaveResult> {
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::selected_save_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn selected_shelve(
    request: contract::SelectedShelveRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::SelectedShelveResult> {
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::fetch_remote_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn publish_current_variation(
    request: contract::PublishCurrentVariationRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::PublishCurrentVariationResult> {
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_apply_incoming_with_context(
        &mut context,
        request,
    ))
}

#[auditaur_command(skip_all)]
pub async fn apply_incoming(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::ApplyIncomingCommandResult> {
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::apply_incoming_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn preflight_merge_incoming(
    request: contract::RemoteRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<MergeIncomingReport> {
    let _guard = lock.0.lock().await;
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
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::merge_incoming_with_context(&mut context, request))
}

#[auditaur_command(skip_all)]
pub async fn merge_incoming_with_resolutions(
    request: contract::MergeIncomingWithResolutionsRequest,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> contract::TauriCommandResult<contract::MergeIncomingCommandResult> {
    let _guard = lock.0.lock().await;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
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
}
