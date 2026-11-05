import { DraftlineErrorCode, draftlineErrorCode } from "./draftlineErrors";
import { draftlineClient, facade, requireWorkspacePath } from "./draftlineVersioning";

export type ShelfRestoreOutcome =
  | "restored"
  /** Files changed since the shelf was made; it is kept so nothing is overwritten. */
  | "conflict"
  /** The shelf is gone (already restored, deleted or pruned). */
  | "missing";

/**
 * Applies a shelf and deletes it. Never overwrites edits made since:
 * Draftline refuses the apply (preflight) and the shelf is kept.
 * Draftline 0.11 refuses when ANY file is dirty, not only overlapping ones.
 */
export async function restoreShelf(shelfId: string): Promise<ShelfRestoreOutcome> {
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
    // The files are back; a leftover shelf can still be deleted (or is pruned, for discards).
    console.warn("Restored shelved changes but couldn't delete their shelf:", err);
  }
  return "restored";
}

export async function deleteShelf(shelfId: string): Promise<void> {
  await draftlineClient.deleteShelf({ workspace_path: requireWorkspacePath(), shelf_id: shelfId });
}
