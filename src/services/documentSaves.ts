// App document saves (architecture v3 §4.13, ADR 0002 "App saves"). Every save
// sends the version and exact text of the document the editor was last synced
// to (`base`); Rust applies the save directly when that is still on disk and
// otherwise three-way merges it onto the newer file. A save that can't merge
// is written to a conflict copy, the document is reloaded and a warning toast
// says where the edits went. Open documents also refresh when the window
// regains focus or Draftline reports a workspace change. Saves and loads belong
// to the project they started in: once another project opens (or this one
// closes) they are dropped before touching disk or an editor.
import {
  documentsIpc,
  type DocumentKind,
  type DocumentSaveCommand,
  type SyncedDocument,
  type Versioned,
} from "../ipc/documents";
import { useAppStore } from "../stores/appStore";
import {
  closeDocumentScope,
  documentEntries,
  documentEntry,
  isClean,
  isEntryCurrent,
  moveDocumentEntry,
  type DocumentVersionEntry,
} from "../stores/documentVersionStore";
import { useToastStore } from "../stores/toastStore";
import { flushEditorWrites } from "../stores/workspaceHelpers";

/** How long an installed document waits for its editor to render before it becomes the base. */
export const INSTALL_SETTLE_MS = 100;
/** How long a project change or rename waits for queued saves before going ahead. */
export const SETTLE_TIMEOUT_MS = 5000;
const MAX_COPY_ATTEMPTS = 50;
/** How often a conflict reload is offered again to an editor that keeps refusing it. */
const MAX_RELOAD_ATTEMPTS = 5;

/** Detail of `cutready:document-refreshed`; cancel the event to keep unsaved edits shown. */
export interface DocumentRefreshedDetail extends SyncedDocument {
  path: string;
  document: unknown;
}

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

/** A save or load from a project that is no longer open; nothing was written or shown. */
export class DocumentSaveDroppedError extends Error {
  constructor(readonly path: string) {
    super(`${path} belongs to a project that is no longer open`);
    this.name = "DocumentSaveDroppedError";
  }
}

/** Open documents didn't finish saving in time, so a project change or rename didn't happen. */
export class DocumentsUnsettledError extends Error {
  constructor() {
    super("CutReady couldn't finish saving open documents. Nothing was moved; try again.");
    this.name = "DocumentsUnsettledError";
  }
}

/** The save needs no retry: its edits went to a conflict copy, or its project closed. */
export function isHandledSaveError(error: unknown): boolean {
  return isDocumentConflict(error) || error instanceof DocumentSaveDroppedError;
}

export function documentKind(path: string): DocumentKind {
  if (path.endsWith(".sk")) return "sketch";
  if (path.endsWith(".sb")) return "storyboard";
  return "note";
}

function currentRoot(): string {
  return useAppStore.getState().currentProject?.root ?? "";
}

function entryFor(path: string): DocumentVersionEntry {
  return documentEntry(currentRoot(), path);
}

/** Throws DocumentSaveDroppedError unless `entry` still belongs to the open project. */
function ensureCurrent(entry: DocumentVersionEntry, path: string) {
  if (!isEntryCurrent(entry, currentRoot())) throw new DocumentSaveDroppedError(path);
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
  ensureCurrent(entry, relativePath);
  const generation = ++entry.loadGeneration;
  const loaded = await documentsIpc.read<T>(kind, relativePath);
  ensureCurrent(entry, relativePath);
  if (entry.loadGeneration === generation && entry.inFlight === 0) adoptWhenSettled(entry, loaded);
  return loaded.document;
}

type SaveArgs = Record<string, unknown> & ({ relativePath: string } | { storyboardPath: string });

/**
 * Saves an open document. Saves of one document run one at a time, in order.
 * Resolves with the committed document; rejects with DocumentConflictError
 * when the save conflicted with changes made elsewhere, and with
 * DocumentSaveDroppedError when its project closed before it ran.
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
    ensureCurrent(entry, path);
    const redirect = entry.redirect?.epoch === epoch ? entry.redirect : undefined;
    if (redirect) {
      const saved = await documentsIpc.save<T>(command, { ...args, [pathKey]: redirect.path, expectedVersion: redirect.version, base: redirect.content });
      Object.assign(redirect, saved.synced ?? { content: saved.content, version: saved.version });
      entry.savedRevision = Math.max(entry.savedRevision, revision);
      return saved.document;
    }
    if (entry.base === undefined) await readBase(entry, path);
    ensureCurrent(entry, path);
    let saved: Versioned<T>;
    try {
      saved = await documentsIpc.save<T>(command, { ...args, expectedVersion: entry.baseVersion, base: entry.base });
    } catch (error) {
      if (!hasCode(error, "stale_document")) throw error;
      return await resolveConflict(entry, command, args, pathKey, revision, epoch);
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

async function createConflictCopy(entry: DocumentVersionEntry, path: string, content: string): Promise<Versioned<string> & { path: string }> {
  const stamp = conflictStamp(new Date());
  for (let attempt = 0; ; attempt += 1) {
    const copyPath = conflictPath(path, stamp, attempt);
    ensureCurrent(entry, path);
    try {
      return { ...(await documentsIpc.createCopy(copyPath, content)), path: copyPath };
    } catch (error) {
      if (!hasCode(error, "file_exists") || attempt >= MAX_COPY_ATTEMPTS) throw error;
    }
  }
}

const fileName = (path: string) => path.split("/").pop() ?? path;

/**
 * Keeps the user's edits in a sibling conflict copy, then reloads the
 * document and says so. Saves already queued for this document, and edits
 * still pending in its editors (written out now, so they queue behind them),
 * follow into the copy; the reload runs after them, and saves made after it
 * go to the document again. If the copy can't be written the save fails and
 * the document stays unsaved, so nothing replaces the edits in the editor.
 */
async function resolveConflict(
  entry: DocumentVersionEntry,
  command: DocumentSaveCommand,
  args: SaveArgs,
  pathKey: "relativePath" | "storyboardPath",
  revision: number,
  epoch: number,
): Promise<never> {
  const path = args[pathKey] as string;
  let copy: Versioned<string> & { path: string };
  let local: Versioned<unknown>;
  try {
    copy = await createConflictCopy(entry, path, entry.base ?? "");
    ensureCurrent(entry, path);
    local = await documentsIpc.save(command, { ...args, [pathKey]: copy.path, expectedVersion: copy.version, base: copy.content });
  } catch (error) {
    if (!(error instanceof DocumentSaveDroppedError)) {
      useToastStore.getState().show(
        `${fileName(path)} changed outside CutReady while you were editing, and CutReady couldn't save your edits to a conflict copy. They're still open here; try again.`,
        10000,
        "error",
      );
    }
    throw error;
  }
  entry.savedRevision = Math.max(entry.savedRevision, revision);
  entry.redirect = { epoch, path: copy.path, content: local.content, version: local.version };
  void flushEditorWrites().catch(() => undefined);
  entry.inFlight += 1;
  const reload = entry.tail.then(() => reloadAfterConflict(entry, path, copy.path));
  entry.tail = reload.catch(() => undefined);
  throw new DocumentConflictError(path, copy.path);
}

/**
 * Shows the document as it is on disk once every editor accepts it. An editor
 * with unsaved typing refuses: its edits are written out (still into the
 * copy) and the reload is offered again after them. Until an editor shows the
 * reload, saves keep going to the copy.
 */
async function reloadAfterConflict(entry: DocumentVersionEntry, path: string, copyPath: string, attempt = 0) {
  const kind = documentKind(path);
  try {
    ensureCurrent(entry, path);
    const reloaded = await documentsIpc.read(kind, path);
    ensureCurrent(entry, path);
    entry.loadGeneration += 1;
    if (install(kind, path, reloaded)) {
      // Saves made before the editor shows the reload still go to the copy.
      globalThis.setTimeout(() => {
        entry.epoch += 1;
        adopt(entry, reloaded);
      }, INSTALL_SETTLE_MS);
    } else if (attempt < MAX_RELOAD_ATTEMPTS) {
      // Flushing queues the editors' saves on this document now; the retry runs after them.
      void flushEditorWrites().catch(() => undefined);
      entry.inFlight += 1;
      const retry = entry.tail.then(() => reloadAfterConflict(entry, path, copyPath, attempt + 1));
      entry.tail = retry.catch(() => undefined);
    }
    if (attempt > 0) return;
    const app = useAppStore.getState();
    await (kind === "sketch" ? app.loadSketches() : kind === "storyboard" ? app.loadStoryboards() : app.loadNotes());
    useToastStore.getState().show(
      `${fileName(path)} changed outside CutReady while you were editing. Your edits were saved to ${fileName(copyPath)}.`,
      10000,
      "warning",
    );
  } finally {
    entry.inFlight -= 1;
  }
}

/**
 * Shows a document read from disk in the editors that have it open. An editor
 * with unsaved edits may cancel to keep them on screen; then nothing is
 * installed and this returns false.
 */
function install(kind: DocumentKind, path: string, loaded: Versioned<unknown>): boolean {
  const detail: DocumentRefreshedDetail = { path, document: loaded.document, content: loaded.content, version: loaded.version };
  if (!window.dispatchEvent(new CustomEvent("cutready:document-refreshed", { detail, cancelable: true }))) return false;
  const app = useAppStore.getState();
  if (kind === "sketch" && app.activeSketchPath === path) {
    useAppStore.setState({ activeSketch: loaded.document as typeof app.activeSketch });
  } else if (kind === "storyboard" && app.activeStoryboardPath === path) {
    useAppStore.setState({ activeStoryboard: loaded.document as typeof app.activeStoryboard });
  } else if (kind === "note" && app.activeNotePath === path) {
    useAppStore.setState({ activeNoteContent: loaded.content });
  }
  return true;
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
    if (entry.base === undefined || !isClean(entry) || !isEntryCurrent(entry, currentRoot())) return;
    const loaded = await documentsIpc.read(kind, path).catch(() => null);
    if (!loaded || loaded.version === entry.baseVersion) return;
    const { editRevision, loadGeneration } = entry;
    await flushEditorWrites().catch(() => undefined);
    if (!isEntryCurrent(entry, currentRoot())) return;
    if (entry.editRevision !== editRevision || entry.loadGeneration !== loadGeneration || !isClean(entry)) continue;
    entry.loadGeneration += 1;
    // An editor that kept its unsaved edits saves them against the old base, which merges.
    if (install(kind, path, loaded)) adoptWhenSettled(entry, loaded);
    return;
  }
}

/** Waits for `promise`, but no longer than `timeoutMs`; false if it timed out. Rejections pass through. */
async function within(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = globalThis.setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true), timedOut]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** Waits until every queued save and conflict reload has finished; false if `timeoutMs` passed first. */
function drainDocumentQueues(timeoutMs: number): Promise<boolean> {
  return within((async () => {
    for (;;) {
      const entries = documentEntries();
      const tails = entries.map((entry) => entry.tail);
      await Promise.all(tails);
      // A conflict queues its reload behind the save; wait for that too.
      if (documentEntries().every((entry) => tails[entries.indexOf(entry)] === entry.tail)) return;
    }
  })(), timeoutMs);
}

/**
 * Writes out pending editor edits and waits (at most `timeoutMs` each) for
 * them and every queued save. Throws if an edit couldn't be saved or the wait
 * timed out; nothing is stopped then, so the caller can give up and retry.
 */
async function settleDocumentSaves(timeoutMs: number): Promise<void> {
  if (!(await within(flushEditorWrites(), timeoutMs)) || !(await drainDocumentQueues(timeoutMs))) {
    throw new DocumentsUnsettledError();
  }
}

/**
 * Before opening, switching or closing a project: settles saves (throws if
 * they don't settle), then stops this project's saves and loads. Call the
 * returned function if the project stays open after all; once another
 * project opens they stay stopped.
 */
export async function quiesceDocumentSaves(timeoutMs = SETTLE_TIMEOUT_MS): Promise<() => void> {
  await settleDocumentSaves(timeoutMs);
  return closeDocumentScope();
}

/**
 * Quiesces saves for a project change. If they don't settle, shows an error
 * toast and returns null: the caller keeps the current project open.
 */
export async function beginProjectChange(timeoutMs = SETTLE_TIMEOUT_MS): Promise<(() => void) | null> {
  try {
    return await quiesceDocumentSaves(timeoutMs);
  } catch (error) {
    console.error("Open documents didn't finish saving:", error);
    useToastStore.getState().show(
      "CutReady couldn't finish saving your open documents, so the project stayed open. Try again.",
      10000,
      "error",
    );
    return null;
  }
}

/**
 * Before renaming project files: settles saves, and throws if they don't
 * settle, so nothing is renamed and the old path keeps its saves.
 */
export async function settleBeforeRename(timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
  await settleDocumentSaves(timeoutMs);
}

/** After a rename: saves of `from` stop, and saves of `to` continue from its synced text. */
export function documentRenamed(from: string, to: string) {
  moveDocumentEntry(from, to);
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
