import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { WorkspaceGraph } from "@draftline/client";

const loadHistoryGraph = vi.fn();
vi.mock("../services/versionHistory", () => ({ loadHistoryGraph: () => loadHistoryGraph() }));
vi.mock("../components/history/HistoryGraphView", () => ({
  default: ({ view }: { view: string }) => <div data-testid="graph-view">{view}</div>,
}));

import { HistoryTab } from "../components/history/HistoryTab";
import { useVersioningStore } from "../stores/versioningStore";

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

  it("shows load errors", async () => {
    loadHistoryGraph.mockRejectedValue(new Error("boom"));
    render(<HistoryTab />);
    expect(await screen.findByText("Couldn't load history: boom")).toBeTruthy();
  });
});
