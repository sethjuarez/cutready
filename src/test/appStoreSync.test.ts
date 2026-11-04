import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetDraftlineSyncStatus = vi.hoisted(() => vi.fn());
const mockListDraftlineRemotes = vi.hoisted(() => vi.fn());
const mockFetchDraftlineRemote = vi.hoisted(() => vi.fn());
const mockPublishDraftlineChanges = vi.hoisted(() => vi.fn());
const mockSendForReview = vi.hoisted(() => vi.fn());
const mockGetGitHubAuthStatus = vi.hoisted(() => vi.fn());
const mockGetDraftlineBaseStatus = vi.hoisted(() => vi.fn());
const mockPreflightDraftlineMergeBase = vi.hoisted(() => vi.fn());
const mockMergeDraftlineFromBase = vi.hoisted(() => vi.fn());

vi.mock("../services/draftlineVersioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/draftlineVersioning")>();
  return {
    ...actual,
    fetchDraftlineRemote: (...args: unknown[]) => mockFetchDraftlineRemote(...args),
    getDraftlineSyncStatus: (...args: unknown[]) => mockGetDraftlineSyncStatus(...args),
    listDraftlineRemotes: (...args: unknown[]) => mockListDraftlineRemotes(...args),
    publishDraftlineChanges: (...args: unknown[]) => mockPublishDraftlineChanges(...args),
    sendForReview: (...args: unknown[]) => mockSendForReview(...args),
    getDraftlineBaseStatus: (...args: unknown[]) => mockGetDraftlineBaseStatus(...args),
    preflightDraftlineMergeBase: (...args: unknown[]) => mockPreflightDraftlineMergeBase(...args),
    mergeDraftlineFromBase: (...args: unknown[]) => mockMergeDraftlineFromBase(...args),
  };
});

vi.mock("../services/githubSetup", () => ({
  getGitHubAuthStatus: (...args: unknown[]) => mockGetGitHubAuthStatus(...args),
}));

import { mergeNeedsDeveloperMessage, remoteSyncErrorMessage, useAppStore } from "../stores/appStore";
import { useVersioningStore } from "../stores/versioningStore";
import { useSyncStore } from "../stores/syncStore";
import { GIT_INDEX_LOCKED_MESSAGE, SEND_OUTSIDE_NAMESPACE_MESSAGE } from "../services/draftlineErrors";
import { useToastStore } from "../stores/toastStore";
import { useMergeNameStore } from "../stores/mergeNameStore";
describe("appStore remote sync status", () => {
  afterEach(() => {
  useMergeNameStore.setState({ pending: null });
    mockFetchDraftlineRemote.mockReset();
    mockGetGitHubAuthStatus.mockReset();
    mockGetDraftlineSyncStatus.mockReset();
    mockListDraftlineRemotes.mockReset();
    mockPublishDraftlineChanges.mockReset();
    mockSendForReview.mockReset();
    mockGetDraftlineBaseStatus.mockReset();
    mockPreflightDraftlineMergeBase.mockReset();
    mockMergeDraftlineFromBase.mockReset();
    useAppStore.setState({
      currentProject: null,
      loadSketches: useAppStore.getInitialState().loadSketches,
      loadStoryboards: useAppStore.getInitialState().loadStoryboards,
      loadNotes: useAppStore.getInitialState().loadNotes,
    });
    useVersioningStore.setState({
      versions: [],
      timelines: [],
      isMerging: false,
      mergeSource: null,
      mergeTarget: null,
      mergeConflicts: [],
      draftlineMergeToken: null,
      draftlineMergeRemote: null,
      checkLargeFiles: useVersioningStore.getInitialState().checkLargeFiles,
      checkDirty: useVersioningStore.getInitialState().checkDirty,
      refreshChangedFiles: useVersioningStore.getInitialState().refreshChangedFiles,
      loadGraphData: useVersioningStore.getInitialState().loadGraphData,
      loadTimelines: useVersioningStore.getInitialState().loadTimelines,
      loadVersions: useVersioningStore.getInitialState().loadVersions,
    });
    useSyncStore.setState({
      sendForReviewPrompt: null,
      shareUrl: null,
      currentRemote: null,
      syncStatus: null,
      syncError: null,
      baseRename: null,
      baseStatus: null,
      incomingCommits: [],
      isSyncing: false,
      refreshIncomingCommits: useSyncStore.getInitialState().refreshIncomingCommits,
    });
    useToastStore.setState({ toasts: [] });
  });

  it("clears stale remote warnings after sync status refresh succeeds", async () => {
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: true });
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
      syncError: "git operation failed: remote authentication required but no callback set",
    });

    await useSyncStore.getState().refreshSyncStatus();

    expect(mockGetDraftlineSyncStatus).toHaveBeenCalledWith("origin");
    expect(useSyncStore.getState().syncStatus).toEqual({ ahead: 0, behind: 0 });
    expect(useSyncStore.getState().syncError).toBeNull();
  });

  it("preserves stale remote warnings when sync status refresh fails", async () => {
    const previousError = "git operation failed: remote authentication required but no callback set";
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: true });
    mockGetDraftlineSyncStatus.mockRejectedValueOnce(new Error("network unavailable"));
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: { ahead: 1, behind: 0 },
      syncError: previousError,
    });

    await useSyncStore.getState().refreshSyncStatus();

    expect(useSyncStore.getState().syncStatus).toBeNull();
    expect(useSyncStore.getState().syncError).toBe(previousError);
  });

  it("warns instead of refreshing status when a GitHub remote has no connected credential", async () => {
    mockListDraftlineRemotes.mockResolvedValueOnce([
      { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
    ]);
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: false });

    await useSyncStore.getState().detectRemote();

    expect(mockGetDraftlineSyncStatus).not.toHaveBeenCalled();
    expect(useSyncStore.getState().currentRemote).toEqual({
      name: "origin",
      url: "https://github.com/sethjuarez/cutready.git",
    });
    expect(useSyncStore.getState().syncStatus).toBeNull();
    expect(useSyncStore.getState().syncError).toBe(
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
      const firstDetection = useSyncStore.getState().detectRemote();
      await useSyncStore.getState().detectRemote();
      rejectStaleDetection(new Error("temporary remote lookup failure"));
      await firstDetection;

      expect(useSyncStore.getState().currentRemote).toEqual({
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
    useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 1, behind: 0 } });

    try {
      await useSyncStore.getState().detectRemote();

      expect(useSyncStore.getState().currentRemote).toEqual(remote);
      expect(useSyncStore.getState().syncStatus).toBeNull();
      expect(warn).toHaveBeenCalledWith("Failed to detect project remote:", expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not fetch a GitHub remote before the user connects GitHub", async () => {
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: false });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
      syncError: null,
    });

    await useSyncStore.getState().fetchFromRemote();

    expect(mockFetchDraftlineRemote).not.toHaveBeenCalled();
    expect(useSyncStore.getState().isSyncing).toBe(false);
    expect(useSyncStore.getState().syncError).toBe(
      "This project has a GitHub remote. Connect GitHub in Settings > Repository before syncing.",
    );
  });

  it("keeps automatic GitHub remote fetch guards silent until the user acts", async () => {
    mockGetGitHubAuthStatus.mockResolvedValueOnce({ connected: false });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
      syncError: null,
    });

    await useSyncStore.getState().fetchFromRemote({ notifyAuthRequired: false });

    expect(mockFetchDraftlineRemote).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useSyncStore.getState().syncError).toBe(
      "This project has a GitHub remote. Connect GitHub in Settings > Repository before syncing.",
    );
  });

  it("does not block sync status refresh when GitHub auth status cannot be checked", async () => {
    const previousStatus = { ahead: 1, behind: 0 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockGetGitHubAuthStatus.mockRejectedValueOnce(new Error("network unavailable"));
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 1 });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: previousStatus,
      syncError: null,
    });

    try {
      await useSyncStore.getState().refreshSyncStatus();

      expect(mockGetDraftlineSyncStatus).toHaveBeenCalledWith("origin");
      expect(useSyncStore.getState().syncStatus).toEqual({ ahead: 0, behind: 1 });
      expect(useSyncStore.getState().syncError).toBeNull();
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

  it("publishes multiple local snapshots as-is and refreshes state", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockPublishDraftlineChanges.mockResolvedValueOnce(undefined);
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    const checkDirty = vi.fn(async () => {});
    const refreshChangedFiles = vi.fn(async () => {});
    const loadGraphData = vi.fn(async () => {});
    const loadTimelines = vi.fn(async () => {});
    const loadVersions = vi.fn(async () => {});

    useVersioningStore.setState({
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 4, color_index: 0 }],
      checkLargeFiles: async () => [],
      checkDirty,
      refreshChangedFiles,
      loadGraphData,
      loadTimelines,
      loadVersions,
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: { ahead: 3, behind: 0 },
    });

    await useSyncStore.getState().pushToRemote();

    expect(mockPublishDraftlineChanges).toHaveBeenCalledTimes(1);
    expect(mockPublishDraftlineChanges).toHaveBeenCalledWith("origin");
    expect(checkDirty).toHaveBeenCalled();
    expect(refreshChangedFiles).toHaveBeenCalled();
    expect(loadGraphData).toHaveBeenCalled();
    expect(loadTimelines).toHaveBeenCalled();
    expect(loadVersions).toHaveBeenCalled();
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it("remembers a renamed remote base so the branch can be renamed to match", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockPublishDraftlineChanges.mockRejectedValueOnce({
      code: "base_renamed",
      message: "renamed",
      details: { from: "trunk", to: "main" },
    });
    useVersioningStore.setState({
      timelines: [{ name: "trunk", label: "trunk", is_active: true, snapshot_count: 2, color_index: 0 }],
      checkLargeFiles: async () => [],
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
    });

    await useSyncStore.getState().pushToRemote();

    expect(useSyncStore.getState().baseRename).toEqual({ from: "trunk", to: "main" });
    expect(useSyncStore.getState().syncError).toContain("renamed trunk to main");
  });

  it("prompts for a pull request title instead of pushing a hybrid project", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    const checkLargeFiles = vi.fn(async () => [] as Array<[string, number]>);
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
    });
    useVersioningStore.setState({
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 2, color_index: 0 }],
      versions: [{ id: "abc", message: "Tighten intro narration", timestamp: "", summary: "" }],
      checkLargeFiles,
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
    });

    await useSyncStore.getState().pushToRemote();

    expect(useSyncStore.getState().sendForReviewPrompt).toEqual({ defaultTitle: "Tighten intro narration", defaultBody: "" });
    expect(mockPublishDraftlineChanges).not.toHaveBeenCalled();
    expect(mockSendForReview).not.toHaveBeenCalled();
    expect(checkLargeFiles).not.toHaveBeenCalled();
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it("sends a hybrid project for review, links the pull request, and refreshes state", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    mockSendForReview.mockResolvedValueOnce({
      remote: "origin",
      variation: "cutready/main",
      base: "main",
      created_variation: true,
      published_versions: 2,
      pull_request: { number: 12, url: "https://github.com/contoso/app/pull/12" },
      created_pull_request: true,
    });
    const checkDirty = vi.fn(async () => {});
    const refreshChangedFiles = vi.fn(async () => {});
    const loadGraphData = vi.fn(async () => {});
    const loadTimelines = vi.fn(async () => {});
    const loadVersions = vi.fn(async () => {});
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
    });
    useVersioningStore.setState({
      checkLargeFiles: async () => [],
      checkDirty,
      refreshChangedFiles,
      loadGraphData,
      loadTimelines,
      loadVersions,
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
      sendForReviewPrompt: { defaultTitle: "Update cutready" },
    });

    await useSyncStore.getState().sendForReview("  Launch demo  ", "Please review");

    expect(mockSendForReview).toHaveBeenCalledWith({ remote: "origin", title: "Launch demo", body: "Please review" });
    expect(mockPublishDraftlineChanges).not.toHaveBeenCalled();
    expect(useSyncStore.getState().sendForReviewPrompt).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: "Pull request #12 opened for review.",
        type: "success",
        link: { label: "Open", url: "https://github.com/contoso/app/pull/12" },
      }),
    ]);
    expect(checkDirty).toHaveBeenCalled();
    expect(refreshChangedFiles).toHaveBeenCalled();
    expect(loadGraphData).toHaveBeenCalled();
    expect(loadTimelines).toHaveBeenCalled();
    expect(loadVersions).toHaveBeenCalled();
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it("blocks send for review when large files are pending", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
    });
    useVersioningStore.setState({
      checkLargeFiles: async () => [["screenshots/huge.png", 120 * 1024 * 1024]],
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
    });

    await useSyncStore.getState().sendForReview("Launch demo");

    expect(mockSendForReview).not.toHaveBeenCalled();
    expect(useSyncStore.getState().syncError).toBe(
      "Large files detected: screenshots/huge.png (120.0 MB). Remove or add to .gitignore before pushing.",
    );
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it("surfaces send-for-review failures as sync errors", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockSendForReview.mockRejectedValueOnce(new Error("pull request provider failed: GitHub returned 422"));
    const loadTimelines = vi.fn(async () => {});
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
    });
    useVersioningStore.setState({
      checkLargeFiles: async () => [],
      loadTimelines,
      checkDirty: async () => {},
      refreshChangedFiles: async () => {},
      loadGraphData: async () => {},
      loadVersions: async () => {},
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
    });

    await useSyncStore.getState().sendForReview("Launch demo");

    expect(useSyncStore.getState().syncError).toBe("pull request provider failed: GitHub returned 422");
    // Send may have switched branches before failing, so state is refreshed anyway.
    expect(loadTimelines).toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it("explains coded send-for-review failures in plain language", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockSendForReview.mockRejectedValueOnce({
      code: "send_outside_namespace",
      message: "branch `feature/login` is not a variation; switch to one or to the base branch to send",
    });
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
    });
    useVersioningStore.setState({
      checkLargeFiles: async () => [],
      loadTimelines: async () => {},
      checkDirty: async () => {},
      refreshChangedFiles: async () => {},
      loadGraphData: async () => {},
      loadVersions: async () => {},
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
    });

    await useSyncStore.getState().sendForReview("Launch demo");

    expect(useSyncStore.getState().syncError).toBe(SEND_OUTSIDE_NAMESPACE_MESSAGE);
  });

  it("routes a hybrid publishTimeline through the Send for review prompt", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
    });
    useVersioningStore.setState({
      timelines: [{ name: "cutready/intro", label: "intro", is_active: true, snapshot_count: 2, color_index: 0 }],
      versions: [{ id: "abc", message: "Tighten intro narration", timestamp: "", summary: "" }],
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
    });

    await useSyncStore.getState().publishTimeline();

    expect(mockPublishDraftlineChanges).not.toHaveBeenCalled();
    expect(useSyncStore.getState().sendForReviewPrompt).toEqual({ defaultTitle: "Tighten intro narration", defaultBody: "" });
  });

  it("routes a hybrid shareChanges through the Send for review prompt without a branch link", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
    });
    useVersioningStore.setState({
      timelines: [{ name: "cutready/intro", label: "intro", is_active: true, snapshot_count: 2, color_index: 0 }],
      versions: [{ id: "abc", message: "Tighten intro narration", timestamp: "", summary: "" }],
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
    });

    await useSyncStore.getState().shareChanges();

    expect(mockPublishDraftlineChanges).not.toHaveBeenCalled();
    expect(useSyncStore.getState().sendForReviewPrompt).toEqual({ defaultTitle: "Tighten intro narration", defaultBody: "" });
    expect(useSyncStore.getState().shareUrl).toBeNull();
  });

  it("publishes a standalone timeline directly", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockPublishDraftlineChanges.mockResolvedValueOnce(undefined);
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    useAppStore.setState({
      currentProject: { root: "D:\\demo", name: "demo", repo_root: "D:\\demo" },
    });
    useVersioningStore.setState({
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 2, color_index: 0 }],
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
    });

    await useSyncStore.getState().publishTimeline();

    expect(mockPublishDraftlineChanges).toHaveBeenCalledWith("origin");
    expect(useSyncStore.getState().sendForReviewPrompt).toBeNull();
  });

  it("explains a refused publish while Git holds the index", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockPublishDraftlineChanges.mockRejectedValueOnce({
      code: "git_index_locked",
      message: "Git is busy in this repository (.git/index.lock exists); try again when it finishes",
    });
    useAppStore.setState({
      currentProject: { root: "D:\\demo", name: "demo", repo_root: "D:\\demo" },
    });
    useVersioningStore.setState({
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 2, color_index: 0 }],
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
    });

    await useSyncStore.getState().publishTimeline();

    expect(useSyncStore.getState().syncError).toBe(GIT_INDEX_LOCKED_MESSAGE);
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it("does not repopulate sync status for a workspace that closed mid-refresh (#263)", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    let resolveStatus!: (status: { ahead: number; behind: number }) => void;
    mockGetDraftlineSyncStatus.mockReturnValueOnce(
      new Promise<{ ahead: number; behind: number }>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    useAppStore.setState({
      currentProject: { root: "D:\\ws\\alpha", repo_root: "D:\\ws\\alpha", name: "Alpha" },
    });
    useVersioningStore.setState({
      loadTimelines: async () => {},
      loadGraphData: async () => {},
      loadVersions: async () => {},
    });
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
    });

    const refresh = useSyncStore.getState().refreshSyncStatus();

    // The workspace closes while the sync request is still in flight.
    await useAppStore.getState().closeProject();
    // A sentinel a subsequent (empty-workspace) refresh would own; the stale
    // continuation must not clobber it.
    useSyncStore.setState({ syncStatus: { ahead: 9, behind: 9 } });

    resolveStatus({ ahead: 1, behind: 2 });
    await refresh;

    expect(useSyncStore.getState().syncStatus).toEqual({ ahead: 9, behind: 9 });
  });

  it("coalesces concurrent refreshes into one round-trip plus a single trailing rerun (#277)", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    const resolvers: Array<(status: { ahead: number; behind: number }) => void> = [];
    mockGetDraftlineSyncStatus.mockImplementation(
      () => new Promise<{ ahead: number; behind: number }>((resolve) => resolvers.push(resolve)),
    );
    useSyncStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
    });

    // Three handlers fire in the same tick — the in-flight guard is set
    // synchronously, so the latter two must join the first, not start their own.
    const refresh = useSyncStore.getState();
    const p1 = refresh.refreshSyncStatus();
    const p2 = refresh.refreshSyncStatus();
    const p3 = refresh.refreshSyncStatus();

    // Only one round-trip is in flight for all three callers.
    await vi.waitFor(() => expect(mockGetDraftlineSyncStatus).toHaveBeenCalledTimes(1));
    resolvers[0]({ ahead: 0, behind: 0 });

    // Because callers arrived mid-flight, exactly one trailing rerun follows.
    await vi.waitFor(() => expect(mockGetDraftlineSyncStatus).toHaveBeenCalledTimes(2));
    resolvers[1]({ ahead: 0, behind: 0 });

    await Promise.all([p1, p2, p3]);

    // 3 concurrent callers collapsed to 2 remote round-trips, not 3.
    expect(mockGetDraftlineSyncStatus).toHaveBeenCalledTimes(2);
  });

  describe("get updates from base (hybrid)", () => {
    const hybridProject = {
      root: "D:\\contoso-app\\cutready",
      name: "cutready",
      repo_root: "D:\\contoso-app\\cutready",
      git_root: "D:\\contoso-app",
      hybrid: true,
    };
    const remote = { name: "origin", url: "https://github.com/contoso/app.git" };
    const cleanReport = {
      dirtyFiles: [],
      conflicts: [],
      canMergeCleanly: true,
      syncStatus: { ahead: 1, behind: 2 },
      token: { source: "main" },
    };

    function stubRefresh() {
      const spies = {
        loadSketches: vi.fn(async () => {}),
        loadStoryboards: vi.fn(async () => {}),
        loadNotes: vi.fn(async () => {}),
        refreshIncomingCommits: vi.fn(async () => {}),
        loadVersions: vi.fn(async () => {}),
        loadGraphData: vi.fn(async () => {}),
        loadTimelines: vi.fn(async () => {}),
        checkDirty: vi.fn(async () => {}),
      };
      useAppStore.setState({
        loadSketches: spies.loadSketches,
        loadStoryboards: spies.loadStoryboards,
        loadNotes: spies.loadNotes,
      });
      useVersioningStore.setState({
        loadVersions: spies.loadVersions,
        loadGraphData: spies.loadGraphData,
        loadTimelines: spies.loadTimelines,
        checkDirty: spies.checkDirty,
      });
      useSyncStore.setState({ refreshIncomingCommits: spies.refreshIncomingCommits });
      return spies;
    }

    it("refreshes base status only for hybrid projects", async () => {
      mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
      mockGetDraftlineSyncStatus.mockResolvedValue({ ahead: 0, behind: 0 });
      mockGetDraftlineBaseStatus.mockResolvedValue({ ahead: 1, behind: 3, base: "main" });
      useAppStore.setState({
        currentProject: { root: "D:\\demo", name: "demo", repo_root: "D:\\demo", hybrid: false },
      });
      useSyncStore.setState({
        currentRemote: remote,
      });

      await useSyncStore.getState().refreshSyncStatus();
      expect(mockGetDraftlineBaseStatus).not.toHaveBeenCalled();
      expect(useSyncStore.getState().baseStatus).toBeNull();

      useAppStore.setState({ currentProject: hybridProject });
      await useSyncStore.getState().refreshSyncStatus();
      expect(mockGetDraftlineBaseStatus).toHaveBeenCalledWith("origin");
      expect(useSyncStore.getState().baseStatus).toEqual({ ahead: 1, behind: 3, base: "main" });
    });

    it("is a no-op for standalone projects", async () => {
      mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
      useAppStore.setState({
        currentProject: { root: "D:\\demo", name: "demo", repo_root: "D:\\demo", hybrid: false },
      });
      useSyncStore.setState({
        currentRemote: remote,
      });

      await useSyncStore.getState().getUpdatesFromBase();

      expect(mockPreflightDraftlineMergeBase).not.toHaveBeenCalled();
      expect(mockMergeDraftlineFromBase).not.toHaveBeenCalled();
    });

    it("merges a clean base update and refreshes state", async () => {
      mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
      mockGetDraftlineSyncStatus.mockResolvedValue({ ahead: 1, behind: 0 });
      mockGetDraftlineBaseStatus.mockResolvedValue({ ahead: 2, behind: 0, base: "main" });
      mockPreflightDraftlineMergeBase.mockResolvedValueOnce(cleanReport);
      mockMergeDraftlineFromBase.mockResolvedValueOnce("abc123");
      useAppStore.setState({
        currentProject: hybridProject,
      });
      useSyncStore.setState({
        currentRemote: remote,
        baseStatus: { ahead: 1, behind: 2, base: "main" },
      });
      const spies = stubRefresh();

      const update = useSyncStore.getState().getUpdatesFromBase();
      await vi.waitFor(() => expect(useMergeNameStore.getState().pending).not.toBeNull());
      expect(useMergeNameStore.getState().pending).toMatchObject({ source: "main", defaultName: "Merge updates from main" });
      expect(mockMergeDraftlineFromBase).not.toHaveBeenCalled();
      useMergeNameStore.getState().answer("Merge updates from main\n\nPicked up the new intro");
      await update;

      expect(mockPreflightDraftlineMergeBase).toHaveBeenCalledWith("origin");
      expect(mockMergeDraftlineFromBase).toHaveBeenCalledWith("origin", "Merge updates from main\n\nPicked up the new intro");
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ message: "Updates from main brought in.", type: "success" }),
      ]);
      for (const spy of Object.values(spies)) expect(spy).toHaveBeenCalled();
      expect(useSyncStore.getState().baseStatus).toEqual({ ahead: 2, behind: 0, base: "main" });
      expect(useSyncStore.getState().syncError).toBeNull();
      expect(useSyncStore.getState().isSyncing).toBe(false);
    });

    it("doesn't merge from base when naming the merge is cancelled", async () => {
      mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
      mockGetDraftlineSyncStatus.mockResolvedValue({ ahead: 1, behind: 0 });
      mockGetDraftlineBaseStatus.mockResolvedValue({ ahead: 1, behind: 2, base: "main" });
      mockPreflightDraftlineMergeBase.mockResolvedValueOnce(cleanReport);
      useAppStore.setState({ currentProject: hybridProject });
      useSyncStore.setState({ currentRemote: remote, baseStatus: { ahead: 1, behind: 2, base: "main" } });
      stubRefresh();

      const update = useSyncStore.getState().getUpdatesFromBase();
      await vi.waitFor(() => expect(useMergeNameStore.getState().pending).not.toBeNull());
      useMergeNameStore.getState().answer(null);
      await update;

      expect(mockMergeDraftlineFromBase).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toEqual([]);
      expect(useSyncStore.getState().syncError).toBeNull();
      expect(useSyncStore.getState().isSyncing).toBe(false);
    });

    it("keeps the developer-needed error visible after refreshing", async () => {
      mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
      mockGetDraftlineSyncStatus.mockResolvedValue({ ahead: 1, behind: 0 });
      mockGetDraftlineBaseStatus.mockResolvedValue({ ahead: 1, behind: 2, base: "main" });
      mockPreflightDraftlineMergeBase.mockRejectedValueOnce({
        code: "merge_needs_developer",
        message: "merge needs a developer: files outside the project conflict: [\"src/app.rs\"]",
      });
      useAppStore.setState({
        currentProject: hybridProject,
      });
      useSyncStore.setState({
        currentRemote: remote,
        baseStatus: { ahead: 1, behind: 2, base: "main" },
      });
      const spies = stubRefresh();

      await useSyncStore.getState().getUpdatesFromBase();

      expect(mockMergeDraftlineFromBase).not.toHaveBeenCalled();
      expect(mockGetDraftlineSyncStatus).toHaveBeenCalled();
      expect(spies.loadTimelines).toHaveBeenCalled();
      expect(spies.loadGraphData).toHaveBeenCalled();
      expect(useSyncStore.getState().syncError).toBe(mergeNeedsDeveloperMessage("main"));
      expect(useVersioningStore.getState().isMerging).toBe(false);
      expect(useSyncStore.getState().isSyncing).toBe(false);
    });

    it("routes in-folder base conflicts to the conflict panel", async () => {
      mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
      mockGetDraftlineSyncStatus.mockResolvedValue({ ahead: 1, behind: 0 });
      mockGetDraftlineBaseStatus.mockResolvedValue({ ahead: 1, behind: 2, base: "main" });
      const conflicts = [{ path: "intro.sk", file_type: "sketch", ours: "{}", theirs: "{}", ancestor: "{}", field_conflicts: [] }];
      mockPreflightDraftlineMergeBase.mockResolvedValueOnce({
        ...cleanReport,
        canMergeCleanly: false,
        conflicts,
      });
      useAppStore.setState({
        currentProject: hybridProject,
      });
      useSyncStore.setState({
        currentRemote: remote,
        baseStatus: { ahead: 1, behind: 2, base: "main" },
      });
      stubRefresh();

      await useSyncStore.getState().getUpdatesFromBase();

      expect(mockMergeDraftlineFromBase).not.toHaveBeenCalled();
      const state = useVersioningStore.getState();
      expect(state.isMerging).toBe(true);
      expect(state.mergeSource).toBe("main");
      expect(state.mergeConflicts).toEqual(conflicts);
      expect(state.draftlineMergeToken).toEqual({ source: "main" });
      expect(state.draftlineMergeRemote).toBe("origin");
      expect(useSyncStore.getState().syncError).toBeNull();
    });
  });
});