// Local history, working tree, project health and merge state (architecture v3
// F6). Project/editor state stays in appStore and remote collaboration lives in
// syncStore; both are read with getState() inside actions only.
import { create } from "zustand";
import {
  createDraftlineVariation,
  deleteDraftlineVariation,
  discardDraftlineChanges,
  discardDraftlineFile,
  hasDraftlineChanges,
  isDraftlineVariationCreateConflictError,
  listDraftlineChangedFiles,
  listDraftlineGraphNodes,
  listDraftlineLargeChangedFiles,
  listDraftlineTimelines,
  listDraftlineVersions,
  preflightDraftlineSwitchVariation,
  mergeDraftlineIncomingWithResolutions,
  preflightDraftlineRenameVariation,
  renameDraftlineVariation,
  saveDraftlineVersion,
  switchDraftlineVariation,
  HEALTHY_PROJECT,
  clearDraftlineStaleLock,
  dismissDraftlineRecovery,
  inspectDraftlineProjectHealth,
  resolveDraftlineRecovery,
  retryDraftlineContentDownload,
  type DraftlineProjectHealth,
  type DraftlineMergeIncomingToken,
} from "../services/draftlineVersioning";
import { useToastStore } from "./toastStore";
import { useAppStore } from "./appStore";
import { useSyncStore } from "./syncStore";
import { activeTimelineLabel, askMergeName } from "../services/mergeName";
import { deleteSetAsideShelf, listSetAsideShelves, restoreSetAsideShelf, setAsideChanges } from "../services/setAsideShelves";
import { DEFAULT_SET_ASIDE_NAME, type IncomingVersion, type SetAsideShelf } from "../domain/versioning";
import {
  clearActiveDocumentState,
  currentWorkspaceGeneration,
  errorMessage,
  flushEditorWrites,
  loadingDocumentStateForTab,
  replaceWorkspaceFile,
  rewriteWorkspaceFiles,
  tabExistsInLoadedProject,
} from "./workspaceHelpers";
import type {
  VersionEntry,
  TimelineInfo,
  GraphNode,
  DiffEntry,
  ConflictFile,
  MergeResult,
  FileResolution,
} from "../types/sketch";

export interface VersioningState {
  /** Version history for the current project. */
  versions: VersionEntry[];
  /** All timelines (branches) in the project. */
  timelines: TimelineInfo[];
  /** Full graph data for SVG rendering. */
  graphNodes: GraphNode[];
  /** Branch created from a historical snapshot that has not recorded its first new save yet. */
  startedBranchFromSnapshot: { branchName: string; snapshotId: string } | null;
  /** Whether there are unsaved changes since the last snapshot. */
  isDirty: boolean;
  /** List of changed files since last snapshot (for Changes panel). */
  changedFiles: DiffEntry[];
  /** Whether a version save is in progress. */
  saving: boolean;
  /** Work set aside to bring back later, newest first. */
  setAsideShelves: SetAsideShelf[];
  /** A set-aside restore or delete is running. */
  setAsideBusy: boolean;
  projectHealth: DraftlineProjectHealth;
  projectHealthBusy: boolean;
  /** Whether we are viewing a rewound snapshot (prev-tip exists). */
  isRewound: boolean;

  // ── Merge ──────────────────────────────────────────────────
  /** Whether a merge is in progress (conflicts being resolved). */
  isMerging: boolean;
  /** Source timeline for the in-progress merge. */
  mergeSource: string | null;
  /** Target timeline for the in-progress merge. */
  mergeTarget: string | null;
  /** Conflict files from the merge engine (empty = clean merge). */
  mergeConflicts: ConflictFile[];
  /** Draftline token for the currently displayed incoming conflict set. */
  draftlineMergeToken: DraftlineMergeIncomingToken | null;
  /** Remote that produced the currently displayed incoming conflict set. */
  draftlineMergeRemote: string | null;
  /** Versions the displayed conflict set brings in, for naming the merge. */
  draftlineMergeIncoming: IncomingVersion[];

  // ── Diff ──────────────────────────────────────────────────
  /** Currently selected diff result (file changes between two snapshots). */
  diffResult: DiffEntry[] | null;
  /** The two commit IDs being compared for diff. */
  diffSelection: { from: string; to: string } | null;
}

export interface VersioningActions {
  /** Load version history. */
  loadVersions: () => Promise<void>;
  /** Check if working directory has unsaved changes. */
  checkDirty: () => Promise<void>;
  /** Refresh list of changed files since last snapshot. */
  refreshChangedFiles: () => Promise<void>;
  /** Save a labeled version. Optional forkLabel for naming the old timeline when forking. */
  saveVersion: (label: string, forkLabel?: string) => Promise<void>;
  /** Sets all unsaved changes aside in a new shelf so the workspace is clean. False if nothing was set aside. */
  stashChanges: (name?: string) => Promise<boolean>;
  /** Discard all working-directory changes, resetting to last snapshot. */
  discardChanges: () => Promise<void>;
  /** Discard changes for one file. */
  discardFile: (filePath: string) => Promise<void>;
  /**
   * Runs `replace`, which rewrites or removes one file on disk, with editor
   * writes for it suppressed; then reloads the sidebar and every open copy,
   * closing tabs whose file is gone. Rethrows `replace`'s error.
   */
  replaceFileOnDisk: (
    filePath: string,
    replace: (paths: { repoPath: string; projectPath: string }) => Promise<unknown>,
  ) => Promise<void>;
  /** Brings one set-aside shelf back into the workspace and deletes it. */
  popStash: (shelfId: string) => Promise<void>;
  /** Deletes a set-aside shelf for good. */
  dropStash: (shelfId: string) => Promise<void>;
  /** Reloads the set-aside shelves. */
  checkStash: () => Promise<void>;
  /** Interrupted operations, stale locks, and missing LFS content for the open project. */
  checkProjectHealth: (options?: { probeContent?: boolean }) => Promise<void>;
  /** Finish (or undo) an interrupted operation, then reload the project. */
  resolveRecovery: () => Promise<void>;
  /** Leave an interrupted operation that can't be finished or undone, then reload. */
  dismissRecovery: () => Promise<void>;
  clearStaleLock: () => Promise<void>;
  retryContentDownload: () => Promise<void>;
  /** Check whether we are in a rewound state (prev-tip exists). */
  checkRewound: () => Promise<void>;
  /** Navigate to any snapshot. Defers fork until commit. */
  navigateToSnapshot: (commitId: string) => Promise<void>;
  /** Open a read-only snapshot preview tab. */
  openSnapshotPreview: (commitId: string) => Promise<void>;
  /** Create a new timeline from a snapshot. */
  createTimeline: (fromCommitId: string, name: string) => Promise<void>;
  /** Create a named branch from a snapshot and switch to it for editing. */
  startTimelineFromSnapshot: (fromCommitId: string, name: string) => Promise<void>;
  /** Load all timelines. */
  loadTimelines: () => Promise<void>;
  /** Switch to a different timeline. */
  switchTimeline: (name: string) => Promise<void>;
  /** Rename the legacy master variation (or a branch the remote renamed) to the new base name. */
  renameLegacyMasterTimeline: () => Promise<void>;
  /** Rename a timeline; false when it failed (already reported). */
  renameTimeline: (from: string, to: string) => Promise<boolean>;
  /** Delete a non-active timeline. */
  deleteTimeline: (name: string) => Promise<void>;
  /** Promote a fork timeline to become the new main. */
  promoteTimeline: (name: string) => Promise<void>;
  /** Load full graph data for SVG rendering. */
  loadGraphData: () => Promise<void>;
  /** Compare HEAD against the working directory. */
  diffWorkingTree: () => Promise<DiffEntry[]>;
  /** Check for large files before pushing. Returns list of (path, size). */
  checkLargeFiles: () => Promise<Array<[string, number]>>;
  /** Merge source timeline into target timeline. */
  mergeTimelines: (source: string, target: string) => Promise<MergeResult>;
  /** Apply user-provided conflict resolutions and create merge commit. */
  /** Resolves to the merge commit, or null when the user cancels naming it. */
  applyMergeResolution: (resolutions: FileResolution[]) => Promise<string | null>;
  /** Cancel an in-progress merge. */
  cancelMerge: () => void;
}

export type VersioningStoreState = VersioningState & VersioningActions;

/** Versioning state as it is when no project is open (including `saving`). */
export function initialVersioningState(): VersioningState {
  return { ...resetVersioningState(), saving: false };
}

/** Fields a project open/close/switch resets; `saving` is deliberately left alone. */
export function resetVersioningState(): Omit<VersioningState, "saving"> {
  return {
    versions: [],
    timelines: [],
    graphNodes: [],
    startedBranchFromSnapshot: null,
    isDirty: false,
    changedFiles: [],
    setAsideShelves: [],
    setAsideBusy: false,
    projectHealth: HEALTHY_PROJECT,
    projectHealthBusy: false,
    isRewound: false,
    isMerging: false,
    mergeSource: null,
    mergeTarget: null,
    mergeConflicts: [],
    draftlineMergeToken: null,
    draftlineMergeRemote: null,
    draftlineMergeIncoming: [],
    diffResult: null,
    diffSelection: null,
  };
}

const app = () => useAppStore.getState();
const sync = () => useSyncStore.getState();

export const useVersioningStore = create<VersioningStoreState>((set, get) => ({
  ...initialVersioningState(),

  loadVersions: async () => {
    const generation = currentWorkspaceGeneration();
    try {
      const versions = await listDraftlineVersions();
      if (generation !== currentWorkspaceGeneration()) return;
      set({ versions });
      await get().checkDirty();
    } catch (err) {
      console.error("Failed to load versions:", err);
    }
  },

  checkDirty: async () => {
    const generation = currentWorkspaceGeneration();
    try {
      const isDirty = await hasDraftlineChanges();
      if (generation !== currentWorkspaceGeneration()) return;
      set({ isDirty });
      // Also refresh the changed files list
      get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to check dirty state:", err);
      useToastStore.getState().show(`Could not check project changes: ${errorMessage(err)}`, 5000, "error");
    }
  },

  refreshChangedFiles: async () => {
    const generation = currentWorkspaceGeneration();
    try {
      const files = await listDraftlineChangedFiles();
      if (generation !== currentWorkspaceGeneration()) return;
      set({ changedFiles: files });
    } catch {
      if (generation !== currentWorkspaceGeneration()) return;
      set({ changedFiles: [] });
    }
  },

  saveVersion: async (label, _forkLabel?) => {
    // Let save failures reach the caller so the snapshot dialog can stay open and explain why.
    await saveDraftlineVersion(label);
    try {
      const activeTimeline = get().timelines.find((timeline) => timeline.is_active);
      const startedBranch = get().startedBranchFromSnapshot;
      set({
        isDirty: false,
        isRewound: false,
        changedFiles: [],
        startedBranchFromSnapshot: startedBranch?.branchName === activeTimeline?.name ? null : startedBranch,
      });
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      await get().checkRewound();
      await sync().refreshSyncStatus();
    } catch (err) {
      console.error("Failed to refresh after saving version:", err);
    }
  },

  stashChanges: async (name = DEFAULT_SET_ASIDE_NAME) => {
    let shelved = false;
    const ok = await rewriteWorkspaceFiles(async () => {
      shelved = await setAsideChanges(name);
    }, "Set aside failed");
    await get().checkStash();
    return ok && shelved;
  },

  discardChanges: async () => {
    await rewriteWorkspaceFiles(discardDraftlineChanges, "Discard failed");
  },

  replaceFileOnDisk: (filePath, replace) => replaceWorkspaceFile(filePath, replace),

  discardFile: async (filePath) => {
    try {
      await get().replaceFileOnDisk(filePath, ({ repoPath }) => discardDraftlineFile(repoPath));
    } catch (err) {
      console.error("Failed to discard file:", err);
      useToastStore.getState().show(`Discard failed: ${errorMessage(err)}`, 5000, "error");
    }
  },

  popStash: async (shelfId) => {
    if (get().setAsideBusy) return;
    set({ setAsideBusy: true });
    const toast = useToastStore.getState();
    try {
      // Draftline refuses to restore over any unsaved work; check first so editors and tabs stay put.
      await flushEditorWrites();
      await get().checkDirty();
      if (get().isDirty) {
        toast.show("Save or set aside your current changes first, then restore these.", 6000, "warning");
        return;
      }
      let outcome = "missing" as Awaited<ReturnType<typeof restoreSetAsideShelf>>;
      await rewriteWorkspaceFiles(async () => {
        outcome = await restoreSetAsideShelf(shelfId);
      }, "Restore failed");
      await get().checkStash();
      if (outcome === "restored") toast.show("Set-aside changes restored.", 3000, "success");
      else if (outcome === "conflict") toast.show("Save or set aside your current changes first, then restore these.", 6000, "warning");
    } finally {
      set({ setAsideBusy: false });
    }
  },

  dropStash: async (shelfId) => {
    if (get().setAsideBusy) return;
    set({ setAsideBusy: true });
    try {
      await deleteSetAsideShelf(shelfId);
    } catch (err) {
      console.error("Failed to delete set-aside changes:", err);
      useToastStore.getState().show(`Delete failed: ${errorMessage(err)}`, 5000, "error");
    } finally {
      await get().checkStash();
      set({ setAsideBusy: false });
    }
  },

  checkStash: async () => {
    const generation = currentWorkspaceGeneration();
    try {
      const setAsideShelves = await listSetAsideShelves();
      if (generation !== currentWorkspaceGeneration()) return;
      set({ setAsideShelves });
    } catch (err) {
      console.error("Failed to check stash:", err);
    }
  },

  checkProjectHealth: async (options) => {
    const generation = currentWorkspaceGeneration();
    try {
      const health = await inspectDraftlineProjectHealth(options);
      if (generation !== currentWorkspaceGeneration()) return;
      set({
        projectHealth: {
          ...health,
          missingContent: health.missingContent ?? get().projectHealth.missingContent,
        },
      });
    } catch (err) {
      console.error("Failed to inspect project health:", err);
    }
  },

  resolveRecovery: async () => {
    const project = app().currentProject;
    if (!project || get().projectHealthBusy) return;
    set({ projectHealthBusy: true });
    try {
      const outcome = await resolveDraftlineRecovery();
      if (outcome === "stuck") {
        useToastStore.getState().show(
          "CutReady couldn't finish or undo the interrupted change. You can dismiss it and keep working; check your files first.",
          8000,
          "warning",
        );
        await get().checkProjectHealth();
        return;
      }
      useToastStore.getState().show(
        outcome === "undone" ? "Undid the interrupted change." : "Finished the interrupted change.",
        4000,
        "success",
      );
      await app().openProject(project.repo_root);
    } catch (err) {
      useToastStore.getState().show(`Recovery failed: ${errorMessage(err)}`, 6000, "error");
      await get().checkProjectHealth();
    } finally {
      set({ projectHealthBusy: false });
    }
  },

  dismissRecovery: async () => {
    const project = app().currentProject;
    if (!project || get().projectHealthBusy) return;
    set({ projectHealthBusy: true });
    try {
      await dismissDraftlineRecovery();
      await app().openProject(project.repo_root);
    } catch (err) {
      useToastStore.getState().show(`Dismiss failed: ${errorMessage(err)}`, 6000, "error");
      await get().checkProjectHealth();
    } finally {
      set({ projectHealthBusy: false });
    }
  },

  clearStaleLock: async () => {
    if (!app().currentProject || get().projectHealthBusy) return;
    set({ projectHealthBusy: true });
    try {
      await clearDraftlineStaleLock();
      useToastStore.getState().show("Cleared the lock left by a closed CutReady.", 4000, "success");
    } catch (err) {
      useToastStore.getState().show(`Clear lock failed: ${errorMessage(err)}`, 6000, "error");
    } finally {
      set({ projectHealthBusy: false });
      await get().checkProjectHealth();
    }
  },

  retryContentDownload: async () => {
    if (!app().currentProject || get().projectHealthBusy) return;
    set({ projectHealthBusy: true });
    try {
      const wrote = await retryDraftlineContentDownload();
      await get().checkProjectHealth();
      const remaining = get().projectHealth.missingContent.length;
      if (remaining > 0) {
        useToastStore.getState().show(
          `${remaining} large ${remaining === 1 ? "file is" : "files are"} still not downloaded. Check that Git LFS is installed and you can reach the shared repository.`,
          7000,
          "warning",
        );
      } else if (wrote) {
        useToastStore.getState().show("Downloaded the missing files.", 4000, "success");
        await Promise.all([app().loadSketches(), app().loadStoryboards(), app().loadNotes()]);
      }
    } catch (err) {
      useToastStore.getState().show(`Download failed: ${errorMessage(err)}`, 6000, "error");
    } finally {
      set({ projectHealthBusy: false });
    }
  },

  checkRewound: async () => {
    set({ isRewound: false });
  },

  navigateToSnapshot: async (commitId) => {
    await get().openSnapshotPreview(commitId);
  },

  openSnapshotPreview: async (commitId) => {
    try {
      const node = get().graphNodes.find((entry) => entry.id === commitId);
      const label = node?.message?.trim() || commitId.slice(0, 7);
      app().openTab({
        type: "snapshot-preview",
        path: `snapshot:${commitId}`,
        title: `Snapshot: ${label}`,
      });
    } catch (err) {
      console.error("Failed to preview snapshot:", err);
      useToastStore.getState().show(`Snapshot preview failed: ${errorMessage(err)}`, 5000, "error");
    }
  },

  createTimeline: async (fromCommitId, name) => {
    try {
      await createDraftlineVariation(fromCommitId, name, sync().currentRemote?.name ?? null);
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadGraphData();
    } catch (err) {
      console.error("Failed to create timeline:", err);
      if (!isDraftlineVariationCreateConflictError(err)) {
        useToastStore.getState().show(`Branch creation failed: ${errorMessage(err)}`, 5000, "error");
      }
      throw err;
    }
  },

  startTimelineFromSnapshot: async (fromCommitId, name) => {
    let createdName = name;
    try {
      createdName = await createDraftlineVariation(fromCommitId, name, sync().currentRemote?.name ?? null) || name;
      set({ startedBranchFromSnapshot: { branchName: createdName, snapshotId: fromCommitId } });
      await get().switchTimeline(createdName);
      useToastStore.getState().show(`Started branch ${createdName} from the previewed snapshot.`, 4000, "success");
    } catch (err) {
      set((state) => (
        state.startedBranchFromSnapshot?.branchName === createdName
          ? { startedBranchFromSnapshot: null }
          : {}
      ));
      console.error("Failed to start branch from snapshot:", err);
      if (!isDraftlineVariationCreateConflictError(err)) {
        useToastStore.getState().show(`Start branch failed: ${errorMessage(err)}`, 5000, "error");
      }
      throw err;
    }
  },

  loadTimelines: async () => {
    const generation = currentWorkspaceGeneration();
    try {
      const timelines = await listDraftlineTimelines();
      if (generation !== currentWorkspaceGeneration()) return;
      set({ timelines });
    } catch (err) {
      console.error("Failed to load timelines:", err);
    }
  },

  switchTimeline: async (name) => {
    useAppStore.setState({ loading: true });
    try {
      const preflight = await preflightDraftlineSwitchVariation(name);
      if (!preflight.can_proceed) {
        const reason = preflight.dirty_files.length > 0
          ? "Save or discard local changes before switching branches."
          : "Branch switch cannot be applied safely right now.";
        useToastStore.getState().show(reason, 5000, "error");
        throw new Error(reason);
      }
      await switchDraftlineVariation(name);
      useAppStore.setState(clearActiveDocumentState());
      await app().loadSketches();
      await app().loadStoryboards();
      await app().loadNotes();
      await app().loadChatArtifacts();

      const state = app();
      const openTabs = state.openTabs.filter((tab) => tabExistsInLoadedProject(tab, state));
      const splitTabs = state.splitTabs.filter((tab) => tabExistsInLoadedProject(tab, state));
      const activeTabId = openTabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : openTabs[0]?.id ?? null;
      const splitActiveTabId = splitTabs.some((tab) => tab.id === state.splitActiveTabId)
        ? state.splitActiveTabId
        : splitTabs[0]?.id ?? null;
      const activeEditorGroup = splitTabs.length === 0 && state.activeEditorGroup === "split"
        ? "main"
        : state.activeEditorGroup;
      const activeTab = activeTabId ? openTabs.find((tab) => tab.id === activeTabId) : undefined;

      useAppStore.setState({
        openTabs,
        activeTabId,
        splitTabs,
        splitActiveTabId,
        activeEditorGroup,
        ...(activeTab ? loadingDocumentStateForTab(activeTab) : clearActiveDocumentState()),
      });

      if (activeTab?.type === "sketch") {
        await app().openSketch(activeTab.path);
      } else if (activeTab?.type === "storyboard") {
        await app().openStoryboard(activeTab.path);
      } else if (activeTab?.type === "note") {
        await app().openNote(activeTab.path);
      }
      app()._persistTabs();
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadGraphData();
      await get().checkDirty();
    } catch (err) {
      console.error("Failed to switch timeline:", err);
      useToastStore.getState().show(`Switch failed: ${errorMessage(err)}`, 5000, "error");
      throw err;
    } finally {
      useAppStore.setState({ loading: false });
    }
  },

  renameLegacyMasterTimeline: async () => {
    const timelines = get().timelines;
    const { from, to } = sync().baseRename ?? { from: "master", to: "main" };
    const hasFrom = timelines.some((timeline) => timeline.name === from);
    const hasTo = timelines.some((timeline) => timeline.name === to);
    if (!hasFrom || hasTo) {
      useSyncStore.setState({ baseRename: null });
      useToastStore.getState().show(`No ${from} branch is available to rename.`, 4000, "info");
      return;
    }

    if (await get().renameTimeline(from, to)) useSyncStore.setState({ baseRename: null, syncError: null });
  },

  renameTimeline: async (from, to) => {
    try {
      const preflight = await preflightDraftlineRenameVariation(from, to);
      await renameDraftlineVariation(from, to, preflight.token);
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadGraphData();
      await get().checkDirty();
      useToastStore.getState().show(`Renamed branch ${from} to ${to}. Publish again to share it.`, 5000, "success");
      return true;
    } catch (err) {
      console.error("Failed to rename Draftline branch:", err);
      useToastStore.getState().show(`Rename failed: ${errorMessage(err)}`, 5000, "error");
      return false;
    }
  },

  deleteTimeline: async (name) => {
    try {
      await deleteDraftlineVariation(name);
      set((state) => (
        state.startedBranchFromSnapshot?.branchName === name
          ? { startedBranchFromSnapshot: null }
          : {}
      ));
      await get().loadTimelines();
      await get().loadGraphData();
      await get().loadVersions();
      useToastStore.getState().show("Branch deleted.", 4000, "success");
    } catch (err) {
      console.error("Failed to delete timeline:", err);
      useToastStore.getState().show(`Delete failed: ${errorMessage(err)}`, 5000, "error");
    }
  },

  promoteTimeline: async (name) => {
    console.warn("Draftline variation promotion is not available yet:", name);
    useToastStore.getState().show("Draftline does not support promoting variations yet.", 5000, "info");
  },

  loadGraphData: async () => {
    const generation = currentWorkspaceGeneration();
    try {
      const graphNodes = await listDraftlineGraphNodes();
      if (generation !== currentWorkspaceGeneration()) return;
      set({ graphNodes });
    } catch (err) {
      console.error("Failed to load graph data:", err);
    }
  },

  diffWorkingTree: async () => {
    const generation = currentWorkspaceGeneration();
    try {
      const entries = await listDraftlineChangedFiles();
      if (generation !== currentWorkspaceGeneration()) return entries;
      set({ diffResult: entries, diffSelection: { from: "HEAD", to: "working" } });
      return entries;
    } catch (err) {
      console.error("Failed to diff working tree:", err);
      return [];
    }
  },

  checkLargeFiles: async () => {
    try {
      const paths = await listDraftlineLargeChangedFiles();
      return paths.map((path): [string, number] => [path, 0]);
    } catch {
      return [];
    }
  },

  // ── Merge actions ─────────────────────────────────────────

  mergeTimelines: async (source, target) => {
    console.warn("Draftline variation merge is not available yet:", source, target);
    useToastStore.getState().show("Draftline does not support merging variations yet.", 5000, "info");
    return { status: "conflicts", conflicts: [] };
  },

  applyMergeResolution: async (resolutions) => {
    const { draftlineMergeToken, draftlineMergeRemote, draftlineMergeIncoming } = get();
    if (!draftlineMergeToken || !draftlineMergeRemote) throw new Error("No Draftline merge in progress");

    // Base merges carry the base branch name as the token source.
    const base = (draftlineMergeToken as { source?: string | null }).source ?? null;
    const message = await askMergeName(base ?? activeTimelineLabel(get().timelines) ?? draftlineMergeRemote, draftlineMergeIncoming);
    if (!message) return null;
    const commitId = await mergeDraftlineIncomingWithResolutions(
      draftlineMergeToken,
      message,
      resolutions.map((resolution) => ({
        path: resolution.path,
        field_path: null,
        choice: { kind: "use_content", content: resolution.content },
      })),
      draftlineMergeRemote,
    );
    set({
      isMerging: false,
      mergeSource: null,
      mergeTarget: null,
      mergeConflicts: [],
      draftlineMergeToken: null,
      draftlineMergeRemote: null,
      draftlineMergeIncoming: [],
    });
    await app().loadSketches();
    await app().loadStoryboards();
    await app().loadNotes();
    await sync().refreshSyncStatus();
    await sync().refreshIncomingCommits();
    await get().loadVersions();
    await get().loadGraphData();
    await get().loadTimelines();
    await get().checkDirty();
    useToastStore.getState().showUpdate(base ? `Updates from ${base} brought in.` : "Incoming saves merged.", "success");
    return commitId;
  },

  cancelMerge: () => {
    set({
      isMerging: false,
      mergeSource: null,
      mergeTarget: null,
      mergeConflicts: [],
      draftlineMergeToken: null,
      draftlineMergeRemote: null,
      draftlineMergeIncoming: [],
    });
  },
}));
