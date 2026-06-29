import { afterEach, describe, expect, it, vi } from "vitest";

const mockGetDraftlineSyncStatus = vi.hoisted(() => vi.fn());

vi.mock("../services/draftlineVersioning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/draftlineVersioning")>();
  return {
    ...actual,
    getDraftlineSyncStatus: (...args: unknown[]) => mockGetDraftlineSyncStatus(...args),
  };
});

import { useAppStore } from "../stores/appStore";

describe("appStore remote sync status", () => {
  afterEach(() => {
    mockGetDraftlineSyncStatus.mockReset();
    useAppStore.setState({
      currentRemote: null,
      syncStatus: null,
      syncError: null,
    });
  });

  it("clears stale remote warnings after sync status refresh succeeds", async () => {
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
});
