// Per-document save state for the app's editors (architecture v3 §4.13).
// Keyed by project root and normalized path, so the main and split panes of
// one document share an entry. services/documentSaves owns the logic; this
// module only holds the state.
import type { SyncedDocument } from "../ipc/documents";
import { normalizeRelativePath } from "./workspaceHelpers";

/** Saves of one document redirected into its conflict copy. */
export interface ConflictRedirect extends SyncedDocument {
  /** The epoch whose saves go to the copy. */
  epoch: number;
  path: string;
}

export interface DocumentVersionEntry {
  /** The exact text the editor content was last synced to. */
  base?: string;
  baseVersion?: string;
  /** Bumped by every save request; `savedRevision` catches up when it lands. */
  editRevision: number;
  savedRevision: number;
  inFlight: number;
  /** Bumped by every load and save so a late load can't install older state. */
  loadGeneration: number;
  /** Bumped when a conflict reload ends; saves from an older epoch go to the copy. */
  epoch: number;
  tail: Promise<unknown>;
  redirect?: ConflictRedirect;
}

const entries = new Map<string, DocumentVersionEntry>();
let entriesRoot: string | null = null;

export function documentEntry(root: string, path: string): DocumentVersionEntry {
  if (root !== entriesRoot) {
    entries.clear();
    entriesRoot = root;
  }
  const key = normalizeRelativePath(path);
  let entry = entries.get(key);
  if (!entry) {
    entry = { editRevision: 0, savedRevision: 0, inFlight: 0, loadGeneration: 0, epoch: 0, tail: Promise.resolve() };
    entries.set(key, entry);
  }
  return entry;
}

/** No save is queued or running and every requested save has landed. */
export function isClean(entry: DocumentVersionEntry): boolean {
  return entry.inFlight === 0 && entry.editRevision === entry.savedRevision;
}

export function resetDocumentVersions() {
  entries.clear();
  entriesRoot = null;
}
