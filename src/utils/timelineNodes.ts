import type { GraphNode } from "../types/sketch";

function newestFirst(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
}

export function firstParentTimelineNodes(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const head = nodes.find((node) => node.is_head) ?? newestFirst(nodes)[0];
  const timeline: GraphNode[] = [];
  const seen = new Set<string>();
  let current: GraphNode | undefined = head;

  while (current && !seen.has(current.id)) {
    timeline.push(current);
    seen.add(current.id);
    current = current.parents.length > 0 ? byId.get(current.parents[0]) : undefined;
  }

  return timeline;
}
