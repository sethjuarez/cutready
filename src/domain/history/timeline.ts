import type { WorkspaceGraph, WorkspaceGraphNode } from "@draftline/client";

/** One version in the History tab's timeline. */
export interface TimelineEntry {
  id: string;
  name: string;
  /** First line of the version comment, when it has one. */
  comment: string | null;
  author: string;
  timeSeconds: number;
  /** The version this one was saved on top of (first parent). */
  parentId: string | null;
  isMerge: boolean;
  isCurrent: boolean;
  /** Whether a remote can reach this version; null when no remote is connected. */
  sent: boolean | null;
}

export function firstLine(text: string | null | undefined): string | null {
  const line = text?.split(/\r?\n/).find((part) => part.trim())?.trim();
  return line || null;
}

function toEntry(node: WorkspaceGraphNode, remote: boolean): TimelineEntry {
  return {
    id: node.version.id,
    name: node.version.label,
    comment: firstLine(node.version.comment),
    author: node.version.author.name,
    timeSeconds: node.version.time_seconds,
    parentId: node.parent_version_ids[0] ?? null,
    isMerge: node.is_merge,
    isCurrent: node.is_current || node.is_head,
    sent: remote ? node.reachable_from_remote_variation === true : null,
  };
}

/** Entries whose name, comment or author contains every word of the query. */
export function searchTimeline(entries: TimelineEntry[], query: string): TimelineEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  return entries.filter((entry) => {
    const text = `${entry.name} ${entry.comment ?? ""} ${entry.author}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * The current timeline's versions, newest first: a first-parent walk from the
 * current version, skipping versions that don't touch this project's folder.
 * `remote` says whether a remote is connected, which decides the sent marker.
 */
export function buildTimeline(graph: WorkspaceGraph, remote: boolean): TimelineEntry[] {
  const byId = new Map(graph.nodes.map((node) => [node.version.id, node]));
  const start = (graph.current_version ? byId.get(graph.current_version) : undefined)
    ?? graph.nodes.find((node) => node.is_current || node.is_head);
  const entries: TimelineEntry[] = [];
  const seen = new Set<string>();
  for (let node = start; node && !seen.has(node.version.id); node = byId.get(node.parent_version_ids[0] ?? "")) {
    seen.add(node.version.id);
    if (node.touches_folder && node.kind === "normal") entries.push(toEntry(node, remote));
  }
  return entries;
}
