import { describe, expect, it } from "vitest";
import type { WorkspaceGraph, WorkspaceGraphNode, WorkspaceGraphRef } from "@draftline/client";
import { buildTimeline, firstLine, pathTimeline, searchTimeline } from "../domain/history/timeline";
import { mergeGraphPages } from "../services/versionHistory";
import { savedAtSeconds } from "../domain/versioning/saveTime";

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

describe("pathTimeline", () => {
  const entry = (id: string, parents: string[]) => ({
    entry: { version: { id, label: `Path ${id}`, comment: "Why\nmore", author: { name: "Bo" }, time_seconds: 50 }, parent_ids: parents, is_head: false },
    files: [],
  });
  const history = { paths: ["a.md"], entries: [entry("2", ["1"]), entry("9", ["8", "7"])], has_more: false, next_cursor: null } as never;

  it("uses graph nodes when they're loaded, so sent markers stay accurate", () => {
    const g = graph([node("2", ["1"], { reachable_from_remote_variation: true } as never)], "2");
    const [first, second] = pathTimeline(history, g, true);
    expect(first).toMatchObject({ id: "2", name: "Version 2", sent: true });
    expect(second).toMatchObject({ id: "9", name: "Path 9", sent: null, isMerge: true, parentId: "8", author: "Bo" });
  });

  it("builds entries from the path history alone when there's no graph", () => {
    const entries = pathTimeline(history, null, false);
    expect(entries.map((e) => e.id)).toEqual(["2", "9"]);
    expect(entries[0]).toMatchObject({ name: "Path 2", comment: "Why", isMerge: false });
  });
});

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
  it("shows generated update versions in plain words, with what came in", () => {
    const comment = "- #24 lead queue with wing-light hero (Dana)\n- Tighten intro (Lee)\n- …and 3 more";
    const merge = (id: string, label: string, extra: Partial<WorkspaceGraphNode["version"]> = {}) =>
      node(id, ["a", "x"], { version: { ...node(id, []).version, label, ...extra } });
    const g = graph([
      merge("n", "Brought in team updates", { comment }),
      merge("o", "Merge updates from main"),
      merge("u", "Combine the intro drafts"),
    ], "n");
    const entries = new Map(g.nodes.map((n) => [n.id, buildTimeline(graph([n], n.id), false)[0]]));
    expect(entries.get("n")).toMatchObject({
      name: "Brought in team updates",
      comment: "#24 lead queue with wing-light hero (Dana) and 4 more",
      teamUpdates: ["#24 lead queue with wing-light hero (Dana)", "Tighten intro (Lee)", "…and 3 more"],
    });
    expect(entries.get("o")).toMatchObject({ name: "Brought in team updates", comment: null });
    expect(entries.get("o")?.teamUpdates).toBeUndefined();
    // A merge someone named themselves keeps its name.
    expect(entries.get("u")).toMatchObject({ name: "Combine the intro drafts" });
  });

  it("finds team updates by what came in", () => {
    const g = graph([node("n", ["a", "x"], {
      is_current: true,
      version: { ...node("n", []).version, label: "Brought in team updates", comment: "- Wing-light hero (Dana)\n- Tighten intro (Lee)" },
    })], "n");
    expect(searchTimeline(buildTimeline(g, false), "dana wing").map((e) => e.id)).toEqual(["n"]);
    expect(searchTimeline(buildTimeline(g, false), "lee intro").map((e) => e.id)).toEqual(["n"]);
  });

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

describe("save time after bringing in team updates", () => {
  // Replaying an unsent save sets its recorded time to now; the author time keeps when it was made.
  const rebased = { id: "r", label: "Outline", author: { name: "Ada" }, saved_by: { name: "Ada" }, time_seconds: 9_000, author_time_seconds: 1_000 };

  it("shows a replayed save at its original time in History", () => {
    const g = graph([node("r", [], { version: rebased } as never)], "r");
    expect(buildTimeline(g, false)[0].timeSeconds).toBe(1_000);
    const history = { paths: ["a.md"], entries: [{ entry: { version: rebased, parent_ids: [], is_head: true }, files: [] }], has_more: false, next_cursor: null } as never;
    expect(pathTimeline(history, null, false)[0].timeSeconds).toBe(1_000);
  });

  it("falls back to the recorded time when there's no author time", () => {
    expect(savedAtSeconds({ time_seconds: 9_000 })).toBe(9_000);
    expect(savedAtSeconds({ time_seconds: 9_000, author_time_seconds: null })).toBe(9_000);
  });
});