import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceGraph } from "@draftline/client";

const loadHistoryGraph = vi.fn();
const loadPathHistory = vi.fn();
vi.mock("../services/versionHistory", () => ({
  loadHistoryGraph: () => loadHistoryGraph(),
  loadPathHistory: (path: string) => loadPathHistory(path),
}));
const loadVersionChangeSummary = vi.fn();
vi.mock("../services/versionChangeSummary", () => ({ loadVersionChangeSummary: (...args: unknown[]) => loadVersionChangeSummary(...args) }));
const loadWorkspaceChangeSummary = vi.fn();
vi.mock("../services/workspaceChangeSummary", () => ({ loadWorkspaceChangeSummary: () => loadWorkspaceChangeSummary() }));
vi.mock("../components/history/HistoryGraphView", () => ({
  default: ({ view }: { view: string }) => <div data-testid="graph-view">{view}</div>,
}));

import { useToastStore } from "../stores/toastStore";
import { HistoryTab } from "../components/history/HistoryTab";
import { useChangeSummaryStore } from "../stores/changeSummaryStore";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";
import { useHistoryFilterStore } from "../stores/historyFilterStore";
import { summarizeChanges } from "../domain/changes";
import { parseCompareTabPath } from "../domain/compare/compareTarget";
import { useAppStore } from "../stores/appStore";

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
    useHistoryFilterStore.setState({ document: null });
    loadPathHistory.mockReset();
  });

  it("opens a Compare tab from an entry's menu", async () => {
    useAppStore.setState({ openTabs: [], activeTabId: null } as never);
    render(<HistoryTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for Act 2 demos" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Compare with previous/ }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for Act 2 demos" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Compare with now/ }));
    const targets = useAppStore.getState().openTabs.map((tab) => parseCompareTabPath(tab.path));
    expect(targets).toEqual([
      { from: "a", to: "b", fromLabel: "First draft", toLabel: "Act 2 demos", path: null, documentTitle: null },
      { from: "b", to: "workspace", fromLabel: "Act 2 demos", toLabel: "Now", path: null, documentTitle: null },
    ]);
  });

  it("opens an entry's actions menu to copy its ID and restore the document", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    loadPathHistory.mockResolvedValue({
      paths: ["intro.md"], has_more: false, next_cursor: null,
      entries: [{ entry: { version: { id: "a", label: "First draft", author: { name: "Ada" }, time_seconds: Date.now() / 1000 }, parent_ids: [], is_head: false }, files: [{ path: "intro.md", kind: "Added" }] }],
    });
    useHistoryFilterStore.setState({ document: { path: "intro.md", title: "Intro" } });
    render(<HistoryTab />);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for First draft" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy ID/ }));
    expect(writeText).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "Actions for First draft" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Restore Intro/ }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Intro");
  });

  it("moves focus into the restore dialog and anchors keyboard menus to the row", async () => {
    loadPathHistory.mockResolvedValue({
      paths: ["intro.md"], has_more: false, next_cursor: null,
      entries: [{ entry: { version: { id: "a", label: "First draft", author: { name: "Ada" }, time_seconds: Date.now() / 1000 }, parent_ids: [], is_head: false }, files: [{ path: "intro.md", kind: "Deleted" }] }],
    });
    useHistoryFilterStore.setState({ document: { path: "intro.md", title: "Intro" } });
    render(<HistoryTab />);
    const row = (await screen.findByText("First draft")).closest("li")!;
    fireEvent.contextMenu(row, { clientX: 0, clientY: 0 });
    const menu = screen.getByRole("menu");
    expect(menu.style.left).not.toBe("0px");
    fireEvent.click(screen.getByRole("menuitem", { name: /Restore Intro/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("reports a failed copy when the clipboard isn't available", async () => {
    Object.assign(navigator, { clipboard: undefined });
    const show = vi.spyOn(useToastStore.getState(), "show");
    render(<HistoryTab />);
    fireEvent.click(await screen.findByRole("button", { name: /Actions for Act 2 demos/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy ID/ }));
    expect(show).toHaveBeenCalledWith("Couldn't copy the version ID", 4000, "error");
  });

  it("filters the timeline to one document and clears back to the project", async () => {
    loadPathHistory.mockResolvedValue({
      paths: ["intro.md"], has_more: false, next_cursor: null,
      entries: [{ entry: { version: { id: "a", label: "First draft", author: { name: "Ada" }, time_seconds: Date.now() / 1000 }, parent_ids: [], is_head: false }, files: [] }],
    });
    useHistoryFilterStore.setState({ document: { path: "intro.md", title: "Intro" } });
    render(<HistoryTab />);
    await screen.findByText("First draft");
    expect(loadPathHistory).toHaveBeenCalledWith("intro.md");
    expect(screen.queryByText("Act 2 demos")).toBeNull();
    expect(screen.getByTestId("history-document-filter").textContent).toContain("Intro");
    fireEvent.click(screen.getByRole("button", { name: /whole project/ }));
    expect(await screen.findByText("Act 2 demos")).toBeTruthy();
    expect(screen.queryByTestId("history-document-filter")).toBeNull();
  });

  it("says a filtered document has no versions even while other documents are unsaved", async () => {
    loadPathHistory.mockResolvedValue({ paths: ["intro.md"], has_more: false, next_cursor: null, entries: [] });
    useVersioningStore.setState({ isDirty: true } as never);
    useHistoryFilterStore.setState({ document: { path: "intro.md", title: "Intro" } });
    render(<HistoryTab />);
    expect(await screen.findByText("No saved versions changed Intro yet.")).toBeTruthy();
  });

  it("scopes chips and the unsaved entry to the filtered document", async () => {
    loadPathHistory.mockResolvedValue({
      paths: ["intro.md"], has_more: false, next_cursor: null,
      entries: [{ entry: { version: { id: "b", label: "Act 2 demos", author: { name: "Ada" }, time_seconds: Date.now() / 1000 }, parent_ids: ["a"], is_head: false }, files: [] }],
    });
    useVersioningStore.setState({ isDirty: true } as never);
    useHistoryFilterStore.setState({ document: { path: "intro.md", title: "Intro" } });
    render(<HistoryTab />);
    await screen.findByTestId("history-entry-chips");
    expect(loadVersionChangeSummary).toHaveBeenCalledWith("a", "b", "intro.md");
    // The workspace's unsaved work only touches intro.sk, so the filtered timeline hides it.
    expect(screen.queryByTestId("history-unsaved-entry")).toBeNull();
  });

  it("shows change chips against the first parent, skipping the root version", async () => {
    render(<HistoryTab />);
    const chips = await screen.findAllByTestId("history-entry-chips");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe("Documents: 1 added");
    expect(loadVersionChangeSummary).toHaveBeenCalledTimes(1);
    expect(loadVersionChangeSummary).toHaveBeenCalledWith("a", "b", null);
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
