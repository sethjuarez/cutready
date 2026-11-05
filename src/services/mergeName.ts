import { clampVersionName, type IncomingVersion } from "../domain/versioning";
import { useMergeNameStore } from "../stores/mergeNameStore";
import { currentWorkspaceGeneration } from "../stores/workspaceHelpers";
import type { TimelineInfo } from "../types/sketch";

/** The prefilled name for a merge: "Merge updates from <source>", kept within the limit. */
export function defaultMergeName(source: string): string {
  const from = source.trim();
  return clampVersionName(from ? `Merge updates from ${from}` : "Merge updates");
}

/** The active timeline's display name: incoming saves are updates to it. */
export function activeTimelineLabel(timelines: readonly TimelineInfo[]): string | undefined {
  return timelines.find((timeline) => timeline.is_active)?.label || undefined;
}

/**
 * Asks the user to approve (or edit) the merge's name. Resolves to the commit
 * message, or null when they cancel or the project changes; the caller must
 * then not merge.
 */
export async function askMergeName(source: string, incoming: IncomingVersion[] = []): Promise<string | null> {
  const generation = currentWorkspaceGeneration();
  const message = await useMergeNameStore.getState().ask(source, defaultMergeName(source), incoming);
  // The project changed while the prompt was open: never merge into the new one.
  return generation === currentWorkspaceGeneration() ? message : null;
}
