import { describe, expect, it } from "vitest";
import {
  cleanupRange,
  firstParentTimelineIds,
  firstParentTimelineNodes,
  headAnchoredCleanupSelection,
  isExactCleanupSelection,
  isExactHeadCleanupSelection,
  twoPointCleanupSelection,
} from "../utils/historyCleanupSelection";
import type { GraphNode } from "../types/sketch";

function node(id: string, index: number, isHead = false, parents: string[] = []): GraphNode {
  return {
    id,
    message: id,
    timestamp: new Date(1_700_000_000_000 - index * 1_000).toISOString(),
    timeline: "main",
    parents,
    lane: 0,
    is_head: isHead,
  };
}

const nodes = [node("head", 0, true), node("second", 1), node("third", 2), node("fourth", 3)];

describe("history cleanup selection", () => {
  it("builds the exact HEAD-anchored range for a clicked older snapshot", () => {
    expect([...headAnchoredCleanupSelection(nodes, "third")]).toEqual(["head", "second", "third"]);
  });

  it("accepts exact contiguous HEAD selections", () => {
    expect(isExactHeadCleanupSelection(nodes, new Set(["head", "second", "third"]))).toBe(true);
  });

  it("rejects selections with holes because cleanup applies to the whole range", () => {
    expect(isExactHeadCleanupSelection(nodes, new Set(["head", "third"]))).toBe(false);
  });

  it("returns the contiguous range used for Draftline cleanup requests", () => {
    expect(cleanupRange(nodes, "head", "third")?.map((rangeNode) => rangeNode.id)).toEqual([
      "head",
      "second",
      "third",
    ]);
  });

  it("builds a contiguous range between two explicit points", () => {
    expect([...twoPointCleanupSelection(nodes, "second", "fourth")]).toEqual(["second", "third", "fourth"]);
  });

  it("accepts exact contiguous non-HEAD selections", () => {
    expect(isExactCleanupSelection(nodes, new Set(["second", "third", "fourth"]))).toBe(true);
  });

  it("rejects non-HEAD selections with holes", () => {
    expect(isExactCleanupSelection(nodes, new Set(["second", "fourth"]))).toBe(false);
  });

  it("follows only first-parent ancestry from the head", () => {
    const graph = [
      node("head", 0, true, ["milestone", "side-tip"]),
      node("milestone", 1, false, ["base"]),
      node("base", 4),
      node("side-tip", 2, false, ["side-old"]),
      node("side-old", 3, false, ["base"]),
    ];

    expect(firstParentTimelineNodes(graph).map((rangeNode) => rangeNode.id)).toEqual([
      "head",
      "milestone",
      "base",
    ]);
    expect(firstParentTimelineIds(graph).has("side-tip")).toBe(false);
  });
});
