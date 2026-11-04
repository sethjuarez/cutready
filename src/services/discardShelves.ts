import { discardShelfName, discardShelvesToPrune } from "../domain/versioning";
import { DraftlineErrorCode, draftlineErrorCode } from "./draftlineErrors";
import { draftlineClient, facade, requireWorkspacePath } from "./draftlineVersioning";

export type UndoDiscardOutcome =
  | "restored"
  /** Files changed since the discard; the shelf is kept so nothing is overwritten. */
  | "conflict"
  /** The shelf is gone (already undone or pruned). */
  | "missing";

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

/**
 * Applies a discard shelf and deletes it. Never overwrites edits made since:
 * Draftline refuses the apply (preflight) and the shelf is kept.
 * Draftline 0.10 refuses when ANY file is dirty, not only overlapping ones.
 */
export async function undoDiscardShelf(shelfId: string): Promise<UndoDiscardOutcome> {
  const workspacePath = requireWorkspacePath();
  const f = facade();
  const shelves = await f.shelves();
  if (!shelves.some((shelf) => shelf.id === shelfId)) return "missing";
  try {
    await f.applyShelf(shelfId);
  } catch (err) {
    if (draftlineErrorCode(err) === DraftlineErrorCode.PreflightFailed) return "conflict";
    throw err;
  }
  try {
    await draftlineClient.deleteShelf({ workspace_path: workspacePath, shelf_id: shelfId });
  } catch (err) {
    // Files are back; a leftover shelf is harmless and gets pruned after 7 days.
    console.warn("Restored discarded changes but couldn't delete their shelf:", err);
  }
  return "restored";
}

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
