import type { PathHistory, WorkspaceGraph } from "@draftline/client";
import { facade } from "./draftlineVersioning";

const PAGE_SIZE = 250;
/** Safety stop so a huge repository can't load forever; the graph then reports has_more. */
const MAX_PAGES = 20;

/** Draftline's graph for the current timeline, including remote and support refs, with every page loaded. */
export async function loadHistoryGraph(): Promise<WorkspaceGraph | null> {
  const f = facade();
  const variations = await f.variations();
  const current = variations.find((entry) => entry.variation.is_current) ?? variations[0];
  if (!current) return null;
  const load = (cursor?: number | null) => f.workspaceGraphForVariation(current.variation.id, {
    include_remotes: true,
    include_support_refs: true,
    limit: PAGE_SIZE,
    cursor,
  });
  let graph = await load();
  for (let page = 1; graph.has_more && graph.next_cursor != null && page < MAX_PAGES; page += 1) {
    graph = mergeGraphPages(graph, await load(graph.next_cursor));
  }
  return graph;
}

/** Appends a later page: new nodes and refs are added, and paging state comes from the later page. */
export function mergeGraphPages(first: WorkspaceGraph, next: WorkspaceGraph): WorkspaceGraph {
  const nodeIds = new Set(first.nodes.map((node) => node.version.id));
  const refIds = new Set(first.refs.map((ref) => ref.id));
  return {
    ...first,
    nodes: [...first.nodes, ...next.nodes.filter((node) => !nodeIds.has(node.version.id))],
    refs: [...first.refs, ...next.refs.filter((ref) => !refIds.has(ref.id))],
    has_more: next.has_more,
    next_cursor: next.next_cursor,
    was_pruned: first.was_pruned || next.was_pruned,
  };
}

/** Versions on the current timeline that changed `path` (a Draftline path), with every page loaded. */
export async function loadPathHistory(path: string): Promise<PathHistory> {
  const f = facade();
  const load = (cursor?: number | null) => f.pathHistory([path], { limit: PAGE_SIZE, cursor });
  let history = await load();
  for (let page = 1; history.has_more && history.next_cursor != null && page < MAX_PAGES; page += 1) {
    const next = await load(history.next_cursor);
    history = { ...next, entries: [...history.entries, ...next.entries] };
  }
  return history;
}
