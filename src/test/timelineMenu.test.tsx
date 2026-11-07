import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
  listen: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
  emitTo: vi.fn(),
  convertFileSrc: vi.fn((path: string) => path),
  Channel: class {},
}));

let settled: Promise<void> = Promise.resolve();
vi.mock("../services/versionOperation", () => ({
  isSaveBlocked: () => false,
  runVersionOperation: async (_operation: string, action: (summary: unknown) => Promise<unknown>) => {
    await settled;
    return action({ documents: [], totals: {} });
  },
}));

import { PreActionHost } from "../components/versioning/PreActionDialog";
import { TimelineMenu } from "../components/versioning/TimelineMenu";
import { usePreActionStore } from "../stores/preActionStore";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";
import type { TimelineInfo } from "../types/sketch";

const original = useVersioningStore.getState();
const timeline = (name: string, active = false): TimelineInfo =>
  ({ name, label: name, is_active: active, snapshot_count: 1, color_index: 0 });

function setup(isDirty: boolean) {
  const switchTimeline = vi.fn(() => Promise.resolve());
  const stashChanges = vi.fn((_name?: string) => Promise.resolve(true));
  const saveVersion = vi.fn(() => Promise.resolve());
  act(() => {
    useSyncStore.setState({ currentRemote: null });
    useVersioningStore.setState({
      timelines: [timeline("main", true), timeline("alt")],
      graphNodes: [],
      isDirty,
      setAsideShelves: [],
      startedBranchFromSnapshot: null,
      switchTimeline,
      stashChanges,
      saveVersion,
    });
  });
  render(<><TimelineMenu /><PreActionHost /></>);
  fireEvent.click(screen.getByTestId("titlebar-variation"));
  return { switchTimeline, stashChanges, saveVersion };
}

afterEach(() => {
  settled = Promise.resolve();
  cleanup();
  act(() => {
    useVersioningStore.setState(original, true);
    usePreActionStore.setState({ pending: null });
  });
});

describe("TimelineMenu", () => {
  it("switches straight away when everything is saved", async () => {
    const { switchTimeline } = setup(false);
    expect(screen.getByTestId("timeline-menu")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch to timeline alt" })));
    expect(switchTimeline).toHaveBeenCalledWith("alt");
    expect(screen.queryByTestId("timeline-menu")).toBeNull();
  });

  it("asks before switching with unsaved changes and can set them aside", async () => {
    const { switchTimeline, stashChanges } = setup(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch to timeline alt" })));
    expect(switchTimeline).not.toHaveBeenCalled();
    expect(screen.getByText("Save your changes first?")).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Set aside & continue" })));
    expect(stashChanges).toHaveBeenCalledTimes(1);
    expect(switchTimeline).toHaveBeenCalledWith("alt");
  });

  it("saves a version first and switches after it", async () => {
    const { switchTimeline, saveVersion } = setup(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch to timeline alt" })));
    expect(screen.queryByText(/discard/i)).toBeNull();
    fireEvent.change(screen.getByTestId("version-name-input"), { target: { value: "Before alt" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save version & continue" })));
    expect(saveVersion).toHaveBeenCalledWith("Before alt");
    expect(switchTimeline).toHaveBeenCalledWith("alt");
    expect(screen.queryByTestId("pre-action-dialog")).toBeNull();
  });

  it("keeps the version and offers to try again when the switch fails", async () => {
    const { switchTimeline, saveVersion } = setup(true);
    switchTimeline.mockRejectedValueOnce(new Error("Timeline is locked"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch to timeline alt" })));
    fireEvent.change(screen.getByTestId("version-name-input"), { target: { value: "Before alt" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save version & continue" })));
    expect(saveVersion).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Your changes are safe. Timeline is locked");
    await act(async () => fireEvent.click(screen.getByTestId("pre-action-retry")));
    expect(saveVersion).toHaveBeenCalledTimes(1);
    expect(switchTimeline).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("pre-action-dialog")).toBeNull();
  });

  it("sets aside again while other set-aside work is waiting, named for the switch", async () => {
    const { switchTimeline, stashChanges } = setup(true);
    act(() => useVersioningStore.setState({ setAsideShelves: [{ id: "cutready-stash", name: "Set-aside changes", timeMs: 0 }] }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch to timeline alt" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Set aside & continue" })));
    expect(stashChanges).toHaveBeenCalledWith(expect.stringMatching(/^Before .*alt/));
    expect(switchTimeline).toHaveBeenCalledWith("alt");
  });

  it("doesn't switch until open edits are written", async () => {
    let release!: () => void;
    settled = new Promise((resolve) => { release = resolve; });
    const { switchTimeline } = setup(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch to timeline alt" })));
    expect(switchTimeline).not.toHaveBeenCalled();
    await act(async () => { release(); await settled; });
    expect(switchTimeline).toHaveBeenCalledWith("alt");
  });

  it("filters the list and never offers to delete the current timeline", () => {
    setup(false);
    expect(screen.queryByRole("button", { name: "Delete timeline main" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete timeline alt" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter timelines"), { target: { value: "zzz" } });
    expect(screen.getByText('No timelines match "zzz"')).toBeInTheDocument();
  });
});
