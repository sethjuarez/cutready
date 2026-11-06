// Remote collaboration state (architecture v3 F6). Local history and merge state
// live in versioningStore; project/editor state stays in appStore. Other stores
// are read with getState() inside actions only.
import { create } from "zustand";
import {
  adoptDraftlineRemoteBranch,
  fetchDraftlineRemote,
  getDraftlineBaseStatus,
  getDraftlineSyncStatus,
  listDraftlineIncomingCommits,
  listDraftlineRemoteBranches,
  listDraftlineRemotes,
  publishDraftlineChanges,
  sendForReview as sendDraftlineForReview,
} from "../services/draftlineVersioning";
import { baseRenamedBranches } from "../services/draftlineErrors";
import { bringInTeamUpdates, type TeamUpdateOutcome } from "../services/teamUpdates";
import { incomingAuthors, reviewRequest, syncCopy } from "../domain/versioning";
import { useToastStore } from "./toastStore";
import { useAppStore } from "./appStore";
import { useVersioningStore } from "./versioningStore";
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
  mergeSyncErrorMessage,
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
  /** Resolves true only when the work actually reached the remote. */
  pushToRemote: () => Promise<boolean>;
  /** Hybrid projects: push the CutReady branch and open/update a pull request. */
  /** Resolves true only when the pull request was opened or updated. */
  sendForReview: (title: string, body?: string, pickedUp?: number) => Promise<boolean>;
  /** Dismiss the Send for review prompt without sending. */
  cancelSendForReview: () => void;
  /** Bring in what the team sent, silently unless files conflict. */
  pullFromRemote: (options?: { quiet?: boolean }) => Promise<TeamUpdateOutcome | null>;
  /** Hybrid projects on their own copy: bring in the shared project's latest updates. */
  getUpdatesFromBase: () => Promise<TeamUpdateOutcome | null>;
  /** Send: bring in team updates first if any, then send the saves (hybrid: for review). */
  syncWithRemote: (version?: { name: string; comment: string }) => Promise<void>;
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
/** True while the project open at call time is still open. Draftline calls follow the open project. */
const sameWorkspace = () => {
  const generation = currentWorkspaceGeneration();
  return () => generation === currentWorkspaceGeneration();
};
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
    const isCurrent = sameWorkspace();
    if (!await ensureGitHubRemoteCredential(currentRemote, options.notifyAuthRequired ?? true)) return;
    if (!isCurrent()) return;
    set({ isSyncing: true, syncError: null });
    try {
      await fetchDraftlineRemote(currentRemote.name);
      if (!isCurrent()) return;
      await get().refreshSyncStatus();
      await get().refreshIncomingCommits();
      await versioning().loadGraphData();
      await versioning().loadTimelines();
      await versioning().loadVersions();
    } catch (err) {
      if (isCurrent()) set({ syncError: remoteSyncErrorMessage(err) });
    } finally {
      // A project switch already reset this store; leave the new project alone.
      if (isCurrent()) set({ isSyncing: false });
    }
  },

  pushToRemote: async () => {
    const { currentRemote } = get();
    const { timelines } = versioning();
    if (!currentRemote) return false;
    const isCurrent = sameWorkspace();
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return false;
    if (!isCurrent()) return false;
    const active = timelines.find((t) => t.is_active);
    if (!active) return false;
    // Another sync operation may have started while credentials were checked.
    if (get().isSyncing) {
      useToastStore.getState().show(SYNC_IN_PROGRESS_MESSAGE, 5000, "info");
      return false;
    }
    const project = app().currentProject;
    if (project?.hybrid) {
      // Hybrid projects send for review (branch + pull request) instead of
      // pushing directly; ask for the pull request title first.
      const { graphNodes, versions } = versioning();
      // Before history loads, the newest save is the best guess for a name.
      const loose = graphNodes.length === 0 && versions[0] ? { name: versions[0].message, comment: versions[0].comment ?? "" } : undefined;
      const review = reviewRequest(graphNodes, get().syncStatus?.ahead ?? Infinity, loose, `Update ${project.name}`);
      set({ sendForReviewPrompt: { defaultTitle: review.title, defaultBody: review.body } });
      return false;
    }
    set({ isSyncing: true, syncError: null, baseRename: null });
    let sent = false;
    try {
      // Large-file check before push
      const largeFileError = largeFilesSyncError(await versioning().checkLargeFiles());
      if (largeFileError) {
        set({ syncError: largeFileError, isSyncing: false });
        return false;
      }
      if (!isCurrent()) return false;
      await publishDraftlineChanges(currentRemote.name);
      sent = true;
      if (!isCurrent()) return true;
      await get().refreshSyncStatus();
      await versioning().checkDirty();
      await versioning().refreshChangedFiles();
      await versioning().loadGraphData();
      await versioning().loadTimelines();
      await versioning().loadVersions();
    } catch (err) {
      // A failed refresh after a good push still counts as sent.
      if (!sent && isCurrent()) set({ syncError: remoteSyncErrorMessage(err), baseRename: baseRenamedBranches(err) });
    } finally {
      if (isCurrent()) set({ isSyncing: false });
    }
    return sent;
  },

  sendForReview: async (title, body, pickedUp = 0) => {
    const { currentRemote } = get();
    set({ sendForReviewPrompt: null });
    if (!currentRemote || !app().currentProject?.hybrid) return false;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return false;
    const isCurrent = sameWorkspace();
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return false;
    if (!isCurrent()) return false;
    if (get().isSyncing) {
      useToastStore.getState().show(SYNC_IN_PROGRESS_MESSAGE, 5000, "info");
      return false;
    }
    set({ isSyncing: true, syncError: null });
    let sendAttempted = false;
    let sent = false;
    let sendError: string | null = null;
    try {
      const largeFileError = largeFilesSyncError(await versioning().checkLargeFiles());
      if (largeFileError) {
        set({ syncError: largeFileError, isSyncing: false });
        return false;
      }
      if (!isCurrent()) return false;
      sendAttempted = true;
      const result = await sendDraftlineForReview({
        remote: currentRemote.name,
        title: trimmedTitle,
        body,
      });
      const { url } = result.pull_request;
      sent = true;
      useToastStore.getState().show(syncCopy.sent(pickedUp, true), 10000, "success", { label: "Open", url });
      if (isCurrent()) set({ shareUrl: url });
    } catch (err) {
      sendError = remoteSyncErrorMessage(err);
      if (isCurrent()) set({ syncError: sendError });
    } finally {
      // Send can switch branches and push before the pull request step fails,
      // so refresh even on error to show the real current variation.
      if (sendAttempted && isCurrent()) {
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
        if (sendError && isCurrent()) set({ syncError: sendError });
      }
      if (isCurrent()) set({ isSyncing: false });
    }
    return sent;
  },

  cancelSendForReview: () => set({ sendForReviewPrompt: null }),

  syncWithRemote: async (version) => {
    const { currentRemote } = get();
    if (!currentRemote) return;
    if (get().isSyncing) {
      useToastStore.getState().show(SYNC_IN_PROGRESS_MESSAGE, 5000, "info");
      return;
    }
    const generation = currentWorkspaceGeneration();
    const stale = () => generation !== currentWorkspaceGeneration();
    await get().fetchFromRemote();
    if (stale() || get().syncError) return;
    // Whatever the team sent comes in first, without a prompt; only a
    // conflict stops the send.
    let pickedUp = 0;
    if ((get().syncStatus?.behind ?? 0) > 0) {
      const outcome = await get().pullFromRemote({ quiet: true });
      if (stale() || outcome?.kind !== "brought-in") return;
      pickedUp = outcome.count;
    }
    const status = get().syncStatus;
    if (!status) {
      // Never guess: without a fresh status we can't tell what still needs sending.
      set({ syncError: syncCopy.couldNotSend });
      return;
    }
    if (status.behind > 0) {
      set({ syncError: syncCopy.moreTeamUpdates });
      return;
    }
    if (status.ahead === 0) {
      if (pickedUp > 0) useToastStore.getState().showUpdate(syncCopy.gotTeamUpdates(pickedUp), "success");
      return;
    }
    if (app().currentProject?.hybrid) {
      const review = reviewRequest(versioning().graphNodes, status.ahead, version);
      await get().sendForReview(review.title, review.body || undefined, pickedUp);
      return;
    }
    const sent = await get().pushToRemote();
    if (sent && !stale()) useToastStore.getState().showUpdate(syncCopy.sent(pickedUp), "success");
  },

  shareChanges: async () => {
    const { currentRemote } = get();
    const { timelines } = versioning();
    if (!currentRemote) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    const sent = await get().pushToRemote();
    // Hybrid projects share via the Send for review prompt (pull request), not a branch link.
    if (!sent || app().currentProject?.hybrid) return;
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

  pullFromRemote: async (options) => {
    const { currentRemote } = get();
    if (!currentRemote) return null;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return null;
    if (get().isSyncing) {
      useToastStore.getState().show(SYNC_IN_PROGRESS_MESSAGE, 5000, "info");
      return null;
    }
    set({ isSyncing: true, syncError: null });
    const generation = currentWorkspaceGeneration();
    const isCurrent = () => generation === currentWorkspaceGeneration();
    let outcome: TeamUpdateOutcome | null = null;
    let updateError: string | null = null;
    try {
      outcome = await bringInTeamUpdates(currentRemote.name, "incoming", isCurrent);
      updateError = announceTeamUpdates(outcome, options?.quiet === true);
    } catch (err) {
      updateError = mergeSyncErrorMessage(err);
    } finally {
      // A project switch already reset this store; leave the new project alone.
      if (isCurrent()) {
        await refreshAfterTeamUpdates(outcome);
        // A successful status refresh clears syncError; keep the failure visible.
        if (updateError && isCurrent()) set({ syncError: updateError });
        if (isCurrent()) set({ isSyncing: false });
      }
    }
    return isCurrent() ? outcome : { kind: "cancelled" };
  },

  getUpdatesFromBase: async () => {
    const { currentRemote } = get();
    if (!currentRemote || !app().currentProject?.hybrid) return null;
    if (!await ensureGitHubRemoteCredential(currentRemote, true)) return null;
    if (get().isSyncing) {
      useToastStore.getState().show(SYNC_IN_PROGRESS_MESSAGE, 5000, "info");
      return null;
    }
    set({ isSyncing: true, syncError: null });
    const generation = currentWorkspaceGeneration();
    const isCurrent = () => generation === currentWorkspaceGeneration();
    let outcome: TeamUpdateOutcome | null = null;
    let updateError: string | null = null;
    try {
      // Fetches first, so the update sees the latest shared project.
      outcome = await bringInTeamUpdates(currentRemote.name, "base", isCurrent);
      updateError = announceTeamUpdates(outcome, false);
    } catch (err) {
      updateError = isMergeNeedsDeveloperError(err)
        ? syncCopy.sharedUpdatesNeedDeveloper
        : mergeSyncErrorMessage(err);
    } finally {
      if (isCurrent()) {
        // Refresh even on failure: the fetch may have moved the shared project.
        await refreshAfterTeamUpdates({ kind: "brought-in", count: 0 });
        if (updateError && isCurrent()) set({ syncError: updateError });
        if (isCurrent()) set({ isSyncing: false });
      }
    }
    return isCurrent() ? outcome : { kind: "cancelled" };
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
      const reason = "Save or discard your changes before switching to the shared timeline.";
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
      useToastStore.getState().show(syncCopy.switchedToShared(branch), 4000, "success");
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

/** Toasts the outcome; returns the message to keep on screen when nothing came in. */
function announceTeamUpdates(outcome: TeamUpdateOutcome, quiet: boolean): string | null {
  const toast = useToastStore.getState();
  switch (outcome.kind) {
    case "none":
      if (!quiet) toast.show(syncCopy.alreadyUpToDate, 4000, "info");
      return null;
    case "brought-in":
      if (!quiet) toast.showUpdate(syncCopy.gotTeamUpdates(outcome.count), "success");
      return null;
    case "conflict":
      toast.showUpdate(syncCopy.conflict(incomingAuthors(versioning().draftlineMergeIncoming)), "info");
      return null;
    case "blocked":
      return outcome.message;
    case "cancelled":
      return null;
  }
}

/** Reload what team updates can change; failures must not mask the update result. */
async function refreshAfterTeamUpdates(outcome: TeamUpdateOutcome | null): Promise<void> {
  const sync = useSyncStore.getState();
  // Status first and on its own: Send decides what to do next from it.
  const steps: Array<() => Promise<unknown>> = [
    () => sync.refreshSyncStatus(),
    () => sync.refreshIncomingCommits(),
    () => versioning().loadVersions(),
    () => versioning().loadGraphData(),
    () => versioning().loadTimelines(),
    () => versioning().checkDirty(),
  ];
  if (outcome?.kind === "brought-in") {
    steps.push(
      () => app().loadSketches(),
      () => app().loadStoryboards(),
      () => app().loadNotes(),
      () => app().loadChatArtifacts(),
    );
  }
  for (const step of steps) {
    try {
      await step();
    } catch {
      // One failed reload must not hide the update result or skip the rest.
    }
  }
}
