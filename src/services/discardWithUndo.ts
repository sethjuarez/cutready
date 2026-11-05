import { useToastStore } from "../stores/toastStore";
import { useVersioningStore } from "../stores/versioningStore";
import { rewriteWorkspaceFiles } from "../stores/workspaceHelpers";
import { shelveForDiscard, undoDiscardShelf, type UndoDiscardOutcome } from "./discardShelves";
import { shelfConflictText, shelfRestoreBlocker } from "./shelves";
import { runVersionOperation } from "./versionOperation";

const UNDO_TOAST_MS = 10_000;

export interface DiscardDeps {
  shelve: (paths?: string[]) => Promise<string | null>;
  undo: (shelfId: string) => Promise<UndoDiscardOutcome>;
  /** Why Undo can't apply right now (checked before editors close), or null. */
  blocker: (shelfId: string) => Promise<UndoDiscardOutcome | null>;
  /** Runs a whole-workspace rewrite with editors closed; false when it failed (already reported). */
  rewriteAll: (operation: () => Promise<void>, failureLabel: string) => Promise<boolean>;
  /** Rewrites one file with its editors suppressed; rethrows. Receives the repository-relative path. */
  rewriteFile: (path: string, operation: (repoPath: string) => Promise<void>) => Promise<void>;
  notify: (message: string, type: "success" | "info" | "warning" | "error", undo?: () => void) => void;
  /** The operation boundary: saves open edits before Undo rewrites files. Throws if they can't be saved. */
  guard: <T>(operation: string, action: () => Promise<T>) => Promise<T>;
}

const plural = (count: number) => `${count} change${count === 1 ? "" : "s"}`;

/** What Undo says for each outcome. Conflicts keep the shelf so nothing is overwritten. */
export function undoMessage(outcome: UndoDiscardOutcome): { text: string; type: "success" | "warning" } {
  switch (outcome.kind) {
    case "restored": return { text: "Discarded changes restored.", type: "success" };
    case "conflict": return { text: `Couldn't undo: ${shelfConflictText(outcome.paths)}. The discarded changes are kept for 7 days.`, type: "warning" };
    case "missing": return { text: "Those discarded changes are no longer available.", type: "warning" };
  }
}

/**
 * Discards into a fresh shelf and offers Undo. `path` discards one file;
 * omit it to discard every change. Returns the shelf id, or null when nothing
 * was discarded.
 */
export async function discardWithUndo(deps: DiscardDeps, count: number, path?: string): Promise<string | null> {
  let shelfId: string | null = null;
  if (path) {
    try {
      await deps.rewriteFile(path, async (repoPath) => {
        shelfId = await deps.shelve([repoPath]);
      });
    } catch (err) {
      deps.notify(`Discard failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      return null;
    }
  } else {
    const ok = await deps.rewriteAll(async () => {
      shelfId = await deps.shelve();
    }, "Discard failed");
    if (!ok) return null;
  }
  if (!shelfId) return null;
  const id: string = shelfId;
  deps.notify(`Discarded ${plural(count)}`, "info", () => {
    void (async () => {
      let outcome: UndoDiscardOutcome = { kind: "missing" };
      let ok: boolean;
      try {
        // Newer edits reach disk first, so the check sees them; a blocked Undo leaves editors open.
        ok = await deps.guard("Undo discard", async () => {
          const blocked = await deps.blocker(id);
          if (blocked) {
            outcome = blocked;
            return true;
          }
          return deps.rewriteAll(async () => {
            outcome = await deps.undo(id);
          }, "Undo failed");
        });
      } catch {
        return; // The status chip shows "Couldn't save – Retry".
      }
      if (!ok) return;
      const message = undoMessage(outcome);
      deps.notify(message.text, message.type);
    })();
  });
  return id;
}

const appDeps: DiscardDeps = {
  shelve: (paths) => shelveForDiscard(paths),
  undo: undoDiscardShelf,
  blocker: shelfRestoreBlocker,
  rewriteAll: rewriteWorkspaceFiles,
  rewriteFile: (path, operation) =>
    useVersioningStore.getState().replaceFileOnDisk(path, ({ repoPath }) => operation(repoPath)),
  notify: (message, type, undo) =>
    useToastStore.getState().show(message, undo ? UNDO_TOAST_MS : 4000, type, undo ? { label: "Undo", onSelect: undo } : undefined),
  guard: (operation, action) => runVersionOperation(operation, () => action()),
};

/** Discard through the operation boundary, so edits still in editors are part of what Undo restores. */
export function discardChangesWithUndo(count: number, path?: string): Promise<string | null> {
  return runVersionOperation("Discard", () => discardWithUndo(appDeps, count, path));
}
