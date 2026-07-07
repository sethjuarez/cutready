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

export function firstParentTimelineIds(nodes: GraphNode[]): Set<string> {
  return new Set(firstParentTimelineNodes(nodes).map((node) => node.id));
}

export function cleanupRange(nodes: GraphNode[], newestId: string, oldestId: string): GraphNode[] | null {
  const ordered = newestFirst(nodes);
  const newestIndex = ordered.findIndex((node) => node.id === newestId);
  const oldestIndex = ordered.findIndex((node) => node.id === oldestId);
  if (newestIndex < 0 || oldestIndex < 0 || oldestIndex < newestIndex) return null;
  return ordered.slice(newestIndex, oldestIndex + 1);
}

export function isExactHeadCleanupSelection(nodes: GraphNode[], selectedIds: Set<string>): boolean {
  const ordered = newestFirst(nodes);
  const head = ordered.find((node) => node.is_head);
  if (!head || !selectedIds.has(head.id) || selectedIds.size < 2) return false;
  const selectedOldest = [...ordered].reverse().find((node) => selectedIds.has(node.id));
  if (!selectedOldest) return false;
  const range = cleanupRange(ordered, head.id, selectedOldest.id);
  return !!range && range.length === selectedIds.size && range.every((node) => selectedIds.has(node.id));
}

export function isExactCleanupSelection(nodes: GraphNode[], selectedIds: Set<string>): boolean {
  const ordered = newestFirst(nodes);
  if (selectedIds.size < 2) return false;
  const selectedNewest = ordered.find((node) => selectedIds.has(node.id));
  const selectedOldest = [...ordered].reverse().find((node) => selectedIds.has(node.id));
  if (!selectedNewest || !selectedOldest) return false;
  const range = cleanupRange(ordered, selectedNewest.id, selectedOldest.id);
  return !!range && range.length === selectedIds.size && range.every((node) => selectedIds.has(node.id));
}

export function headAnchoredCleanupSelection(nodes: GraphNode[], clickedId: string): Set<string> {
  const ordered = newestFirst(nodes);
  const headIndex = ordered.findIndex((node) => node.is_head);
  const clickedIndex = ordered.findIndex((node) => node.id === clickedId);
  if (headIndex < 0 || clickedIndex < headIndex) return new Set();
  return new Set(ordered.slice(headIndex, clickedIndex + 1).map((node) => node.id));
}

export function twoPointCleanupSelection(nodes: GraphNode[], firstId: string, secondId: string): Set<string> {
  const ordered = newestFirst(nodes);
  const firstIndex = ordered.findIndex((node) => node.id === firstId);
  const secondIndex = ordered.findIndex((node) => node.id === secondId);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex === secondIndex) return new Set();
  const start = Math.min(firstIndex, secondIndex);
  const end = Math.max(firstIndex, secondIndex);
  return new Set(ordered.slice(start, end + 1).map((node) => node.id));
}
