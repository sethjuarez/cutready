import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetDraftlineSyncStatus = vi.hoisted(() => vi.fn());
const mockListDraftlineRemotes = vi.hoisted(() => vi.fn());
const mockFetchDraftlineRemote = vi.hoisted(() => vi.fn());
const mockListDraftlinePendingSnapshotCleanups = vi.hoisted(() => vi.fn());
const mockGetGitHubAuthStatus = vi.hoisted(() => vi.fn());

vi.mock("../services/draftlineVersioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/draftlineVersioning")>();
  return {
    ...actual,
    fetchDraftlineRemote: (...args: unknown[]) => mockFetchDraftlineRemote(...args),
    getDraftlineSyncStatus: (...args: unknown[]) => mockGetDraftlineSyncStatus(...args),
    listDraftlineRemotes: (...args: unknown[]) => mockListDraftlineRemotes(...args),
    listDraftlinePendingSnapshotCleanups: (...args: unknown[]) => mockListDraftlinePendingSnapshotCleanups(...args),
  };
});

vi.mock("../services/githubSetup", () => ({
  getGitHubAuthStatus: (...args: unknown[]) => mockGetGitHubAuthStatus(...args),
}));

import { remoteSyncErrorMessage, useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";

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
    useAppStore.setState({
      currentRemote: null,
      timelines: [],
      syncStatus: null,
      syncError: null,
      incomingCommits: [],
      isSyncing: false,
      pendingHistoryCleanup: null,
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
    expect(useAppStore.getState().syncError).toContain("Publish or undo compacted history");
  });
});
