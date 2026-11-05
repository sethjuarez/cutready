import { discardShelfName, discardShelvesToPrune } from "../domain/versioning";
import { draftlineClient, facade, requireWorkspacePath } from "./draftlineVersioning";
import { restoreShelf, type ShelfRestoreOutcome } from "./shelves";

export type UndoDiscardOutcome = ShelfRestoreOutcome;

/**
 * Discards by shelving: the changes leave the workspace but stay in their own
 * shelf, so Undo can bring exactly this discard back. Returns the shelf id,
 * or null when there was nothing to discard.
 * `paths` are repository-relative; omit them to discard every change.
 */
export async function shelveForDiscard(paths?: string[], now = Date.now()): Promise<string | null> {
  const f = facade();
  const targets = paths ?? (await f.changes()).files.map((file) => file.path);
  if (targets.length === 0) return null;
  const result = await f.selectedShelve(targets, discardShelfName(now));
  return result.shelf.id;
}

/** Applies a discard shelf and deletes it, never overwriting edits made since. */
export const undoDiscardShelf = restoreShelf;

/** Deletes discard shelves older than 7 days. Draftline has no pruning of its own. */
export async function pruneDiscardShelves(now = Date.now()): Promise<number> {
  const workspacePath = requireWorkspacePath();
  const shelves = await facade().shelves();
  const stale = discardShelvesToPrune(shelves.map((shelf) => shelf.id), now);
  for (const id of stale) {
    await draftlineClient.deleteShelf({ workspace_path: workspacePath, shelf_id: id });
  }
  return stale.length;
}
