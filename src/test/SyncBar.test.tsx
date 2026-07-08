import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("../services/tauri", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  listen: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({ settings: { repoRemoteUrl: "" } }),
}));

import { SyncBar } from "../components/SyncBar";
import { useAppStore } from "../stores/appStore";
import type { DraftlinePendingHistoryCleanup } from "../services/draftlineVersioning";

const originalState = {
  detectRemote: useAppStore.getState().detectRemote,
  fetchFromRemote: useAppStore.getState().fetchFromRemote,
  pullFromRemote: useAppStore.getState().pullFromRemote,
  pushToRemote: useAppStore.getState().pushToRemote,
  syncWithRemote: useAppStore.getState().syncWithRemote,
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

describe("SyncBar", () => {
  afterEach(() => {
    cleanup();
    mockInvoke.mockReset();
    act(() => {
      useAppStore.setState({
        ...originalState,
        currentRemote: null,
        syncStatus: null,
        syncError: null,
        timelines: [],
        isSyncing: false,
        lastHistoryCleanup: null,
        pendingHistoryCleanup: null,
      });
    });
  });

  it("publishes pending milestone history instead of normal syncing when local and remote histories diverge", async () => {
    const pushToRemote = vi.fn(() => Promise.resolve());
    const pullFromRemote = vi.fn(() => Promise.resolve());
    const syncWithRemote = vi.fn(() => Promise.resolve());

    act(() => {
      useAppStore.setState({
        currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
        syncStatus: { ahead: 39, behind: 37 },
        timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
        pendingHistoryCleanup: pendingCleanup,
        detectRemote: vi.fn(() => Promise.resolve()),
        fetchFromRemote: vi.fn(() => Promise.resolve()),
        pushToRemote,
        pullFromRemote,
        syncWithRemote,
      });
    });

    render(<SyncBar variant="compact" />);

    const sendButton = screen.getByRole("button", { name: /publish milestone history/i });
    expect(sendButton).toHaveTextContent("Send");

    await act(async () => {
      fireEvent.click(sendButton);
    });

    expect(pushToRemote).toHaveBeenCalledTimes(1);
    expect(pullFromRemote).not.toHaveBeenCalled();
    expect(syncWithRemote).not.toHaveBeenCalled();
  });

  it("shows GitHub sign-in guidance for remote auth failures", () => {
    act(() => {
      useAppStore.setState({
        currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
        syncStatus: { ahead: 1, behind: 0 },
        syncError: "GitHub rejected the remote operation. Reconnect GitHub in Settings, then try again.",
        timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
        detectRemote: vi.fn(() => Promise.resolve()),
        fetchFromRemote: vi.fn(() => Promise.resolve()),
      });
    });

    render(<SyncBar />);

    expect(screen.getByText("GitHub sign-in required — reconnect in Settings")).toBeInTheDocument();
  });
});
