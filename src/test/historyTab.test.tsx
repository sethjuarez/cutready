import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceGraph } from "@draftline/client";

const loadHistoryGraph = vi.fn();
vi.mock("../services/versionHistory", () => ({ loadHistoryGraph: () => loadHistoryGraph() }));
const loadVersionChangeSummary = vi.fn();
vi.mock("../services/versionChangeSummary", () => ({ loadVersionChangeSummary: (...args: unknown[]) => loadVersionChangeSummary(...args) }));
const loadWorkspaceChangeSummary = vi.fn();
vi.mock("../services/workspaceChangeSummary", () => ({ loadWorkspaceChangeSummary: () => loadWorkspaceChangeSummary() }));
vi.mock("../components/history/HistoryGraphView", () => ({
  default: ({ view }: { view: string }) => <div data-testid="graph-view">{view}</div>,
}));

import { HistoryTab } from "../components/history/HistoryTab";
import { useChangeSummaryStore } from "../stores/changeSummaryStore";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";
import { summarizeChanges } from "../domain/changes";

function version(id: string, label: string, parents: string[], comment?: string) {
  return {
    id,
    version: { id, label, author: { name: "Ada" }, saved_by: { name: "Ada" }, time_seconds: Date.now() / 1000, comment },
    parent_version_ids: parents,
    touches_folder: true,
    is_head: false,
    is_current: id === "b",
    is_merge: false,
    kind: "normal",
    reachable_from_remote_variation: id === "a",
  };
}

const graph = {
  current_version: "b",
  refs: [],
  nodes: [version("b", "Act 2 demos", ["a"], "Tightened intro\nmore"), version("a", "First draft", [])],
} as unknown as WorkspaceGraph;

describe("HistoryTab", () => {
  beforeEach(() => {
    loadHistoryGraph.mockReset().mockResolvedValue(graph);
    loadVersionChangeSummary.mockReset().mockResolvedValue(summarizeChanges([{ path: "intro.md", status: "added" }]));
    loadWorkspaceChangeSummary.mockReset().mockResolvedValue(summarizeChanges([{ path: "intro.sk", status: "modified" }]));
    useVersioningStore.setState({ isDirty: false } as never);
    useSyncStore.setState({ currentRemote: null } as never);
  });

  it("shows change chips against the first parent, skipping the root version", async () => {
    render(<HistoryTab />);
    const chips = await screen.findAllByTestId("history-entry-chips");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe("Documents: 1 added");
    expect(loadVersionChangeSummary).toHaveBeenCalledTimes(1);
    expect(loadVersionChangeSummary).toHaveBeenCalledWith("a", "b");
  });

  it("marks versions sent or not sent only when a remote is connected", async () => {
    const { unmount } = render(<HistoryTab />);
    await screen.findByText("First draft");
    expect(screen.queryByText("Sent")).toBeNull();
    unmount();
    useSyncStore.setState({ currentRemote: { name: "origin", url: "x" } } as never);
    render(<HistoryTab />);
    await screen.findByText("First draft");
    expect(screen.getByText("Not sent").closest("[data-version-id]")?.getAttribute("data-version-id")).toBe("b");
    expect(screen.getByText("Sent").closest("[data-version-id]")?.getAttribute("data-version-id")).toBe("a");
  });

  it("shows an Unsaved changes entry with chips that opens the save form", async () => {
    const openForSave = vi.fn();
    useChangeSummaryStore.setState({ openForSave } as never);
    useVersioningStore.setState({ isDirty: true } as never);
    render(<HistoryTab />);
    const entry = await screen.findByTestId("history-unsaved-entry");
    expect(await screen.findByText("1 sketch edited")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    expect(openForSave).toHaveBeenCalled();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search versions" }), { target: { value: "draft" } });
    expect(entry.isConnected).toBe(false);
  });

  it("lists versions newest first and opens a preview", async () => {
    const openSnapshotPreview = vi.fn();
    useVersioningStore.setState({ openSnapshotPreview } as never);
    render(<HistoryTab />);
    const first = await screen.findByRole("button", { name: /^Current version, preview:\s*Act 2 demos/ });
    expect(first.getAttribute("aria-current")).toBe("true");
    expect(screen.getAllByTestId("history-entry").map((el) => el.getAttribute("data-version-id"))).toEqual(["b", "a"]);
    expect(screen.getByText("Tightened intro")).toBeTruthy();
    fireEvent.click(first);
    expect(openSnapshotPreview).toHaveBeenCalledWith("b");
  });

  it("filters by search", async () => {
    render(<HistoryTab />);
    await screen.findByText("First draft");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search versions" }), { target: { value: "draft" } });
    expect(screen.queryByText("Act 2 demos")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search versions" }), { target: { value: "zzz" } });
    expect(screen.getByText(/No versions match/)).toBeTruthy();
  });

  it("switches to the lazy graph view, first-parent by default", async () => {
    render(<HistoryTab />);
    await screen.findByText("First draft");
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect((await screen.findByTestId("graph-view")).textContent).toBe("first-parent");
    fireEvent.click(screen.getByRole("checkbox", { name: "Show merged-in versions" }));
    expect(screen.getByTestId("graph-view").textContent).toBe("expanded");
  });

  it("shows the Unsaved changes entry before the first version is saved", async () => {
    loadHistoryGraph.mockResolvedValue({ ...graph, current_version: null, nodes: [] });
    useVersioningStore.setState({ isDirty: true } as never);
    render(<HistoryTab />);
    expect(await screen.findByTestId("history-unsaved-entry")).toBeTruthy();
    expect(screen.queryByText("No versions yet.")).toBeNull();
  });

  it("shows load errors", async () => {
    loadHistoryGraph.mockRejectedValue(new Error("boom"));
    render(<HistoryTab />);
    expect(await screen.findByText("Couldn't load history: boom")).toBeTruthy();
  });
});
