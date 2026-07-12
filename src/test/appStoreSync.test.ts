import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetDraftlineSyncStatus = vi.hoisted(() => vi.fn());
const mockListDraftlineRemotes = vi.hoisted(() => vi.fn());
const mockFetchDraftlineRemote = vi.hoisted(() => vi.fn());
const mockListDraftlinePendingSnapshotCleanups = vi.hoisted(() => vi.fn());
const mockPublishDraftlineChanges = vi.hoisted(() => vi.fn());
const mockGetGitHubAuthStatus = vi.hoisted(() => vi.fn());

vi.mock("../services/draftlineVersioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/draftlineVersioning")>();
  return {
    ...actual,
    fetchDraftlineRemote: (...args: unknown[]) => mockFetchDraftlineRemote(...args),
    getDraftlineSyncStatus: (...args: unknown[]) => mockGetDraftlineSyncStatus(...args),
    listDraftlineRemotes: (...args: unknown[]) => mockListDraftlineRemotes(...args),
    listDraftlinePendingSnapshotCleanups: (...args: unknown[]) => mockListDraftlinePendingSnapshotCleanups(...args),
    publishDraftlineChanges: (...args: unknown[]) => mockPublishDraftlineChanges(...args),
  };
});

vi.mock("../services/githubSetup", () => ({
  getGitHubAuthStatus: (...args: unknown[]) => mockGetGitHubAuthStatus(...args),
}));

import { remoteSyncErrorMessage, useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import type {
  DraftlineHistoryCleanupPreview,
  DraftlineHistoryCleanupPublishResult,
  DraftlineHistoryCompactionCandidates,
  DraftlineTimelineCleanupResult,
} from "../services/draftlineVersioning";

function cleanupCandidates(start: string, end: string, canCompact = true): DraftlineHistoryCompactionCandidates {
  return {
    target_variation: "main",
    selected_version: end,
    target_head: end,
    candidates: [{
      version: {
        id: start,
        label: "Range start",
        author: { name: "CutReady", email: null },
        saved_by: { name: "CutReady", email: null },
        time_seconds: 1_783_537_920,
      },
      include_range: { start, end },
      selected_role: "range_end",
      can_compact: canCompact,
      requires_descendant_replay: false,
      selected_commit_count: 3,
      descendant_rewrite_count: 0,
      blockers: canCompact ? [] : [{
        code: "merge_boundary_requires_user_choice",
        message: "cleanup range crosses merge commit `merge-commit`",
        related_versions: ["merge-commit"],
        safe_next_actions: ["normal_work"],
      }],
      warnings: [],
    }],
  };
}

describe("appStore remote sync status", () => {
  beforeEach(() => {
    mockListDraftlinePendingSnapshotCleanups.mockResolvedValue([]);
  });

  afterEach(() => {
    mockFetchDraftlineRemote.mockReset();
    mockGetGitHubAuthStatus.mockReset();
    mockGetDraftlineSyncStatus.mockReset();
    mockListDraftlineRemotes.mockReset();
    mockListDraftlinePendingSnapshotCleanups.mockReset();
    mockPublishDraftlineChanges.mockReset();
    useAppStore.setState({
      currentRemote: null,
      timelines: [],
      syncStatus: null,
      syncError: null,
      incomingCommits: [],
      isSyncing: false,
      pendingHistoryCleanup: null,
      prePushMilestonePrompt: null,
      requestPrePushMilestone: useAppStore.getInitialState().requestPrePushMilestone,
      findSnapshotCleanupCandidates: useAppStore.getInitialState().findSnapshotCleanupCandidates,
      previewSnapshotCleanup: useAppStore.getInitialState().previewSnapshotCleanup,
      applySnapshotCleanup: useAppStore.getInitialState().applySnapshotCleanup,
      publishSnapshotCleanup: useAppStore.getInitialState().publishSnapshotCleanup,
      checkLargeFiles: useAppStore.getInitialState().checkLargeFiles,
      checkDirty: useAppStore.getInitialState().checkDirty,
      refreshChangedFiles: useAppStore.getInitialState().refreshChangedFiles,
      loadGraphData: useAppStore.getInitialState().loadGraphData,
      loadTimelines: useAppStore.getInitialState().loadTimelines,
      loadVersions: useAppStore.getInitialState().loadVersions,
    });
    useToastStore.setState({ toasts: [] });
  });

  it("clears stale remote warnings after sync status refresh succeeds", async () => {
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: true });
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
      syncError: "git operation failed: remote authentication required but no callback set",
    });

    await useAppStore.getState().refreshSyncStatus();

    expect(mockGetDraftlineSyncStatus).toHaveBeenCalledWith("origin");
    expect(useAppStore.getState().syncStatus).toEqual({ ahead: 0, behind: 0 });
    expect(useAppStore.getState().syncError).toBeNull();
  });

  it("preserves stale remote warnings when sync status refresh fails", async () => {
    const previousError = "git operation failed: remote authentication required but no callback set";
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: true });
    mockGetDraftlineSyncStatus.mockRejectedValueOnce(new Error("network unavailable"));
    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: { ahead: 1, behind: 0 },
      syncError: previousError,
    });

    await useAppStore.getState().refreshSyncStatus();

    expect(useAppStore.getState().syncStatus).toBeNull();
    expect(useAppStore.getState().syncError).toBe(previousError);
  });

  it("warns instead of refreshing status when a GitHub remote has no connected credential", async () => {
    mockListDraftlineRemotes.mockResolvedValueOnce([
      { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
    ]);
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: false });

    await useAppStore.getState().detectRemote();

    expect(mockGetDraftlineSyncStatus).not.toHaveBeenCalled();
    expect(useAppStore.getState().currentRemote).toEqual({
      name: "origin",
      url: "https://github.com/sethjuarez/cutready.git",
    });
    expect(useAppStore.getState().syncStatus).toBeNull();
    expect(useAppStore.getState().syncError).toBe(
      "This project has a GitHub remote. Connect GitHub in Settings > Repository before syncing.",
    );
  });

  it("retains a discovered remote when a stale detection fails", async () => {
    let rejectStaleDetection!: (error: Error) => void;
    const staleDetection = new Promise<never>((_, reject) => {
      rejectStaleDetection = reject;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockListDraftlineRemotes
      .mockReturnValueOnce(staleDetection)
      .mockResolvedValueOnce([{ name: "origin", url: "https://github.com/sethjuarez/cutready.git" }]);
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockGetDraftlineSyncStatus.mockResolvedValue({ ahead: 0, behind: 0 });

    try {
      const firstDetection = useAppStore.getState().detectRemote();
      await useAppStore.getState().detectRemote();
      rejectStaleDetection(new Error("temporary remote lookup failure"));
      await firstDetection;

      expect(useAppStore.getState().currentRemote).toEqual({
        name: "origin",
        url: "https://github.com/sethjuarez/cutready.git",
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("retains a configured remote when a fresh detection fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const remote = { name: "origin", url: "https://github.com/sethjuarez/cutready.git" };
    mockListDraftlineRemotes.mockRejectedValueOnce(new Error("temporary remote lookup failure"));
    useAppStore.setState({ currentRemote: remote, syncStatus: { ahead: 1, behind: 0 } });

    try {
      await useAppStore.getState().detectRemote();

      expect(useAppStore.getState().currentRemote).toEqual(remote);
      expect(useAppStore.getState().syncStatus).toBeNull();
      expect(warn).toHaveBeenCalledWith("Failed to detect project remote:", expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not fetch a GitHub remote before the user connects GitHub", async () => {
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: false });
    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
      syncError: null,
    });

    await useAppStore.getState().fetchFromRemote();

    expect(mockFetchDraftlineRemote).not.toHaveBeenCalled();
    expect(useAppStore.getState().isSyncing).toBe(false);
    expect(useAppStore.getState().syncError).toBe(
      "This project has a GitHub remote. Connect GitHub in Settings > Repository before syncing.",
    );
  });

  it("keeps automatic GitHub remote fetch guards silent until the user acts", async () => {
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: false });
    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
      syncError: null,
    });

    await useAppStore.getState().fetchFromRemote({ notifyAuthRequired: false });

    expect(mockFetchDraftlineRemote).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useAppStore.getState().syncError).toBe(
      "This project has a GitHub remote. Connect GitHub in Settings > Repository before syncing.",
    );
  });

  it("does not block sync status refresh when GitHub auth status cannot be checked", async () => {
    const previousStatus = { ahead: 1, behind: 0 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockGetGitHubAuthStatus.mockRejectedValueOnce(new Error("network unavailable"));
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 1 });
    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: previousStatus,
      syncError: null,
    });

    try {
      await useAppStore.getState().refreshSyncStatus();

      expect(mockGetDraftlineSyncStatus).toHaveBeenCalledWith("origin");
      expect(useAppStore.getState().syncStatus).toEqual({ ahead: 0, behind: 1 });
      expect(useAppStore.getState().syncError).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "Could not confirm GitHub auth status before sync; continuing remote operation.",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("normalizes Git HTTP 401 sync failures into a GitHub reconnect message", () => {
    const message = remoteSyncErrorMessage(
      "{\"code\":\"git\",\"message\":\"git operation failed: request failed with status code: 401; class=Http (34)\"}",
    );

    expect(message).toBe("GitHub rejected the remote operation. Reconnect GitHub in Settings, then try again.");
  });

  it("loads durable pending cleanup state when Draftline blocks normal sync", async () => {
    const pendingCleanup = {
      plan_id: "cleanup-1",
      target_variation: "main",
      expected_local_head: "before",
      replacement_head: "after",
      backup_refs: [],
      ref_updates: [],
      publish_status: "shared_history_rewrite_required",
    };
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: true });
    mockFetchDraftlineRemote.mockRejectedValueOnce({
      code: "history_cleanup_blocked",
      message: "Pending history cleanup must be resolved first.",
      details: { operation: "fetch", diagnostics: [], can_proceed: false },
    });
    mockListDraftlinePendingSnapshotCleanups.mockResolvedValueOnce([pendingCleanup]);
    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
    });

    await useAppStore.getState().fetchFromRemote();

    expect(mockListDraftlinePendingSnapshotCleanups).toHaveBeenCalledWith("main");
    expect(useAppStore.getState().pendingHistoryCleanup).toEqual(pendingCleanup);
    expect(useAppStore.getState().syncError).toContain("Publish or undo milestone history");
  });

  it("compacts unpublished local snapshots into a milestone before pushing", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    const requestPrePushMilestone = vi.fn(async () => ({ type: "milestone" as const, label: "Finalize onboarding walkthrough" }));
    const previewSnapshotCleanup = vi.fn(async () => ({ plan_id: "plan-1" }) as DraftlineHistoryCleanupPreview);
    const applySnapshotCleanup = vi.fn(async () => ({}) as DraftlineTimelineCleanupResult);
    const publishSnapshotCleanup = vi.fn(async () => ({}) as DraftlineHistoryCleanupPublishResult);
    const findSnapshotCleanupCandidates = vi.fn(async () => cleanupCandidates("c", "e"));

    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 4, color_index: 0 }],
      syncStatus: { ahead: 3, behind: 0 },
      graphNodes: [
        { id: "e", message: "Wed afternoon 12:31", timestamp: "2026-07-08T18:31:00Z", timeline: "main", parents: ["d"], lane: 0, is_head: true },
        { id: "d", message: "Refine intro", timestamp: "2026-07-08T18:20:00Z", timeline: "main", parents: ["c"], lane: 0, is_head: false },
        { id: "c", message: "Quick save", timestamp: "2026-07-08T18:12:00Z", timeline: "main", parents: ["a"], lane: 0, is_head: false },
        { id: "a", message: "Shared base", timestamp: "2026-07-08T18:00:00Z", timeline: "main", parents: [], lane: 0, is_head: false },
      ],
      checkLargeFiles: async () => [],
      findSnapshotCleanupCandidates,
      requestPrePushMilestone,
      previewSnapshotCleanup,
      applySnapshotCleanup,
      publishSnapshotCleanup,
    });

    await useAppStore.getState().pushToRemote();

    expect(requestPrePushMilestone).toHaveBeenCalledWith(expect.objectContaining({
      snapshotCount: 3,
      newestCommitId: "e",
      oldestCommitId: "c",
      latestSnapshotLabel: "Wed afternoon 12:31",
      suggestedLabel: "Refine intro",
      remoteName: "origin",
    }));
    expect(findSnapshotCleanupCandidates).toHaveBeenCalledWith("e");
    expect(previewSnapshotCleanup).toHaveBeenCalledWith("c", "e", "Finalize onboarding walkthrough", ["e", "d", "c"]);
    expect(applySnapshotCleanup).toHaveBeenCalledWith("plan-1");
    expect(publishSnapshotCleanup).toHaveBeenCalledWith("plan-1", "origin");
    expect(mockPublishDraftlineChanges).not.toHaveBeenCalled();
    expect(useAppStore.getState().isSyncing).toBe(false);
  });

  it("publishes the milestone commit when cleanup does not require guarded remote publishing", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockPublishDraftlineChanges.mockResolvedValueOnce(undefined);
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    const requestPrePushMilestone = vi.fn(async () => ({ type: "milestone" as const, label: "Auditaur milestone validation" }));
    const previewSnapshotCleanup = vi.fn(async () => ({ plan_id: "plan-1" }) as DraftlineHistoryCleanupPreview);
    const applySnapshotCleanup = vi.fn(async () => ({}) as DraftlineTimelineCleanupResult);
    const publishSnapshotCleanup = vi.fn(async () => null);
    const findSnapshotCleanupCandidates = vi.fn(async () => cleanupCandidates("c", "e"));

    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 4, color_index: 0 }],
      syncStatus: { ahead: 3, behind: 0 },
      graphNodes: [
        { id: "e", message: "Wed afternoon 12:31", timestamp: "2026-07-08T18:31:00Z", timeline: "main", parents: ["d"], lane: 0, is_head: true },
        { id: "d", message: "Refine intro", timestamp: "2026-07-08T18:20:00Z", timeline: "main", parents: ["c"], lane: 0, is_head: false },
        { id: "c", message: "Quick save", timestamp: "2026-07-08T18:12:00Z", timeline: "main", parents: ["a"], lane: 0, is_head: false },
        { id: "a", message: "Shared base", timestamp: "2026-07-08T18:00:00Z", timeline: "main", parents: [], lane: 0, is_head: false },
      ],
      checkLargeFiles: async () => [],
      findSnapshotCleanupCandidates,
      requestPrePushMilestone,
      previewSnapshotCleanup,
      applySnapshotCleanup,
      publishSnapshotCleanup,
      checkDirty: async () => {},
      refreshChangedFiles: async () => {},
      loadGraphData: async () => {},
      loadTimelines: async () => {},
      loadVersions: async () => {},
    });

    await useAppStore.getState().pushToRemote();

    expect(findSnapshotCleanupCandidates).toHaveBeenCalledWith("e");
    expect(previewSnapshotCleanup).toHaveBeenCalledWith("c", "e", "Auditaur milestone validation", ["e", "d", "c"]);
    expect(applySnapshotCleanup).toHaveBeenCalledWith("plan-1");
    expect(publishSnapshotCleanup).toHaveBeenCalledWith("plan-1", "origin");
    expect(mockListDraftlinePendingSnapshotCleanups).toHaveBeenCalled();
    expect(mockPublishDraftlineChanges).toHaveBeenCalledWith("origin");
  });

  it("pushes snapshots as-is when the automatic milestone range crosses a merge boundary", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockPublishDraftlineChanges.mockResolvedValueOnce(undefined);
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    const requestPrePushMilestone = vi.fn(async () => ({ type: "milestone" as const, label: "Should not be used" }));
    const previewSnapshotCleanup = vi.fn(async () => ({ plan_id: "plan-1" }) as DraftlineHistoryCleanupPreview);
    const findSnapshotCleanupCandidates = vi.fn(async () => cleanupCandidates("c", "e", false));

    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 4, color_index: 0 }],
      syncStatus: { ahead: 3, behind: 0 },
      graphNodes: [
        { id: "e", message: "Wed afternoon 12:31", timestamp: "2026-07-08T18:31:00Z", timeline: "main", parents: ["d"], lane: 0, is_head: true },
        { id: "d", message: "Merge shared edits", timestamp: "2026-07-08T18:20:00Z", timeline: "main", parents: ["c", "side"], lane: 0, is_head: false },
        { id: "c", message: "Quick save", timestamp: "2026-07-08T18:12:00Z", timeline: "main", parents: ["a"], lane: 0, is_head: false },
        { id: "a", message: "Shared base", timestamp: "2026-07-08T18:00:00Z", timeline: "main", parents: [], lane: 0, is_head: false },
      ],
      checkLargeFiles: async () => [],
      findSnapshotCleanupCandidates,
      requestPrePushMilestone,
      previewSnapshotCleanup,
      checkDirty: async () => {},
      refreshChangedFiles: async () => {},
      loadGraphData: async () => {},
      loadTimelines: async () => {},
      loadVersions: async () => {},
    });

    await useAppStore.getState().pushToRemote();

    expect(findSnapshotCleanupCandidates).toHaveBeenCalledWith("e");
    expect(requestPrePushMilestone).not.toHaveBeenCalled();
    expect(previewSnapshotCleanup).not.toHaveBeenCalled();
    expect(mockPublishDraftlineChanges).toHaveBeenCalledWith("origin");
  });

  it("pushes snapshots as-is when the user skips the milestone", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockPublishDraftlineChanges.mockResolvedValueOnce(undefined);
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    const requestPrePushMilestone = vi.fn(async () => ({ type: "pushAsIs" as const }));
    const findSnapshotCleanupCandidates = vi.fn(async () => cleanupCandidates("b", "c"));

    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 3, color_index: 0 }],
      syncStatus: { ahead: 2, behind: 0 },
      graphNodes: [
        { id: "c", message: "Wed afternoon 12:31", timestamp: "2026-07-08T18:31:00Z", timeline: "main", parents: ["b"], lane: 0, is_head: true },
        { id: "b", message: "Quick save", timestamp: "2026-07-08T18:12:00Z", timeline: "main", parents: ["a"], lane: 0, is_head: false },
        { id: "a", message: "Shared base", timestamp: "2026-07-08T18:00:00Z", timeline: "main", parents: [], lane: 0, is_head: false },
      ],
      checkLargeFiles: async () => [],
      findSnapshotCleanupCandidates,
      requestPrePushMilestone,
      checkDirty: async () => {},
      refreshChangedFiles: async () => {},
      loadGraphData: async () => {},
      loadTimelines: async () => {},
      loadVersions: async () => {},
    });

    await useAppStore.getState().pushToRemote();

    expect(findSnapshotCleanupCandidates).toHaveBeenCalledWith("c");
    expect(requestPrePushMilestone).toHaveBeenCalledTimes(1);
    expect(mockPublishDraftlineChanges).toHaveBeenCalledWith("origin");
  });

  it("cancels a milestone push without publishing snapshots", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    const requestPrePushMilestone = vi.fn(async () => ({ type: "cancel" as const }));
    const findSnapshotCleanupCandidates = vi.fn(async () => cleanupCandidates("b", "c"));

    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 3, color_index: 0 }],
      syncStatus: { ahead: 2, behind: 0 },
      graphNodes: [
        { id: "c", message: "Wed afternoon 12:31", timestamp: "2026-07-08T18:31:00Z", timeline: "main", parents: ["b"], lane: 0, is_head: true },
        { id: "b", message: "Quick save", timestamp: "2026-07-08T18:12:00Z", timeline: "main", parents: ["a"], lane: 0, is_head: false },
        { id: "a", message: "Shared base", timestamp: "2026-07-08T18:00:00Z", timeline: "main", parents: [], lane: 0, is_head: false },
      ],
      checkLargeFiles: async () => [],
      findSnapshotCleanupCandidates,
      requestPrePushMilestone,
    });

    await useAppStore.getState().pushToRemote();

    expect(findSnapshotCleanupCandidates).toHaveBeenCalledWith("c");
    expect(requestPrePushMilestone).toHaveBeenCalledTimes(1);
    expect(mockPublishDraftlineChanges).not.toHaveBeenCalled();
    expect(useAppStore.getState().isSyncing).toBe(false);
  });

  it("does not prompt for a milestone when only one local snapshot is ahead", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockPublishDraftlineChanges.mockResolvedValueOnce(undefined);
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    const requestPrePushMilestone = vi.fn(async () => ({ type: "milestone" as const, label: "Should not be used" }));

    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 2, color_index: 0 }],
      syncStatus: { ahead: 1, behind: 0 },
      graphNodes: [
        { id: "b", message: "Single local save", timestamp: "2026-07-08T18:31:00Z", timeline: "main", parents: ["a"], lane: 0, is_head: true },
        { id: "a", message: "Shared base", timestamp: "2026-07-08T18:00:00Z", timeline: "main", parents: [], lane: 0, is_head: false },
      ],
      checkLargeFiles: async () => [],
      requestPrePushMilestone,
      checkDirty: async () => {},
      refreshChangedFiles: async () => {},
      loadGraphData: async () => {},
      loadTimelines: async () => {},
      loadVersions: async () => {},
    });

    await useAppStore.getState().pushToRemote();

    expect(requestPrePushMilestone).not.toHaveBeenCalled();
    expect(mockPublishDraftlineChanges).toHaveBeenCalledWith("origin");
  });
});
