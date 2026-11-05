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

const runVersionOperation = vi.hoisted(() => vi.fn());
vi.mock("../services/identity", () => ({
  getContributorIdentity: () => Promise.resolve({ name: "Ada", email: "ada@example.com", source: "git" }),
}));
vi.mock("../services/versionOperation", () => ({
  runVersionOperation,
  isSaveBlocked: () => false,
}));

import { TimelineMenu } from "../components/versioning/TimelineMenu";
import { StatusChip } from "../components/versioning/StatusChip";
import { SendSection } from "../components/versioning/SendSection";
import { WindowControls } from "../components/WindowControls";
import { useAppStore } from "../stores/appStore";
import { useChangeSummaryStore } from "../stores/changeSummaryStore";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";
import type { ChangeSummary } from "../domain/changes";
import type { DiffEntry } from "../types/sketch";

const originalPush = useSyncStore.getState().pushToRemote;
const originalSync = useSyncStore.getState().syncWithRemote;
const originalReview = useSyncStore.getState().sendForReview;
const remote = { name: "origin", url: "https://github.com/example/repo.git" };
const changed = (path: string) => ({ path, status: "modified" }) as unknown as DiffEntry;
const emptySummary = { documents: [], totals: {} } as unknown as ChangeSummary;

function runWith(summary: ChangeSummary) {
  runVersionOperation.mockImplementation((_op: string, action: (s: ChangeSummary) => Promise<unknown>) => action(summary));
}

afterEach(() => {
  cleanup();
  runVersionOperation.mockReset();
  act(() => {
    useAppStore.setState({ currentProject: null });
    useVersioningStore.setState({ timelines: [], changedFiles: [], graphNodes: [], saving: false });
    useChangeSummaryStore.setState({ summary: null, saveFailure: null, popoverOpen: false });
    useSyncStore.setState({
      currentRemote: null,
      syncStatus: null,
      isSyncing: false,
      pushToRemote: originalPush,
      syncWithRemote: originalSync,
      sendForReview: originalReview,
    });
  });
});

describe("StatusChip", () => {
  it("shows the change count and toggles the popover state", () => {
    runWith(emptySummary);
    act(() => useVersioningStore.setState({ changedFiles: [changed("a.sk"), changed("b.md")] }));
    render(<StatusChip />);
    const chip = screen.getByTestId("titlebar-sync-status");
    expect(chip).toHaveTextContent("2 changes");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    expect(useChangeSummaryStore.getState().popoverOpen).toBe(true);
  });

  it("shows versions waiting to send when everything is saved", () => {
    act(() => useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 2, behind: 0 } }));
    render(<StatusChip />);
    expect(screen.getByTestId("titlebar-sync-status")).toHaveTextContent("2 to send");
  });

  it("retries the blocked action instead of opening when a save failed", () => {
    const retry = vi.fn(() => Promise.resolve());
    act(() => useChangeSummaryStore.setState({ saveFailure: { operation: "Send", message: "Couldn't save", retry } }));
    render(<StatusChip />);
    const chip = screen.getByTestId("titlebar-sync-status");
    expect(chip).toHaveTextContent("Couldn't save – Retry");
    fireEvent.click(chip);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(useChangeSummaryStore.getState().popoverOpen).toBe(false);
  });
});

describe("SendSection", () => {
  it("renders nothing without a remote", () => {
    const { container } = render(<SendSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is disabled and reads Up to date when there's nothing new", () => {
    act(() => useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 0, behind: 0 } }));
    render(<SendSection />);
    expect(screen.getByTestId("titlebar-send")).toBeDisabled();
    expect(screen.getByTestId("titlebar-send")).toHaveTextContent("Up to date");
  });

  it("sends saved versions through the operation boundary", async () => {
    runWith(emptySummary);
    const pushToRemote = vi.fn(() => Promise.resolve(true));
    act(() => useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 2, behind: 0 }, pushToRemote, fetchFromRemote: vi.fn(async () => undefined) }));
    render(<SendSection />);
    const send = screen.getByTestId("titlebar-send");
    expect(send).toHaveTextContent("Send 2 versions");
    await act(async () => fireEvent.click(send));
    expect(runVersionOperation).toHaveBeenCalledWith("Send", expect.any(Function));
    expect(pushToRemote).toHaveBeenCalledTimes(1);
  });

  it("syncs instead of pushing when the branch has diverged", async () => {
    runWith(emptySummary);
    const pushToRemote = vi.fn(() => Promise.resolve(true));
    const syncWithRemote = vi.fn(() => Promise.resolve());
    act(() => useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 1, behind: 1 }, pushToRemote, syncWithRemote }));
    render(<SendSection />);
    await act(async () => fireEvent.click(screen.getByTestId("titlebar-send")));
    expect(syncWithRemote).toHaveBeenCalledTimes(1);
    expect(pushToRemote).not.toHaveBeenCalled();
  });

  it("asks for a version first when there are unsaved changes", () => {
    act(() => {
      useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 0, behind: 0 } });
      useChangeSummaryStore.setState({ summary: { documents: [{ path: "a.sk" }], totals: {} } as unknown as ChangeSummary });
    });
    render(<SendSection />);
    fireEvent.click(screen.getByTestId("titlebar-send"));
    expect(screen.getByText("Save these changes as a version before sending.")).toBeInTheDocument();
    expect(screen.getByTestId("version-save")).toHaveTextContent("Save & send");
  });

  it("sends hybrid projects for review with the latest version name", async () => {
    runWith(emptySummary);
    const sendForReview = vi.fn(() => Promise.resolve(true));
    act(() => {
      useAppStore.setState({ currentProject: { hybrid: true } as never });
      useVersioningStore.setState({
        graphNodes: [{ id: "abc", message: "Tighten intro", timestamp: "", timeline: "main", parents: [], lane: 0, is_head: true }],
      });
      useSyncStore.setState({ currentRemote: remote, syncStatus: { ahead: 1, behind: 0 }, sendForReview, fetchFromRemote: vi.fn(async () => undefined) });
    });
    render(<SendSection />);
    expect(screen.getByTestId("titlebar-send")).toHaveTextContent("Send for review 1 version");
    await act(async () => fireEvent.click(screen.getByTestId("titlebar-send")));
    expect(sendForReview).toHaveBeenCalledWith("Tighten intro", undefined, 0);
  });
});
describe("TimelineMenu", () => {
  it("renders nothing without an active variation", () => {
    const { container } = render(<TimelineMenu />);
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
    render(<TimelineMenu />);
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
