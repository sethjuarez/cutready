import type { ChangeSummary } from "../domain/changes";
import { useChangeSummaryStore, type SaveFailure } from "../stores/changeSummaryStore";
import { settleDocumentWrites } from "./documentSaves";
import { loadWorkspaceChangeSummary } from "./workspaceChangeSummary";

/** Thrown when open edits couldn't be saved, so the versioning action never started. */
export class SaveBlockedError extends Error {
  constructor(
    readonly operation: string,
    readonly cause: unknown,
  ) {
    super(`Couldn't save your latest edits, so ${operation} didn't run.`);
    this.name = "SaveBlockedError";
  }
}

export function isSaveBlocked(error: unknown): error is SaveBlockedError {
  return error instanceof SaveBlockedError;
}

export interface VersionOperationDeps {
  /** Writes out editor edits and waits for queued disk saves; throws if they don't settle. */
  settle: () => Promise<void>;
  loadSummary: () => Promise<ChangeSummary>;
  onSummary: (summary: ChangeSummary) => void;
  onSaveFailure: (failure: SaveFailure | null) => void;
}

export type VersionOperation = <T>(operation: string, action: (summary: ChangeSummary) => Promise<T>) => Promise<T>;

/**
 * The operation boundary every Save version, Send, switch, restore and
 * incoming action goes through: save open edits, recompute the change
 * summary, then act on that summary. If the save fails the action doesn't
 * run, and the failure (with a retry) is published for the status chip.
 * Summary and action errors propagate unchanged; they are not save failures.
 */
export function createVersionOperation(deps: VersionOperationDeps): VersionOperation {
  let attempt = 0;
  const run: VersionOperation = async (operation, action) => {
    const current = ++attempt;
    try {
      await deps.settle();
    } catch (error) {
      if (current === attempt) {
        let retrying: Promise<void> | null = null;
        deps.onSaveFailure({
          operation,
          message: "Couldn't save",
          // Single-flight, so a double click can't run Send or Save version twice.
          retry: () => (retrying ??= run(operation, action).then(() => undefined).finally(() => { retrying = null; })),
        });
      }
      throw new SaveBlockedError(operation, error);
    }
    // A newer operation owns the chip now; don't clear its failure.
    if (current === attempt) deps.onSaveFailure(null);
    const summary = await deps.loadSummary();
    deps.onSummary(summary);
    return action(summary);
  };
  return run;
}

export const runVersionOperation: VersionOperation = createVersionOperation({
  settle: () => settleDocumentWrites(),
  loadSummary: loadWorkspaceChangeSummary,
  onSummary: (summary) => useChangeSummaryStore.getState().setSummary(summary),
  onSaveFailure: (failure) => useChangeSummaryStore.getState().setSaveFailure(failure),
});
