import type { ChangeKind, PathHistory, WorkspaceGraph, WorkspaceGraphNode } from "@draftline/client";
import { isTeamUpdatesName, plainVersion } from "../versioning/teamUpdates";
import { savedAtSeconds } from "../versioning/saveTime";

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
  /** In a per-document timeline, how this version changed the document. */
  pathChange?: ChangeKind;
  /** For a version that brought in the team's saves: what came in, one line each. */
  teamUpdates?: string[];
}

export function firstLine(text: string | null | undefined): string | null {
  const line = text?.split(/\r?\n/).find((part) => part.trim())?.trim();
  return line || null;
}

/**
 * Generated merge names ("Merge updates from main") read as plain words:
 * "Brought in team updates", with what came in as the comment.
 */
function plainNames(entry: TimelineEntry, rawComment: string | null | undefined): TimelineEntry {
  const plain = plainVersion(entry.name, rawComment, entry.isMerge);
  if (!entry.isMerge || !isTeamUpdatesName(entry.name)) return entry;
  return {
    ...entry,
    name: plain.name,
    comment: firstLine(plain.comment),
    ...(plain.teamUpdates.length > 0 ? { teamUpdates: plain.teamUpdates } : {}),
  };
}

function toEntry(node: WorkspaceGraphNode, remote: boolean): TimelineEntry {
  return plainNames({
    id: node.version.id,
    name: node.version.label,
    comment: firstLine(node.version.comment),
    author: node.version.author.name,
    timeSeconds: savedAtSeconds(node.version),
    parentId: node.parent_version_ids[0] ?? null,
    isMerge: node.is_merge,
    isCurrent: node.is_current || node.is_head,
    sent: remote ? node.reachable_from_remote_variation === true : null,
  }, node.version.comment);
}

/** Entries whose name, comment or author contains every word of the query. */
export function searchTimeline(entries: TimelineEntry[], query: string): TimelineEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  return entries.filter((entry) => {
    const text = `${entry.name} ${entry.comment ?? ""} ${entry.teamUpdates?.join(" ") ?? ""} ${entry.author}`.toLowerCase();
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

/**
 * Versions that changed the selected document, newest first, as Draftline's
 * per-path history reports them. The graph supplies the current and sent markers.
 */
export function pathTimeline(history: PathHistory, graph: WorkspaceGraph | null, remote: boolean): TimelineEntry[] {
  const nodes = new Map(graph?.nodes.map((node) => [node.version.id, node]) ?? []);
  const paths = new Set(history.paths);
  return history.entries.map(({ entry, files }) => {
    const pathChange = files.find((file) => paths.has(file.path))?.kind;
    const node = nodes.get(entry.version.id);
    if (node) return { ...toEntry(node, remote), pathChange };
    return plainNames({
      pathChange,
      id: entry.version.id,
      name: entry.version.label,
      comment: firstLine(entry.version.comment),
      author: entry.version.author.name,
      timeSeconds: savedAtSeconds(entry.version),
      parentId: entry.parent_ids[0] ?? null,
      isMerge: entry.parent_ids.length > 1,
      isCurrent: graph?.current_version === entry.version.id || entry.is_head,
      sent: null,
    }, entry.version.comment);
  });
}
