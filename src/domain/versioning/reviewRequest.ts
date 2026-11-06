import type { GraphNode } from "../../types/sketch";
import { firstParentTimelineNodes } from "../../utils/timelineNodes";
import { isTeamUpdatesName, plainVersion, teamUpdatesFromComment, teamUpdatesNameKind } from "./teamUpdates";

export interface SaveSummary {
  name: string;
  comment: string;
}

const FALLBACK_TITLE = "CutReady changes";
const MAX_LISTED = 20;

const nameOf = (node: GraphNode) => node.message.split(/\r?\n/, 1)[0].trim();
const summaryOf = (node: GraphNode): SaveSummary => ({ name: nameOf(node), comment: node.comment?.trim() ?? "" });

type NodeIndex = ReadonlyMap<string, GraphNode>;
const indexOf = (nodes: GraphNode[]): NodeIndex => new Map(nodes.map((node) => [node.id, node]));
const isShared = (node: GraphNode | undefined) => !!node && (node.reachable_from_remote_variation || !!node.is_remote_tip);

/**
 * A version that only brought in work the team had already sent: a merge whose
 * other parents are all shared. A merge of the person's own variations
 * ("Merge into…") isn't one, even under the prefilled "Merge updates from …"
 * name. Without the other parents in view, the generated name decides.
 */
export function isTeamUpdate(node: GraphNode, index: NodeIndex = new Map()): boolean {
  if (node.parents.length <= 1) return false;
  const others = node.parents.slice(1).map((id) => index.get(id));
  if (others.every((parent) => parent !== undefined)) return others.every(isShared);
  return isTeamUpdatesName(node.message);
}

/** A save someone made, not a version CutReady created to bring in other people's work. */
export function isUserSave(node: GraphNode, index?: NodeIndex): boolean {
  return !isTeamUpdate(node, index);
}

/** A version's name as people should read it ("Brought in team updates" for generated ones). */
export function versionDisplayName(node: GraphNode): string {
  return plainVersion(node.message, node.comment, node.parents.length > 1).name;
}

/**
 * Versions on this timeline the remote doesn't have yet, newest first. A team
 * update's second parent is already shared, so only the first-parent line counts.
 */
export function unsentVersions(nodes: GraphNode[], ahead: number): GraphNode[] {
  const unsent: GraphNode[] = [];
  for (const node of firstParentTimelineNodes(nodes)) {
    if (unsent.length >= ahead || node.reachable_from_remote_variation || node.is_remote_tip) break;
    unsent.push(node);
  }
  return unsent;
}

/**
 * How many saves people would say are waiting to send: `ahead` minus the
 * versions CutReady made to bring in team updates. Never 0 while something is
 * unsent, so Send stays available; falls back to `ahead` before history loads.
 */
export function savesToSend(nodes: GraphNode[], ahead: number): number {
  if (ahead <= 0) return 0;
  if (nodes.length === 0) return ahead;
  const index = indexOf(nodes);
  return Math.max(1, unsentVersions(nodes, ahead).filter((node) => isUserSave(node, index)).length);
}

/** How many teammates' saves the given team-update versions brought in; null when a version doesn't say. */
function teamUpdateCount(versions: GraphNode[]): number | null {
  let total = 0;
  for (const version of versions) {
    if (teamUpdatesNameKind(version.message) !== "current") return null;
    const { lines, more } = teamUpdatesFromComment(version.comment);
    if (lines.length + more === 0) return null;
    total += lines.length + more;
  }
  return total;
}

/**
 * The pull request for Send for review, built from the person's own saves only:
 * titled after the newest, listing the saves, and noting in one line any team
 * updates the review carries along.
 * `ahead` bounds the walk to versions the remote doesn't have; `typed` is a save
 * just made by Save & send.
 */
export function reviewRequest(
  nodes: GraphNode[],
  ahead: number,
  typed?: SaveSummary,
  fallbackTitle = FALLBACK_TITLE,
): { title: string; body: string } {
  const index = indexOf(nodes);
  const unsent = unsentVersions(nodes, ahead);
  const saves = unsent.filter((node) => isUserSave(node, index)).map(summaryOf);
  const merges = unsent.filter((node) => isTeamUpdate(node, index));
  if (typed?.name.trim() && saves[0]?.name !== typed.name.trim()) {
    saves.unshift({ name: typed.name.trim(), comment: typed.comment.trim() });
  }
  // Only unsent saves name the review; anything older may be a teammate's.
  const [newest] = saves;
  // The branch is a slug of the title, so it stays the save's own name; the body lists the rest.
  const title = newest?.name || fallbackTitle;

  const parts: string[] = [];
  if (newest?.comment) parts.push(newest.comment);
  if (saves.length > 1) {
    const listed = [...saves].reverse().slice(-MAX_LISTED).map((save) => `- ${save.name}`);
    const earlier = saves.length - listed.length;
    if (earlier > 0) listed.unshift(`- …and ${earlier} earlier`);
    parts.push(`Saves in this review:\n${listed.join("\n")}`);
  }
  if (merges.length > 0) {
    const count = teamUpdateCount(merges);
    parts.push(
      count === null
        ? "Also includes team updates that are already shared; they aren't part of this review."
        : `Also includes ${count} team ${count === 1 ? "update" : "updates"} that ${count === 1 ? "is" : "are"} already shared; they aren't part of this review.`,
    );
  }
  return { title, body: parts.join("\n\n") };
}
