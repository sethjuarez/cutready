//! Internal Tauri commands for CutReady's Draftline-backed versioning service.

use std::path::{Path, PathBuf};

use draftline::merge::{MergeConflict, ResolutionKind};
use draftline::tauri_contract as contract;
use draftline::{
    ApplyIncomingReport, ApplyIncomingResult, ChangeKind, ChangeSet, ChangedFile, Contributor,
    ContributorProfile, HistoryEntry, MergeConflictResolution, MergeIncomingReport,
    MergeIncomingResult, MergeIncomingToken, MergeResolutionChoice, PreflightReport, PreviewFile,
    RemoteCredential, RemoteCredentialRequest, RemoteEndpoint, Shelf, SyncState, SyncStatus,
    Variation, VariationId, VariationMetadata, VariationRenamePreflight, VariationSummary, Version,
    VersionDiff, VersionId, VersionPreview, WorkspaceSummary,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::draftline_adapter::{
    cutready_content_policy, cutready_remote_options, CutReadyDraftlineAdapter,
};
use crate::engine::project;
use crate::{AppState, ProjectLock};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineChangeSetDto {
    pub files: Vec<DraftlineChangedFileDto>,
    pub diff: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineChangedFileDto {
    pub path: String,
    pub kind: DraftlineChangeKindDto,
    pub is_binary: bool,
    pub is_large: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftlineChangeKindDto {
    Added,
    Modified,
    Deleted,
    Renamed,
    Conflicted,
    TypeChanged,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineVersionDto {
    pub id: VersionId,
    pub label: String,
    pub author: DraftlineContributorDto,
    pub saved_by: DraftlineContributorDto,
    pub time_seconds: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineWorkspaceSummaryDto {
    pub active_variation: DraftlineVariationDto,
    pub variations: Vec<DraftlineVariationDto>,
    pub versions: Vec<DraftlineVersionDto>,
    pub dirty_files: Vec<DraftlineChangedFileDto>,
    pub is_dirty: bool,
    pub recovery: Option<serde_json::Value>,
    pub state_may_be_inconsistent: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineHistoryEntryDto {
    pub version: DraftlineVersionDto,
    pub variation_tips: Vec<VariationId>,
    pub is_head: bool,
    pub parent_ids: Vec<VersionId>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineVariationSummaryDto {
    pub variation: DraftlineVariationDto,
    pub head_version: Option<DraftlineVersionDto>,
    pub reachable_version_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineContributorDto {
    pub name: String,
    pub email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineVariationDto {
    pub id: VariationId,
    pub name: String,
    pub label: Option<String>,
    pub slug: Option<String>,
    pub display_label: String,
    pub is_current: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineVersionPreviewDto {
    pub id: VersionId,
    pub files: Vec<DraftlinePreviewFileDto>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineShelfDto {
    pub id: String,
    pub version: DraftlineVersionDto,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlinePreviewFileDto {
    pub path: String,
    pub content: Option<String>,
    pub is_binary: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlinePreflightReportDto {
    pub operation: String,
    pub will_write_files: bool,
    pub dirty_files: Vec<DraftlineChangedFileDto>,
    pub file_hazards: Vec<String>,
    pub untracked_assets: Vec<String>,
    pub unresolved_conflicts: Vec<String>,
    pub large_files: Vec<String>,
    pub binary_files: Vec<String>,
    pub variation_divergence: Option<String>,
    pub can_proceed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineVersionDiffDto {
    pub from_version: Option<VersionId>,
    pub to_version: Option<VersionId>,
    pub files: Vec<DraftlineChangedFileDto>,
    pub patch: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineFileDiffContentDto {
    pub path: String,
    pub head_content: Option<String>,
    pub working_content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineRemoteEndpointDto {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlinePublishResultDto {
    pub remote: String,
    pub variation: String,
    pub published_versions: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineSyncStatusDto {
    pub remote: String,
    pub variation: String,
    pub ahead: usize,
    pub behind: usize,
    pub state: DraftlineSyncStateDto,
    pub incoming: Vec<DraftlineRemoteVersionSummaryDto>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineApplyIncomingReportDto {
    pub sync_status: DraftlineSyncStatusDto,
    pub dirty_files: Vec<DraftlineChangedFileDto>,
    pub is_fast_forward: bool,
    pub can_proceed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineApplyIncomingResultDto {
    pub applied_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineMergeIncomingReportDto {
    pub sync_status: DraftlineSyncStatusDto,
    pub dirty_files: Vec<DraftlineChangedFileDto>,
    pub file_hazards: Vec<String>,
    pub conflicts: Vec<DraftlineMergeConflictDto>,
    pub token: Option<DraftlineMergeIncomingTokenDto>,
    pub can_merge_cleanly: bool,
    pub changed_workspace: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineMergeIncomingTokenDto {
    pub remote: String,
    pub variation: String,
    pub local_oid: String,
    pub remote_oid: String,
    pub merge_base_oid: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineMergeConflictDto {
    pub path: String,
    pub field_path: Option<String>,
    pub label: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub resolution: DraftlineResolutionKindDto,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftlineResolutionKindDto {
    Choose,
    Edit,
    Combine,
    Delete,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineMergeConflictResolutionInput {
    pub path: String,
    pub field_path: Option<String>,
    pub choice: DraftlineMergeResolutionChoiceInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DraftlineMergeResolutionChoiceInput {
    UseOurs,
    UseTheirs,
    UseBase,
    Delete,
    UseContent { content: String },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineMergeIncomingResultDto {
    pub version: DraftlineVersionDto,
    pub merged_files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftlineSyncStateDto {
    UpToDate,
    LocalAhead,
    IncomingAvailable,
    NeedsMerge,
    NoRemoteVersion,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineRemoteVersionSummaryDto {
    pub id: String,
    pub label: String,
    pub author: DraftlineContributorDto,
    pub time_seconds: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftlineVariationMetadataInput {
    pub label: Option<String>,
    pub slug: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum DraftlineSwitchPolicyInput {
    AbortIfDirty,
    SaveFirst { label: String },
}

fn draftline_project_root(state: &AppState) -> Result<PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(draftline_root_from_project_view(view))
}

fn draftline_root_from_project_view(view: &crate::models::script::ProjectView) -> PathBuf {
    view.repo_root.clone()
}

fn open_adapter(state: &AppState) -> Result<CutReadyDraftlineAdapter, String> {
    CutReadyDraftlineAdapter::open_project(draftline_project_root(state)?)
        .map_err(|error| error.to_string())
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

fn open_draftline_context(
    state: &AppState,
    app: Option<AppHandle>,
) -> Result<(PathBuf, contract::DraftlineCommandContext<'static>), String> {
    let root = draftline_project_root(state)?;
    let context = build_draftline_context(&root, app)?;
    Ok((root, context))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn change_kind_to_dto(kind: ChangeKind) -> DraftlineChangeKindDto {
    match kind {
        ChangeKind::Added => DraftlineChangeKindDto::Added,
        ChangeKind::Modified => DraftlineChangeKindDto::Modified,
        ChangeKind::Deleted => DraftlineChangeKindDto::Deleted,
        ChangeKind::Renamed => DraftlineChangeKindDto::Renamed,
        ChangeKind::Conflicted => DraftlineChangeKindDto::Conflicted,
        ChangeKind::TypeChanged => DraftlineChangeKindDto::TypeChanged,
    }
}

fn contributor_to_dto(contributor: Contributor) -> DraftlineContributorDto {
    DraftlineContributorDto {
        name: contributor.name,
        email: contributor.email,
    }
}

fn change_set_to_dto(change_set: ChangeSet) -> DraftlineChangeSetDto {
    DraftlineChangeSetDto {
        files: change_set
            .files
            .into_iter()
            .map(changed_file_to_dto)
            .collect(),
        diff: change_set.diff,
    }
}

fn changed_file_to_dto(file: ChangedFile) -> DraftlineChangedFileDto {
    DraftlineChangedFileDto {
        path: path_to_string(&file.path),
        kind: change_kind_to_dto(file.kind),
        is_binary: file.is_binary,
        is_large: file.is_large,
    }
}

fn version_to_dto(version: Version) -> DraftlineVersionDto {
    DraftlineVersionDto {
        id: version.id().clone(),
        label: version.label,
        author: contributor_to_dto(version.author),
        saved_by: contributor_to_dto(version.saved_by),
        time_seconds: version.time_seconds,
    }
}

fn workspace_summary_to_dto(
    summary: WorkspaceSummary,
) -> Result<DraftlineWorkspaceSummaryDto, String> {
    let recovery = summary
        .recovery
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| error.to_string())?;

    Ok(DraftlineWorkspaceSummaryDto {
        active_variation: variation_to_dto(summary.active_variation),
        variations: summary
            .variations
            .into_iter()
            .map(variation_to_dto)
            .collect(),
        versions: summary.versions.into_iter().map(version_to_dto).collect(),
        dirty_files: summary
            .dirty_files
            .into_iter()
            .map(changed_file_to_dto)
            .collect(),
        is_dirty: summary.is_dirty,
        recovery,
        state_may_be_inconsistent: summary.state_may_be_inconsistent,
    })
}

fn history_entry_to_dto(entry: HistoryEntry) -> DraftlineHistoryEntryDto {
    DraftlineHistoryEntryDto {
        version: version_to_dto(entry.version),
        variation_tips: entry.variation_tips,
        is_head: entry.is_head,
        parent_ids: entry.parent_ids,
    }
}

fn variation_summary_to_dto(summary: VariationSummary) -> DraftlineVariationSummaryDto {
    DraftlineVariationSummaryDto {
        variation: variation_to_dto(summary.variation),
        head_version: summary.head_version.map(version_to_dto),
        reachable_version_count: summary.reachable_version_count,
    }
}

fn variation_to_dto(variation: Variation) -> DraftlineVariationDto {
    let id = variation.id().clone();
    let display_label = variation.display_label().to_string();
    let VariationMetadata { label, slug } = variation.metadata;
    DraftlineVariationDto {
        id,
        name: variation.name,
        label,
        slug,
        display_label,
        is_current: variation.is_current,
    }
}

fn preview_file_to_dto(file: PreviewFile) -> DraftlinePreviewFileDto {
    DraftlinePreviewFileDto {
        path: path_to_string(&file.path),
        content: file.content,
        is_binary: file.is_binary,
    }
}

fn preview_to_dto(preview: VersionPreview) -> DraftlineVersionPreviewDto {
    DraftlineVersionPreviewDto {
        id: preview.id,
        files: preview.files.into_iter().map(preview_file_to_dto).collect(),
    }
}

fn shelf_to_dto(shelf: Shelf) -> DraftlineShelfDto {
    DraftlineShelfDto {
        id: shelf.id,
        version: version_to_dto(shelf.version),
    }
}

fn version_diff_to_dto(diff: VersionDiff) -> DraftlineVersionDiffDto {
    DraftlineVersionDiffDto {
        from_version: diff.from_version,
        to_version: diff.to_version,
        files: diff.files.into_iter().map(changed_file_to_dto).collect(),
        patch: diff.patch,
    }
}

fn preflight_to_dto(report: PreflightReport) -> DraftlinePreflightReportDto {
    DraftlinePreflightReportDto {
        operation: report.operation,
        will_write_files: report.will_write_files,
        dirty_files: report
            .dirty_files
            .into_iter()
            .map(changed_file_to_dto)
            .collect(),
        file_hazards: report
            .file_hazards
            .iter()
            .map(|hazard| path_to_string(&hazard.path))
            .collect(),
        untracked_assets: report
            .untracked_assets
            .iter()
            .map(|path| path_to_string(path))
            .collect(),
        unresolved_conflicts: report
            .unresolved_conflicts
            .iter()
            .map(|path| path_to_string(path))
            .collect(),
        large_files: report
            .large_files
            .iter()
            .map(|path| path_to_string(path))
            .collect(),
        binary_files: report
            .binary_files
            .iter()
            .map(|path| path_to_string(path))
            .collect(),
        variation_divergence: report.variation_divergence,
        can_proceed: report.can_proceed,
    }
}

fn remote_endpoint_to_dto(remote: RemoteEndpoint) -> DraftlineRemoteEndpointDto {
    DraftlineRemoteEndpointDto {
        name: remote.name,
        url: redact_remote_url_credentials(&remote.url),
    }
}

fn sync_state_to_dto(state: SyncState) -> DraftlineSyncStateDto {
    match state {
        SyncState::UpToDate => DraftlineSyncStateDto::UpToDate,
        SyncState::LocalAhead => DraftlineSyncStateDto::LocalAhead,
        SyncState::IncomingAvailable => DraftlineSyncStateDto::IncomingAvailable,
        SyncState::NeedsMerge => DraftlineSyncStateDto::NeedsMerge,
        SyncState::NoRemoteVersion => DraftlineSyncStateDto::NoRemoteVersion,
    }
}

fn sync_status_to_dto(status: SyncStatus) -> DraftlineSyncStatusDto {
    DraftlineSyncStatusDto {
        remote: status.remote,
        variation: status.variation,
        ahead: status.ahead,
        behind: status.behind,
        state: sync_state_to_dto(status.state),
        incoming: status
            .incoming
            .into_iter()
            .map(|incoming| DraftlineRemoteVersionSummaryDto {
                id: incoming.id,
                label: incoming.label,
                author: contributor_to_dto(incoming.author),
                time_seconds: incoming.time_seconds,
            })
            .collect(),
    }
}

fn apply_incoming_report_to_dto(report: ApplyIncomingReport) -> DraftlineApplyIncomingReportDto {
    DraftlineApplyIncomingReportDto {
        sync_status: sync_status_to_dto(report.sync_status),
        dirty_files: report
            .dirty_files
            .into_iter()
            .map(changed_file_to_dto)
            .collect(),
        is_fast_forward: report.is_fast_forward,
        can_proceed: report.can_proceed,
    }
}

fn apply_incoming_result_to_dto(result: ApplyIncomingResult) -> DraftlineApplyIncomingResultDto {
    DraftlineApplyIncomingResultDto {
        applied_count: result.applied_count,
    }
}

fn merge_incoming_report_to_dto(report: MergeIncomingReport) -> DraftlineMergeIncomingReportDto {
    DraftlineMergeIncomingReportDto {
        sync_status: sync_status_to_dto(report.sync_status),
        dirty_files: report
            .dirty_files
            .into_iter()
            .map(changed_file_to_dto)
            .collect(),
        file_hazards: report
            .file_hazards
            .iter()
            .map(|hazard| path_to_string(&hazard.path))
            .collect(),
        conflicts: report
            .conflicts
            .into_iter()
            .map(merge_conflict_to_dto)
            .collect(),
        token: report.token.map(merge_token_to_dto),
        can_merge_cleanly: report.can_merge_cleanly,
        changed_workspace: report.changed_workspace,
    }
}

fn merge_token_to_dto(token: MergeIncomingToken) -> DraftlineMergeIncomingTokenDto {
    DraftlineMergeIncomingTokenDto {
        remote: token.remote,
        variation: token.variation,
        local_oid: token.local_oid,
        remote_oid: token.remote_oid,
        merge_base_oid: token.merge_base_oid,
    }
}

fn merge_token_from_dto(
    token: DraftlineMergeIncomingTokenDto,
) -> Result<MergeIncomingToken, String> {
    serde_json::from_value(serde_json::json!({
        "remote": token.remote,
        "variation": token.variation,
        "local_oid": token.local_oid,
        "remote_oid": token.remote_oid,
        "merge_base_oid": token.merge_base_oid,
    }))
    .map_err(|error| error.to_string())
}

fn merge_conflict_to_dto(conflict: MergeConflict) -> DraftlineMergeConflictDto {
    DraftlineMergeConflictDto {
        path: path_to_string(&conflict.path),
        field_path: conflict.field_path,
        label: conflict.label,
        base: conflict.base,
        ours: conflict.ours,
        theirs: conflict.theirs,
        resolution: resolution_kind_to_dto(conflict.resolution),
    }
}

fn resolution_kind_to_dto(kind: ResolutionKind) -> DraftlineResolutionKindDto {
    match kind {
        ResolutionKind::Choose => DraftlineResolutionKindDto::Choose,
        ResolutionKind::Edit => DraftlineResolutionKindDto::Edit,
        ResolutionKind::Combine => DraftlineResolutionKindDto::Combine,
        ResolutionKind::Delete => DraftlineResolutionKindDto::Delete,
    }
}

fn merge_resolution_from_input(
    resolution: DraftlineMergeConflictResolutionInput,
) -> MergeConflictResolution {
    let choice = match resolution.choice {
        DraftlineMergeResolutionChoiceInput::UseOurs => MergeResolutionChoice::UseOurs,
        DraftlineMergeResolutionChoiceInput::UseTheirs => MergeResolutionChoice::UseTheirs,
        DraftlineMergeResolutionChoiceInput::UseBase => MergeResolutionChoice::UseBase,
        DraftlineMergeResolutionChoiceInput::Delete => MergeResolutionChoice::Delete,
        DraftlineMergeResolutionChoiceInput::UseContent { content } => {
            MergeResolutionChoice::UseContent { content }
        }
    };

    if let Some(field_path) = resolution.field_path {
        MergeConflictResolution::with_field_path(resolution.path, field_path, choice)
    } else {
        MergeConflictResolution::new(resolution.path, choice)
    }
}

fn merge_incoming_result_to_dto(result: MergeIncomingResult) -> DraftlineMergeIncomingResultDto {
    DraftlineMergeIncomingResultDto {
        version: version_to_dto(result.version),
        merged_files: result
            .merged_files
            .iter()
            .map(|path| path_to_string(path))
            .collect(),
    }
}

fn switch_policy_from_input(policy: DraftlineSwitchPolicyInput) -> draftline::SwitchPolicy {
    match policy {
        DraftlineSwitchPolicyInput::AbortIfDirty => draftline::SwitchPolicy::AbortIfDirty,
        DraftlineSwitchPolicyInput::SaveFirst { label } => {
            draftline::SwitchPolicy::SaveFirst { label }
        }
    }
}

fn version_id_from_input(version: String) -> Result<VersionId, String> {
    VersionId::from_canonical_string(&version).map_err(|error| error.to_string())
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
    let mut cmd = std::process::Command::new("gh");
    cmd.args(["auth", "token"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    match cmd.output() {
        Ok(output) if output.status.success() => {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if token.is_empty() {
                None
            } else {
                Some(token)
            }
        }
        _ => None,
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
    contract::into_tauri_result(contract::get_workspace_graph_with_context(&context, request))
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

#[auditaur_command(skip_all, err)]
pub async fn draftline_inspect_changes(
    state: State<'_, AppState>,
) -> Result<DraftlineChangeSetDto, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .inspect_changes()
        .map(change_set_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_discard_changes(
    state: State<'_, AppState>,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineChangeSetDto, String> {
    let _guard = lock.0.lock().await;
    let (workspace_path, mut context) = open_draftline_context(&state, Some(app))?;
    let changes = contract::get_changes_with_context(
        &context,
        contract::WorkspaceRequest {
            workspace_path: workspace_path.clone(),
        },
    )
    .map_err(|error| error.to_string())?;
    let paths = changes.files.into_iter().map(|file| file.path).collect();
    contract::selected_discard_with_context(
        &mut context,
        contract::SelectedDiscardRequest {
            workspace_path,
            paths,
        },
    )
    .map(|result| change_set_to_dto(result.discarded))
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_discard_file(
    path: String,
    state: State<'_, AppState>,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<Option<DraftlineChangedFileDto>, String> {
    let _guard = lock.0.lock().await;
    let (workspace_path, mut context) = open_draftline_context(&state, Some(app))?;
    contract::selected_discard_with_context(
        &mut context,
        contract::SelectedDiscardRequest {
            workspace_path,
            paths: vec![PathBuf::from(path)],
        },
    )
    .map(|result| {
        result
            .discarded
            .files
            .into_iter()
            .next()
            .map(changed_file_to_dto)
    })
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_workspace_summary(
    state: State<'_, AppState>,
) -> Result<DraftlineWorkspaceSummaryDto, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .workspace_summary()
        .map_err(|error| error.to_string())
        .and_then(workspace_summary_to_dto)
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_save_version(
    label: String,
    state: State<'_, AppState>,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineVersionDto, String> {
    let _guard = lock.0.lock().await;
    let (workspace_path, mut context) = open_draftline_context(&state, Some(app))?;
    let changes = contract::get_changes_with_context(
        &context,
        contract::WorkspaceRequest {
            workspace_path: workspace_path.clone(),
        },
    )
    .map_err(|error| error.to_string())?;
    let paths = changes.files.into_iter().map(|file| file.path).collect();
    contract::selected_save_with_context(
        &mut context,
        contract::SelectedSaveRequest {
            workspace_path,
            paths,
            label,
        },
    )
    .map(|result| version_to_dto(result.version))
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_shelve_changes(
    name: String,
    state: State<'_, AppState>,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineShelfDto, String> {
    let _guard = lock.0.lock().await;
    let (workspace_path, mut context) = open_draftline_context(&state, Some(app))?;
    let changes = contract::get_changes_with_context(
        &context,
        contract::WorkspaceRequest {
            workspace_path: workspace_path.clone(),
        },
    )
    .map_err(|error| error.to_string())?;
    let paths = changes.files.into_iter().map(|file| file.path).collect();
    contract::selected_shelve_with_context(
        &mut context,
        contract::SelectedShelveRequest {
            workspace_path,
            paths,
            name,
        },
    )
    .map(|result| shelf_to_dto(result.shelf))
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_list_shelves(
    state: State<'_, AppState>,
) -> Result<Vec<DraftlineShelfDto>, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .list_shelves()
        .map(|shelves| shelves.into_iter().map(shelf_to_dto).collect())
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_apply_shelf(
    id: String,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineShelfDto, String> {
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    adapter
        .apply_shelf(&id)
        .map(shelf_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_delete_shelf(
    id: String,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<(), String> {
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    adapter.delete_shelf(&id).map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_list_versions(
    state: State<'_, AppState>,
) -> Result<Vec<DraftlineVersionDto>, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .versions()
        .map(|versions| versions.into_iter().map(version_to_dto).collect())
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_full_history(
    state: State<'_, AppState>,
) -> Result<Vec<DraftlineHistoryEntryDto>, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .full_history()
        .map(|entries| entries.into_iter().map(history_entry_to_dto).collect())
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_preview_version(
    version: String,
    state: State<'_, AppState>,
) -> Result<DraftlineVersionPreviewDto, String> {
    let version = version_id_from_input(version)?;
    let adapter = open_adapter(&state)?;
    adapter
        .preview_version(&version)
        .map(preview_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_preview_version_file(
    version: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<DraftlinePreviewFileDto>, String> {
    let version = version_id_from_input(version)?;
    let adapter = open_adapter(&state)?;
    adapter
        .preview_version_file(&version, path)
        .map(|file| file.map(preview_file_to_dto))
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_current_variation(state: State<'_, AppState>) -> Result<String, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .current_variation()
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_list_variations(
    state: State<'_, AppState>,
) -> Result<Vec<DraftlineVariationDto>, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .variations()
        .map(|variations| variations.into_iter().map(variation_to_dto).collect())
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_variation_summaries(
    state: State<'_, AppState>,
) -> Result<Vec<DraftlineVariationSummaryDto>, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .variation_summaries()
        .map(|summaries| {
            summaries
                .into_iter()
                .map(variation_summary_to_dto)
                .collect()
        })
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_create_variation_from(
    version: String,
    name: String,
    metadata: Option<DraftlineVariationMetadataInput>,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineVariationDto, String> {
    let _guard = lock.0.lock().await;
    let version = version_id_from_input(version)?;
    let adapter = open_adapter(&state)?;
    let metadata = metadata.unwrap_or(DraftlineVariationMetadataInput {
        label: None,
        slug: None,
    });
    adapter
        .create_variation_from_with_metadata(
            &version,
            &name,
            metadata.label.as_deref(),
            metadata.slug.as_deref(),
        )
        .map(variation_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_delete_variation(
    variation: VariationId,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<(), String> {
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    adapter
        .delete_variation(&variation)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_preflight_switch_variation(
    variation: VariationId,
    state: State<'_, AppState>,
) -> Result<DraftlinePreflightReportDto, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .preflight_switch_variation(&variation)
        .map(preflight_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_switch_variation(
    variation: VariationId,
    policy: DraftlineSwitchPolicyInput,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineVariationDto, String> {
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    adapter
        .switch_variation_with_policy(&variation, switch_policy_from_input(policy))
        .map(variation_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_restore_version_as_new_save(
    version: String,
    label: String,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineVersionDto, String> {
    let _guard = lock.0.lock().await;
    let version = version_id_from_input(version)?;
    let adapter = open_adapter(&state)?;
    adapter
        .restore_version_as_new_save(&version, &label)
        .map(version_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_squash_versions(
    count: usize,
    label: String,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineVersionDto, String> {
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    adapter
        .squash_versions(count, &label)
        .map(version_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_diff_versions(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<DraftlineVersionDiffDto, String> {
    let from = version_id_from_input(from)?;
    let to = version_id_from_input(to)?;
    let adapter = open_adapter(&state)?;
    adapter
        .diff_versions(&from, &to)
        .map(version_diff_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_diff_version_to_workspace(
    version: String,
    state: State<'_, AppState>,
) -> Result<DraftlineVersionDiffDto, String> {
    let version = version_id_from_input(version)?;
    let adapter = open_adapter(&state)?;
    adapter
        .diff_version_to_workspace(&version)
        .map(version_diff_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_file_diff_content(
    file_path: String,
    state: State<'_, AppState>,
) -> Result<DraftlineFileDiffContentDto, String> {
    let root = draftline_project_root(&state)?;
    let adapter =
        CutReadyDraftlineAdapter::open_project(&root).map_err(|error| error.to_string())?;
    let head_content = match adapter
        .versions()
        .map_err(|error| error.to_string())?
        .first()
    {
        Some(version) => adapter
            .preview_version_file(version.id(), &file_path)
            .map_err(|error| error.to_string())?
            .and_then(|file| file.content),
        None => None,
    };

    let abs_path = project::safe_resolve(&root, &file_path).map_err(|error| error.to_string())?;
    let working_content = if abs_path.exists() {
        Some(std::fs::read_to_string(&abs_path).map_err(|error| error.to_string())?)
    } else {
        None
    };

    Ok(DraftlineFileDiffContentDto {
        path: file_path,
        head_content,
        working_content,
    })
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_add_remote(
    name: String,
    url: String,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineRemoteEndpointDto, String> {
    reject_remote_url_credentials(&url)?;
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    adapter
        .add_remote(&name, &url)
        .map(remote_endpoint_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_list_remotes(
    state: State<'_, AppState>,
) -> Result<Vec<DraftlineRemoteEndpointDto>, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .remotes()
        .map(|remotes| remotes.into_iter().map(remote_endpoint_to_dto).collect())
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_fetch_remote(
    remote: String,
    state: State<'_, AppState>,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<(), String> {
    let _guard = lock.0.lock().await;
    let (workspace_path, mut context) = open_draftline_context(&state, Some(app))?;
    contract::fetch_remote_with_context(
        &mut context,
        contract::RemoteRequest {
            workspace_path,
            remote,
        },
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_preflight_apply_incoming(
    remote: String,
    state: State<'_, AppState>,
) -> Result<DraftlineApplyIncomingReportDto, String> {
    let (workspace_path, mut context) = open_draftline_context(&state, None)?;
    contract::preflight_apply_incoming_with_context(
        &mut context,
        contract::RemoteRequest {
            workspace_path,
            remote,
        },
    )
    .map(apply_incoming_report_to_dto)
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_apply_incoming(
    remote: String,
    state: State<'_, AppState>,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineApplyIncomingResultDto, String> {
    let _guard = lock.0.lock().await;
    let (workspace_path, mut context) = open_draftline_context(&state, Some(app))?;
    contract::apply_incoming_with_context(
        &mut context,
        contract::RemoteRequest {
            workspace_path,
            remote,
        },
    )
    .map(|result| apply_incoming_result_to_dto(result.apply))
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_preflight_merge_incoming(
    remote: String,
    state: State<'_, AppState>,
) -> Result<DraftlineMergeIncomingReportDto, String> {
    let (workspace_path, mut context) = open_draftline_context(&state, None)?;
    contract::preflight_merge_incoming_with_context(
        &mut context,
        contract::RemoteRequest {
            workspace_path,
            remote,
        },
    )
    .map(merge_incoming_report_to_dto)
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_merge_incoming(
    remote: String,
    label: String,
    state: State<'_, AppState>,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineMergeIncomingResultDto, String> {
    let _guard = lock.0.lock().await;
    let (workspace_path, mut context) = open_draftline_context(&state, Some(app))?;
    contract::merge_incoming_with_context(
        &mut context,
        contract::MergeIncomingRequest {
            workspace_path,
            remote,
            label,
        },
    )
    .map(|result| merge_incoming_result_to_dto(result.merge))
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_merge_incoming_with_resolutions(
    token: DraftlineMergeIncomingTokenDto,
    label: String,
    resolutions: Vec<DraftlineMergeConflictResolutionInput>,
    state: State<'_, AppState>,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineMergeIncomingResultDto, String> {
    let _guard = lock.0.lock().await;
    let (workspace_path, mut context) = open_draftline_context(&state, Some(app))?;
    let remote = token.remote.clone();
    contract::merge_incoming_with_resolutions_with_context(
        &mut context,
        contract::MergeIncomingWithResolutionsRequest {
            workspace_path,
            remote,
            label,
            token: merge_token_from_dto(token)?,
            resolutions: resolutions
                .into_iter()
                .map(merge_resolution_from_input)
                .collect(),
        },
    )
    .map(|result| merge_incoming_result_to_dto(result.merge))
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_publish_changes(
    remote: String,
    state: State<'_, AppState>,
    app: AppHandle,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlinePublishResultDto, String> {
    let _guard = lock.0.lock().await;
    let (workspace_path, mut context) = open_draftline_context(&state, Some(app))?;
    contract::publish_current_variation_with_context(
        &mut context,
        contract::PublishCurrentVariationRequest {
            workspace_path,
            remote,
        },
    )
    .map(|result| DraftlinePublishResultDto {
        remote: result.publish.remote,
        variation: result.publish.variation,
        published_versions: result.publish.published_versions,
    })
    .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_sync_status(
    remote: String,
    state: State<'_, AppState>,
) -> Result<DraftlineSyncStatusDto, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .sync_status(&remote)
        .map_err(|error| error.to_string())
        .map(sync_status_to_dto)
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
    fn typed_version_id_boundary_rejects_short_prefixes() {
        let error = version_id_from_input("0123456789abcdef".to_string()).unwrap_err();

        assert!(!error.is_empty());
    }

    #[test]
    fn typed_version_id_boundary_rejects_uppercase_hex() {
        let error = version_id_from_input("0123456789ABCDEF0123456789abcdef01234567".to_string())
            .unwrap_err();

        assert!(!error.is_empty());
    }

    #[test]
    fn preflight_dto_preserves_dirty_file_shape() {
        let report = PreflightReport {
            operation: "switch_variation".to_string(),
            will_write_files: true,
            dirty_files: vec![draftline::ChangedFile {
                path: PathBuf::from("intro.sk"),
                kind: ChangeKind::Modified,
                is_binary: false,
                is_large: false,
            }],
            file_hazards: Vec::new(),
            untracked_assets: vec![PathBuf::from("screenshots/frame.png")],
            unresolved_conflicts: Vec::new(),
            large_files: Vec::new(),
            binary_files: Vec::new(),
            variation_divergence: Some("main -> alternate".to_string()),
            can_proceed: false,
        };

        let dto = preflight_to_dto(report);
        assert!(!dto.can_proceed);
        assert_eq!(dto.dirty_files[0].path, "intro.sk");
        assert!(matches!(
            dto.dirty_files[0].kind,
            DraftlineChangeKindDto::Modified
        ));
        assert_eq!(dto.untracked_assets, vec!["screenshots/frame.png"]);
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
