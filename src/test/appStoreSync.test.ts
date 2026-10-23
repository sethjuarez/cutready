import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetDraftlineSyncStatus = vi.hoisted(() => vi.fn());
const mockListDraftlineRemotes = vi.hoisted(() => vi.fn());
const mockFetchDraftlineRemote = vi.hoisted(() => vi.fn());
const mockPublishDraftlineChanges = vi.hoisted(() => vi.fn());
const mockSendForReview = vi.hoisted(() => vi.fn());
const mockGetGitHubAuthStatus = vi.hoisted(() => vi.fn());

vi.mock("../services/draftlineVersioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/draftlineVersioning")>();
  return {
    ...actual,
    fetchDraftlineRemote: (...args: unknown[]) => mockFetchDraftlineRemote(...args),
    getDraftlineSyncStatus: (...args: unknown[]) => mockGetDraftlineSyncStatus(...args),
    listDraftlineRemotes: (...args: unknown[]) => mockListDraftlineRemotes(...args),
    publishDraftlineChanges: (...args: unknown[]) => mockPublishDraftlineChanges(...args),
    sendForReview: (...args: unknown[]) => mockSendForReview(...args),
  };
});

vi.mock("../services/githubSetup", () => ({
  getGitHubAuthStatus: (...args: unknown[]) => mockGetGitHubAuthStatus(...args),
}));

import { remoteSyncErrorMessage, useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
describe("appStore remote sync status", () => {
  afterEach(() => {
    mockFetchDraftlineRemote.mockReset();
    mockGetGitHubAuthStatus.mockReset();
    mockGetDraftlineSyncStatus.mockReset();
    mockListDraftlineRemotes.mockReset();
    mockPublishDraftlineChanges.mockReset();
    mockSendForReview.mockReset();
    useAppStore.setState({
      currentProject: null,
      versions: [],
      sendForReviewPrompt: null,
      shareUrl: null,
      currentRemote: null,
      timelines: [],
      syncStatus: null,
      syncError: null,
      incomingCommits: [],
      isSyncing: false,
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

  it("publishes multiple local snapshots as-is and refreshes state", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockPublishDraftlineChanges.mockResolvedValueOnce(undefined);
    mockGetDraftlineSyncStatus.mockResolvedValueOnce({ ahead: 0, behind: 0 });
    const checkDirty = vi.fn(async () => {});
    const refreshChangedFiles = vi.fn(async () => {});
    const loadGraphData = vi.fn(async () => {});
    const loadTimelines = vi.fn(async () => {});
    const loadVersions = vi.fn(async () => {});

    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 4, color_index: 0 }],
      syncStatus: { ahead: 3, behind: 0 },
      checkLargeFiles: async () => [],
      checkDirty,
      refreshChangedFiles,
      loadGraphData,
      loadTimelines,
      loadVersions,
    });

    await useAppStore.getState().pushToRemote();

    expect(mockPublishDraftlineChanges).toHaveBeenCalledTimes(1);
    expect(mockPublishDraftlineChanges).toHaveBeenCalledWith("origin");
    expect(checkDirty).toHaveBeenCalled();
    expect(refreshChangedFiles).toHaveBeenCalled();
    expect(loadGraphData).toHaveBeenCalled();
    expect(loadTimelines).toHaveBeenCalled();
    expect(loadVersions).toHaveBeenCalled();
    expect(useAppStore.getState().isSyncing).toBe(false);
  });

  it("prompts for a pull request title instead of pushing a hybrid project", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    const checkLargeFiles = vi.fn(async () => [] as Array<[string, number]>);
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 2, color_index: 0 }],
      versions: [{ id: "abc", message: "Tighten intro narration", timestamp: "", summary: "" }],
      checkLargeFiles,
    });

    await useAppStore.getState().pushToRemote();

    expect(useAppStore.getState().sendForReviewPrompt).toEqual({ defaultTitle: "Tighten intro narration" });
    expect(mockPublishDraftlineChanges).not.toHaveBeenCalled();
    expect(mockSendForReview).not.toHaveBeenCalled();
    expect(checkLargeFiles).not.toHaveBeenCalled();
    expect(useAppStore.getState().isSyncing).toBe(false);
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
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
      sendForReviewPrompt: { defaultTitle: "Update cutready" },
      checkLargeFiles: async () => [],
      checkDirty,
      refreshChangedFiles,
      loadGraphData,
      loadTimelines,
      loadVersions,
    });

    await useAppStore.getState().sendForReview("  Launch demo  ", "Please review");

    expect(mockSendForReview).toHaveBeenCalledWith({ remote: "origin", title: "Launch demo", body: "Please review" });
    expect(mockPublishDraftlineChanges).not.toHaveBeenCalled();
    expect(useAppStore.getState().sendForReviewPrompt).toBeNull();
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
    expect(useAppStore.getState().isSyncing).toBe(false);
  });

  it("blocks send for review when large files are pending", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
      checkLargeFiles: async () => [["screenshots/huge.png", 120 * 1024 * 1024]],
    });

    await useAppStore.getState().sendForReview("Launch demo");

    expect(mockSendForReview).not.toHaveBeenCalled();
    expect(useAppStore.getState().syncError).toBe(
      "Large files detected: screenshots/huge.png (120.0 MB). Remove or add to .gitignore before pushing.",
    );
    expect(useAppStore.getState().isSyncing).toBe(false);
  });

  it("surfaces send-for-review failures as sync errors", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    mockSendForReview.mockRejectedValueOnce(new Error("pull request provider failed: GitHub returned 422"));
    const loadTimelines = vi.fn(async () => {});
    useAppStore.setState({
      currentProject: { root: "D:\\contoso-app\\cutready", name: "cutready", repo_root: "D:\\contoso-app\\cutready", hybrid: true },
      currentRemote: { name: "origin", url: "https://github.com/contoso/app.git" },
      checkLargeFiles: async () => [],
      loadTimelines,
      checkDirty: async () => {},
      refreshChangedFiles: async () => {},
      loadGraphData: async () => {},
      loadVersions: async () => {},
    });

    await useAppStore.getState().sendForReview("Launch demo");

    expect(useAppStore.getState().syncError).toBe("pull request provider failed: GitHub returned 422");
    // Send may have switched branches before failing, so state is refreshed anyway.
    expect(loadTimelines).toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(useAppStore.getState().isSyncing).toBe(false);
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
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
      loadTimelines: async () => {},
      loadGraphData: async () => {},
      loadVersions: async () => {},
    });

    const refresh = useAppStore.getState().refreshSyncStatus();

    // The workspace closes while the sync request is still in flight.
    useAppStore.getState().closeProject();
    // A sentinel a subsequent (empty-workspace) refresh would own; the stale
    // continuation must not clobber it.
    useAppStore.setState({ syncStatus: { ahead: 9, behind: 9 } });

    resolveStatus({ ahead: 1, behind: 2 });
    await refresh;

    expect(useAppStore.getState().syncStatus).toEqual({ ahead: 9, behind: 9 });
  });

  it("coalesces concurrent refreshes into one round-trip plus a single trailing rerun (#277)", async () => {
    mockGetGitHubAuthStatus.mockResolvedValue({ connected: true });
    const resolvers: Array<(status: { ahead: number; behind: number }) => void> = [];
    mockGetDraftlineSyncStatus.mockImplementation(
      () => new Promise<{ ahead: number; behind: number }>((resolve) => resolvers.push(resolve)),
    );
    useAppStore.setState({
      currentRemote: { name: "origin", url: "https://github.com/sethjuarez/cutready.git" },
      syncStatus: null,
    });

    // Three handlers fire in the same tick — the in-flight guard is set
    // synchronously, so the latter two must join the first, not start their own.
    const refresh = useAppStore.getState();
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
});
