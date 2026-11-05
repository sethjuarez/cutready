import { describe, expect, it } from "vitest";
import type { WorkspaceGraph, WorkspaceGraphNode, WorkspaceGraphRef } from "@draftline/client";
import { buildTimeline, firstLine, searchTimeline } from "../domain/history/timeline";
import { mergeGraphPages } from "../services/versionHistory";

function node(id: string, parents: string[], extra: Partial<WorkspaceGraphNode> = {}): WorkspaceGraphNode {
  return {
    id,
    version: { id, label: `Version ${id}`, author: { name: "Ada" }, saved_by: { name: "Ada" }, time_seconds: 100 },
    parent_ids: parents,
    parent_version_ids: parents,
    variation_tips: [],
    touches_folder: true,
    is_head: false,
    is_current: false,
    is_tip: false,
    is_merge: parents.length > 1,
    is_branch_point: false,
    child_ids: [],
    child_count: 0,
    kind: "normal",
    topo_index: 0,
    layout: { lane: 0, row: 0, display_label: id },
    boundary: { missing_parent_ids: [], missing_child_ids: [], hidden_parent_count: 0, hidden_child_count: 0 },
    available_actions: [],
    ...extra,
  } as WorkspaceGraphNode;
}

function graph(nodes: WorkspaceGraphNode[], current: string, refs: Partial<WorkspaceGraphRef>[] = []): WorkspaceGraph {
  return {
    workspace_id: { root: "/p" },
    current_version: current,
    dirty: {} as WorkspaceGraph["dirty"],
    state_may_be_inconsistent: false,
    nodes,
    refs: refs as WorkspaceGraphRef[],
    snapshot_id: "s",
    was_pruned: false,
    has_more: false,
  };
}

describe("mergeGraphPages", () => {
  it("appends new nodes and refs and takes paging state from the later page", () => {
    const first = { ...graph([node("b", ["a"])], "b", [{ id: "r1" }]), has_more: true, next_cursor: 1 };
    const next = { ...graph([node("b", ["a"]), node("a", [])], "b", [{ id: "r1" }, { id: "r2" }]), has_more: false, next_cursor: null };
    const merged = mergeGraphPages(first, next);
    expect(merged.nodes.map((n) => n.id)).toEqual(["b", "a"]);
    expect(merged.refs.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(merged).toMatchObject({ has_more: false, next_cursor: null, current_version: "b" });
  });
});

describe("buildTimeline", () => {
  it("walks first parents from the current version, newest first", () => {
    const g = graph([
      node("m", ["c", "x"], { is_current: true }),
      node("x", ["b"]),
      node("c", ["b"]),
      node("b", ["a"]),
      node("a", []),
    ], "m");
    expect(buildTimeline(g, false).map((e) => e.id)).toEqual(["m", "c", "b", "a"]);
    expect(buildTimeline(g, false)[0]).toMatchObject({ isMerge: true, isCurrent: true, parentId: "c" });
  });

  it("skips versions that don't touch this folder and remote-only versions", () => {
    const g = graph([
      node("c", ["b"], { is_current: true }),
      node("b", ["a"], { touches_folder: false }),
      node("a", []),
      node("r", ["c"], { kind: "remote_only" }),
    ], "c");
    expect(buildTimeline(g, false).map((e) => e.id)).toEqual(["c", "a"]);
  });

  it("marks sent versions only when a remote is connected", () => {
    const nodes = [
      node("b", ["a"], { is_current: true, reachable_from_remote_variation: false }),
      node("a", [], { reachable_from_remote_variation: true }),
    ];
    expect(buildTimeline(graph(nodes, "b"), false).map((e) => e.sent)).toEqual([null, null]);
    expect(buildTimeline(graph(nodes, "b"), true).map((e) => e.sent)).toEqual([false, true]);
  });

  it("uses the comment's first non-empty line", () => {
    const g = graph([node("a", [], { is_current: true, version: { id: "a", label: "Intro", author: { name: "Ada" }, saved_by: { name: "Ada" }, time_seconds: 1, comment: "\nTightened copy\nmore" } })], "a");
    expect(buildTimeline(g, false)[0]).toMatchObject({ name: "Intro", comment: "Tightened copy", author: "Ada" });
    expect(firstLine("  \n ")).toBeNull();
  });

  it("searches name, comment and author by every word", () => {
    const g = graph([
      node("b", ["a"], { is_current: true, version: { id: "b", label: "Act 2 demos", author: { name: "Ada" }, saved_by: { name: "Ada" }, time_seconds: 2, comment: "tightened intro" } }),
      node("a", []),
    ], "b");
    const entries = buildTimeline(g, false);
    expect(searchTimeline(entries, "  ").length).toBe(2);
    expect(searchTimeline(entries, "ACT intro").map((e) => e.id)).toEqual(["b"]);
    expect(searchTimeline(entries, "act missing")).toEqual([]);
  });

  it("falls back to the head node and stops on cycles", () => {
    const g = graph([node("a", ["b"], { is_head: true }), node("b", ["a"])], "missing");
    expect(buildTimeline(g, false).map((e) => e.id)).toEqual(["a", "b"]);
  });
});
