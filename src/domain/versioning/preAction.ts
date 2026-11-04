/** What to do before a restore, timeline switch or incoming update. */
export type PreActionDecision =
  | { kind: "run" }
  /** Unsaved work: ask to save a version first, or set it aside when no shelf is in use. */
  | { kind: "ask"; changeCount: number; canSetAside: boolean };

export interface PreActionState {
  /** Documents with unsaved changes, from the operation boundary's summary. */
  changedDocuments: number;
  /** Draftline still reports a dirty workspace (e.g. files the summary doesn't classify). */
  isDirty: boolean;
  /** A "Set aside" shelf already exists; setting aside again would mix two sets of work. */
  hasStash: boolean;
}

/**
 * Draftline's switch, restore and incoming preflights all need a clean
 * workspace, so unsaved work must become a version or be set aside first.
 * There is deliberately no "continue without saving".
 */
export function preActionDecision({ changedDocuments, isDirty, hasStash }: PreActionState): PreActionDecision {
  if (changedDocuments === 0 && !isDirty) return { kind: "run" };
  return { kind: "ask", changeCount: Math.max(changedDocuments, 1), canSetAside: !hasStash };
}
