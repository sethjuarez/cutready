// Remote collaboration state (architecture v3 F6). Local history and merge state
// live in versioningStore; project/editor state stays in appStore. Other stores
// are read with getState() inside actions only.
import { create } from "zustand";
import {
  applyDraftlineIncoming,
  adoptDraftlineRemoteBranch,
  fetchDraftlineRemote,
  getDraftlineBaseStatus,
  getDraftlineSyncStatus,
  listDraftlineIncomingCommits,
  listDraftlineRemoteBranches,
  listDraftlineRemotes,
  preflightDraftlineIncoming,
  preflightDraftlineMergeBase,
  preflightDraftlineMergeIncoming,
  mergeDraftlineFromBase,
  mergeDraftlineIncoming,
  publishDraftlineChanges,
  sendForReview as sendDraftlineForReview,
} from "../services/draftlineVersioning";
import { baseRenamedBranches, mergeNeedsDeveloperMessage } from "../services/draftlineErrors";
import { useToastStore } from "./toastStore";
import { useAppStore } from "./appStore";
import { useVersioningStore } from "./versioningStore";
import { activeTimelineLabel, askMergeName } from "../services/mergeName";
import {
  SYNC_IN_PROGRESS_MESSAGE,
  buildShareUrl,
  bumpRemoteDetectionGeneration,
  currentRemoteDetectionGeneration,
  currentWorkspaceGeneration,
  ensureGitHubRemoteCredential,
  errorMessage,
  isMergeNeedsDeveloperError,
  largeFilesSyncError,
  remoteSyncErrorMessage,
} from "./workspaceHelpers";
import type {
  RemoteBranchInfo,
  RemoteInfo,
  SyncStatus,
  BaseStatus,
  IncomingCommit,
} from "../types/sketch";

export interface SyncState {
  /** Detected/configured remote, null if none. */
  currentRemote: RemoteInfo | null;
  /** Branches that exist on the selected remote but have not been adopted locally. */
  remoteBranches: RemoteBranchInfo[];
  /** Whether remote-only branches are currently being refreshed. */
  remoteBranchesLoading: boolean;
  /** Ahead/behind counts vs remote tracking branch. */
  syncStatus: SyncStatus | null;
  /** Hybrid projects on a non-base branch: ahead/behind vs the remote base (e.g. `main`). */
  baseStatus: BaseStatus | null;
  /** Whether a fetch/push/pull is in progress. */
  isSyncing: boolean;
  /** Last error from a sync operation. */
  syncError: string | null;
  /** Publish found the remote renamed its default branch; rename this branch to match. */
  baseRename: { from: string; to: string } | null;
  /** Incoming snapshots discovered by the latest fetch. */
  incomingCommits: IncomingCommit[];
  /** Share/PR URL for the latest successful share operation. */
  shareUrl: string | null;
  /** Hybrid projects: pending "Send for review" prompt (pull request title). */
  sendForReviewPrompt: { defaultTitle: string; defaultBody?: string } | null;
}

export interface SyncActions {
  /** Detect configured remote for the project. */
  detectRemote: () => Promise<void>;
  /** Fetch from the remote. */
  fetchFromRemote: (options?: { notifyAuthRequired?: boolean }) => Promise<void>;
  /** Push current timeline to the remote (hybrid projects: opens the Send for review prompt). */
  pushToRemote: () => Promise<void>;
  /** Hybrid projects: push the CutReady branch and open/update a pull request. */
  sendForReview: (title: string, body?: string) => Promise<void>;
  /** Dismiss the Send for review prompt without sending. */
  cancelSendForReview: () => void;
  /** Pull from remote (fast-forward merge). */
  pullFromRemote: () => Promise<void>;
  /** Hybrid projects on a non-base branch: merge the latest base (e.g. `main`) in. */
  getUpdatesFromBase: () => Promise<void>;
  /** Sync: fetch then push (or pull if behind). */
  syncWithRemote: () => Promise<void>;
  /** Share local changes safely with collaborators. */
  shareChanges: () => Promise<void>;
  /** Refresh incoming remote snapshot preview. */
  refreshIncomingCommits: () => Promise<void>;
  /** Refresh the ahead/behind sync status. */
  refreshSyncStatus: () => Promise<void>;
  /** List branches available on the remote. */
  loadRemoteBranches: () => Promise<RemoteBranchInfo[]>;
  /** Checkout a remote-only branch as a local tracking branch. */
  checkoutRemoteTimeline: (branch: string) => Promise<void>;
  /** Publish (push) the current local-only timeline to the remote. */
  publishTimeline: () => Promise<void>;
}

export type SyncStoreState = SyncState & SyncActions;

/** Sync state as it is when no project is open. */
export function initialSyncState(): SyncState {
  return resetSyncState();
}

/** Fields a project open/close/switch resets (all of them). */
export function resetSyncState(): SyncState {
  return {
    currentRemote: null,
    remoteBranches: [],
    remoteBranchesLoading: false,
    syncStatus: null,
    baseStatus: null,
    isSyncing: false,
    syncError: null,
    baseRename: null,
    incomingCommits: [],
    shareUrl: null,
    sendForReviewPrompt: null,
  };
}

/**
 * Coalesces `refreshSyncStatus`. Its remote preflight round-trip is fired
 * (often un-awaited) from ~a dozen handlers, so bursts around a save/fetch used
 * to stack up several concurrent round-trips. Concurrent callers now join one
 * in-flight refresh; any request that arrives during a pass schedules one more
 * pass after it, so the loop reruns until a pass completes with no new request
 * queued. In practice triggers are discrete (a save fans out a short burst), so
 * this settles in one or two passes while collapsing the burst to a single
 * trailing round-trip instead of one per caller.
 */
let syncStatusInFlight: Promise<void> | null = null;
let syncStatusRerunQueued = false;

const app = () => useAppStore.getState();
const versioning = () => useVersioningStore.getState();

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  ...initialSyncState(),

  detectRemote: async () => {
    const generation = bumpRemoteDetectionGeneration();
    try {
      const remotes = await listDraftlineRemotes();
      if (generation !== currentRemoteDetectionGeneration()) return;
      const info = remotes[0] ?? null;
      set({
        currentRemote: info ?? null,
        remoteBranches: [],
        remoteBranchesLoading: false,
        syncStatus: null,
        incomingCommits: [],
        syncError: null,
        shareUrl: null,
      });
      if (info) {
        if (!await ensureGitHubRemoteCredential(info)) return;
        if (generation !== currentRemoteDetectionGeneration()) return;
        await get().refreshSyncStatus();
      }
    } catch (err) {
      if (generation !== currentRemoteDetectionGeneration()) return;
      console.warn("Failed to detect project remote:", err);
      set((state) => ({
        remoteBranches: [],
        remoteBranchesLoading: false,
        syncStatus: null,
        incomingCommits: [],
        syncError: state.currentRemote ? remoteSyncErrorMessage(err) : null,
        shareUrl: null,
      }));
    }
  },

  fetchFromRemote: async (options = {}) => {
    const { currentRemote } = get();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, options.notifyAuthRequired ?? true)) return;
    set({ isSyncing: true, syncError: null });
    try {
      await fetchDraftlineRemote(currentRemote.name);
      await get().refreshSyncStatus();
      await get().refreshIncomingCommits();
      await versioning().loadGraphData();
      await versioning().loadTimelines();
      await versioning().loadVersions();
    } catch (err) {
      set({ syncError: remoteSyncErrorMessage(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  pushToRemote: async () => {
    const { currentRemote } = get();
    const { timelines } = versioning();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    // Another sync operation may have started while credentials were checked.
    if (get().isSyncing) {
      useToastStore.getState().show(SYNC_IN_PROGRESS_MESSAGE, 5000, "info");
      return;
    }
    const project = app().currentProject;
    if (project?.hybrid) {
      // Hybrid projects send for review (branch + pull request) instead of
      // pushing directly; ask for the pull request title first.
      set({
        sendForReviewPrompt: {
          defaultTitle: versioning().versions[0]?.message?.trim() || `Update ${project.name}`,
          defaultBody: versioning().versions[0]?.comment ?? "",
        },
      });
      return;
    }
    set({ isSyncing: true, syncError: null, baseRename: null });
    try {
      // Large-file check before push
      const largeFileError = largeFilesSyncError(await versioning().checkLargeFiles());
      if (largeFileError) {
        set({ syncError: largeFileError, isSyncing: false });
        return;
      }
      await publishDraftlineChanges(currentRemote.name);
      await get().refreshSyncStatus();
      await versioning().checkDirty();
      await versioning().refreshChangedFiles();
      await versioning().loadGraphData();
      await versioning().loadTimelines();
      await versioning().loadVersions();
    } catch (err) {
      set({ syncError: remoteSyncErrorMessage(err), baseRename: baseRenamedBranches(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  sendForReview: async (title, body) => {
    const { currentRemote } = get();
    set({ sendForReviewPrompt: null });
    if (!currentRemote || !app().currentProject?.hybrid) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    if (get().isSyncing) {
      useToastStore.getState().show(SYNC_IN_PROGRESS_MESSAGE, 5000, "info");
      return;
    }
    set({ isSyncing: true, syncError: null });
    let sendAttempted = false;
    let sendError: string | null = null;
    try {
      const largeFileError = largeFilesSyncError(await versioning().checkLargeFiles());
      if (largeFileError) {
        set({ syncError: largeFileError, isSyncing: false });
        return;
      }
      sendAttempted = true;
      const result = await sendDraftlineForReview({
        remote: currentRemote.name,
        title: trimmedTitle,
        body,
      });
      const { number, url } = result.pull_request;
      useToastStore.getState().show(
        result.created_pull_request
          ? `Pull request #${number} opened for review.`
          : `Pull request #${number} updated.`,
        10000,
        "success",
        { label: "Open", url },
      );
      set({ shareUrl: url });
    } catch (err) {
      sendError = remoteSyncErrorMessage(err);
      set({ syncError: sendError });
    } finally {
      // Send can switch branches and push before the pull request step fails,
      // so refresh even on error to show the real current variation.
      if (sendAttempted) {
        try {
          await get().refreshSyncStatus();
          await versioning().checkDirty();
          await versioning().refreshChangedFiles();
          await versioning().loadGraphData();
          await versioning().loadTimelines();
          await versioning().loadVersions();
        } catch {
          // Refresh failures must not mask the send result.
        }
        // A successful status refresh clears syncError; keep the send failure visible.
        if (sendError) set({ syncError: sendError });
      }
      set({ isSyncing: false });
    }
  },

  cancelSendForReview: () => set({ sendForReviewPrompt: null }),

  syncWithRemote: async () => {
    // Fetch first to get latest state
    await get().fetchFromRemote();
    const updated = get().syncStatus;
    if (!updated) return;
    // If behind, pull first
    if (updated.behind > 0) {
      await get().pullFromRemote();
    }
    // If ahead (and not diverged), push
    const afterPull = get().syncStatus;
    if (afterPull && afterPull.ahead > 0 && afterPull.behind === 0) {
      await get().pushToRemote();
    }
  },

  shareChanges: async () => {
    const { currentRemote } = get();
    const { timelines } = versioning();
    if (!currentRemote) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    await get().pushToRemote();
    // Hybrid projects share via the Send for review prompt (pull request), not a branch link.
    if (app().currentProject?.hybrid) return;
    const url = buildShareUrl(currentRemote.url, active.name);
    set({ shareUrl: url });
    if (url) {
      try {
        await navigator.clipboard.writeText(url);
        useToastStore.getState().show("Share link copied. Your work is safely published.", 4000, "success");
      } catch {
        useToastStore.getState().show("Your work is safely published.", 4000, "success");
      }
    }
  },

  pullFromRemote: async () => {
    const { currentRemote } = get();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    set({ isSyncing: true, syncError: null });
    try {
      const preflight = await preflightDraftlineIncoming(currentRemote.name);
      if (!preflight.canProceed) {
        const state = preflight.syncStatus.state;
        if (state === "needsMerge" && preflight.dirtyFiles.length === 0) {
          const mergeReport = await preflightDraftlineMergeIncoming(currentRemote.name);
          if (mergeReport.canMergeCleanly && mergeReport.token) {
            const message = await askMergeName(activeTimelineLabel(versioning().timelines) ?? currentRemote.name);
            if (!message) return;
            await mergeDraftlineIncoming(currentRemote.name, message);
            await app().loadSketches();
            await app().loadStoryboards();
            await app().loadNotes();
            await get().refreshSyncStatus();
            await get().refreshIncomingCommits();
            await versioning().loadVersions();
            await versioning().loadGraphData();
            await versioning().loadTimelines();
            await versioning().checkDirty();
            useToastStore.getState().showUpdate("Incoming saves merged.", "success");
            return;
          }
          if (mergeReport.conflicts.length > 0 && mergeReport.token) {
            // Merge state belongs to versioningStore; both updates land synchronously.
            useVersioningStore.setState({
              isMerging: true,
              mergeSource: currentRemote.name,
              mergeTarget: "incoming",
              mergeConflicts: mergeReport.conflicts,
              draftlineMergeToken: mergeReport.token,
              draftlineMergeRemote: currentRemote.name,
            });
            set({
              syncError: null,
              syncStatus: { ahead: mergeReport.syncStatus.ahead, behind: mergeReport.syncStatus.behind },
            });
            useToastStore.getState().showUpdate("Incoming saves need conflict resolution.", "info");
            return;
          }
          set({
            syncError: "Incoming saves cannot be merged safely right now.",
            syncStatus: { ahead: mergeReport.syncStatus.ahead, behind: mergeReport.syncStatus.behind },
          });
          return;
        }
        const reason = preflight.dirtyFiles.length > 0
          ? "Save or discard local changes before applying incoming saves."
          : "Incoming saves cannot be applied safely right now.";
        set({ syncError: reason, syncStatus: { ahead: preflight.syncStatus.ahead, behind: preflight.syncStatus.behind } });
        return;
      }

      await applyDraftlineIncoming(currentRemote.name);
      await app().loadSketches();
      await app().loadStoryboards();
      await app().loadNotes();
      await app().loadChatArtifacts();
      await get().refreshSyncStatus();
      await get().refreshIncomingCommits();
      await versioning().loadVersions();
      await versioning().loadGraphData();
      await versioning().loadTimelines();
      await versioning().checkDirty();
      useToastStore.getState().showUpdate("Incoming saves applied.", "success");
    } catch (err) {
      set({ syncError: remoteSyncErrorMessage(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  getUpdatesFromBase: async () => {
    const { currentRemote } = get();
    if (!currentRemote || !app().currentProject?.hybrid) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    if (get().isSyncing) {
      useToastStore.getState().show(SYNC_IN_PROGRESS_MESSAGE, 5000, "info");
      return;
    }
    const base = get().baseStatus?.base ?? "main";
    set({ isSyncing: true, syncError: null });
    let updateError: string | null = null;
    try {
      // Fetches first, so the merge below sees the latest base.
      const report = await preflightDraftlineMergeBase(currentRemote.name);
      if (report.dirtyFiles.length > 0) {
        updateError = `Save or discard local changes before getting updates from ${base}.`;
      } else if (report.canMergeCleanly && report.token) {
        const message = await askMergeName(base);
        if (message) {
          await mergeDraftlineFromBase(currentRemote.name, message);
          useToastStore.getState().showUpdate(`Updates from ${base} brought in.`, "success");
        }
      } else if (report.conflicts.length > 0 && report.token) {
        useVersioningStore.setState({
          isMerging: true,
          mergeSource: base,
          mergeTarget: "incoming",
          mergeConflicts: report.conflicts,
          draftlineMergeToken: report.token,
          draftlineMergeRemote: currentRemote.name,
        });
        useToastStore.getState().showUpdate(`Updates from ${base} need conflict resolution.`, "info");
      } else if (report.syncStatus.behind === 0) {
        useToastStore.getState().show(`Already up to date with ${base}.`, 4000, "info");
      } else {
        updateError = `Updates from ${base} can't be brought in safely right now.`;
      }
    } catch (err) {
      updateError = isMergeNeedsDeveloperError(err)
        ? mergeNeedsDeveloperMessage(base)
        : remoteSyncErrorMessage(err);
    } finally {
      // Refresh even on failure: the fetch may have moved the base.
      try {
        await app().loadSketches();
        await app().loadStoryboards();
        await app().loadNotes();
        await get().refreshSyncStatus();
        await get().refreshIncomingCommits();
        await versioning().loadVersions();
        await versioning().loadGraphData();
        await versioning().loadTimelines();
        await versioning().checkDirty();
      } catch {
        // Refresh failures must not mask the update result.
      }
      // A successful status refresh clears syncError; keep the failure visible.
      if (updateError) set({ syncError: updateError });
      set({ isSyncing: false });
    }
  },

  loadRemoteBranches: async () => {
    const generation = currentWorkspaceGeneration();
    const { currentRemote } = get();
    const { timelines } = versioning();
    if (!currentRemote) {
      set({ remoteBranches: [], remoteBranchesLoading: false });
      return [];
    }
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) {
      set({ remoteBranches: [], remoteBranchesLoading: false });
      return [];
    }
    if (generation !== currentWorkspaceGeneration()) return [];
    set({ remoteBranchesLoading: true, syncError: null });
    try {
      const localNames = new Set(timelines.map((timeline) => timeline.name));
      const branches = (await listDraftlineRemoteBranches(currentRemote.name))
        .filter((branch) => !localNames.has(branch.id) && !localNames.has(branch.name));
      if (generation !== currentWorkspaceGeneration()) return [];
      set({ remoteBranches: branches });
      return branches;
    } catch (err) {
      const message = errorMessage(err);
      if (generation === currentWorkspaceGeneration()) set({ remoteBranches: [], syncError: message });
      return [];
    } finally {
      if (generation === currentWorkspaceGeneration()) set({ remoteBranchesLoading: false });
    }
  },

  checkoutRemoteTimeline: async (branch: string) => {
    const { currentRemote } = get();
    const { isDirty } = versioning();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    if (isDirty) {
      const reason = "Save or discard local changes before adopting a remote branch.";
      useToastStore.getState().show(reason, 5000, "error");
      throw new Error(reason);
    }
    set({ isSyncing: true, syncError: null });
    try {
      await adoptDraftlineRemoteBranch(currentRemote.name, branch);
      await versioning().loadTimelines();
      await versioning().switchTimeline(branch);
      await get().loadRemoteBranches();
      await get().refreshSyncStatus();
      await versioning().loadGraphData();
      useToastStore.getState().show(`Adopted ${currentRemote.name}/${branch}.`, 4000, "success");
    } catch (err) {
      set({ syncError: errorMessage(err) });
      throw err;
    } finally {
      set({ isSyncing: false });
    }
  },

  publishTimeline: async () => {
    // Hybrid projects never publish directly; they go through Send for review.
    if (app().currentProject?.hybrid) {
      await get().pushToRemote();
      return;
    }
    const { currentRemote } = get();
    const { timelines } = versioning();
    if (!currentRemote) return;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    set({ isSyncing: true, syncError: null });
    try {
      await publishDraftlineChanges(currentRemote.name);
      await get().refreshSyncStatus();
    } catch (err) {
      set({ syncError: remoteSyncErrorMessage(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  refreshSyncStatus: async () => {
    // Join an in-flight refresh; flag that state may have changed so another
    // pass follows the current round-trip once it completes.
    if (syncStatusInFlight) {
      syncStatusRerunQueued = true;
      return syncStatusInFlight;
    }
    const runOnce = async () => {
      const generation = currentWorkspaceGeneration();
      const { currentRemote } = get();
      if (!currentRemote) return;
      if (!await ensureGitHubRemoteCredential(currentRemote)) return;
      try {
        const status = await getDraftlineSyncStatus(currentRemote.name);
        if (generation !== currentWorkspaceGeneration()) return;
        set({ syncStatus: status, syncError: null });
      } catch {
        if (generation !== currentWorkspaceGeneration()) return;
        set({ syncStatus: null });
      }
      // Only hybrid projects on a branch other than the base can fall behind it.
      let baseStatus: BaseStatus | null = null;
      if (app().currentProject?.hybrid) {
        try {
          baseStatus = await getDraftlineBaseStatus(currentRemote.name);
        } catch {
          baseStatus = null;
        }
      }
      if (generation !== currentWorkspaceGeneration()) return;
      set({ baseStatus });
    };
    syncStatusInFlight = (async () => {
      try {
        do {
          syncStatusRerunQueued = false;
          await runOnce();
        } while (syncStatusRerunQueued);
      } finally {
        syncStatusInFlight = null;
      }
    })();
    return syncStatusInFlight;
  },

  refreshIncomingCommits: async () => {
    const generation = currentWorkspaceGeneration();
    const { currentRemote, syncStatus } = get();
    if (!currentRemote || !syncStatus || syncStatus.behind === 0) {
      set({ incomingCommits: [] });
      return;
    }
    if (!await ensureGitHubRemoteCredential(currentRemote)) return;
    try {
      const incoming = await listDraftlineIncomingCommits(currentRemote.name);
      if (generation !== currentWorkspaceGeneration()) return;
      set({ incomingCommits: incoming });
    } catch {
      if (generation !== currentWorkspaceGeneration()) return;
      set({ incomingCommits: [] });
    }
  },
}));
