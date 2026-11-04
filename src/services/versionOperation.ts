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
  /** Counts in-flight, non-quiet operations for the chip's Saving… state. */
  onBusy?: (delta: 1 | -1) => void;
}

export interface VersionOperationOptions {
  /** Read-only refresh (opening the popover): don't show Saving…. */
  quiet?: boolean;
}

export type VersionOperation = <T>(
  operation: string,
  action: (summary: ChangeSummary) => Promise<T>,
  options?: VersionOperationOptions,
) => Promise<T>;

/**
 * The operation boundary every Save version, Send, switch, restore and
 * incoming action goes through: save open edits, recompute the change
 * summary, then act on that summary. If the save fails the action doesn't
 * run, and the failure (with a retry) is published for the status chip.
 * Summary and action errors propagate unchanged; they are not save failures.
 * Only the most recently started summary load is published, so an older
 * load resolving late can't overwrite a newer one.
 */
export function createVersionOperation(deps: VersionOperationDeps): VersionOperation {
  let attempt = 0;
  let summaryLoad = 0;
  const run: VersionOperation = async (operation, action, options) => {
    const current = ++attempt;
    const busy = !options?.quiet;
    if (busy) deps.onBusy?.(1);
    try {
      try {
        await deps.settle();
      } catch (error) {
        if (current === attempt) {
          let retrying: Promise<void> | null = null;
          deps.onSaveFailure({
            operation,
            message: "Couldn't save",
            // Single-flight, so a double click can't run Send or Save version twice.
            retry: () => (retrying ??= run(operation, action, options).then(() => undefined).finally(() => { retrying = null; })),
          });
        }
        throw new SaveBlockedError(operation, error);
      }
      // A newer operation owns the chip now; don't clear its failure.
      if (current === attempt) deps.onSaveFailure(null);
      const load = ++summaryLoad;
      const summary = await deps.loadSummary();
      if (load === summaryLoad) deps.onSummary(summary);
      return await action(summary);
    } finally {
      if (busy) deps.onBusy?.(-1);
    }
  };
  return run;
}

export const runVersionOperation: VersionOperation = createVersionOperation({
  settle: () => settleDocumentWrites(),
  loadSummary: loadWorkspaceChangeSummary,
  onSummary: (summary) => useChangeSummaryStore.getState().setSummary(summary),
  onSaveFailure: (failure) => useChangeSummaryStore.getState().setSaveFailure(failure),
  onBusy: (delta) => useChangeSummaryStore.getState().adjustBusy(delta),
});
