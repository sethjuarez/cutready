import { describe, expect, it } from "vitest";
import { firstParentTimelineNodes } from "../utils/timelineNodes";
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

describe("firstParentTimelineNodes", () => {
  it("follows only first-parent ancestry from the head", () => {
    const graph = [
      node("head", 0, true, ["merged", "side-tip"]),
      node("merged", 1, false, ["base"]),
      node("base", 4),
      node("side-tip", 2, false, ["side-old"]),
      node("side-old", 3, false, ["base"]),
    ];

    expect(firstParentTimelineNodes(graph).map((n) => n.id)).toEqual([
      "head",
      "merged",
      "base",
    ]);
  });
});
