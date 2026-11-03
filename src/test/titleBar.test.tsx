import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));

import { TitleBarSyncStatus, TitleBarVariationChip, sendAction, unsavedChangesLabel } from "../components/TitleBarStatus";
import { WindowControls } from "../components/WindowControls";
import { useAppStore } from "../stores/appStore";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";
import type { DiffEntry } from "../types/sketch";

const originalPush = useSyncStore.getState().pushToRemote;
const originalSync = useSyncStore.getState().syncWithRemote;
const originalSetView = useAppStore.getState().setView;
const remote = { name: "origin", url: "https://github.com/example/repo.git" };
const changed = (path: string) => ({ path, status: "modified" }) as unknown as DiffEntry;

afterEach(() => {
  cleanup();
  act(() => {
    useAppStore.setState({ currentProject: null, setView: originalSetView });
    useVersioningStore.setState({ timelines: [], changedFiles: [] });
    useSyncStore.setState({ currentRemote: null, syncStatus: null, isSyncing: false, pushToRemote: originalPush, syncWithRemote: originalSync });
  });
});

describe("unsavedChangesLabel", () => {
  it("pluralises the unsaved count", () => {
    expect(unsavedChangesLabel(0)).toBe("All changes saved");
    expect(unsavedChangesLabel(1)).toBe("1 unsaved change");
    expect(unsavedChangesLabel(4)).toBe("4 unsaved changes");
  });
});

describe("sendAction", () => {
  it("covers unknown, diverged, behind-only and idle states", () => {
    expect(sendAction(null, false, "Send")).toEqual({ kind: "disabled", title: "Checking sync status" });
    expect(sendAction({ ahead: 1, behind: 2 }, false, "Send")).toMatchObject({ kind: "sync" });
    expect(sendAction({ ahead: 0, behind: 2 }, false, "Send").kind).toBe("disabled");
    expect(sendAction({ ahead: 0, behind: 0 }, false, "Send").title).toBe("Nothing saved to send yet");
    expect(sendAction({ ahead: 3, behind: 0 }, true, "Send").kind).toBe("disabled");
  });
});

describe("TitleBarSyncStatus", () => {
  it("syncs instead of pushing when the branch has diverged", () => {
    const pushToRemote = vi.fn(() => Promise.resolve());
    const syncWithRemote = vi.fn(() => Promise.resolve());
    act(() =>
      useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 1, behind: 1 }, pushToRemote, syncWithRemote }),
    );
    render(<TitleBarSyncStatus />);
    fireEvent.click(screen.getByTestId("titlebar-send"));
    expect(syncWithRemote).toHaveBeenCalledTimes(1);
    expect(pushToRemote).not.toHaveBeenCalled();
  });

  it("disables Send while sync status is unknown", () => {
    act(() => useSyncStore.setState({ currentRemote: remote, syncStatus: null }));
    render(<TitleBarSyncStatus />);
    expect(screen.getByTestId("titlebar-send")).toBeDisabled();
    expect(screen.getByTestId("titlebar-send")).toHaveAccessibleName("Checking sync status");
  });

  it("shows the unsaved count and opens Changes", () => {
    const setView = vi.fn();
    act(() => {
      useAppStore.setState({ setView });
      useVersioningStore.setState({ changedFiles: [changed("a.sk"), changed("b.md")] });
    });
    render(<TitleBarSyncStatus />);
    const status = screen.getByTestId("titlebar-sync-status");
    expect(status).toHaveTextContent("2 unsaved changes");
    fireEvent.click(status);
    expect(setView).toHaveBeenCalledWith("changes");
  });

  it("hides Send without a remote", () => {
    render(<TitleBarSyncStatus />);
    expect(screen.queryByTestId("titlebar-send")).toBeNull();
  });

  it("disables Send when nothing saved is ahead of the remote", () => {
    act(() => useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 0, behind: 0 } }));
    render(<TitleBarSyncStatus />);
    expect(screen.getByTestId("titlebar-send")).toBeDisabled();
  });

  it("disables Send while syncing", () => {
    act(() => useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 2, behind: 0 }, isSyncing: true }));
    render(<TitleBarSyncStatus />);
    expect(screen.getByTestId("titlebar-send")).toBeDisabled();
  });

  it("sends saved changes through pushToRemote", () => {
    const pushToRemote = vi.fn(() => Promise.resolve());
    act(() => useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 2, behind: 0 }, pushToRemote }));
    render(<TitleBarSyncStatus />);
    const send = screen.getByTestId("titlebar-send");
    expect(send).toHaveAccessibleName("Send: share 2 saved changes");
    fireEvent.click(send);
    expect(pushToRemote).toHaveBeenCalledTimes(1);
  });

  it("labels Send for review in hybrid projects", () => {
    act(() => {
      useAppStore.setState({ currentProject: { hybrid: true } as never });
      useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 1, behind: 0 } });
    });
    render(<TitleBarSyncStatus />);
    expect(screen.getByTestId("titlebar-send")).toHaveTextContent("Send for review");
  });
});

describe("TitleBarVariationChip", () => {
  it("renders nothing without an active variation", () => {
    const { container } = render(<TitleBarVariationChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the active variation label", () => {
    act(() =>
      useVersioningStore.setState({
        timelines: [
          { name: "main", label: "main", is_active: false, snapshot_count: 1, color_index: 0 },
          { name: "cutready/alt", label: "Alt take", is_active: true, snapshot_count: 1, color_index: 1 },
        ],
      }),
    );
    render(<TitleBarVariationChip />);
    expect(screen.getByTestId("titlebar-variation")).toHaveTextContent("Alt take");
  });
});

describe("WindowControls", () => {
  it("exposes labelled caption buttons that reflect maximized state", () => {
    const onMaximize = vi.fn();
    const { rerender } = render(
      <WindowControls maximized={false} onMinimize={vi.fn()} onMaximize={onMaximize} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(onMaximize).toHaveBeenCalled();
    rerender(<WindowControls maximized onMinimize={vi.fn()} onMaximize={onMaximize} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
