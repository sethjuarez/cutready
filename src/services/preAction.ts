import { preActionDecision } from "../domain/versioning";
import { usePreActionStore, type PreActionRequest } from "../stores/preActionStore";
import { useVersioningStore } from "../stores/versioningStore";
import { isSaveBlocked, runVersionOperation } from "./versionOperation";

/**
 * Runs a restore, timeline switch or incoming update through the operation
 * boundary. With unsaved work it opens the pre-action dialog instead, which
 * saves a version (or sets the work aside) and then continues.
 */
export function requestPreAction(request: PreActionRequest): Promise<void> {
  return runVersionOperation(request.operation, async (summary) => {
    const { isDirty, hasStash } = useVersioningStore.getState();
    const decision = preActionDecision({ changedDocuments: summary.documents.length, isDirty, hasStash });
    if (decision.kind === "ask") {
      usePreActionStore.getState().ask({ ...request, changeCount: decision.changeCount, canSetAside: decision.canSetAside });
      return;
    }
    await request.run();
  });
}

/** Fire-and-forget form for click handlers; a blocked save already shows on the status chip. */
export function startPreAction(request: PreActionRequest): void {
  void requestPreAction(request).catch((err) => {
    if (!isSaveBlocked(err)) console.error(`${request.operation} failed:`, err);
  });
}

/** Get updates (incoming saves or the base timeline), asking first when work is unsaved. */
export function startGetUpdates(run: () => Promise<void>): void {
  startPreAction({ operation: "Get updates", target: "getting updates", run });
}

export type SetAsideResult = { shelved: false } | { shelved: true; followUp?: () => Promise<void> };

/** "Set aside & continue", first half: shelve the work. The caller then runs the action. */
export async function setAsideFor(request: PreActionRequest): Promise<SetAsideResult> {
  const followUp = request.onSetAside?.() ?? undefined;
  const shelved = await runVersionOperation("Set aside", () => useVersioningStore.getState().stashChanges());
  return shelved ? { shelved: true, followUp } : { shelved: false };
}
