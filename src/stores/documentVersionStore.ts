// Per-document save state for the app's editors (architecture v3 §4.13).
// Keyed by project root and normalized path, so the main and split panes of
// one document share an entry. Entries belong to one workspace generation:
// opening, switching or closing a project starts a new set, and saves or
// loads still holding an older entry are dropped. services/documentSaves owns
// the logic; this module only holds the state.
import type { SyncedDocument } from "../ipc/documents";
import { currentWorkspaceGeneration, normalizeRelativePath } from "./workspaceHelpers";

/** Saves of one document redirected into its conflict copy. */
export interface ConflictRedirect extends SyncedDocument {
  /** The epoch whose saves go to the copy. */
  epoch: number;
  path: string;
}

export interface DocumentVersionEntry {
  /** The project root and workspace generation the entry belongs to. */
  root: string;
  generation: number;
  /** Set when the entry stops tracking its file (renamed, or its project closed). */
  retired: boolean;
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
  /** A conflict reload an editor refused; it runs again after the next save of this document. */
  pendingReload?: () => Promise<void>;
  /** During a redirect: the editors that show `loaded` from disk again. */
  installs?: RedirectInstalls;
}

export interface RedirectInstalls {
  epoch: number;
  loaded: SyncedDocument;
  editors: Set<symbol>;
}

const entries = new Map<string, DocumentVersionEntry>();
let entriesScope: string | null = null;
/** The workspace generation being closed, if a project change is under way. */
let closingGeneration: number | null = null;

function newEntry(root: string, generation: number): DocumentVersionEntry {
  return { root, generation, retired: false, editRevision: 0, savedRevision: 0, inFlight: 0, loadGeneration: 0, epoch: 0, tail: Promise.resolve() };
}

function scopeEntries(root: string): number {
  const generation = currentWorkspaceGeneration();
  const scope = `${generation}\u0000${root}`;
  if (scope !== entriesScope) {
    for (const entry of entries.values()) entry.retired = true;
    entries.clear();
    entriesScope = scope;
  }
  return generation;
}

export function documentEntry(root: string, path: string): DocumentVersionEntry {
  const generation = scopeEntries(root);
  const key = normalizeRelativePath(path);
  let entry = entries.get(key);
  if (!entry) {
    entry = newEntry(root, generation);
    entries.set(key, entry);
  }
  return entry;
}

/** Whether saves and loads for `entry` may still touch disk and editors in the project at `root`. */
export function isEntryCurrent(entry: DocumentVersionEntry, root: string | undefined): boolean {
  return !entry.retired
    && entry.root === root
    && entry.generation === currentWorkspaceGeneration()
    && entry.generation !== closingGeneration;
}

/** The tracked entry of `path` in the project at `root`, without starting one. */
export function peekDocumentEntry(root: string, path: string): DocumentVersionEntry | undefined {
  const entry = entries.get(normalizeRelativePath(path));
  return entry && isEntryCurrent(entry, root) ? entry : undefined;
}

/** Every entry of the current project. */
export function documentEntries(): DocumentVersionEntry[] {
  return Array.from(entries.values());
}

/** Every entry of the current project, with its relative path. */
export function documentEntryPaths(): [string, DocumentVersionEntry][] {
  return Array.from(entries.entries());
}

/**
 * Stops saves and loads of the current project's documents until `release`,
 * or for good once another project replaces it.
 */
export function closeDocumentScope(): () => void {
  const generation = currentWorkspaceGeneration();
  closingGeneration = generation;
  return () => {
    if (closingGeneration === generation) closingGeneration = null;
  };
}

/**
 * A file moved from `from` to `to`: the old entry stops (its queued saves are
 * dropped) and a new one at `to` starts from the same synced text, so later
 * saves of the renamed document carry the right base.
 */
export function moveDocumentEntry(from: string, to: string) {
  const old = entries.get(normalizeRelativePath(from));
  retire(from);
  retire(to);
  if (!old) return;
  const moved = newEntry(old.root, old.generation);
  if (old.inFlight === 0 && old.editRevision === old.savedRevision) {
    moved.base = old.base;
    moved.baseVersion = old.baseVersion;
  }
  entries.set(normalizeRelativePath(to), moved);
}

function retire(path: string) {
  const key = normalizeRelativePath(path);
  const entry = entries.get(key);
  if (entry) entry.retired = true;
  entries.delete(key);
}

/** No save is queued or running and every requested save has landed. */
export function isClean(entry: DocumentVersionEntry): boolean {
  return entry.inFlight === 0 && entry.editRevision === entry.savedRevision;
}

export function resetDocumentVersions() {
  entries.clear();
  entriesScope = null;
  closingGeneration = null;
}
