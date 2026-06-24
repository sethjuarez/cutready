import { invoke } from "./tauri";
import type { DiffEntry, GraphNode, IncomingCommit, RemoteInfo, SyncStatus, TimelineInfo, VersionEntry } from "../types/sketch";

interface DraftlineVersionDto {
  id: string;
  label: string;
  timeSeconds: number;
  author: {
    name: string;
    email?: string | null;
  };
}

interface DraftlineVariationDto {
  id: string;
  name: string;
  displayLabel: string;
  isCurrent: boolean;
}

interface DraftlineWorkspaceSummaryDto {
  activeVariation: DraftlineVariationDto;
  variations: DraftlineVariationDto[];
  versions: DraftlineVersionDto[];
  dirtyFiles: DraftlineChangedFileDto[];
  isDirty: boolean;
  stateMayBeInconsistent: boolean;
}

interface DraftlineHistoryEntryDto {
  version: DraftlineVersionDto;
  variationTips: string[];
  isHead: boolean;
  parentIds: string[];
}

interface DraftlineVariationSummaryDto {
  variation: DraftlineVariationDto;
  headVersion?: DraftlineVersionDto | null;
  reachableVersionCount: number;
}

interface DraftlineRemoteDto {
  name: string;
  url: string;
}

interface DraftlineSyncStatusDto {
  remote: string;
  variation: string;
  ahead: number;
  behind: number;
  state: "upToDate" | "localAhead" | "incomingAvailable" | "needsMerge" | "noRemoteVersion";
  incoming: Array<{
    id: string;
    label: string;
    timeSeconds: number;
    author: {
      name: string;
      email?: string | null;
    };
  }>;
}

interface DraftlineChangedFileDto {
  path: string;
  kind: "added" | "modified" | "deleted" | "renamed" | "conflicted" | "typeChanged";
}

interface DraftlineChangeSetDto {
  files: DraftlineChangedFileDto[];
}

interface DraftlineVersionDiffDto {
  fromVersion?: string | null;
  toVersion?: string | null;
  files: DraftlineChangedFileDto[];
  patch?: string | null;
}

interface DraftlineApplyIncomingReportDto {
  syncStatus: DraftlineSyncStatusDto;
  dirtyFiles: DraftlineChangedFileDto[];
  isFastForward: boolean;
  canProceed: boolean;
}

interface DraftlineApplyIncomingResultDto {
  appliedCount: number;
}

export async function listDraftlineVersions(): Promise<VersionEntry[]> {
  const summary = await getDraftlineWorkspaceSummary();
  return summary.versions.map((version) => ({
    id: version.id,
    message: version.label,
    timestamp: new Date(version.timeSeconds * 1000).toISOString(),
    summary: version.label,
  }));
}

export async function listDraftlineGraphNodes(): Promise<GraphNode[]> {
  const [summary, history, variations] = await Promise.all([
    getDraftlineWorkspaceSummary(),
    invoke<DraftlineHistoryEntryDto[]>("draftline_full_history"),
    invoke<DraftlineVariationSummaryDto[]>("draftline_variation_summaries"),
  ]);
  const laneByVariation = new Map(variations.map((entry, index) => [entry.variation.id, index]));
  const headVariationByVersion = new Map(
    variations
      .filter((entry) => entry.headVersion)
      .map((entry) => [entry.headVersion!.id, entry.variation.id]),
  );

  return history.map((entry) => {
    const timeline = entry.variationTips[0]
      ?? headVariationByVersion.get(entry.version.id)
      ?? summary.activeVariation.id;
    return {
      id: entry.version.id,
      message: entry.version.label,
      timestamp: new Date(entry.version.timeSeconds * 1000).toISOString(),
      timeline,
      parents: entry.parentIds,
      lane: laneByVariation.get(timeline) ?? 0,
      is_head: entry.isHead,
      is_branch_tip: entry.variationTips.length > 0,
      author: entry.version.author.name,
    };
  });
}

export async function listDraftlineTimelines(): Promise<TimelineInfo[]> {
  const variations = await invoke<DraftlineVariationSummaryDto[]>("draftline_variation_summaries");

  return variations.map((summary, index) => ({
    name: summary.variation.id,
    label: summary.variation.displayLabel,
    is_active: summary.variation.isCurrent,
    snapshot_count: summary.reachableVersionCount,
    color_index: index,
  }));
}

export async function previewDraftlineVersion(version: string): Promise<DiffEntry[]> {
  return versionDiffToDiffEntries(
    await invoke<DraftlineVersionDiffDto>("draftline_diff_version_to_workspace", { version }),
  );
}

export async function diffDraftlineVersions(from: string, to: string): Promise<DiffEntry[]> {
  return versionDiffToDiffEntries(
    await invoke<DraftlineVersionDiffDto>("draftline_diff_versions", { from, to }),
  );
}

export async function createDraftlineVariation(fromVersion: string, name: string): Promise<void> {
  await invoke<DraftlineVariationDto>("draftline_create_variation_from", {
    version: fromVersion,
    name,
    metadata: { label: name, slug: name },
  });
}

export async function switchDraftlineVariation(variation: string, saveFirstLabel?: string): Promise<void> {
  await invoke<DraftlineVariationDto>("draftline_switch_variation", {
    variation,
    policy: saveFirstLabel
      ? { type: "saveFirst", label: saveFirstLabel }
      : { type: "abortIfDirty" },
  });
}

export async function restoreDraftlineVersionAsNewSave(version: string, label: string): Promise<string> {
  const restored = await invoke<DraftlineVersionDto>("draftline_restore_version_as_new_save", { version, label });
  return restored.id;
}

export async function listDraftlineRemotes(): Promise<RemoteInfo[]> {
  const remotes = await invoke<DraftlineRemoteDto[]>("draftline_list_remotes");
  return remotes.map((remote) => ({ name: remote.name, url: remote.url }));
}

export async function addDraftlineRemote(name: string, url: string): Promise<RemoteInfo> {
  const remote = await invoke<DraftlineRemoteDto>("draftline_add_remote", { name, url });
  return { name: remote.name, url: remote.url };
}

export async function fetchDraftlineRemote(remote: string, githubToken: string | null): Promise<void> {
  await invoke("draftline_fetch_remote", { remote, githubToken });
}

export async function publishDraftlineChanges(remote: string, githubToken: string | null): Promise<void> {
  await invoke("draftline_publish_changes", { remote, githubToken });
}

export async function preflightDraftlineIncoming(remote: string): Promise<DraftlineApplyIncomingReportDto> {
  return invoke<DraftlineApplyIncomingReportDto>("draftline_preflight_apply_incoming", { remote });
}

export async function applyDraftlineIncoming(remote: string, githubToken: string | null): Promise<number> {
  const result = await invoke<DraftlineApplyIncomingResultDto>("draftline_apply_incoming", { remote, githubToken });
  return result.appliedCount;
}

export async function getDraftlineSyncStatus(remote: string): Promise<SyncStatus> {
  const status = await invoke<DraftlineSyncStatusDto>("draftline_sync_status", { remote });
  return {
    ahead: status.ahead,
    behind: status.behind,
  };
}

export async function listDraftlineIncomingCommits(remote: string): Promise<IncomingCommit[]> {
  const status = await invoke<DraftlineSyncStatusDto>("draftline_sync_status", { remote });
  return status.incoming.map((version) => ({
    id: version.id,
    message: version.label,
    author: version.author.name,
    timestamp: new Date(version.timeSeconds * 1000).toISOString(),
    changed_files: [],
    projects: [status.variation],
  }));
}

export async function inspectDraftlineChanges(): Promise<DraftlineChangeSetDto> {
  const summary = await getDraftlineWorkspaceSummary();
  return { files: summary.dirtyFiles };
}

export async function hasDraftlineChanges(): Promise<boolean> {
  const changes = await inspectDraftlineChanges();
  return changes.files.length > 0;
}

export async function listDraftlineChangedFiles(): Promise<DiffEntry[]> {
  const summary = await getDraftlineWorkspaceSummary();
  const head = summary.versions[0]?.id;
  if (!head) {
    return changedFilesToDiffEntries(summary.dirtyFiles);
  }
  return versionDiffToDiffEntries(
    await invoke<DraftlineVersionDiffDto>("draftline_diff_version_to_workspace", { version: head }),
  );
}

export async function saveDraftlineVersion(label: string): Promise<string> {
  const version = await invoke<DraftlineVersionDto>("draftline_save_version", { label });
  return version.id;
}

export async function squashDraftlineVersions(count: number, label: string): Promise<string> {
  const version = await invoke<DraftlineVersionDto>("draftline_squash_versions", { count, label });
  return version.id;
}

async function getDraftlineWorkspaceSummary(): Promise<DraftlineWorkspaceSummaryDto> {
  return invoke<DraftlineWorkspaceSummaryDto>("draftline_workspace_summary");
}

function versionDiffToDiffEntries(diff: DraftlineVersionDiffDto): DiffEntry[] {
  return changedFilesToDiffEntries(diff.files);
}

function changedFilesToDiffEntries(files: DraftlineChangedFileDto[]): DiffEntry[] {
  return files.map((file) => ({
    path: file.path,
    status: changeKindToStatus(file.kind),
    additions: 0,
    deletions: 0,
  }));
}

function changeKindToStatus(kind: DraftlineChangedFileDto["kind"]): string {
  switch (kind) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "conflicted":
      return "conflicted";
    case "typeChanged":
      return "modified";
    case "modified":
    default:
      return "modified";
  }
}
