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

const originalState = {
  detectRemote: useAppStore.getState().detectRemote,
  fetchFromRemote: useAppStore.getState().fetchFromRemote,
  pullFromRemote: useAppStore.getState().pullFromRemote,
  pushToRemote: useAppStore.getState().pushToRemote,
  syncWithRemote: useAppStore.getState().syncWithRemote,
};

const originalGetUpdatesFromBase = useAppStore.getState().getUpdatesFromBase;

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
        baseStatus: null,
        currentProject: null,
        getUpdatesFromBase: originalGetUpdatesFromBase,
        timelines: [],
        isSyncing: false,
      });
    });
  });

  it("sends local snapshots as a plain push when only ahead of the remote", async () => {
    const pushToRemote = vi.fn(() => Promise.resolve());
    const pullFromRemote = vi.fn(() => Promise.resolve());
    const syncWithRemote = vi.fn(() => Promise.resolve());

    act(() => {
      useAppStore.setState({
        currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
        syncStatus: { ahead: 3, behind: 0 },
        timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
        detectRemote: vi.fn(() => Promise.resolve()),
        fetchFromRemote: vi.fn(() => Promise.resolve()),
        pushToRemote,
        pullFromRemote,
        syncWithRemote,
      });
    });

    render(<SyncBar variant="compact" />);

    const sendButton = screen.getByRole("button", { name: /share changes/i });
    expect(sendButton).toHaveTextContent("Send");

    await act(async () => {
      fireEvent.click(sendButton);
    });

    expect(pushToRemote).toHaveBeenCalledTimes(1);
    expect(pullFromRemote).not.toHaveBeenCalled();
    expect(syncWithRemote).not.toHaveBeenCalled();
  });

  it("hides the primary action when sync status is unavailable", () => {
    act(() => {
      useAppStore.setState({
        currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
        syncStatus: null,
        timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
        detectRemote: vi.fn(() => Promise.resolve()),
        fetchFromRemote: vi.fn(() => Promise.resolve()),
      });
    });

    render(<SyncBar variant="compact" />);

    expect(screen.queryByRole("button", { name: /share changes/i })).not.toBeInTheDocument();
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

  it("offers updates from the base branch for hybrid projects behind their base", async () => {
    const getUpdatesFromBase = vi.fn(() => Promise.resolve());
    act(() => {
      useAppStore.setState({
        currentProject: { root: "D:\\app\\cutready", name: "cutready", repo_root: "D:\\app\\cutready", hybrid: true },
        currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
        syncStatus: { ahead: 0, behind: 0 },
        baseStatus: { ahead: 1, behind: 2, base: "main" },
        timelines: [{ name: "cutready/launch", label: "cutready/launch", is_active: true, snapshot_count: 1, color_index: 0 }],
        detectRemote: vi.fn(() => Promise.resolve()),
        fetchFromRemote: vi.fn(() => Promise.resolve()),
        getUpdatesFromBase,
      });
    });

    render(<SyncBar variant="compact" />);

    const button = screen.getByRole("button", { name: /get updates from main/i });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(getUpdatesFromBase).toHaveBeenCalledTimes(1);
  });

  it("does not offer base updates for standalone projects", () => {
    act(() => {
      useAppStore.setState({
        currentProject: { root: "D:\\demo", name: "demo", repo_root: "D:\\demo", hybrid: false },
        currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
        syncStatus: { ahead: 0, behind: 0 },
        baseStatus: { ahead: 0, behind: 5, base: "main" },
        timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
        detectRemote: vi.fn(() => Promise.resolve()),
        fetchFromRemote: vi.fn(() => Promise.resolve()),
      });
    });

    render(<SyncBar />);

    expect(screen.queryByRole("button", { name: /get updates from main/i })).not.toBeInTheDocument();
  });

  it("labels the hybrid primary action as Send for review", async () => {
    const pushToRemote = vi.fn(() => Promise.resolve());
    act(() => {
      useAppStore.setState({
        currentProject: { root: "D:\\app\\cutready", name: "cutready", repo_root: "D:\\app\\cutready", hybrid: true },
        currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
        syncStatus: { ahead: 2, behind: 0 },
        timelines: [{ name: "cutready/launch", label: "cutready/launch", is_active: true, snapshot_count: 1, color_index: 0 }],
        detectRemote: vi.fn(() => Promise.resolve()),
        fetchFromRemote: vi.fn(() => Promise.resolve()),
        pushToRemote,
      });
    });

    render(<SyncBar />);

    const button = screen.getByRole("button", { name: /send for review/i });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(pushToRemote).toHaveBeenCalledTimes(1);
  });

  it("shows plain-language Draftline guidance as-is even when it mentions a GitHub path", () => {
    const message = "An interrupted change has to be finished in the other folder that started it (D:\\github\\deck). Open that folder in CutReady to finish it, then try again.";
    act(() => {
      useAppStore.setState({
        currentRemote: { name: "origin", url: "https://github.com/example/repo.git" },
        syncStatus: { ahead: 1, behind: 0 },
        syncError: message,
        timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
        detectRemote: vi.fn(() => Promise.resolve()),
        fetchFromRemote: vi.fn(() => Promise.resolve()),
      });
    });

    render(<SyncBar />);

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText("GitHub sign-in required — reconnect in Settings")).not.toBeInTheDocument();
  });
});