// Helpers shared by appStore, versioningStore and syncStore: workspace
// generation guards, editor-flush suppression, workspace file rewrites,
// tab/document state helpers and remote-sync error formatting.
//
// Stores are read through `getState()` inside function bodies only, so the
// circular imports between these modules are safe.
import { setDraftlineWorkspacePath } from "../services/draftlineVersioning";
import {
  DraftlineErrorCode,
  draftlineErrorCode,
  friendlyDraftlineErrorMessage,
  mergeNeedsDeveloperMessage,
} from "../services/draftlineErrors";
import { getGitHubAuthStatus } from "../services/githubSetup";
import { draftlinePathVariants } from "../utils/draftlinePaths";
import type { ProjectView } from "../types/project";
import type { RemoteInfo } from "../types/sketch";
import { useToastStore } from "./toastStore";
import { useAppStore, type AppStoreState, type EditorTab } from "./appStore";
import { useVersioningStore } from "./versioningStore";
import { useSyncStore } from "./syncStore";

// ── Workspace generations ──────────────────────────────────

/**
 * Monotonic counter bumped whenever the active Draftline workspace changes
 * (open, create, switch, or close). Asynchronous loaders capture the value at
 * their start and reject stale continuations before applying results, so a
 * late history/dirty/sync response cannot repopulate a closed or replaced
 * workspace (issue #263).
 */
let workspaceGeneration = 0;
let remoteDetectionGeneration = 0;

export function beginWorkspaceGeneration(path: string | null): void {
  workspaceGeneration += 1;
  setDraftlineWorkspacePath(path);
}

export function currentWorkspaceGeneration(): number {
  return workspaceGeneration;
}

/** Invalidates any in-flight remote detection; returns the new generation. */
export function bumpRemoteDetectionGeneration(): number {
  remoteDetectionGeneration += 1;
  return remoteDetectionGeneration;
}

export function currentRemoteDetectionGeneration(): number {
  return remoteDetectionGeneration;
}

// ── Errors ─────────────────────────────────────────────────

export function errorMessage(error: unknown): string {
  const code = draftlineErrorCode(error);
  if (code === DraftlineErrorCode.RecoveryRequired || code === DraftlineErrorCode.WorkspaceLocked) {
    // The message points at the recovery banner; make sure it's showing.
    queueMicrotask(() => void useVersioningStore.getState().checkProjectHealth({ probeContent: false }));
  }
  const friendly = friendlyDraftlineErrorMessage(error);
  if (friendly) return friendly;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim()) return maybeMessage;
    const maybeError = (error as { error?: unknown }).error;
    if (typeof maybeError === "string" && maybeError.trim()) return maybeError;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

const GITHUB_REMOTE_AUTH_MESSAGE =
  "This project has a GitHub remote. Connect GitHub in Settings > Repository before syncing.";
const GITHUB_REMOTE_AUTH_FAILED_MESSAGE =
  "GitHub rejected the remote operation. Reconnect GitHub in Settings, then try again.";

export function remoteSyncErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("status code: 401")
    || lower.includes("\"code\":\"unauthorized\"")
    || lower.includes("authentication required")
    || lower.includes("unauthorized")
  ) {
    return GITHUB_REMOTE_AUTH_FAILED_MESSAGE;
  }
  return message;
}

export const SYNC_IN_PROGRESS_MESSAGE = "A sync is already running. Wait for it to finish, then try again.";

/** Draftline error code: bringing in the base conflicts in files outside the CutReady folder. */
export const MERGE_NEEDS_DEVELOPER = DraftlineErrorCode.MergeNeedsDeveloper;

export { mergeNeedsDeveloperMessage };

export function isMergeNeedsDeveloperError(error: unknown): boolean {
  if (draftlineErrorCode(error) === MERGE_NEEDS_DEVELOPER) return true;
  return errorMessage(error).toLowerCase().includes("merge needs a developer");
}

// ── Remote helpers ─────────────────────────────────────────

export function buildShareUrl(remoteUrl: string, branch: string): string | null {
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match) return null;
  const repo = match[1];
  if (branch === "main" || branch === "master") return `https://github.com/${repo}`;
  return `https://github.com/${repo}/compare/${branch}?expand=1`;
}

export function largeFilesSyncError(largeFiles: [string, number][]): string | null {
  if (largeFiles.length === 0) return null;
  const names = largeFiles
    .map(([p, s]) => s > 0 ? `${p} (${(s / 1024 / 1024).toFixed(1)} MB)` : p)
    .join(", ");
  return `Large files detected: ${names}. Remove or add to .gitignore before pushing.`;
}

function isGitHubRemoteUrl(remoteUrl: string): boolean {
  return /github\.com[/:][^/]+\/[^\s/]+(?:\.git)?$/i.test(remoteUrl.trim());
}

export async function ensureGitHubRemoteCredential(remote: RemoteInfo | null, notify = false): Promise<boolean> {
  if (!remote || !isGitHubRemoteUrl(remote.url)) return true;

  try {
    const status = await getGitHubAuthStatus();
    if (status.connected) return true;

    useSyncStore.setState({ syncStatus: null, incomingCommits: [], syncError: GITHUB_REMOTE_AUTH_MESSAGE });
    if (notify) {
      useToastStore.getState().show(GITHUB_REMOTE_AUTH_MESSAGE, 6000, "warning");
    }
    return false;
  } catch (error) {
    console.warn("Could not confirm GitHub auth status before sync; continuing remote operation.", error);
    return true;
  }
}

// ── Editor flushes ─────────────────────────────────────────

const suppressedEditorFlushPaths = new Set<string>();

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function scopedPathVariants(filePath: string, currentProject: ProjectView | null) {
  const { draftlinePath, projectPath } = draftlinePathVariants(filePath, currentProject);
  return { repoPath: draftlinePath, projectPath };
}

export function suppressEditorFlush(relativePath: string) {
  suppressedEditorFlushPaths.add(normalizeRelativePath(relativePath));
}

export function shouldSuppressEditorFlush(relativePath: string | null | undefined): boolean {
  return !!relativePath && suppressedEditorFlushPaths.has(normalizeRelativePath(relativePath));
}

export function clearSuppressedEditorFlush(relativePath: string) {
  suppressedEditorFlushPaths.delete(normalizeRelativePath(relativePath));
}

export function clearSuppressedEditorFlushes(relativePaths: string[]) {
  for (const relativePath of relativePaths) {
    clearSuppressedEditorFlush(relativePath);
  }
}

type EditorFlush = () => Promise<unknown> | unknown;
const editorFlushes = new Set<EditorFlush>();

/** Editors with debounced writes register here so callers can write them out on demand. */
export function registerEditorFlush(flush: EditorFlush): () => void {
  editorFlushes.add(flush);
  return () => {
    editorFlushes.delete(flush);
  };
}

/** Writes every editor's pending (debounced) changes to disk; rejects if any write failed. */
export async function flushEditorWrites(): Promise<void> {
  const results = await Promise.allSettled(Array.from(editorFlushes, async (flush) => flush()));
  const failed = results.find((result) => result.status === "rejected" || result.value === false);
  if (failed) {
    throw new Error("CutReady couldn't save an open editor's latest changes. Nothing was moved; try again.");
  }
}

// ── Tab / document state ───────────────────────────────────

export function isDocumentTab(tab: EditorTab): tab is EditorTab & { type: "sketch" | "storyboard" | "note" | "chat-artifact" } {
  return tab.type === "sketch" || tab.type === "storyboard" || tab.type === "note" || tab.type === "chat-artifact";
}

export function nextActiveTabIdAfterFiltering(previousTabs: EditorTab[], nextTabs: EditorTab[], activeTabId: string | null): string | null {
  if (!activeTabId) return null;
  if (nextTabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  if (nextTabs.length === 0) return null;
  const previousIndex = previousTabs.findIndex((tab) => tab.id === activeTabId);
  return nextTabs[Math.min(Math.max(previousIndex, 0), nextTabs.length - 1)]?.id ?? null;
}

export function clearActiveDocumentState(): Pick<AppStoreState,
  | "activeSketchPath"
  | "activeSketch"
  | "activeStoryboardPath"
  | "activeStoryboard"
  | "activeNotePath"
  | "activeNoteContent"
  | "activeNoteLocked"
  | "activeChatArtifactPath"
> {
  return {
    activeSketchPath: null,
    activeSketch: null,
    activeStoryboardPath: null,
    activeStoryboard: null,
    activeNotePath: null,
    activeNoteContent: null,
    activeNoteLocked: false,
    activeChatArtifactPath: null,
  };
}

export function loadingDocumentStateForTab(tab: EditorTab): Partial<AppStoreState> {
  if (tab.type === "sketch") {
    return {
      activeSketchPath: tab.path,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
      activeChatArtifactPath: null,
    };
  }
  if (tab.type === "storyboard") {
    return {
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: tab.path,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
      activeChatArtifactPath: null,
    };
  }
  if (tab.type === "note") {
    return {
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: tab.path,
      activeNoteContent: null,
      activeNoteLocked: false,
      activeChatArtifactPath: null,
    };
  }
  if (tab.type === "chat-artifact") {
    return {
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
      activeChatArtifactPath: tab.path,
    };
  }
  return clearActiveDocumentState();
}

export function tabExistsInLoadedProject(tab: EditorTab, state: AppStoreState): boolean {
  if (tab.type === "sketch") return state.sketches.some((sketch) => sketch.path === tab.path);
  if (tab.type === "storyboard") return state.storyboards.some((storyboard) => storyboard.path === tab.path);
  if (tab.type === "note") return state.notes.some((note) => note.path === tab.path);
  if (tab.type === "chat-artifact") return state.chatArtifacts.some((artifact) => artifact.path === tab.path);
  return true;
}

// ── Workspace file rewrites ────────────────────────────────

/**
 * Runs an operation that rewrites managed files on disk (discard, shelve).
 * Closes editors first so pending edits can't be flushed back over the result.
 */
export async function rewriteWorkspaceFiles(
  operation: () => Promise<void>,
  failureLabel: string,
  /** Rethrow instead of toasting, for callers that show the error themselves. */
  options: { rethrow?: boolean } = {},
): Promise<boolean> {
  const app = useAppStore.getState;
  const set = useAppStore.setState;
  const suppressedPaths = Array.from(new Set([
    ...app().openTabs.filter(isDocumentTab).map((tab) => tab.path),
    ...app().splitTabs.filter(isDocumentTab).map((tab) => tab.path),
    app().activeSketchPath,
    app().activeStoryboardPath,
    app().activeNotePath,
    app().activeChatArtifactPath,
  ].filter((path): path is string => !!path)));
  try {
    for (const path of suppressedPaths) suppressEditorFlush(path);
    set({
      activeSketch: null,
      activeSketchPath: null,
      activeStoryboard: null,
      activeStoryboardPath: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
      activeChatArtifactPath: null,
    });
    await operation();
    await app().loadSketches();
    await app().loadStoryboards();
    await app().loadNotes();
    await app().loadChatArtifacts();
    set({
      openTabs: [],
      activeTabId: null,
      splitTabs: [],
      splitActiveTabId: null,
      activeEditorGroup: "main",
      editorReloadPath: null,
    });
    globalThis.setTimeout(() => clearSuppressedEditorFlushes(suppressedPaths), 100);
    await useVersioningStore.getState().checkDirty();
    return true;
  } catch (err) {
    clearSuppressedEditorFlushes(suppressedPaths);
    console.error(`${failureLabel}:`, err);
    if (!options.rethrow) useToastStore.getState().show(`${failureLabel}: ${errorMessage(err)}`, 5000, "error");
    await useVersioningStore.getState().checkDirty();
    if (options.rethrow) throw err;
    return false;
  }
}

/**
 * Runs `replace`, which rewrites or removes one file on disk, with editor
 * writes for it suppressed; then reloads the sidebar and every open copy,
 * closing tabs whose file is gone. Rethrows `replace`'s error.
 */
export async function replaceWorkspaceFile(
  filePath: string,
  replace: (paths: { repoPath: string; projectPath: string }) => Promise<unknown>,
): Promise<void> {
  const get = useAppStore.getState;
  const set = useAppStore.setState;
  const { repoPath, projectPath } = scopedPathVariants(filePath, get().currentProject);
  const suppressedPaths = Array.from(new Set([filePath, repoPath, projectPath].filter(Boolean)));
  const pathMatchesDiscard = (path: string | null | undefined) => {
    if (!path) return false;
    const normalized = normalizeRelativePath(path);
    return normalized === repoPath || normalized === projectPath;
  };
  try {
    for (const path of suppressedPaths) suppressEditorFlush(path);
    await replace({ repoPath, projectPath });
    await get().loadSketches();
    await get().loadStoryboards();
    await get().loadNotes();
    await get().loadChatArtifacts();
    const {
      activeSketchPath,
      activeStoryboardPath,
      activeNotePath,
      activeChatArtifactPath,
      sketches,
      storyboards,
      notes,
      chatArtifacts,
      openTabs,
      activeTabId,
      splitTabs,
      splitActiveTabId,
      activeEditorGroup,
    } = get();
    const fileExistsForTab = (tab: EditorTab) => {
      if (!pathMatchesDiscard(tab.path) || !isDocumentTab(tab)) return true;
      if (tab.type === "sketch") return sketches.some((sketch) => sketch.path === projectPath);
      if (tab.type === "storyboard") return storyboards.some((storyboard) => storyboard.path === projectPath);
      if (tab.type === "note") return notes.some((note) => note.path === projectPath);
      return chatArtifacts.some((artifact) => artifact.path === projectPath);
    };
    const nextOpenTabs = openTabs.filter(fileExistsForTab);
    const nextSplitTabs = splitTabs.filter(fileExistsForTab);
    const nextActiveTabId = nextActiveTabIdAfterFiltering(openTabs, nextOpenTabs, activeTabId);
    const nextSplitActiveTabId = nextActiveTabIdAfterFiltering(splitTabs, nextSplitTabs, splitActiveTabId);
    const fileWasOpen = openTabs.some((tab) => isDocumentTab(tab) && pathMatchesDiscard(tab.path))
      || splitTabs.some((tab) => isDocumentTab(tab) && pathMatchesDiscard(tab.path))
      || pathMatchesDiscard(activeSketchPath)
      || pathMatchesDiscard(activeStoryboardPath)
      || pathMatchesDiscard(activeNotePath)
      || pathMatchesDiscard(activeChatArtifactPath);
    set((state) => ({
      openTabs: nextOpenTabs,
      activeTabId: nextActiveTabId,
      splitTabs: nextSplitTabs,
      splitActiveTabId: nextSplitActiveTabId,
      activeEditorGroup: nextSplitTabs.length > 0 ? activeEditorGroup : "main",
      editorReloadKey: fileWasOpen ? state.editorReloadKey + 1 : state.editorReloadKey,
      editorReloadPath: fileWasOpen ? projectPath : state.editorReloadPath,
    }));
    if (pathMatchesDiscard(activeSketchPath)) {
      set({
        activeSketchPath: null,
        activeSketch: null,
      });
      if (sketches.some((sketch) => sketch.path === projectPath)) {
        await get().openSketch(projectPath);
      } else {
        set({ activeSketchPath: null, activeSketch: null });
        if (nextActiveTabId) get().setActiveTab(nextActiveTabId);
      }
    } else if (pathMatchesDiscard(activeStoryboardPath)) {
      set({
        activeStoryboardPath: null,
        activeStoryboard: null,
      });
      if (storyboards.some((storyboard) => storyboard.path === projectPath)) {
        await get().openStoryboard(projectPath);
      } else {
        set({ activeStoryboardPath: null, activeStoryboard: null });
        if (nextActiveTabId) get().setActiveTab(nextActiveTabId);
      }
    } else if (pathMatchesDiscard(activeNotePath)) {
      set({
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
      });
      if (notes.some((note) => note.path === projectPath)) {
        await get().openNote(projectPath);
      } else {
        set({ activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
        if (nextActiveTabId) get().setActiveTab(nextActiveTabId);
      }
    } else if (pathMatchesDiscard(activeChatArtifactPath)) {
      set({ activeChatArtifactPath: null });
      if (chatArtifacts.some((artifact) => artifact.path === projectPath)) {
        await get().openChatArtifact(projectPath);
      } else {
        set({ activeChatArtifactPath: null });
        if (nextActiveTabId) get().setActiveTab(nextActiveTabId);
      }
    } else if (nextActiveTabId !== activeTabId) {
      if (nextActiveTabId) get().setActiveTab(nextActiveTabId);
      else set({
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
        activeChatArtifactPath: null,
      });
    }
    get()._persistTabs();
    globalThis.setTimeout(() => clearSuppressedEditorFlushes(suppressedPaths), 100);
    await useVersioningStore.getState().checkDirty();
  } catch (err) {
    clearSuppressedEditorFlushes(suppressedPaths);
    await useVersioningStore.getState().checkDirty();
    throw err;
  }
}
