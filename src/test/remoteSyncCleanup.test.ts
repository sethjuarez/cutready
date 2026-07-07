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

import { useAppStore } from "../stores/appStore";
import type { DraftlinePendingHistoryCleanup } from "../services/draftlineVersioning";

const originalState = {
  fetchFromRemote: useAppStore.getState().fetchFromRemote,
  pullFromRemote: useAppStore.getState().pullFromRemote,
  pushToRemote: useAppStore.getState().pushToRemote,
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
    expect(useAppStore.getState().syncError).toContain("Publish or undo compacted history");
  });

  it("does not directly pull incoming saves while compacted history is pending", async () => {
    useAppStore.setState({
      currentRemote: { name: "origin", url: "file:///tmp/cutready.git" },
      pendingHistoryCleanup: pendingCleanup,
    });

    await useAppStore.getState().pullFromRemote();

    expect(mockPreflightDraftlineIncoming).not.toHaveBeenCalled();
    expect(useAppStore.getState().syncError).toContain("Publish or undo compacted history");
  });
});
