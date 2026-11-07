import { setAsideShelfId, setAsideShelves, type SetAsideShelf } from "../domain/versioning";
import { facade } from "./draftlineVersioning";

export { deleteShelf as deleteSetAsideShelf, restoreShelf as restoreSetAsideShelf } from "./shelves";

/** The work waiting to be brought back, newest first. */
export async function listSetAsideShelves(): Promise<SetAsideShelf[]> {
  return setAsideShelves(await facade().shelves());
}

/**
 * Moves every unsaved change into a new shelf of its own, so several sets of
 * work can wait side by side. False when there was nothing to set aside.
 */
export async function setAsideChanges(name: string, now = Date.now()): Promise<boolean> {
  const f = facade();
  const changes = await f.changes();
  if (changes.files.length === 0) return false;
  await f.selectedShelve(changes.files.map((file) => file.path), setAsideShelfId(name, now));
  return true;
}
