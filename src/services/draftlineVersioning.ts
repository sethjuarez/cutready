import {
  createDraftlineClient,
  createDraftlineHostFacade,
  createMergeConflictViewModel,
  createWholeFileUseContentResolutions,
  type ApplyIncomingReport,
  type ChangedFile,
  type ConflictContentSource,
  type DraftlineHostFacade,
  type MergeConflictResolution,
  type MergeConflictViewModel,
  type MergeIncomingReport,
  type MergeIncomingToken,
  type PreflightReport,
  type RemoteVariation,
  type RenameVariationResult,
  type RestoreVersionTarget,
  type SwitchVariationResult,
  type SyncState,
  type TargetedRestoreVersionResult,
  type VariationRenamePreflight,
  type VariationRenameToken,
  type VariationCreatePreflight,
  type VariationCreateToken,
  type HistoryCleanupPreview,
  type TimelineCleanupResult,
  type VariationSummary,
  type Version,
  type VersionDiff,
  type WorkspaceGraphNode,
  type WorkspaceGraphRef,
} from "@draftline/client";
import { invoke, listen } from "./tauri";
import type { ConflictFile, DiffEntry, GraphNode, IncomingCommit, RemoteBranchInfo, RemoteInfo, SyncStatus, TimelineInfo, VersionEntry } from "../types/sketch";

export type DraftlineMergeIncomingToken = MergeIncomingToken;
export type DraftlineMergeConflictResolution = MergeConflictResolution;
export type DraftlineRestoreVersionTarget = RestoreVersionTarget;
export type DraftlineVariationRenamePreflight = VariationRenamePreflight;
export type DraftlineVariationRenameToken = VariationRenameToken;
export type DraftlineRenameVariationResult = RenameVariationResult;
export type DraftlineSwitchVariationPreflight = PreflightReport;
export type DraftlineSwitchVariationResult = SwitchVariationResult;
export type DraftlineVariationCreatePreflight = VariationCreatePreflight;
export type DraftlineVariationCreateToken = VariationCreateToken;
export type DraftlineHistoryCleanupPreview = HistoryCleanupPreview;
export type DraftlineTimelineCleanupResult = TimelineCleanupResult;

export class DraftlineVariationCreateConflictError extends Error {
  readonly preflight: VariationCreatePreflight;

  constructor(preflight: VariationCreatePreflight) {
    super(variationCreateConflictMessage(preflight));
    this.name = "DraftlineVariationCreateConflictError";
    this.preflight = preflight;
  }
}

export function isDraftlineVariationCreateConflictError(
  error: unknown,
): error is DraftlineVariationCreateConflictError {
  return error instanceof DraftlineVariationCreateConflictError;
}

export interface DraftlineMergeIncomingReport {
  syncStatus: {
    ahead: number;
    behind: number;
    state: "upToDate" | "localAhead" | "incomingAvailable" | "needsMerge" | "noRemoteVersion";
  };
  dirtyFiles: DiffEntry[];
  fileHazards: string[];
  conflicts: ConflictFile[];
  token?: MergeIncomingToken | null;
  canMergeCleanly: boolean;
  changedWorkspace: boolean;
  viewModel: MergeConflictViewModel;
}

export interface DraftlinePreviewFile {
  path: string;
  content: string | null;
  isBinary: boolean;
}

export interface DraftlineFileDiffContent {
  path: string;
  headContent: string | null;
  workingContent: string | null;
  headPresent: boolean;
  workingPresent: boolean;
  isBinary: boolean;
}

interface DraftlineApplyIncomingReportDto {
  syncStatus: {
    ahead: number;
    behind: number;
    state: "upToDate" | "localAhead" | "incomingAvailable" | "needsMerge" | "noRemoteVersion";
  };
  dirtyFiles: DiffEntry[];
  isFastForward: boolean;
  canProceed: boolean;
}

let draftlineWorkspacePath: string | null = null;
let cachedFacade: DraftlineHostFacade | null = null;
let cachedFacadePath: string | null = null;

const draftlineClient = createDraftlineClient({ invoke, listen });

export function setDraftlineWorkspacePath(path: string | null) {
  draftlineWorkspacePath = path;
  cachedFacade = null;
  cachedFacadePath = null;
}

function facade(): DraftlineHostFacade {
  if (!draftlineWorkspacePath) {
    throw new Error("No Draftline workspace is currently open");
  }
  if (!cachedFacade || cachedFacadePath !== draftlineWorkspacePath) {
    cachedFacade = createDraftlineHostFacade({
      client: draftlineClient,
      workspacePath: draftlineWorkspacePath,
    });
    cachedFacadePath = draftlineWorkspacePath;
  }
  return cachedFacade;
}

export async function listDraftlineVersions(): Promise<VersionEntry[]> {
  const summary = await facade().inspect();
  return summary.summary.versions.map(versionToEntry);
}

export async function listDraftlineGraphNodes(): Promise<GraphNode[]> {
  const [graph, variations] = await Promise.all([
    facade().workspaceGraphOverview({
      include_remotes: true,
      include_support_refs: true,
      max_nodes: 250,
      recent_nodes: 80,
    }),
    facade().variations(),
  ]);
  const laneByVariation = new Map(variations.map((entry, index) => [entry.variation.id, index]));
  const refsByVersion = refsByTargetVersion(graph.refs);

  return graph.nodes.map((node) => {
    const refs = refsByVersion.get(node.version.id) ?? [];
    const timeline = graphNodeTimeline(node, refs, graph.current_variation ?? variations[0]?.variation.id ?? "main");
    return {
      id: node.version.id,
      message: node.version.label,
      timestamp: new Date(node.version.time_seconds * 1000).toISOString(),
      timeline,
      parents: node.parent_version_ids,
      lane: laneByVariation.get(timeline) ?? node.layout.lane,
      is_head: node.is_current || node.is_head,
      is_branch_tip: node.is_tip || refs.some((ref) => ref.kind === "local_variation" && ref.is_user_facing),
      is_remote_tip: refs.some((ref) => ref.kind === "remote_variation"),
      author: node.version.author.name,
    };
  });
}

export async function listDraftlineTimelines(): Promise<TimelineInfo[]> {
  const variations = await facade().variations();
  return variations.map((summary, index) => variationToTimeline(summary, index));
}

export async function previewDraftlineVersion(version: string): Promise<DiffEntry[]> {
  return versionDiffToDiffEntries(await facade().diffVersionToWorkspace(version));
}

export async function previewDraftlineVersionFile(version: string, path: string): Promise<DraftlinePreviewFile | null> {
  const file = await facade().previewVersionFile(version, path);
  return file
    ? {
      path: file.path,
      content: file.content ?? null,
      isBinary: file.is_binary,
    }
    : null;
}

export async function previewDraftlineWorkspaceFile(path: string): Promise<DraftlinePreviewFile | null> {
  const file = await facade().previewWorkspaceFile(path);
  return file
    ? {
      path: file.path,
      content: file.content ?? null,
      isBinary: file.is_binary,
    }
    : null;
}

export async function previewDraftlineWorkspaceDiffFile(path: string): Promise<DraftlineFileDiffContent> {
  const summary = await facade().inspect();
  const head = summary.summary.versions[0]?.id;
  const [headFile, workingFile] = await Promise.all([
    head ? facade().previewVersionFile(head, path) : Promise.resolve(null),
    facade().previewWorkspaceFile(path),
  ]);
  return {
    path,
    headContent: headFile?.content ?? null,
    workingContent: workingFile?.content ?? null,
    headPresent: headFile !== null,
    workingPresent: workingFile !== null,
    isBinary: headFile?.is_binary ?? workingFile?.is_binary ?? false,
  };
}

export async function diffDraftlineVersions(from: string, to: string): Promise<DiffEntry[]> {
  return versionDiffToDiffEntries(await facade().diffVersions(from, to));
}

export async function createDraftlineVariation(
  fromVersion: string,
  name: string,
  remote?: string | null,
): Promise<void> {
  if (!draftlineWorkspacePath) {
    throw new Error("No Draftline workspace is currently open");
  }

  const metadata = { label: name, slug: name };
  const preflight = await draftlineClient.preflightCreateVariationFromVersion({
    workspace_path: draftlineWorkspacePath,
    version_id: fromVersion,
    name,
    remote: remote ?? null,
  });
  if (!preflight.can_create || !preflight.token) {
    throw new DraftlineVariationCreateConflictError(preflight);
  }

  try {
    await draftlineClient.createVariationFromVersionGuarded({
      workspace_path: draftlineWorkspacePath,
      token: preflight.token,
      metadata,
    });
  } catch (error) {
    const failedPreflight = variationCreatePreflightFromError(error);
    if (failedPreflight) {
      throw new DraftlineVariationCreateConflictError(failedPreflight);
    }

    const refreshed = await draftlineClient.preflightCreateVariationFromVersion({
      workspace_path: draftlineWorkspacePath,
      version_id: fromVersion,
      name,
      remote: remote ?? null,
    });
    if (!refreshed.can_create || !refreshed.token) {
      throw new DraftlineVariationCreateConflictError(refreshed);
    }
    throw error;
  }
}

export async function deleteDraftlineVariation(variation: string): Promise<void> {
  if (!draftlineWorkspacePath) {
    throw new Error("No Draftline workspace is currently open");
  }
  await invoke("delete_variation", {
    request: { workspace_path: draftlineWorkspacePath, variation },
  });
}

export async function preflightDraftlineRenameVariation(
  sourceVariationId: string,
  targetVariationId: string,
): Promise<VariationRenamePreflight> {
  if (!draftlineWorkspacePath) {
    throw new Error("No Draftline workspace is currently open");
  }
  return invoke<VariationRenamePreflight>("preflight_rename_variation", {
    request: {
      workspace_path: draftlineWorkspacePath,
      source_variation_id: sourceVariationId,
      target_variation_id: targetVariationId,
    },
  });
}

export async function renameDraftlineVariation(
  sourceVariationId: string,
  targetVariationId: string,
  token?: VariationRenameToken,
): Promise<RenameVariationResult> {
  if (!draftlineWorkspacePath) {
    throw new Error("No Draftline workspace is currently open");
  }
  return invoke<RenameVariationResult>("rename_variation", {
    request: {
      workspace_path: draftlineWorkspacePath,
      source_variation_id: sourceVariationId,
      target_variation_id: targetVariationId,
      token,
    },
  });
}

export async function preflightDraftlineSwitchVariation(variation: string): Promise<PreflightReport> {
  return facade().preflightSwitchVariation(variation);
}

export async function switchDraftlineVariation(variation: string): Promise<SwitchVariationResult> {
  return facade().switchVariation(variation);
}

export async function restoreDraftlineVersionAsNewSave(version: string, label: string): Promise<string> {
  const restored = await facade().restoreAsNewSave(version, label);
  return restored.version.id;
}

export async function restoreDraftlineVersionAsNewSaveToVariation(
  version: string,
  label: string,
  target: RestoreVersionTarget,
): Promise<TargetedRestoreVersionResult> {
  return facade().restoreAsNewSaveToVariation(version, label, target);
}

export async function listDraftlineRemotes(): Promise<RemoteInfo[]> {
  const remotes = await facade().remotes();
  return remotes.map((remote) => ({ name: remote.name, url: remote.url }));
}

export async function addDraftlineRemote(name: string, url: string): Promise<RemoteInfo> {
  if (!draftlineWorkspacePath) {
    throw new Error("No Draftline workspace is currently open");
  }
  const remote = await invoke<{ name: string; url: string }>("add_remote", {
    request: { workspace_path: draftlineWorkspacePath, name, url },
  });
  return { name: remote.name, url: remote.url };
}

export async function fetchDraftlineRemote(remote: string): Promise<void> {
  await facade().fetchRemote(remote);
}

export async function publishDraftlineChanges(remote: string): Promise<void> {
  await facade().publishCurrentVariation(remote);
}

export async function listDraftlineRemoteBranches(remote: string): Promise<RemoteBranchInfo[]> {
  return (await facade().remoteVariations(remote)).map(remoteVariationToBranchInfo);
}

export async function adoptDraftlineRemoteBranch(remote: string, variationId: string): Promise<void> {
  await facade().adoptRemoteVariation(variationId, remote);
}

export async function preflightDraftlineIncoming(remote: string): Promise<DraftlineApplyIncomingReportDto> {
  return applyIncomingReportToDto(await facade().preflightApplyIncoming(remote));
}

export async function applyDraftlineIncoming(remote: string): Promise<number> {
  const result = await facade().applyIncoming(remote);
  return result.apply.applied_count;
}

export async function preflightDraftlineMergeIncoming(remote: string): Promise<DraftlineMergeIncomingReport> {
  return mergeIncomingReportToDto(await facade().preflightMergeIncoming(remote));
}

export async function mergeDraftlineIncoming(remote: string, label: string): Promise<string> {
  const result = await facade().mergeIncoming(label, remote);
  return result.merge.version.id;
}

export async function mergeDraftlineIncomingWithResolutions(
  token: MergeIncomingToken,
  label: string,
  resolutions: MergeConflictResolution[],
  remote = token.remote,
): Promise<string> {
  const result = await facade().mergeIncomingWithResolutions(label, token, resolutions, remote);
  return result.merge.version.id;
}

export function createDraftlineWholeFileUseContentResolutions(
  report: MergeIncomingReport,
  source: ConflictContentSource,
): MergeConflictResolution[] {
  return createWholeFileUseContentResolutions(report, source);
}

export async function getDraftlineSyncStatus(remote: string): Promise<SyncStatus> {
  const status = await facade().preflightApplyIncoming(remote);
  return {
    ahead: status.sync_status.ahead,
    behind: status.sync_status.behind,
  };
}

export async function listDraftlineIncomingCommits(remote: string): Promise<IncomingCommit[]> {
  const status = (await facade().preflightApplyIncoming(remote)).sync_status;
  return status.incoming.map((version) => ({
    id: version.id,
    message: version.label,
    author: version.author.name,
    timestamp: new Date(version.time_seconds * 1000).toISOString(),
    changed_files: [],
    projects: [status.variation],
  }));
}

export async function inspectDraftlineChanges() {
  return facade().changes();
}

export async function discardDraftlineChanges(): Promise<void> {
  const changes = await facade().changes();
  if (changes.files.length === 0) return;
  await facade().selectedDiscard(changes.files.map((file) => file.path));
}

export async function discardDraftlineFile(path: string): Promise<void> {
  await facade().selectedDiscard([path]);
}

export async function hasDraftlineChanges(): Promise<boolean> {
  const changes = await facade().changes();
  return changes.files.length > 0;
}

export async function listDraftlineChangedFiles(): Promise<DiffEntry[]> {
  const summary = await facade().inspect();
  const head = summary.summary.versions[0]?.id;
  if (!head) {
    return changedFilesToDiffEntries(summary.summary.dirty_files);
  }
  return versionDiffToDiffEntries(await facade().diffVersionToWorkspace(head));
}

export async function listDraftlineLargeChangedFiles(): Promise<string[]> {
  const changes = await facade().changes();
  return changes.files
    .filter((file) => file.is_large)
    .map((file) => file.path);
}

export async function saveDraftlineVersion(label: string): Promise<string> {
  const version = await facade().save(label);
  return version.version.id;
}

const CUTREADY_STASH_SHELF = "cutready-stash";

export async function shelveDraftlineChanges(): Promise<void> {
  const changes = await facade().changes();
  if (changes.files.length === 0) return;
  await facade().selectedShelve(changes.files.map((file) => file.path), CUTREADY_STASH_SHELF);
}

export async function hasDraftlineShelf(): Promise<boolean> {
  const shelves = await facade().shelves();
  return shelves.some((shelf) => shelf.id === CUTREADY_STASH_SHELF);
}

export async function popDraftlineShelf(): Promise<boolean> {
  const shelves = await facade().shelves();
  const shelf = shelves.find((candidate) => candidate.id === CUTREADY_STASH_SHELF);
  if (!shelf) return false;
  await facade().applyShelf(shelf.id);
  await invoke("delete_shelf", {
    request: { workspace_path: draftlineWorkspacePath, shelf_id: shelf.id },
  });
  return true;
}

export async function squashDraftlineVersions(count: number, label: string): Promise<string> {
  if (!draftlineWorkspacePath) {
    throw new Error("No Draftline workspace is currently open");
  }
  const version = await invoke<Version>("squash_versions", {
    request: { workspace_path: draftlineWorkspacePath, count, label },
  });
  return version.id;
}

export async function previewDraftlineSnapshotCleanup(
  oldestVersion: string,
  newestVersion: string,
  label: string,
  targetVariation?: string | null,
): Promise<HistoryCleanupPreview> {
  if (!draftlineWorkspacePath) {
    throw new Error("No Draftline workspace is currently open");
  }
  return draftlineClient.previewHistoryCleanup({
    workspace_path: draftlineWorkspacePath,
    cleanup: {
      target_variation: targetVariation ?? null,
      base: { kind: "auto" },
      mode: {
        kind: "compact_milestones",
        milestones: [{
          title: label,
          description: null,
          include_range: { start: oldestVersion, end: newestVersion },
        }],
        preserve_named_branches: true,
        preserve_merge_boundaries: true,
      },
      safety: {
        create_backup_ref: true,
        backup_ref_name: null,
        require_clean_worktree: true,
      },
      remote_policy: { kind: "local_only" },
    },
  });
}

export async function applyDraftlineSnapshotCleanup(planId: string): Promise<TimelineCleanupResult> {
  if (!draftlineWorkspacePath) {
    throw new Error("No Draftline workspace is currently open");
  }
  return draftlineClient.applyHistoryCleanup({
    workspace_path: draftlineWorkspacePath,
    plan_id: planId,
    confirmation: "user_confirmed",
  });
}

function refsByTargetVersion(refs: WorkspaceGraphRef[]): Map<string, WorkspaceGraphRef[]> {
  const byVersion = new Map<string, WorkspaceGraphRef[]>();
  for (const ref of refs) {
    const existing = byVersion.get(ref.target_version);
    if (existing) {
      existing.push(ref);
    } else {
      byVersion.set(ref.target_version, [ref]);
    }
  }
  return byVersion;
}

function graphNodeTimeline(node: WorkspaceGraphNode, refs: WorkspaceGraphRef[], fallback: string): string {
  const localRef = refs.find((ref) => ref.kind === "local_variation" && ref.variation);
  return localRef?.variation ?? node.variation_tips[0] ?? fallback;
}

function versionToEntry(version: Version): VersionEntry {
  return {
    id: version.id,
    message: version.label,
    timestamp: new Date(version.time_seconds * 1000).toISOString(),
    summary: version.label,
  };
}

function variationToTimeline(summary: VariationSummary, index: number): TimelineInfo {
  return {
    name: summary.variation.id,
    label: summary.variation.metadata.label ?? summary.variation.name,
    is_active: summary.variation.is_current,
    snapshot_count: summary.reachable_version_count,
    color_index: index,
  };
}

function remoteVariationToBranchInfo(variation: RemoteVariation): RemoteBranchInfo {
  return {
    id: variation.id,
    name: variation.name,
    remote: variation.remote,
    head_message: variation.head_version?.label,
    head_author: variation.head_version?.author.name,
    head_timestamp: variation.head_version
      ? new Date(variation.head_version.time_seconds * 1000).toISOString()
      : undefined,
  };
}

function variationCreateConflictMessage(preflight: VariationCreatePreflight): string {
  if (preflight.remote_collision || preflight.remote_only_collision) {
    const remote = preflight.remote ?? "remote";
    const head = preflight.existing_remote_head?.label
      ? ` Remote head: ${preflight.existing_remote_head.label}.`
      : "";
    const suggestion = preflight.suggested_alternative
      ? ` Suggested name: ${preflight.suggested_alternative}.`
      : "";
    return `Branch "${preflight.variation}" already exists on ${remote}.${head}${suggestion}`;
  }
  if (preflight.local_collision) {
    return `Branch "${preflight.variation}" already exists locally.`;
  }
  return `Branch "${preflight.variation}" cannot be created.`;
}

function variationCreatePreflightFromError(error: unknown): VariationCreatePreflight | null {
  const value = typeof error === "string" ? parseJsonObject(error) : error;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const preflight = record.preflight ?? record.report;
  if (isVariationCreatePreflight(preflight)) return preflight;
  if (
    (record.kind === "variation_create_preflight_failed" || record.code === "variation_create_preflight_failed")
    && isVariationCreatePreflight(record.preflight)
  ) {
    return record.preflight;
  }
  return null;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isVariationCreatePreflight(value: unknown): value is VariationCreatePreflight {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.from_version === "string"
    && typeof record.variation === "string"
    && typeof record.can_create === "boolean"
    && typeof record.local_collision === "boolean"
    && typeof record.remote_collision === "boolean"
    && typeof record.remote_only_collision === "boolean";
}

function versionDiffToDiffEntries(diff: VersionDiff): DiffEntry[] {
  return changedFilesToDiffEntries(diff.files);
}

function changedFilesToDiffEntries(files: ChangedFile[]): DiffEntry[] {
  return files.map((file) => ({
    path: file.path,
    status: changeKindToStatus(file.kind),
    additions: 0,
    deletions: 0,
  }));
}

function changeKindToStatus(kind: ChangedFile["kind"]): string {
  switch (kind) {
    case "Added":
      return "added";
    case "Deleted":
      return "deleted";
    case "Renamed":
      return "renamed";
    case "Conflicted":
      return "conflicted";
    case "TypeChanged":
      return "modified";
    case "Modified":
    default:
      return "modified";
  }
}

function syncStateToDto(state: SyncState): DraftlineApplyIncomingReportDto["syncStatus"]["state"] {
  switch (state) {
    case "LocalAhead":
      return "localAhead";
    case "IncomingAvailable":
      return "incomingAvailable";
    case "NeedsMerge":
      return "needsMerge";
    case "NoRemoteVersion":
      return "noRemoteVersion";
    case "UpToDate":
    default:
      return "upToDate";
  }
}

function applyIncomingReportToDto(report: ApplyIncomingReport): DraftlineApplyIncomingReportDto {
  return {
    syncStatus: {
      ahead: report.sync_status.ahead,
      behind: report.sync_status.behind,
      state: syncStateToDto(report.sync_status.state),
    },
    dirtyFiles: changedFilesToDiffEntries(report.dirty_files),
    isFastForward: report.is_fast_forward,
    canProceed: report.can_proceed,
  };
}

function mergeIncomingReportToDto(report: MergeIncomingReport): DraftlineMergeIncomingReport {
  const viewModel = createMergeConflictViewModel(report);
  return {
    syncStatus: {
      ahead: report.sync_status.ahead,
      behind: report.sync_status.behind,
      state: syncStateToDto(report.sync_status.state),
    },
    dirtyFiles: changedFilesToDiffEntries(report.dirty_files),
    fileHazards: report.file_hazards.map((hazard) => hazard.path),
    conflicts: conflictViewModelToConflictFiles(viewModel),
    token: report.token,
    canMergeCleanly: report.can_merge_cleanly,
    changedWorkspace: report.changed_workspace,
    viewModel,
  };
}

function conflictViewModelToConflictFiles(viewModel: MergeConflictViewModel): ConflictFile[] {
  return viewModel.files.map((file) => {
    const wholeFile = file.whole_file_conflicts[0];
    return {
      path: file.path,
      file_type: fileTypeForPath(file.path),
      ours: wholeFile?.ours ?? "",
      theirs: wholeFile?.theirs ?? "",
      ancestor: wholeFile?.base ?? "",
      field_conflicts: file.field_conflicts.flatMap((field) => field.conflicts.map((conflict) => ({
        field_path: field.field_path,
        ours: conflict.ours ?? null,
        theirs: conflict.theirs ?? null,
        ancestor: conflict.base ?? null,
      }))),
      text_conflicts: [],
    };
  });
}

function fileTypeForPath(path: string): ConflictFile["file_type"] {
  if (path.endsWith(".sk")) return "sketch";
  if (path.endsWith(".sb")) return "storyboard";
  if (path.endsWith(".md")) return "note";
  return "other";
}
