//! Internal, feature-gated Tauri commands for the Draftline adapter spike.

use std::path::{Path, PathBuf};

use draftline::{
    ApplyIncomingReport, ApplyIncomingResult, ChangeKind, ChangeSet, ChangedFile, Contributor,
    HistoryEntry, PreflightReport, PreviewFile, RemoteEndpoint, SyncState, SyncStatus, Variation,
    VariationId, VariationMetadata, VariationSummary, Version, VersionDiff, VersionId,
    VersionPreview, WorkspaceSummary,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::draftline_adapter::{cutready_remote_options, CutReadyDraftlineAdapter};
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
    Ok(view.root.clone())
}

fn open_adapter(state: &AppState) -> Result<CutReadyDraftlineAdapter, String> {
    CutReadyDraftlineAdapter::open_project(draftline_project_root(state)?)
        .map_err(|error| error.to_string())
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
            "Remote URLs must not include credentials. Use the token field for authentication."
                .to_string(),
        );
    }

    Ok(())
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
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineVersionDto, String> {
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    adapter
        .save_version(&label)
        .map(version_to_dto)
        .map_err(|error| error.to_string())
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
    github_token: Option<String>,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<(), String> {
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    let mut options = cutready_remote_options(github_token);
    adapter
        .fetch_remote_with_options(&remote, &mut options)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_preflight_apply_incoming(
    remote: String,
    state: State<'_, AppState>,
) -> Result<DraftlineApplyIncomingReportDto, String> {
    let adapter = open_adapter(&state)?;
    adapter
        .preflight_apply_incoming(&remote)
        .map(apply_incoming_report_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_apply_incoming(
    remote: String,
    github_token: Option<String>,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlineApplyIncomingResultDto, String> {
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    let mut options = cutready_remote_options(github_token);
    adapter
        .apply_incoming_with_options(&remote, &mut options)
        .map(apply_incoming_result_to_dto)
        .map_err(|error| error.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn draftline_publish_changes(
    remote: String,
    github_token: Option<String>,
    state: State<'_, AppState>,
    lock: State<'_, ProjectLock>,
) -> Result<DraftlinePublishResultDto, String> {
    let _guard = lock.0.lock().await;
    let adapter = open_adapter(&state)?;
    let mut options = cutready_remote_options(github_token);
    adapter
        .publish_changes_with_options(&remote, &mut options)
        .map(|result| DraftlinePublishResultDto {
            remote: result.remote,
            variation: result.variation,
            published_versions: result.published_versions,
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
        .map(sync_status_to_dto)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct TypedIdBoundary {
        version: VersionId,
        variation: VariationId,
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
        let error =
            version_id_from_input("0123456789ABCDEF0123456789abcdef01234567".to_string())
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
