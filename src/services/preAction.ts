import { preActionDecision, setAsideNameFor } from "../domain/versioning";
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
    const { isDirty } = useVersioningStore.getState();
    const decision = preActionDecision({ changedDocuments: summary.documents.length, isDirty });
    if (decision.kind === "ask") {
      usePreActionStore.getState().ask({ ...request, changeCount: decision.changeCount });
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
export function startGetUpdates(run: () => Promise<unknown>): void {
  startPreAction({ operation: "Get updates", target: "getting updates", run: async () => { await run(); } });
}

export type SetAsideResult = { shelved: false } | { shelved: true; followUp?: () => Promise<void> };

/** "Set aside & continue", first half: shelve the work. The caller then runs the action. */
export async function setAsideFor(request: PreActionRequest): Promise<SetAsideResult> {
  const followUp = request.onSetAside?.() ?? undefined;
  const shelved = await runVersionOperation("Set aside", () => useVersioningStore.getState().stashChanges(setAsideNameFor(request.target)));
  return shelved ? { shelved: true, followUp } : { shelved: false };
}
