import { shelfOverlapPaths } from "./draftlineErrors";
import { draftlineClient, facade, requireWorkspacePath } from "./draftlineVersioning";

export type ShelfRestoreOutcome =
  | { kind: "restored" }
  /** Unsaved files at `paths` would be overwritten; the shelf is kept. */
  | { kind: "conflict"; paths: string[] }
  /** The shelf is gone (already restored, deleted or pruned). */
  | { kind: "missing" };

/**
 * Applies a shelf and deletes it. Never overwrites edits made since:
 * Draftline refuses when unsaved files overlap the shelf and the shelf is kept.
 * Unsaved work elsewhere is left alone.
 */
export async function restoreShelf(shelfId: string): Promise<ShelfRestoreOutcome> {
  const workspacePath = requireWorkspacePath();
  const f = facade();
  const shelves = await f.shelves();
  if (!shelves.some((shelf) => shelf.id === shelfId)) return { kind: "missing" };
  try {
    await f.applyShelf(shelfId);
  } catch (err) {
    const paths = shelfOverlapPaths(err);
    if (paths) return { kind: "conflict", paths };
    throw err;
  }
  try {
    await draftlineClient.deleteShelf({ workspace_path: workspacePath, shelf_id: shelfId });
  } catch (err) {
    // The files are back; a leftover shelf can still be deleted (or is pruned, for discards).
    console.warn("Restored shelved changes but couldn't delete their shelf:", err);
  }
  return { kind: "restored" };
}

/**
 * Why a shelf can't be applied right now, without touching files or editors:
 * a conflict listing the unsaved files in the way, `missing`, or null when it can.
 */
export async function shelfRestoreBlocker(shelfId: string): Promise<ShelfRestoreOutcome | null> {
  const workspace_path = requireWorkspacePath();
  const shelves = await facade().shelves();
  if (!shelves.some((shelf) => shelf.id === shelfId)) return { kind: "missing" };
  let paths: string[];
  try {
    const report = await draftlineClient.preflightApplyShelf({ workspace_path, shelf_id: shelfId });
    paths = report.overlapping_files.map((file) => file.path);
  } catch {
    return null; // Best-effort: the apply itself reports any hazard through the usual failure toast.
  }
  return paths.length > 0 ? { kind: "conflict", paths } : null;
}

/** "a.sk, notes/b.md and 2 more" from repository-relative paths. */
export function describeShelfPaths(paths: string[], shown = 3): string {
  if (paths.length <= shown) return paths.length > 1 ? `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}` : paths.join("");
  return `${paths.slice(0, shown).join(", ")} and ${paths.length - shown} more`;
}

/** Why a shelf couldn't be applied, naming the unsaved files in the way when known. */
export function shelfConflictText(paths: string[]): string {
  return `you have unsaved changes in ${describeShelfPaths(paths)}`;
}

export async function deleteShelf(shelfId: string): Promise<void> {
  await draftlineClient.deleteShelf({ workspace_path: requireWorkspacePath(), shelf_id: shelfId });
}