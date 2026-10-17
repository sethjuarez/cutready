import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockPreflightDraftlineIncoming = vi.hoisted(() => vi.fn());

vi.mock("../services/tauri", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  listen: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));

vi.mock("../services/draftlineVersioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/draftlineVersioning")>();
  return {
    ...actual,
    preflightDraftlineIncoming: (...args: unknown[]) => mockPreflightDraftlineIncoming(...args),
  };
});

import {
  HISTORY_CLEANUP_BUSY_MESSAGE,
  PENDING_CLEANUP_STALE_MESSAGE,
  SYNC_IN_PROGRESS_MESSAGE,
  useAppStore,
} from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { setDraftlineWorkspacePath, type DraftlinePendingHistoryCleanup } from "../services/draftlineVersioning";

const originalState = {
  fetchFromRemote: useAppStore.getState().fetchFromRemote,
  pullFromRemote: useAppStore.getState().pullFromRemote,
  pushToRemote: useAppStore.getState().pushToRemote,
  checkLargeFiles: useAppStore.getState().checkLargeFiles,
  publishSnapshotCleanup: useAppStore.getState().publishSnapshotCleanup,
  refreshSyncStatus: useAppStore.getState().refreshSyncStatus,
  refreshIncomingCommits: useAppStore.getState().refreshIncomingCommits,
  loadGraphData: useAppStore.getState().loadGraphData,
  loadTimelines: useAppStore.getState().loadTimelines,
  loadVersions: useAppStore.getState().loadVersions,
};

const pendingCleanup = {
  plan_id: "op-1",
  target_variation: "main",
  expected_local_head: "old-head",
  replacement_head: "new-head",
  backup_refs: [],
  ref_updates: [],
  publish_status: "shared_history_rewrite_required",
} satisfies DraftlinePendingHistoryCleanup;

describe("remote sync with pending history cleanup", () => {
  afterEach(() => {
    mockInvoke.mockReset();
    mockPreflightDraftlineIncoming.mockReset();
    useToastStore.setState({ toasts: [] });
    useAppStore.setState({
      ...originalState,
      currentRemote: null,
      timelines: [],
      syncStatus: null,
      isSyncing: false,
      syncError: null,
      lastHistoryCleanup: null,
      pendingHistoryCleanup: null,
    });
  });

  it("does not pull incoming saves after local compaction because that invalidates cleanup publishing", async () => {
    const pullFromRemote = vi.fn(() => Promise.resolve());
    const pushToRemote = vi.fn(() => Promise.resolve());

    useAppStore.setState({
      pendingHistoryCleanup: pendingCleanup,
      syncStatus: { ahead: 36, behind: 11 },
      fetchFromRemote: async () => {
        useAppStore.setState({ syncStatus: { ahead: 36, behind: 11 } });
      },
      pullFromRemote,
      pushToRemote,
    });

    await useAppStore.getState().syncWithRemote();

    expect(pullFromRemote).not.toHaveBeenCalled();
    expect(pushToRemote).not.toHaveBeenCalled();
    expect(useAppStore.getState().syncError).toContain("Publish or undo milestone history");
  });

  it("does not directly pull incoming saves while milestone history is pending", async () => {
    useAppStore.setState({
      currentRemote: { name: "origin", url: "file:///tmp/cutready.git" },
      pendingHistoryCleanup: pendingCleanup,
    });

    await useAppStore.getState().pullFromRemote();

    expect(mockPreflightDraftlineIncoming).not.toHaveBeenCalled();
    expect(useAppStore.getState().syncError).toContain("Publish or undo milestone history");
  });

  it("points to Stop sharing when a save after compaction makes the pending publish stale", async () => {
    const publishSnapshotCleanup = vi.fn(() =>
      Promise.reject({ code: "local_state_changed", message: "local state changed", details: null }),
    );
    useAppStore.setState({
      currentRemote: { name: "origin", url: "file:///tmp/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
      pendingHistoryCleanup: pendingCleanup,
      checkLargeFiles: vi.fn(() => Promise.resolve([])),
      publishSnapshotCleanup,
    });

    await useAppStore.getState().pushToRemote();

    expect(publishSnapshotCleanup).toHaveBeenCalledWith("op-1", "origin");
    expect(useAppStore.getState().syncError).toBe(PENDING_CLEANUP_STALE_MESSAGE);
    expect(useAppStore.getState().isSyncing).toBe(false);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({ message: PENDING_CLEANUP_STALE_MESSAGE, type: "warning" }),
    );
  });

  it("refuses to abandon a pending cleanup while a sync could be publishing it", async () => {
    useAppStore.setState({ pendingHistoryCleanup: pendingCleanup, isSyncing: true });

    await expect(useAppStore.getState().abandonSnapshotCleanup("op-1")).rejects.toThrow(SYNC_IN_PROGRESS_MESSAGE);

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingHistoryCleanup).toEqual(pendingCleanup);
  });

  it("does not start or clear a push when another sync claimed isSyncing during the credential check", async () => {
    const publishSnapshotCleanup = vi.fn(() => Promise.resolve(null));
    useAppStore.setState({
      currentRemote: { name: "origin", url: "file:///tmp/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
      pendingHistoryCleanup: pendingCleanup,
      isSyncing: true,
      publishSnapshotCleanup,
    });

    await useAppStore.getState().pushToRemote();

    expect(publishSnapshotCleanup).not.toHaveBeenCalled();
    expect(useAppStore.getState().isSyncing).toBe(true);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({ message: SYNC_IN_PROGRESS_MESSAGE, type: "info" }),
    );
  });

  it("tells the user when push loses the milestone history lock to another operation", async () => {
    const publishSnapshotCleanup = vi.fn(() => Promise.reject(new Error(HISTORY_CLEANUP_BUSY_MESSAGE)));
    useAppStore.setState({
      currentRemote: { name: "origin", url: "file:///tmp/cutready.git" },
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
      pendingHistoryCleanup: pendingCleanup,
      checkLargeFiles: vi.fn(() => Promise.resolve([])),
      publishSnapshotCleanup,
    });

    await useAppStore.getState().pushToRemote();

    expect(useAppStore.getState().syncError).toBe(HISTORY_CLEANUP_BUSY_MESSAGE);
    expect(useAppStore.getState().isSyncing).toBe(false);
    expect(useToastStore.getState().toasts).toContainEqual(
      expect.objectContaining({ message: HISTORY_CLEANUP_BUSY_MESSAGE, type: "warning" }),
    );
  });

  it("refuses to abandon while the pending cleanup publish is in flight, even before isSyncing is set", async () => {
    setDraftlineWorkspacePath("D:\\project");
    let finishPublish!: (value: unknown) => void;
    mockInvoke.mockImplementation(() => new Promise((resolve) => { finishPublish = resolve; }));
    useAppStore.setState({
      pendingHistoryCleanup: pendingCleanup,
      isSyncing: false,
      refreshSyncStatus: vi.fn(() => Promise.resolve()),
      refreshIncomingCommits: vi.fn(() => Promise.resolve()),
      loadGraphData: vi.fn(() => Promise.resolve()),
      loadTimelines: vi.fn(() => Promise.resolve()),
      loadVersions: vi.fn(() => Promise.resolve()),
    });

    try {
      const publishing = useAppStore.getState().publishSnapshotCleanup("op-1", "origin");

      await expect(useAppStore.getState().abandonSnapshotCleanup("op-1")).rejects.toThrow(HISTORY_CLEANUP_BUSY_MESSAGE);
      expect(mockInvoke).not.toHaveBeenCalledWith("abandon_pending_history_cleanup", expect.anything());

      finishPublish({});
      await publishing;
    } finally {
      setDraftlineWorkspacePath(null);
    }
  });

  it("abandons a pending cleanup and refreshes sync state without moving snapshots", async () => {
    setDraftlineWorkspacePath("D:\\project");
    mockInvoke.mockImplementation((command: string) => {
      if (command === "abandon_pending_history_cleanup") return Promise.resolve(pendingCleanup);
      if (command === "list_pending_history_cleanups") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
    const refreshSyncStatus = vi.fn(() => Promise.resolve());
    const refreshIncomingCommits = vi.fn(() => Promise.resolve());
    const loadGraphData = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      pendingHistoryCleanup: pendingCleanup,
      refreshSyncStatus,
      refreshIncomingCommits,
      loadGraphData,
    });

    try {
      await useAppStore.getState().abandonSnapshotCleanup("op-1");
    } finally {
      setDraftlineWorkspacePath(null);
    }

    expect(mockInvoke).toHaveBeenCalledWith("abandon_pending_history_cleanup", {
      request: { workspace_path: "D:\\project", plan_id: "op-1" },
    });
    expect(useAppStore.getState().pendingHistoryCleanup).toBeNull();
    expect(useAppStore.getState().isSyncing).toBe(false);
    expect(refreshSyncStatus).toHaveBeenCalled();
    expect(refreshIncomingCommits).toHaveBeenCalled();
    expect(loadGraphData).toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("undo_pending_history_cleanup", expect.anything());
  });
});
