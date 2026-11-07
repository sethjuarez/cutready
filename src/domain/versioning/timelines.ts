import type { GraphNode, RemoteBranchInfo, TimelineInfo } from "../../types/sketch";

const matches = (text: string, query: string) => text.toLowerCase().includes(query.trim().toLowerCase());

/** Local timelines matching the filter, current first. */
export function filterTimelines(timelines: readonly TimelineInfo[], query: string): TimelineInfo[] {
  const shown = timelines.filter((timeline) => matches(timeline.label || timeline.name, query));
  return [...shown.filter((t) => t.is_active), ...shown.filter((t) => !t.is_active)];
}

/** Remote timelines matching the filter that don't already exist locally. */
export function filterRemoteTimelines(
  remote: readonly RemoteBranchInfo[],
  local: readonly TimelineInfo[],
  query: string,
): RemoteBranchInfo[] {
  const localNames = new Set(local.map((timeline) => timeline.name));
  return remote.filter((branch) => !localNames.has(branch.id) && matches(branch.name, query));
}

/**
 * The timeline left behind when it was started from a version and never got a
 * save of its own, so it is safe to offer cleaning it up after switching away.
 */
export function emptyStartedTimeline(
  started: { branchName: string; snapshotId: string } | null,
  active: TimelineInfo | undefined,
  graphNodes: readonly GraphNode[],
): string | null {
  if (!started || !active || active.name !== started.branchName) return null;
  const head = graphNodes.find((node) => node.is_head);
  return head?.id === started.snapshotId ? started.branchName : null;
}

/** Why a timeline name can't be used, or null when it's fine. */
export function timelineNameProblem(name: string, existing: readonly TimelineInfo[], current?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed !== current && existing.some((timeline) => timeline.name === trimmed || timeline.label === trimmed)) {
    return `A timeline named "${trimmed}" already exists.`;
  }
  return null;
}
