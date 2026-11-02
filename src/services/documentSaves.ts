// App document saves (architecture v3 §4.13, ADR 0002 "App saves"). Every save
// sends the version and exact text of the document the editor was last synced
// to (`base`); Rust applies the save directly when that is still on disk and
// otherwise three-way merges it onto the newer file. A save that can't merge
// is written to a conflict copy, the document is reloaded and a warning toast
// says where the edits went. Open documents also refresh when the window
// regains focus or Draftline reports a workspace change.
import {
  documentsIpc,
  type DocumentKind,
  type DocumentSaveCommand,
  type SyncedDocument,
  type Versioned,
} from "../ipc/documents";
import { useAppStore } from "../stores/appStore";
import { documentEntry, isClean, type DocumentVersionEntry } from "../stores/documentVersionStore";
import { useToastStore } from "../stores/toastStore";
import { flushEditorWrites } from "../stores/workspaceHelpers";

/** How long an installed document waits for its editor to render before it becomes the base. */
export const INSTALL_SETTLE_MS = 100;
const MAX_COPY_ATTEMPTS = 50;

/** A save that couldn't merge with changes made elsewhere; its edits are in `copyPath`. */
export class DocumentConflictError extends Error {
  constructor(readonly path: string, readonly copyPath: string) {
    super(`${path} changed elsewhere; your edits were saved to ${copyPath}`);
    this.name = "DocumentConflictError";
  }
}

export function isDocumentConflict(error: unknown): error is DocumentConflictError {
  return error instanceof DocumentConflictError;
}

export function documentKind(path: string): DocumentKind {
  if (path.endsWith(".sk")) return "sketch";
  if (path.endsWith(".sb")) return "storyboard";
  return "note";
}

function entryFor(path: string): DocumentVersionEntry {
  return documentEntry(useAppStore.getState().currentProject?.root ?? "", path);
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === code;
}

function adopt(entry: DocumentVersionEntry, synced: SyncedDocument) {
  entry.base = synced.content;
  entry.baseVersion = synced.version;
}

/**
 * Makes `loaded` the base once its editor has had time to render it, unless a
 * save or load started meanwhile. Until then the older base stays: a save
 * built from content the editor showed before the install still merges.
 */
function adoptWhenSettled(entry: DocumentVersionEntry, loaded: SyncedDocument) {
  const generation = entry.loadGeneration;
  globalThis.setTimeout(() => {
    if (entry.loadGeneration === generation && entry.inFlight === 0) adopt(entry, loaded);
  }, INSTALL_SETTLE_MS);
}

/** Reads a document for an editor and records it as that editor's base. */
export async function loadDocument<T>(kind: DocumentKind, relativePath: string): Promise<T> {
  const entry = entryFor(relativePath);
  const generation = ++entry.loadGeneration;
  const loaded = await documentsIpc.read<T>(kind, relativePath);
  if (entry.loadGeneration === generation && entry.inFlight === 0) adoptWhenSettled(entry, loaded);
  return loaded.document;
}

type SaveArgs = Record<string, unknown> & ({ relativePath: string } | { storyboardPath: string });

/**
 * Saves an open document. Saves of one document run one at a time, in order.
 * Resolves with the committed document; rejects with DocumentConflictError
 * when the save conflicted with changes made elsewhere.
 */
export function saveDocument<T>(command: DocumentSaveCommand, args: SaveArgs): Promise<T> {
  const pathKey = "storyboardPath" in args ? "storyboardPath" : "relativePath";
  const entry = entryFor(args[pathKey] as string);
  const revision = ++entry.editRevision;
  const epoch = entry.epoch;
  entry.inFlight += 1;
  entry.loadGeneration += 1;
  const run = entry.tail.then(() => runSave<T>(entry, command, args, pathKey, revision, epoch));
  entry.tail = run.catch(() => undefined);
  return run;
}

async function runSave<T>(
  entry: DocumentVersionEntry,
  command: DocumentSaveCommand,
  args: SaveArgs,
  pathKey: "relativePath" | "storyboardPath",
  revision: number,
  epoch: number,
): Promise<T> {
  const path = args[pathKey] as string;
  let merged = false;
  try {
    const redirect = entry.redirect?.epoch === epoch ? entry.redirect : undefined;
    if (redirect) {
      const saved = await documentsIpc.save<T>(command, { ...args, [pathKey]: redirect.path, expectedVersion: redirect.version, base: redirect.content });
      Object.assign(redirect, saved.synced ?? { content: saved.content, version: saved.version });
      entry.savedRevision = Math.max(entry.savedRevision, revision);
      return saved.document;
    }
    if (entry.base === undefined) await readBase(entry, path);
    let saved: Versioned<T>;
    try {
      saved = await documentsIpc.save<T>(command, { ...args, expectedVersion: entry.baseVersion, base: entry.base });
    } catch (error) {
      if (!hasCode(error, "stale_document")) throw error;
      entry.savedRevision = Math.max(entry.savedRevision, revision);
      return await resolveConflict(entry, command, args, pathKey, epoch);
    }
    entry.savedRevision = Math.max(entry.savedRevision, revision);
    // The editor holds what this save sent; a merged document is shown by the refresh.
    adopt(entry, saved.synced ?? saved);
    merged = saved.merged;
    return saved.document;
  } finally {
    entry.inFlight -= 1;
    if (merged) void refreshOpenDocuments();
  }
}

/** A save with no known base reads one; a note that doesn't exist yet is created. */
async function readBase(entry: DocumentVersionEntry, path: string) {
  const kind = documentKind(path);
  try {
    adopt(entry, await documentsIpc.read(kind, path));
  } catch (error) {
    if (kind !== "note") throw error;
  }
}

function conflictPath(path: string, stamp: string, attempt: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  return `${stem} (conflict ${stamp}${attempt > 0 ? `-${attempt}` : ""})${ext}`;
}

/** `YYYYMMDD-HHMMSS` in UTC. */
export function conflictStamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

async function createConflictCopy(path: string, content: string): Promise<Versioned<string> & { path: string }> {
  const stamp = conflictStamp(new Date());
  for (let attempt = 0; ; attempt += 1) {
    const copyPath = conflictPath(path, stamp, attempt);
    try {
      return { ...(await documentsIpc.createCopy(copyPath, content)), path: copyPath };
    } catch (error) {
      if (!hasCode(error, "file_exists") || attempt >= MAX_COPY_ATTEMPTS) throw error;
    }
  }
}

/**
 * Keeps the user's edits in a sibling conflict copy, then reloads the
 * document and says so. Saves already queued for this document, and edits
 * still pending in its editors (written out now, so they queue behind them),
 * follow into the copy; the reload runs after them, and saves made after it
 * go to the document again.
 */
async function resolveConflict(
  entry: DocumentVersionEntry,
  command: DocumentSaveCommand,
  args: SaveArgs,
  pathKey: "relativePath" | "storyboardPath",
  epoch: number,
): Promise<never> {
  const path = args[pathKey] as string;
  const copy = await createConflictCopy(path, entry.base ?? "");
  const local = await documentsIpc.save(command, { ...args, [pathKey]: copy.path, expectedVersion: copy.version, base: copy.content });
  entry.redirect = { epoch, path: copy.path, content: local.content, version: local.version };
  void flushEditorWrites().catch(() => undefined);
  entry.inFlight += 1;
  const reload = entry.tail.then(() => reloadAfterConflict(entry, path, copy.path));
  entry.tail = reload.catch(() => undefined);
  throw new DocumentConflictError(path, copy.path);
}

async function reloadAfterConflict(entry: DocumentVersionEntry, path: string, copyPath: string) {
  const kind = documentKind(path);
  try {
    const reloaded = await documentsIpc.read(kind, path);
    entry.loadGeneration += 1;
    install(kind, path, reloaded);
    // Saves made before the editor shows the reload still go to the copy.
    globalThis.setTimeout(() => {
      entry.epoch += 1;
      adopt(entry, reloaded);
    }, INSTALL_SETTLE_MS);
    const app = useAppStore.getState();
    await (kind === "sketch" ? app.loadSketches() : kind === "storyboard" ? app.loadStoryboards() : app.loadNotes());
    const name = (p: string) => p.split("/").pop() ?? p;
    useToastStore.getState().show(
      `${name(path)} changed outside CutReady while you were editing. Your edits were saved to ${name(copyPath)}.`,
      10000,
      "warning",
    );
  } finally {
    entry.inFlight -= 1;
  }
}

/** Shows a document read from disk in the editors that have it open. */
function install(kind: DocumentKind, path: string, loaded: Versioned<unknown>) {
  const app = useAppStore.getState();
  if (kind === "sketch" && app.activeSketchPath === path) {
    useAppStore.setState({ activeSketch: loaded.document as typeof app.activeSketch });
  } else if (kind === "storyboard" && app.activeStoryboardPath === path) {
    useAppStore.setState({ activeStoryboard: loaded.document as typeof app.activeStoryboard });
  } else if (kind === "note" && app.activeNotePath === path) {
    useAppStore.setState({ activeNoteContent: loaded.content });
  }
  window.dispatchEvent(new CustomEvent("cutready:document-refreshed", { detail: { path } }));
}

function openDocumentPaths(): string[] {
  const { openTabs, splitTabs } = useAppStore.getState();
  const paths = [...openTabs, ...splitTabs]
    .filter((tab) => tab.type === "sketch" || tab.type === "storyboard" || tab.type === "note")
    .map((tab) => tab.path);
  return Array.from(new Set(paths));
}

/**
 * Reloads one open document if it changed on disk and has no local edits in
 * flight. Pending editor edits are written first; if that saved anything, the
 * document is checked again, so an install never replaces unsaved typing.
 */
async function refreshDocument(path: string) {
  const entry = entryFor(path);
  const kind = documentKind(path);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (entry.base === undefined || !isClean(entry)) return;
    const loaded = await documentsIpc.read(kind, path).catch(() => null);
    if (!loaded || loaded.version === entry.baseVersion) return;
    const { editRevision, loadGeneration } = entry;
    await flushEditorWrites().catch(() => undefined);
    if (entry.editRevision !== editRevision || entry.loadGeneration !== loadGeneration || !isClean(entry)) continue;
    entry.loadGeneration += 1;
    install(kind, path, loaded);
    adoptWhenSettled(entry, loaded);
    return;
  }
}

let refreshing: Promise<void> | null = null;
let refreshAgain = false;

/** Refreshes every open document; concurrent calls coalesce into one more pass. */
export function refreshOpenDocuments(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      do {
        refreshAgain = false;
        if (!useAppStore.getState().currentProject) return;
        await Promise.all(openDocumentPaths().map(refreshDocument));
      } while (refreshAgain);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Refreshes open documents when the window regains focus or becomes visible. */
export function watchOpenDocuments(): () => void {
  const refresh = () => {
    if (document.visibilityState !== "hidden") void refreshOpenDocuments();
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}
