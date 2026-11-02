import { create } from "zustand";
import { invoke, commandErrorText } from "../services/tauri";
import {
  moveDraftlineProjectFolder,
  type MoveProjectFolderResult,
} from "../services/draftlineVersioning";
import {
  DraftlineErrorCode,
  adoptionPromptFromError,
  draftlineErrorCode,
  SAVE_BEFORE_MOVE_MESSAGE,
  type AdoptionPrompt,
} from "../services/draftlineErrors";
import { recordActivityEntries } from "../services/telemetry";
import { useToastStore } from "./toastStore";
import { beginProjectChange, isHandledSaveError, loadDocument, MAIN_EDITOR, readDocument, saveDocument, type SaveOptions } from "../services/documentSaves";
import { getStoryboardSketchPaths } from "../utils/storyboard";
import type { ProjectView, ProjectEntry, RecentProject } from "../types/project";
import type {
  Sketch,
  SketchSummary,
  Storyboard,
  StoryboardSummary,
  StoryboardItem,
  NoteSummary,
} from "../types/sketch";
import { useVersioningStore, resetVersioningState } from "./versioningStore";
import { useSyncStore, resetSyncState } from "./syncStore";
import { useChatStore } from "./chatStore";
import {
  beginWorkspaceGeneration,
  bumpRemoteDetectionGeneration,
  clearActiveDocumentState,
  clearSuppressedEditorFlushes,
  errorMessage,
  flushEditorWrites,
  isDocumentTab,
  loadingDocumentStateForTab,
  shouldSuppressEditorFlush,
  suppressEditorFlush,
} from "./workspaceHelpers";

/** The Output panel keeps a rolling window; full history lives in telemetry/run state. */
export const MAX_ACTIVITY_ENTRIES = 1000;

// Shared with versioningStore/syncStore; re-exported so existing importers keep working.
export {
  errorMessage,
  remoteSyncErrorMessage,
  SYNC_IN_PROGRESS_MESSAGE,
  MERGE_NEEDS_DEVELOPER,
  mergeNeedsDeveloperMessage,
  suppressEditorFlush,
  shouldSuppressEditorFlush,
  clearSuppressedEditorFlush,
  registerEditorFlush,
  flushEditorWrites,
} from "./workspaceHelpers";

function isDatabasePath(path: string): boolean {
  const databasePath = path.split("#", 1)[0];
  return databasePath === "cutready://agent-state" || /\.(db|sqlite|sqlite3)$/i.test(databasePath);
}

/** The panels / views available in the app. */
export type AppView = "home" | "project" | "assets" | "narrations" | "recording" | "settings" | "chat" | "changes";

/** Output panel tabs. */
export type OutputTab = "activity" | "debug" | "terminal";

/** Activity log entry for the output panel. */
export interface ActivityEntry {
  id: string;
  timestamp: Date;
  source: string;
  content: string;
  level: "info" | "warn" | "error" | "success";
}

/** Sidebar display order manifest. */
export interface SidebarOrder {
  storyboards: string[];
  sketches: string[];
  notes: string[];
}

/** An open tab in the editor area. */
export interface EditorTab {
  id: string;
  type: "sketch" | "storyboard" | "note" | "chat-artifact" | "history" | "snapshot-preview" | "asset" | "diff" | "agent-run" | "database";
  path: string;
  title: string;
}

/** Generate a deterministic main-pane tab ID from type + path. */
export function makeMainTabId(type: EditorTab["type"], path: string): string {
  return `${type}-${path}`;
}

/** Generate a deterministic split-pane tab ID from type + path. */
export function makeSplitTabId(type: EditorTab["type"], path: string): string {
  return `split-${type}-${path}`;
}

/** A project asset (screenshot or visual) with reference info. */
export interface AssetInfo {
  path: string;
  size: number;
  assetType: "screenshot" | "visual";
  referencedBy: string[];
  modifiedAt: number;
}

/** A project narration/audio cut available for reuse. */
export interface NarrationAssetInfo {
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: number;
  referencedBy: string[];
}

export interface AppStoreState {
  /** Current active view. */
  view: AppView;
  /** Currently open project (null if none). */
  currentProject: ProjectView | null;
  /** Recent projects for the home screen. */
  recentProjects: RecentProject[];
  /** All projects in the current repo (empty for single-project repos). */
  projects: ProjectEntry[];
  /** Whether the current repo has multiple projects. */
  isMultiProject: boolean;
  /** Whether an operation is in progress. */
  loading: boolean;
  /** Whether a multi-project workspace is actively switching projects. */
  projectSwitching: boolean;
  /** Last error message to display in the UI. */
  error: string | null;
  /** Width of the sidebar panel in pixels. */
  sidebarWidth: number;
  /** Whether the sidebar panel is visible. */
  sidebarVisible: boolean;
  /** Whether the output/activity panel is visible. */
  outputVisible: boolean;
  /** Active output panel tab. */
  outputActiveTab: OutputTab;
  /** Height of the output panel in pixels. */
  outputHeight: number;
  /** Width of the secondary chat/history panel in pixels. */
  secondaryWidth: number;

  // ── Tabs ───────────────────────────────────────────────

  /** Open editor tabs. */
  openTabs: EditorTab[];
  /** Currently active tab id. */
  activeTabId: string | null;
  /** Tabs open in the split (right) pane. Empty = split hidden. */
  splitTabs: EditorTab[];
  /** Currently active tab in the split pane. */
  splitActiveTabId: string | null;
  /** Which editor group currently has focus ("main" or "split"). */
  activeEditorGroup: "main" | "split";
  /** Incremented to force the active editor to remount after external file restoration. */
  editorReloadKey: number;
  /** The file path associated with the latest forced editor remount. */
  editorReloadPath: string | null;

  // ── Sketch state ───────────────────────────────────────

  /** Sketch summaries for the current project. */
  sketches: SketchSummary[];
  /** The currently active sketch path (relative). */
  activeSketchPath: string | null;
  /** The full active sketch (loaded when editing). */
  activeSketch: Sketch | null;

  // ── Storyboard state ─────────────────────────────────

  /** Storyboard summaries for the current project. */
  storyboards: StoryboardSummary[];
  /** The currently active storyboard path (relative). */
  activeStoryboardPath: string | null;
  /** The full active storyboard (loaded when viewing). */
  activeStoryboard: Storyboard | null;

  // ── Note state ──────────────────────────────────────────

  /** Note summaries for the current project. */
  notes: NoteSummary[];
  /** The currently active note path (relative). */
  activeNotePath: string | null;
  /** The full active note content (loaded when editing). */
  activeNoteContent: string | null;
  /** Whether the active note is locked against editing. */
  activeNoteLocked: boolean;
  /** Note paths currently in preview mode (persists across tab switches). */
  notePreviewPaths: Set<string>;
  /** Promoted chat artifact summaries for the current project. */
  chatArtifacts: NoteSummary[];
  /** The currently active promoted chat artifact path (relative). */
  activeChatArtifactPath: string | null;

  // ── Asset state ──────────────────────────────────────────
  /** All project assets (screenshots + visuals) with reference info. */
  assets: AssetInfo[];
  /** All project narration/audio cuts available for reuse. */
  narrationAssets: NarrationAssetInfo[];

  /** Activity log entries for the output panel. */
  activityLog: ActivityEntry[];
  /** Debug log entries for the debug panel. */
  debugLog: ActivityEntry[];

  /** Whether the secondary panel is visible. */
  showSecondaryPanel: boolean;
  /** A folder the user tried to open that isn't a CutReady project yet (e.g. a code repository). */
  adoptionPrompt: AdoptionPrompt | null;
  /** Whether the "Move project folder" dialog is open. */
  moveFolderDialogOpen: boolean;

  // ── Sidebar order ────────────────────────────────────────
  /** Sidebar display order manifest (paths per category). */
  sidebarOrder: SidebarOrder | null;

  /** Clear the current error. */
  clearError: () => void;
  /** Switch to a different view. */
  setView: (view: AppView) => void;
  /** Set sidebar width. */
  setSidebarWidth: (width: number | ((current: number) => number)) => void;
  /** Toggle sidebar visibility. */
  toggleSidebar: () => void;
  /** Toggle output panel visibility. */
  toggleOutput: () => void;
  /** Show the output panel with a specific active tab. */
  showOutputTab: (tab: OutputTab) => void;
  /** Set output panel height. */
  setOutputHeight: (height: number) => void;
  /** Set secondary chat/history panel width. */
  setSecondaryWidth: (width: number | ((current: number) => number)) => void;

  // ── Tab actions ────────────────────────────────────────

  /** Open a tab (or focus if already open). */
  openTab: (tab: Omit<EditorTab, "id">) => void;
  /** Close a tab by id. */
  closeTab: (tabId: string) => void;
  /** Close all tabs except the given one. */
  closeOtherTabs: (tabId: string) => void;
  /** Close all tabs to the right of the given tab. */
  closeTabsToRight: (tabId: string) => void;
  /** Close all tabs to the left of the given tab. */
  closeTabsToLeft: (tabId: string) => void;
  /** Close all open tabs (main and split). */
  closeAllTabs: () => void;
  /** Set the active tab. */
  setActiveTab: (tabId: string) => void;
  /** Open a tab in the split (right) pane. */
  openTabInSplit: (tabId: string) => void;
  /** Close a specific tab in the split pane. */
  closeTabInSplit: (tabId: string) => void;
  /** Switch the active tab within the split pane. */
  setActiveSplitTab: (tabId: string) => void;
  /** Close the split pane (clears all split tabs). */
  closeSplit: () => void;
  /** Reorder tabs. */
  reorderTabs: (tabIds: string[]) => void;
  /** Set the active editor group ("main" or "split"). */
  setActiveEditorGroup: (group: "main" | "split") => void;
  /** Move a main tab to the split pane (removes from main, adds to split). */
  moveTabToSplit: (tabId: string) => void;
  /** Move a split tab back to the main pane (removes from split, adds/focuses in main). */
  moveTabFromSplit: (splitTabId: string) => void;
  /** Reorder tabs in the split pane. */
  reorderSplitTabs: (tabIds: string[]) => void;
  /** @internal Remove a split tab matching type+path (used by delete actions). */
  _removeSplitTabByPath: (type: EditorTab["type"], path: string) => void;
  /** @internal Persist open tabs to localStorage. */
  _persistTabs: () => void;

  // ── Project actions ───────────────────────────────────────

  loadRecentProjects: () => Promise<void>;
  removeRecentProject: (path: string) => Promise<void>;
  createProject: (path: string) => Promise<void>;
  openProject: (path: string, options?: { adopt?: boolean }) => Promise<void>;
  /** Answer the adoption prompt: create the suggested CutReady folder, manage the folder as-is, or cancel. */
  resolveAdoptionPrompt: (choice: "create" | "adopt" | "cancel") => Promise<void>;
  setMoveFolderDialogOpen: (open: boolean) => void;
  /**
   * Move the project folder to `to` (relative to its repository) as one save,
   * then reopen it there. Throws (without changing anything) when the move is refused.
   */
  moveProjectFolder: (to: string) => Promise<MoveProjectFolderResult>;
  /** Closes the project once open documents are saved (false if they couldn't be; it stays open). `force` closes at once. */
  closeProject: (options?: { force?: boolean }) => Promise<boolean>;

  // ── Multi-project actions ──────────────────────────────────

  /** Load the list of projects in the current repo. */
  loadProjects: () => Promise<void>;
  /** Switch to a different project within the repo (false if it didn't switch). */
  switchProject: (projectPath: string) => Promise<boolean>;
  /** Create a new project within the current repo. */
  createProjectInRepo: (name: string, description?: string) => Promise<void>;
  /** Delete a project from the repo. */
  deleteProjectFromRepo: (projectPath: string, deleteFiles?: boolean) => Promise<void>;

  // ── Sketch actions ─────────────────────────────────────

  /** Load sketch list for current project. */
  loadSketches: () => Promise<void>;
  /** Create a new sketch and open it. */
  createSketch: (title: string) => Promise<void>;
  /** Open a sketch for editing by path. */
  openSketch: (sketchPath: string) => Promise<void>;
  /** Update the active sketch (description and/or rows). */
  updateSketch: (update: { description?: unknown; rows?: import("../types/sketch").PlanningRow[]; metadata?: import("../types/sketch").DocumentMetadata }, options?: SaveOptions) => Promise<void>;
  /** Update a sketch's title. */
  updateSketchTitle: (sketchPath: string, title: string) => Promise<void>;
  /** Delete a sketch. */
  deleteSketch: (sketchPath: string) => Promise<void>;
  /** Close the active sketch (return to storyboard). */
  closeSketch: () => void;

  // ── Storyboard actions ───────────────────────────────

  /** Load storyboard list for current project. */
  loadStoryboards: () => Promise<void>;
  /** Create a new storyboard and open it. */
  createStoryboard: (title: string) => Promise<void>;
  /** Open a storyboard for viewing by path. */
  openStoryboard: (storyboardPath: string) => Promise<void>;
  /** Update storyboard title/description. */
  updateStoryboard: (update: { title?: string; description?: string; metadata?: import("../types/sketch").DocumentMetadata }) => Promise<void>;
  /** Lock or unlock the active storyboard. */
  setStoryboardLocked: (locked: boolean) => Promise<void>;
  /** Delete a storyboard. */
  deleteStoryboard: (storyboardPath: string) => Promise<void>;
  /** Add a sketch to the active storyboard. */
  addSketchToStoryboard: (sketchPath: string, position?: number) => Promise<void>;
  /** Remove an item from the active storyboard. */
  removeFromStoryboard: (position: number) => Promise<void>;
  /** Add a section to the active storyboard. */
  addSectionToStoryboard: (title: string, position?: number) => Promise<void>;
  /** Reorder storyboard items. */
  reorderStoryboardItems: (items: StoryboardItem[]) => Promise<void>;
  /** Close the active storyboard (return to list). */
  closeStoryboard: () => void;

  // ── Note actions ─────────────────────────────────────────

  /** Load note list for current project. */
  loadNotes: () => Promise<void>;
  /** Create a new note and open it. */
  createNote: (title: string) => Promise<void>;
  /** Open a note for editing by path. */
  openNote: (notePath: string) => Promise<void>;
  /** Update the active note content. */
  updateNote: (content: string, options?: SaveOptions) => Promise<void>;
  /** Lock or unlock a note. */
  setNoteLocked: (notePath: string, locked: boolean) => Promise<void>;
  /** Delete a note. */
  deleteNote: (notePath: string) => Promise<void>;
  /** Close the active note. */
  closeNote: () => void;
  /** Set preview mode for a note path. */
  setNotePreview: (notePath: string, preview: boolean) => void;
  /** Load promoted chat artifacts for current project. */
  loadChatArtifacts: () => Promise<void>;
  /** Open a promoted chat artifact by path. */
  openChatArtifact: (artifactPath: string) => Promise<void>;
  /** Delete a promoted chat artifact. */
  deleteChatArtifact: (artifactPath: string) => Promise<void>;

  // ── Asset actions ──────────────────────────────────────────

  /** Load assets (screenshots + visuals) for current project. */
  loadAssets: () => Promise<void>;
  /** Load narration/audio cuts for current project. */
  loadNarrationAssets: () => Promise<void>;
  /** Open an asset in a new tab. */
  openAsset: (path: string, assetType: "screenshot" | "visual") => void;
  /** Open a SQLite database in a read-only inspector tab. */
  openDatabase: (path: string, tableName?: string) => void;
  /** Import an image from the filesystem into the project. */
  importAsset: () => Promise<void>;
  /** Delete an asset file. */
  deleteAsset: (path: string) => Promise<void>;
  /** Delete unreferenced screenshot and visual files. */
  deleteUnlinkedAssets: () => Promise<number>;
  /** Delete unreferenced narration/audio files. */
  deleteUnlinkedNarrationAssets: () => Promise<number>;

  /** Add entries to activity log. */
  addActivityEntries: (entries: ActivityEntry[]) => void;
  /** Clear activity log. */
  clearActivityLog: () => void;
  /** Add a debug log entry. */
  addDebugEntry: (entry: ActivityEntry) => void;
  /** Clear debug log. */
  clearDebugLog: () => void;

  /** Toggle the secondary panel. */
  toggleSecondaryPanel: () => void;
  /** Explicitly show or hide the secondary panel. */
  setSecondaryPanelVisible: (visible: boolean) => void;
  /** Clone a workspace from a GitHub URL. */
  cloneFromUrl: (url: string, destPath: string) => Promise<boolean>;

  // ── Sidebar order actions ──────────────────────────────────

  /** Load sidebar order manifest from project. */
  loadSidebarOrder: () => Promise<void>;
  /** Save sidebar order manifest. */
  saveSidebarOrder: (order: SidebarOrder) => Promise<void>;

}

// ── Layout persistence helpers ─────────────────────────────────
const LAYOUT_KEY = "cutready:layout";

type PersistedLayout = {
  sidebarWidth: number;
  sidebarVisible: boolean;
  outputVisible: boolean;
  outputHeight: number;
  secondaryWidth: number;
  showSecondaryPanel: boolean;
};

function numberValue(data: Record<string, unknown>, key: keyof PersistedLayout): number | undefined {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key];
  return typeof value === "boolean" ? value : undefined;
}

function pruneLayout(data: Record<string, unknown>): Partial<PersistedLayout> {
  const layout: Partial<PersistedLayout> = {};
  const sidebarWidth = numberValue(data, "sidebarWidth");
  const outputHeight = numberValue(data, "outputHeight");
  const secondaryWidth = numberValue(data, "secondaryWidth");
  const sidebarVisible = booleanValue(data, "sidebarVisible");
  const outputVisible = booleanValue(data, "outputVisible");
  const showSecondaryPanel =
    booleanValue(data, "showSecondaryPanel") ?? booleanValue(data, "showVersionHistory");

  if (sidebarWidth !== undefined) layout.sidebarWidth = sidebarWidth;
  if (sidebarVisible !== undefined) layout.sidebarVisible = sidebarVisible;
  if (outputVisible !== undefined) layout.outputVisible = outputVisible;
  if (outputHeight !== undefined) layout.outputHeight = outputHeight;
  if (secondaryWidth !== undefined) layout.secondaryWidth = secondaryWidth;
  if (showSecondaryPanel !== undefined) layout.showSecondaryPanel = showSecondaryPanel;

  return layout;
}

function loadLayout(): Partial<PersistedLayout> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pruned = pruneLayout(parsed);
    if (JSON.stringify(pruned) !== JSON.stringify(parsed)) {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(pruned));
    }
    return pruned;
  } catch {
    return {};
  }
}

function saveLayout(partial: Record<string, unknown>) {
  try {
    const current = loadLayout();
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...current, ...partial }));
  } catch { /* ignore */ }
}

const savedLayout = loadLayout();

type PersistedWorkspaceState = {
  open_tabs: { id: string; type: string; path: string; title: string }[];
  active_tab_id: string | null;
  chat_session_path: string | null;
};

async function restoreWorkspaceState(get: () => AppStoreState, set: (partial: Partial<AppStoreState>) => void) {
  try {
    const ws = await invoke<PersistedWorkspaceState>("get_workspace_state");
    const { sketches, storyboards, notes, chatArtifacts } = get();
    const validTabs: EditorTab[] = (ws.open_tabs ?? [])
      .map((t) => ({ id: t.id, type: t.type as EditorTab["type"], path: t.path, title: t.title }))
      .filter((t) => {
        if (t.type === "sketch") return sketches.some((s) => s.path === t.path);
        if (t.type === "storyboard") return storyboards.some((s) => s.path === t.path);
        if (t.type === "note") return notes.some((n) => n.path === t.path);
        if (t.type === "chat-artifact") return chatArtifacts.some((artifact) => artifact.path === t.path);
        if (t.type === "database") return isDatabasePath(t.path);
        return false;
      });

    if (validTabs.length > 0) {
      const activeId = validTabs.find((t) => t.id === ws.active_tab_id)
        ? ws.active_tab_id!
        : validTabs[0].id;
      set({ openTabs: validTabs, activeTabId: activeId });
      const active = validTabs.find((t) => t.id === activeId);
      if (active?.type === "sketch") await get().openSketch(active.path);
      else if (active?.type === "storyboard") await get().openStoryboard(active.path);
      else if (active?.type === "note") await get().openNote(active.path);
      else if (active?.type === "chat-artifact") await get().openChatArtifact(active.path);
    }

    useChatStore.setState({
      chatMessages: [],
      chatSessionPath: null,
      chatLoading: false,
      chatError: null,
      chatInputDraft: "",
    });
  } catch {
    // First launch or corrupted local workspace UI state; project content still loads normally.
  }
}

function viewportWidth() {
  return typeof window === "undefined" ? 1440 : window.innerWidth;
}

function viewportHeight() {
  return typeof window === "undefined" ? 900 : window.innerHeight;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function maxWidthWithRemainder(min: number, desired: number, minRemainder: number) {
  return Math.max(min, Math.min(Math.max(min, desired), Math.max(min, viewportWidth() - minRemainder)));
}

function maxHeightWithRemainder(min: number, desired: number, minRemainder: number) {
  return Math.max(min, Math.min(Math.max(min, desired), Math.max(min, viewportHeight() - minRemainder)));
}

function clampSidebarWidth(width: number) {
  return clamp(width, 160, maxWidthWithRemainder(160, Math.max(400, viewportWidth() - 420), 320));
}

function clampSecondaryWidth(width: number) {
  return clamp(width, 260, maxWidthWithRemainder(260, Math.max(720, viewportWidth() - 360), 320));
}

function clampOutputHeight(height: number) {
  return clamp(height, 72, maxHeightWithRemainder(72, Math.max(500, viewportHeight() - 220), 160));
}

export const useAppStore = create<AppStoreState>((set, get) => ({
  view: "home",
  currentProject: null,
  recentProjects: [],
  projects: [],
  isMultiProject: false,
  loading: false,
  projectSwitching: false,
  error: null,
  sidebarWidth: clampSidebarWidth(savedLayout.sidebarWidth ?? 240),
  sidebarVisible: savedLayout.sidebarVisible ?? true,
  outputVisible: savedLayout.outputVisible ?? false,
  outputActiveTab: "activity",
  outputHeight: clampOutputHeight(savedLayout.outputHeight ?? 200),
  secondaryWidth: clampSecondaryWidth(savedLayout.secondaryWidth ?? 420),

  openTabs: [],
  activeTabId: null,
  splitTabs: [],
  splitActiveTabId: null,
  activeEditorGroup: "main",
  editorReloadKey: 0,
  editorReloadPath: null,

  sketches: [],
  activeSketchPath: null,
  activeSketch: null,
  storyboards: [],
  activeStoryboardPath: null,
  activeStoryboard: null,
  notes: [],
  activeNotePath: null,
  activeNoteContent: null,
  activeNoteLocked: false,
  notePreviewPaths: new Set(),
  chatArtifacts: [],
  activeChatArtifactPath: null,
  assets: [],
  narrationAssets: [],
  activityLog: [],
  debugLog: [],
  showSecondaryPanel: savedLayout.showSecondaryPanel ?? true,
  adoptionPrompt: null,
  moveFolderDialogOpen: false,
  sidebarOrder: null,

  clearError: () => set({ error: null }),
  setView: (view) => set({ view }),
  setSidebarWidth: (width) => {
    const next = typeof width === "function" ? width(get().sidebarWidth) : width;
    const w = clampSidebarWidth(next);
    set({ sidebarWidth: w });
    saveLayout({ sidebarWidth: w });
  },
  toggleSidebar: () => set((s) => {
    saveLayout({ sidebarVisible: !s.sidebarVisible });
    return { sidebarVisible: !s.sidebarVisible };
  }),
  toggleOutput: () => set((s) => {
    saveLayout({ outputVisible: !s.outputVisible });
    return { outputVisible: !s.outputVisible };
  }),
  showOutputTab: (tab) => {
    saveLayout({ outputVisible: true });
    set({ outputVisible: true, outputActiveTab: tab });
  },
  setOutputHeight: (height) => {
    const h = clampOutputHeight(height);
    set({ outputHeight: h });
    saveLayout({ outputHeight: h });
  },
  setSecondaryWidth: (width) => {
    const next = typeof width === "function" ? width(get().secondaryWidth) : width;
    const w = clampSecondaryWidth(next);
    set({ secondaryWidth: w });
    saveLayout({ secondaryWidth: w });
  },
  // Persist workspace state. Chat transcripts live in agent-state runs.
  _persistTabs: () => {
    const { openTabs, activeTabId } = get();
    invoke("set_workspace_state", {
      workspace: {
        open_tabs: openTabs.map((t) => ({ id: t.id, type: t.type, path: t.path, title: t.title })),
        active_tab_id: activeTabId,
        chat_session_path: null,
      },
    }).catch(() => {});
  },

  openTab: (tab) => {
    const { openTabs, view } = get();
    const existing = openTabs.find((t) => t.path === tab.path && t.type === tab.type);
    if (existing) {
      set({ activeTabId: existing.id });
    } else {
      const id = makeMainTabId(tab.type, tab.path);
      const newTab: EditorTab = { ...tab, id };
      set({ openTabs: [...openTabs, newTab], activeTabId: id });
    }
    // Navigate away from non-editor views (settings, home) to show the tab
    if (view === "settings" || view === "home" || view === "chat") {
      set({ view: "project" });
    }
    get()._persistTabs();
  },
  closeTab: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = openTabs.filter((t) => t.id !== tabId);
    let nextActive = activeTabId;
    if (activeTabId === tabId) {
      // Activate adjacent tab
      if (next.length === 0) {
        nextActive = null;
      } else if (idx < next.length) {
        nextActive = next[idx].id;
      } else {
        nextActive = next[next.length - 1].id;
      }
    }
    const nextTab = nextActive ? next.find((t) => t.id === nextActive) : undefined;
    set({
      openTabs: next,
      activeTabId: nextActive,
      ...(nextTab ? loadingDocumentStateForTab(nextTab) : clearActiveDocumentState()),
    });
    // Split tabs are independent — closing a main tab does not close its split counterpart
    // Load the new active tab's content
    if (nextTab) {
      if (nextTab?.type === "sketch") {
        get().openSketch(nextTab.path);
      } else if (nextTab?.type === "storyboard") {
        get().openStoryboard(nextTab.path);
      } else if (nextTab?.type === "note") {
        get().openNote(nextTab.path);
      } else if (nextTab?.type === "chat-artifact") {
        get().openChatArtifact(nextTab.path);
      }
    }
    get()._persistTabs();
  },
  closeOtherTabs: (tabId) => {
    const { openTabs } = get();
    const keep = openTabs.find((t) => t.id === tabId);
    if (!keep) return;
    set({ openTabs: [keep], activeTabId: tabId, ...loadingDocumentStateForTab(keep) });
    if (keep.type === "sketch") get().openSketch(keep.path);
    else if (keep.type === "storyboard") get().openStoryboard(keep.path);
    else if (keep.type === "note") get().openNote(keep.path);
    else if (keep.type === "chat-artifact") get().openChatArtifact(keep.path);
    get()._persistTabs();
  },
  closeTabsToRight: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = openTabs.slice(0, idx + 1);
    const nextActive = next.find((t) => t.id === activeTabId) ? activeTabId : next[next.length - 1]?.id ?? null;
    const nextTab = nextActive ? next.find((t) => t.id === nextActive) : undefined;
    set({
      openTabs: next,
      activeTabId: nextActive,
      ...(nextTab && nextActive !== activeTabId ? loadingDocumentStateForTab(nextTab) : {}),
      ...(!nextTab ? clearActiveDocumentState() : {}),
    });
    if (nextActive && nextActive !== activeTabId) get().setActiveTab(nextActive);
    get()._persistTabs();
  },
  closeTabsToLeft: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = openTabs.slice(idx);
    const nextActive = next.find((t) => t.id === activeTabId) ? activeTabId : next[0]?.id ?? null;
    const nextTab = nextActive ? next.find((t) => t.id === nextActive) : undefined;
    set({
      openTabs: next,
      activeTabId: nextActive,
      ...(nextTab && nextActive !== activeTabId ? loadingDocumentStateForTab(nextTab) : {}),
      ...(!nextTab ? clearActiveDocumentState() : {}),
    });
    if (nextActive && nextActive !== activeTabId) get().setActiveTab(nextActive);
    get()._persistTabs();
  },
  closeAllTabs: () => {
    set({
      openTabs: [], activeTabId: null, splitTabs: [], splitActiveTabId: null, activeEditorGroup: "main",
      ...clearActiveDocumentState(),
    });
    get()._persistTabs();
  },
  setActiveTab: (tabId) => {
    const { openTabs } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    set({ activeTabId: tabId, ...loadingDocumentStateForTab(tab) });
    if (tab.type === "sketch") {
      get().openSketch(tab.path);
    } else if (tab.type === "storyboard") {
      get().openStoryboard(tab.path);
    } else if (tab.type === "note") {
      get().openNote(tab.path);
    } else if (tab.type === "chat-artifact") {
      get().openChatArtifact(tab.path);
    }
    get()._persistTabs();
  },
  openTabInSplit: (tabId) => {
    const { openTabs, splitTabs } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Focus existing split tab if same document is already there
    const existing = splitTabs.find((t) => t.path === tab.path && t.type === tab.type);
    if (existing) {
      set({ splitActiveTabId: existing.id });
    } else {
      const splitId = makeSplitTabId(tab.type, tab.path);
      const newSplitTab: EditorTab = { ...tab, id: splitId };
      set({ splitTabs: [...splitTabs, newSplitTab], splitActiveTabId: splitId });
    }
  },
  closeTabInSplit: (tabId) => {
    const { splitTabs, splitActiveTabId } = get();
    const idx = splitTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = splitTabs.filter((t) => t.id !== tabId);
    if (next.length === 0) {
      set({ splitTabs: [], splitActiveTabId: null, activeEditorGroup: "main" });
    } else {
      let nextActive = splitActiveTabId;
      if (splitActiveTabId === tabId) {
        nextActive = idx < next.length ? next[idx].id : next[next.length - 1].id;
      }
      set({ splitTabs: next, splitActiveTabId: nextActive });
    }
  },
  setActiveSplitTab: (tabId) => {
    set({ splitActiveTabId: tabId });
  },
  closeSplit: () => {
    set({ splitTabs: [], splitActiveTabId: null, activeEditorGroup: "main" });
  },
  reorderTabs: (tabIds) => {
    const { openTabs } = get();
    const reordered = tabIds
      .map((id) => openTabs.find((t) => t.id === id))
      .filter(Boolean) as EditorTab[];
    set({ openTabs: reordered });
    get()._persistTabs();
  },

  setActiveEditorGroup: (group) => {
    set({ activeEditorGroup: group });
  },

  moveTabToSplit: (tabId) => {
    const { openTabs, activeTabId, splitTabs } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (openTabs.length < 2) return;
    // Guard: only splittable types
    if (tab.type === "history" || tab.type === "snapshot-preview" || tab.type === "asset" || tab.type === "agent-run" || tab.type === "diff" || tab.type === "database") return;

    // Remove from main
    const newOpenTabs = openTabs.filter((t) => t.id !== tabId);
    let newActiveTabId = activeTabId;
    if (activeTabId === tabId) {
      const idx = openTabs.findIndex((t) => t.id === tabId);
      newActiveTabId = newOpenTabs.length > 0
        ? (idx < newOpenTabs.length ? newOpenTabs[idx].id : newOpenTabs[newOpenTabs.length - 1].id)
        : null;
    }

    // Add to split (focus existing if same doc already there)
    const existing = splitTabs.find((t) => t.path === tab.path && t.type === tab.type);
    if (existing) {
      const nextMainTab = newActiveTabId ? newOpenTabs.find((t) => t.id === newActiveTabId) : undefined;
      set({
        openTabs: newOpenTabs,
        activeTabId: newActiveTabId,
        splitActiveTabId: existing.id,
        activeEditorGroup: "split",
        ...(nextMainTab ? loadingDocumentStateForTab(nextMainTab) : clearActiveDocumentState()),
      });
    } else {
      const splitId = makeSplitTabId(tab.type, tab.path);
      const newSplitTab: EditorTab = { ...tab, id: splitId };
      const nextMainTab = newActiveTabId ? newOpenTabs.find((t) => t.id === newActiveTabId) : undefined;
      set({
        openTabs: newOpenTabs,
        activeTabId: newActiveTabId,
        splitTabs: [...splitTabs, newSplitTab],
        splitActiveTabId: splitId,
        activeEditorGroup: "split",
        ...(nextMainTab ? loadingDocumentStateForTab(nextMainTab) : clearActiveDocumentState()),
      });
    }

    // Load content for the new active main tab (or clear)
    if (newActiveTabId) get().setActiveTab(newActiveTabId);
    else set(clearActiveDocumentState());

    get()._persistTabs();
  },

  moveTabFromSplit: (splitTabId) => {
    const { splitTabs, splitActiveTabId, openTabs } = get();
    const splitTab = splitTabs.find((t) => t.id === splitTabId);
    if (!splitTab) return;

    // Remove from split
    const newSplitTabs = splitTabs.filter((t) => t.id !== splitTabId);
    let newSplitActiveTabId = splitActiveTabId;
    if (splitActiveTabId === splitTabId) {
      const idx = splitTabs.findIndex((t) => t.id === splitTabId);
      newSplitActiveTabId = newSplitTabs.length > 0
        ? (idx < newSplitTabs.length ? newSplitTabs[idx].id : newSplitTabs[newSplitTabs.length - 1].id)
        : null;
    }
    const nextActiveEditorGroup = newSplitTabs.length === 0 ? "main" : "main";

    // Add/focus in main
    const existing = openTabs.find((t) => t.path === splitTab.path && t.type === splitTab.type);
    if (existing) {
      set({ splitTabs: newSplitTabs, splitActiveTabId: newSplitActiveTabId, activeEditorGroup: nextActiveEditorGroup });
      get().setActiveTab(existing.id);
    } else {
      const mainId = makeMainTabId(splitTab.type, splitTab.path);
      const mainTab: EditorTab = { ...splitTab, id: mainId };
      set({ splitTabs: newSplitTabs, splitActiveTabId: newSplitActiveTabId, openTabs: [...openTabs, mainTab], activeEditorGroup: nextActiveEditorGroup });
      get().setActiveTab(mainId);
    }

    get()._persistTabs();
  },

  reorderSplitTabs: (tabIds) => {
    const { splitTabs } = get();
    const reordered = tabIds.map((id) => splitTabs.find((t) => t.id === id)).filter(Boolean) as EditorTab[];
    set({ splitTabs: reordered });
  },

  _removeSplitTabByPath: (type, path) => {
    const { splitTabs, splitActiveTabId } = get();
    const next = splitTabs.filter((t) => !(t.type === type && t.path === path));
    if (next.length === splitTabs.length) return; // nothing to remove
    if (next.length === 0) {
      set({ splitTabs: [], splitActiveTabId: null, activeEditorGroup: "main" });
    } else {
      const stillActive = next.find((t) => t.id === splitActiveTabId);
      set({ splitTabs: next, splitActiveTabId: stillActive ? splitActiveTabId : next[0].id });
    }
  },

  // ── Project actions ───────────────────────────────────────

  loadRecentProjects: async () => {
    try {
      const recentProjects = await invoke<RecentProject[]>("get_recent_projects");
      set({ recentProjects });
    } catch (err) {
      console.error("Failed to load recent projects:", err);
    }
  },

  removeRecentProject: async (path) => {
    try {
      await invoke("remove_recent_project", { path });
      await get().loadRecentProjects();
    } catch (err) {
      console.error("Failed to remove recent project:", err);
    }
  },

  createProject: async (path) => {
    bumpRemoteDetectionGeneration();
    set({ loading: true });
    const releaseDocuments = await beginProjectChange();
    if (!releaseDocuments) return set({ loading: false });
    try {
      const project = await invoke<ProjectView>("create_project_folder", { path });
      beginWorkspaceGeneration(project.repo_root);
      useVersioningStore.setState(resetVersioningState());
      useSyncStore.setState(resetSyncState());
      useChatStore.setState({ chatMessages: [], chatSessionPath: null });
      set({
        currentProject: project,
        view: "project",
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        ...clearActiveDocumentState(),
      });
      localStorage.setItem("cutready:lastProject", path);
      await get().loadRecentProjects();
      await get().loadProjects();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadChatArtifacts();
      await get().loadSidebarOrder();
      await useVersioningStore.getState().loadVersions();
      await useVersioningStore.getState().loadTimelines();
      await useVersioningStore.getState().loadGraphData();
      await useVersioningStore.getState().checkDirty();
      await useVersioningStore.getState().checkRewound();
      await useVersioningStore.getState().checkStash();
      await useVersioningStore.getState().checkProjectHealth();
    } catch (err) {
      console.error("Failed to create project:", err);
      set({ error: errorMessage(err) });
    } finally {
      releaseDocuments();
      set({ loading: false });
    }
  },

  openProject: async (path, options) => {
    bumpRemoteDetectionGeneration();
    set({ loading: true, adoptionPrompt: null });
    const releaseDocuments = await beginProjectChange();
    if (!releaseDocuments) return set({ loading: false });
    try {
      const project = await invoke<ProjectView>("open_project_folder", { path, adopt: options?.adopt ?? false });
      beginWorkspaceGeneration(project.repo_root);
      useVersioningStore.setState(resetVersioningState());
      useSyncStore.setState(resetSyncState());
      useChatStore.setState({
        chatMessages: [],
        chatSessionPath: null,
        chatLoading: false,
        chatError: null,
        chatInputDraft: "",
      });
      set({
        currentProject: project,
        view: "project",
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        ...clearActiveDocumentState(),
      });
      localStorage.setItem("cutready:lastProject", path);
      // Surface interrupted operations before loaders that may refuse during recovery.
      await useVersioningStore.getState().checkProjectHealth();
      // Load multi-project state
      await get().loadProjects();
      // Load workspace settings
      const { useSettingsStore } = await import("../hooks/useSettings");
      await useSettingsStore.getState()._loadWorkspaceSettings();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadChatArtifacts();
      await get().loadSidebarOrder();
      await restoreWorkspaceState(get, set);
      await useVersioningStore.getState().loadVersions();
      await useVersioningStore.getState().loadTimelines();
      await useVersioningStore.getState().loadGraphData();
      await useVersioningStore.getState().checkDirty();
      await useVersioningStore.getState().checkRewound();
      await useVersioningStore.getState().checkStash();
      // Establish remote state before startup completes; fetching stays non-blocking.
      await useSyncStore.getState().detectRemote();
      if (useSyncStore.getState().currentRemote) {
        useSyncStore.getState().fetchFromRemote({ notifyAuthRequired: false }).catch(() => {});
      }
    } catch (err) {
      const prompt = adoptionPromptFromError(err);
      if (prompt) {
        set({ adoptionPrompt: prompt });
        return;
      }
      console.error("Failed to open project:", err);
      set({ error: errorMessage(err) });
    } finally {
      releaseDocuments();
      set({ loading: false });
    }
  },

  resolveAdoptionPrompt: async (choice) => {
    const prompt = get().adoptionPrompt;
    set({ adoptionPrompt: null });
    if (!prompt || choice === "cancel") return;
    if (choice === "adopt") {
      await get().openProject(prompt.folder, { adopt: true });
    } else if (prompt.suggestedExists) {
      // Choosing the existing folder confirms it, even if it holds other files.
      await get().openProject(prompt.suggested, { adopt: true });
    } else {
      await get().createProject(prompt.suggested);
    }
  },

  setMoveFolderDialogOpen: (open) => set({ moveFolderDialogOpen: open }),

  moveProjectFolder: async (to) => {
    const project = get().currentProject;
    if (!project) throw new Error("Open a project first.");
    // Debounced editor edits must reach disk before deciding whether anything is unsaved.
    await flushEditorWrites();
    await useVersioningStore.getState().checkDirty();
    if (useVersioningStore.getState().isDirty) throw new Error(SAVE_BEFORE_MOVE_MESSAGE);
    const oldRoot = project.repo_root;
    const openPaths = Array.from(new Set([
      ...get().openTabs.filter(isDocumentTab).map((tab) => tab.path),
      ...get().splitTabs.filter(isDocumentTab).map((tab) => tab.path),
    ]));
    // Editors must not write back into the old folder once it has moved.
    for (const path of openPaths) suppressEditorFlush(path);
    let result: MoveProjectFolderResult;
    try {
      result = await moveDraftlineProjectFolder(to);
    } catch (err) {
      if (draftlineErrorCode(err) === DraftlineErrorCode.ProjectStateStranded) {
        // Content and local history are split; stop writing until the user repairs it.
        set({ moveFolderDialogOpen: false });
        // Keep editor flushes suppressed so unmounting editors can't write into the split state.
        void get().closeProject({ force: true });
        throw err;
      }
      clearSuppressedEditorFlushes(openPaths);
      throw err;
    }
    set({ moveFolderDialogOpen: false });
    // Keep a way back to the moved project even if reopening it fails below.
    await invoke("add_recent_project", { path: result.projectRoot }).catch(console.error);
    await get().removeRecentProject(oldRoot);
    set({ error: null });
    await get().openProject(result.projectRoot);
    globalThis.setTimeout(() => clearSuppressedEditorFlushes(openPaths), 100);
    const reopened = get().currentProject;
    // openProject installs a fresh project object only when it succeeds.
    if (!reopened || reopened === project) {
      const reason = get().error ?? "it didn't open";
      void get().closeProject({ force: true });
      useToastStore.getState().show(
        `Moved the project to ${result.projectRoot}, but couldn't reopen it (${reason}). Open it from Recent Projects.`,
        10000,
        "error",
      );
      return result;
    }
    const where = result.to ? `${result.to}/` : "the repository root";
    const leftBehind = result.leftBehind.length
      ? ` ${result.leftBehind.length} untracked file${result.leftBehind.length === 1 ? "" : "s"} stayed behind: ${result.leftBehind.slice(0, 3).join(", ")}${result.leftBehind.length > 3 ? "…" : ""}`
      : "";
    useToastStore.getState().show(
      `Moved the project to ${where}. Its history moved with it.${leftBehind}`,
      leftBehind ? 8000 : 5000,
      leftBehind ? "warning" : "success",
    );
    return result;
  },

  closeProject: async (options) => {
    if (!options?.force && !(await beginProjectChange())) return false;
    bumpRemoteDetectionGeneration();
    invoke("close_project").catch(console.error);
    beginWorkspaceGeneration(null);
    localStorage.removeItem("cutready:lastProject");
    import("../hooks/useSettings").then(({ useSettingsStore }) => useSettingsStore.getState()._clearWorkspaceSettings());
    useVersioningStore.setState(resetVersioningState());
    useSyncStore.setState(resetSyncState());
    useChatStore.setState({
      chatMessages: [],
      chatSessionPath: null,
      chatLoading: false,
      chatError: null,
      pendingChatPrompt: null,
    });
    set({
      currentProject: null,
      projects: [],
      isMultiProject: false,
      view: "home",
      sketches: [],
      storyboards: [],
      notes: [],
      chatArtifacts: [],
      ...clearActiveDocumentState(),
      assets: [],
      narrationAssets: [],
      activityLog: [],
      debugLog: [],
      sidebarOrder: null,
      openTabs: [],
      activeTabId: null,
      splitTabs: [],
      splitActiveTabId: null,
      activeEditorGroup: "main",
    });
    return true;
  },

  // ── Multi-project actions ──────────────────────────────────

  loadProjects: async () => {
    try {
      const [projects, isMulti] = await Promise.all([
        invoke<ProjectEntry[]>("list_projects"),
        invoke<boolean>("is_multi_project"),
      ]);
      set({ projects, isMultiProject: isMulti });
    } catch {
      set({ projects: [], isMultiProject: false });
    }
  },

  switchProject: async (projectPath) => {
    set({ loading: true, projectSwitching: true });
    const releaseDocuments = await beginProjectChange();
    if (!releaseDocuments) {
      set({ loading: false, projectSwitching: false });
      return false;
    }
    try {
      const { openTabs, activeTabId, currentProject } = get();
      const { startedBranchFromSnapshot } = useVersioningStore.getState();
      await invoke("set_workspace_state", {
        workspace: {
          open_tabs: openTabs.map((t) => ({
            id: t.id,
            type: t.type,
            path: t.path,
            title: t.title,
          })),
          active_tab_id: activeTabId,
          chat_session_path: null,
        },
      }).catch(() => {});

      const project = await invoke<ProjectView>("switch_project", { projectPath });
      const preservesDraftlineWorkspace = currentProject?.repo_root === project.repo_root;
      beginWorkspaceGeneration(project.repo_root);
      useVersioningStore.setState({
        ...resetVersioningState(),
        startedBranchFromSnapshot: preservesDraftlineWorkspace ? startedBranchFromSnapshot : null,
      });
      useSyncStore.setState(resetSyncState());
      useChatStore.setState({
        chatMessages: [],
        chatSessionPath: null,
        chatError: null,
        chatLoading: false,
        chatInputDraft: "",
      });
      set({
        currentProject: project,
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        ...clearActiveDocumentState(),
      });
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadChatArtifacts();
      await get().loadSidebarOrder();
      await restoreWorkspaceState(get, set);
      await useVersioningStore.getState().loadVersions();
      await useVersioningStore.getState().loadTimelines();
      await useVersioningStore.getState().loadGraphData();
      await useVersioningStore.getState().checkDirty();
      await useVersioningStore.getState().checkRewound();
      await useVersioningStore.getState().checkStash();
      await useVersioningStore.getState().checkProjectHealth();
    } catch (err) {
      console.error("Failed to switch project:", err);
      set({ error: commandErrorText(err) });
      return false;
    } finally {
      releaseDocuments();
      set({ loading: false, projectSwitching: false });
    }
    return true;
  },

  createProjectInRepo: async (name, description) => {
    try {
      await invoke("create_project_in_repo", { name, description: description ?? null });
      await get().loadProjects();
    } catch (err) {
      console.error("Failed to create project:", err);
      set({ error: commandErrorText(err) });
    }
  },

  deleteProjectFromRepo: async (projectPath, deleteFiles = false) => {
    try {
      await invoke("delete_project", { projectPath, deleteFiles });
      await get().loadProjects();
      await useVersioningStore.getState().checkDirty();
      await useVersioningStore.getState().refreshChangedFiles();
      await useVersioningStore.getState().loadGraphData();
    } catch (err) {
      console.error("Failed to delete project:", err);
      const message = `Could not delete project: ${commandErrorText(err)}`;
      set({ error: message });
      useToastStore.getState().show(message, 5000, "error");
      throw err;
    }
  },

  // ── Sketch actions ─────────────────────────────────────

  loadSketches: async () => {
    try {
      const sketches = await invoke<SketchSummary[]>("list_sketches");
      set({ sketches });
    } catch (err) {
      console.error("Failed to load sketches:", err);
    }
  },

  createSketch: async (title) => {
    try {
      let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!slug) slug = `untitled-${Date.now()}`;
      const relativePath = slug + ".sk";
      const sketch = await invoke<Sketch>("create_sketch", { relativePath, title });
      set({
        activeSketchPath: relativePath,
        activeSketch: sketch,
        activeStoryboardPath: null,
        activeStoryboard: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
      });
      get().openTab({ type: "sketch", path: relativePath, title });
      await get().loadSketches();
    } catch (err) {
      console.error("Failed to create sketch:", err);
    }
  },

  openSketch: async (sketchPath) => {
    set({
      activeSketchPath: sketchPath,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
    });
    try {
      const { document: sketch, installed } = await readDocument<Sketch>("sketch", sketchPath);
      if (get().activeSketchPath !== sketchPath) return;
      set({ activeSketchPath: sketchPath, activeSketch: sketch });
      installed(MAIN_EDITOR);
      get().openTab({ type: "sketch", path: sketchPath, title: sketch.title });
    } catch (err) {
      console.error("Failed to open sketch:", err);
    }
  },

  updateSketch: async (update, options) => {
    const { activeSketchPath } = get();
    if (!activeSketchPath) return;
    if (shouldSuppressEditorFlush(activeSketchPath)) return;
    try {
      await saveDocument("update_sketch", { relativePath: activeSketchPath, ...update });
      const { activeSketch, activeSketchPath: currentActiveSketchPath } = get();
      if (activeSketch && currentActiveSketchPath === activeSketchPath) {
        set({ activeSketch: { ...activeSketch, ...update } });
      }
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update sketch:", err);
      if (options?.rethrow && !isHandledSaveError(err)) throw err;
    }
  },

  updateSketchTitle: async (sketchPath, title) => {
    // Guard: skip if navigation has cleared the active sketch
    if (!get().activeSketchPath) return;
    if (shouldSuppressEditorFlush(sketchPath)) return;
    try {
      await saveDocument("update_sketch_title", { relativePath: sketchPath, title });
      await get().loadSketches();
      const { activeSketch, activeSketchPath } = get();
      if (activeSketch && activeSketchPath === sketchPath) {
        set({ activeSketch: { ...activeSketch, title } });
      }
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update sketch title:", err);
    }
  },

  deleteSketch: async (sketchPath) => {
    try {
      await invoke("delete_sketch", { relativePath: sketchPath });
      const { activeSketchPath, openTabs } = get();
      if (activeSketchPath === sketchPath) {
        set({ activeSketchPath: null, activeSketch: null });
      }
      // Close any tab for this sketch in both panes
      const tab = openTabs.find((t) => t.path === sketchPath && t.type === "sketch");
      if (tab) get().closeTab(tab.id);
      get()._removeSplitTabByPath("sketch", sketchPath);
      await get().loadSketches();
      await get().loadStoryboards();
      const { activeStoryboardPath: currentActiveStoryboardPath } = get();
      if (currentActiveStoryboardPath) {
        const storyboard = await loadDocument<Storyboard>("storyboard", currentActiveStoryboardPath);
        if (get().activeStoryboardPath === currentActiveStoryboardPath) {
          set({ activeStoryboard: storyboard });
        }
      }
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to delete sketch:", err);
    }
  },

  closeSketch: () => {
    set({ activeSketchPath: null, activeSketch: null });
  },

  // ── Storyboard actions ───────────────────────────────

  loadStoryboards: async () => {
    try {
      const storyboards = await invoke<StoryboardSummary[]>("list_storyboards");
      set({ storyboards });
    } catch (err) {
      console.error("Failed to load storyboards:", err);
    }
  },

  createStoryboard: async (title) => {
    try {
      let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!slug) slug = `untitled-${Date.now()}`;
      const relativePath = slug + ".sb";
      const storyboard = await invoke<Storyboard>("create_storyboard", { relativePath, title });
      set({
        activeStoryboardPath: relativePath,
        activeStoryboard: storyboard,
        activeSketchPath: null,
        activeSketch: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
      });
      get().openTab({ type: "storyboard", path: relativePath, title });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to create storyboard:", err);
    }
  },

  openStoryboard: async (storyboardPath) => {
    set({
      activeStoryboardPath: storyboardPath,
      activeStoryboard: null,
      activeSketchPath: null,
      activeSketch: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
    });
    try {
      const { document: storyboard, installed } = await readDocument<Storyboard>("storyboard", storyboardPath);
      if (get().activeStoryboardPath !== storyboardPath) return;
      set({
        activeStoryboardPath: storyboardPath,
        activeStoryboard: storyboard,
        activeSketchPath: null,
        activeSketch: null,
      });
      installed(MAIN_EDITOR);
      get().openTab({ type: "storyboard", path: storyboardPath, title: storyboard.title });
    } catch (err) {
      console.error("Failed to open storyboard:", err);
    }
  },

  updateStoryboard: async (update) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    if (shouldSuppressEditorFlush(activeStoryboardPath)) return;
    try {
      const storyboard = await saveDocument<Storyboard>("update_storyboard", { relativePath: activeStoryboardPath, ...update });
      if (get().activeStoryboardPath === activeStoryboardPath) {
        set({ activeStoryboard: storyboard });
      }
      await get().loadStoryboards();
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update storyboard:", err);
    }
  },

  setStoryboardLocked: async (locked) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      const storyboard = await saveDocument<Storyboard>("set_storyboard_lock", { relativePath: activeStoryboardPath, locked });
      if (get().activeStoryboardPath === activeStoryboardPath) {
        set({ activeStoryboard: storyboard });
      }
      await get().loadStoryboards();
      await get().loadSketches();
      const { activeSketchPath, activeStoryboardPath: currentActiveStoryboardPath } = get();
      const sketchPaths = currentActiveStoryboardPath === activeStoryboardPath
        ? getStoryboardSketchPaths(storyboard)
        : [];
      if (activeSketchPath && sketchPaths.includes(activeSketchPath)) {
        await get().openSketch(activeSketchPath);
      }
      window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update storyboard lock:", err);
    }
  },

  deleteStoryboard: async (storyboardPath) => {
    try {
      await invoke("delete_storyboard", { relativePath: storyboardPath });
      const { activeStoryboardPath, openTabs } = get();
      if (activeStoryboardPath === storyboardPath) {
        set({ activeStoryboardPath: null, activeStoryboard: null });
      }
      const tab = openTabs.find((t) => t.path === storyboardPath && t.type === "storyboard");
      if (tab) get().closeTab(tab.id);
      get()._removeSplitTabByPath("storyboard", storyboardPath);
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to delete storyboard:", err);
    }
  },

  addSketchToStoryboard: async (sketchPath, position) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      const storyboard = await saveDocument<Storyboard>("add_sketch_to_storyboard", {
        storyboardPath: activeStoryboardPath,
        sketchPath,
        position: position ?? null,
      });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to add sketch to storyboard:", err);
    }
  },

  removeFromStoryboard: async (position) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      const storyboard = await saveDocument<Storyboard>("remove_sketch_from_storyboard", {
        storyboardPath: activeStoryboardPath,
        position,
      });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to remove from storyboard:", err);
    }
  },

  addSectionToStoryboard: async (title, position) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      const storyboard = await saveDocument<Storyboard>("add_section_to_storyboard", {
        storyboardPath: activeStoryboardPath,
        title,
        description: null,
        position: position ?? null,
      });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to add section:", err);
    }
  },

  reorderStoryboardItems: async (items) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      const storyboard = await saveDocument<Storyboard>("reorder_storyboard_items", {
        storyboardPath: activeStoryboardPath,
        items,
      });
      set({ activeStoryboard: storyboard });
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to reorder items:", err);
    }
  },

  closeStoryboard: () => {
    set({ activeStoryboardPath: null, activeStoryboard: null, activeSketchPath: null, activeSketch: null });
  },

  // ── Note actions ──────────────────────────────────────────

  loadNotes: async () => {
    try {
      const notes = await invoke<NoteSummary[]>("list_notes");
      set({ notes });
    } catch (err) {
      console.error("Failed to load notes:", err);
    }
  },

  createNote: async (title) => {
    try {
      let slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!slug) slug = `untitled-${Date.now()}`;
      const relativePath = slug + ".md";
      await invoke("create_note", { relativePath });
      set({
        activeNotePath: relativePath,
        activeNoteContent: "",
        activeNoteLocked: false,
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
      });
      get().openTab({ type: "note", path: relativePath, title });
      await get().loadNotes();
    } catch (err) {
      console.error("Failed to create note:", err);
    }
  },

  openNote: async (notePath) => {
    set({
      activeNotePath: notePath,
      activeNoteContent: null,
      activeNoteLocked: false,
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
    });
    try {
      const [{ document: content, installed }, lock] = await Promise.all([
        readDocument<string>("note", notePath),
        invoke<{ locked: boolean }>("get_note_lock", { relativePath: notePath }),
      ]);
      if (get().activeNotePath !== notePath) return;
      const title = notePath.replace(/\.md$/, "").split("/").pop() ?? notePath;
      set({
        activeNotePath: notePath,
        activeNoteContent: content,
        activeNoteLocked: lock.locked,
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
      });
      installed(MAIN_EDITOR);
      get().openTab({ type: "note", path: notePath, title });
    } catch (err) {
      console.error("Failed to open note:", err);
    }
  },

  updateNote: async (content, options) => {
    const { activeNotePath, activeNoteLocked } = get();
    if (!activeNotePath) return;
    if (shouldSuppressEditorFlush(activeNotePath)) return;
    if (activeNoteLocked) return;
    try {
      await saveDocument("update_note", { relativePath: activeNotePath, content });
      // Note content and dirty state live in separate stores; update both synchronously.
      if (get().activeNotePath === activeNotePath) set({ activeNoteContent: content });
      useVersioningStore.setState({ isDirty: true });
      await useVersioningStore.getState().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to update note:", err);
      if (options?.rethrow && !isHandledSaveError(err)) throw err;
    }
  },

  setNoteLocked: async (notePath, locked) => {
    try {
      const lock = await invoke<{ locked: boolean }>("set_note_lock", { relativePath: notePath, locked });
      if (get().activeNotePath === notePath) set({ activeNoteLocked: lock.locked });
    } catch (err) {
      console.error("Failed to update note lock:", err);
    }
  },

  deleteNote: async (notePath) => {
    try {
      await invoke("delete_note", { relativePath: notePath });
      const { activeNotePath, openTabs } = get();
      if (activeNotePath === notePath) {
        set({ activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
      }
      const tab = openTabs.find((t) => t.path === notePath && t.type === "note");
      if (tab) get().closeTab(tab.id);
      get()._removeSplitTabByPath("note", notePath);
      get().setNotePreview(notePath, false);
      await get().loadNotes();
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
  },

  closeNote: () => {
    set({ activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
  },

  setNotePreview: (notePath, preview) => {
    const next = new Set(get().notePreviewPaths);
    if (preview) next.add(notePath);
    else next.delete(notePath);
    set({ notePreviewPaths: next });
  },

  loadChatArtifacts: async () => {
    try {
      const chatArtifacts = await invoke<NoteSummary[]>("list_chat_artifacts");
      set({ chatArtifacts });
    } catch (err) {
      console.error("Failed to load promoted chats:", err);
    }
  },

  openChatArtifact: async (artifactPath) => {
    const title = artifactPath.replace(/\.cv$/, "").split("/").pop() ?? artifactPath;
    set({
      activeChatArtifactPath: artifactPath,
      activeSketchPath: null,
      activeSketch: null,
      activeStoryboardPath: null,
      activeStoryboard: null,
      activeNotePath: null,
      activeNoteContent: null,
      activeNoteLocked: false,
    });
    get().openTab({ type: "chat-artifact", path: artifactPath, title });
  },

  deleteChatArtifact: async (artifactPath) => {
    try {
      await invoke("delete_note", { relativePath: artifactPath });
      const { activeChatArtifactPath, openTabs } = get();
      if (activeChatArtifactPath === artifactPath) {
        set({ activeChatArtifactPath: null });
      }
      const tab = openTabs.find((t) => t.path === artifactPath && t.type === "chat-artifact");
      if (tab) get().closeTab(tab.id);
      get()._removeSplitTabByPath("chat-artifact", artifactPath);
      await get().loadChatArtifacts();
    } catch (err) {
      console.error("Failed to delete promoted chat:", err);
    }
  },

  // ── Asset actions ──────────────────────────────────────────

  loadAssets: async () => {
    try {
      const raw = await invoke<{ path: string; size: number; referencedBy: string[]; assetType: string; modifiedAt: number }[]>("list_project_images");
      const assets: AssetInfo[] = raw.map((r) => ({
        path: r.path,
        size: r.size,
        assetType: r.assetType as "screenshot" | "visual",
        referencedBy: r.referencedBy,
        modifiedAt: r.modifiedAt,
      }));
      set({ assets });
    } catch (err) {
      console.error("Failed to load assets:", err);
    }
  },

  loadNarrationAssets: async () => {
    try {
      const narrationAssets = await invoke<NarrationAssetInfo[]>("list_project_narration_assets");
      set({ narrationAssets });
    } catch (err) {
      console.error("Failed to load narration assets:", err);
      set({ narrationAssets: [] });
    }
  },

  openAsset: (path, _assetType) => {
    const filename = path.split("/").pop() ?? path;
    get().openTab({ type: "asset", path, title: filename });
    // Navigate to assets view if not already there
    if (get().view !== "assets" && get().view !== "project") {
      set({ view: "assets" });
    }
  },

  openDatabase: (path, tableName) => {
    const filename = path.split("/").pop() ?? path;
    const tabPath = tableName ? `${path}#${encodeURIComponent(tableName)}` : path;
    get().openTab({ type: "database", path: tabPath, title: tableName ? `${tableName} (${filename})` : filename });
  },

  importAsset: async () => {
    try {
      const { open } = await import("../dialogs");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
      });
      if (!selected) return;
      const filePath = typeof selected === "string" ? selected : selected;
      await invoke("import_image", { sourcePath: filePath });
      await get().loadAssets();
    } catch (err) {
      console.error("Failed to import asset:", err);
    }
  },

  deleteAsset: async (path) => {
    try {
      await invoke("delete_project_image", { relativePath: path });
      // Close any open tab for this asset
      const { openTabs, activeTabId } = get();
      const tab = openTabs.find((t) => t.type === "asset" && t.path === path);
      if (tab) {
        const filtered = openTabs.filter((t) => t.id !== tab.id);
        set({
          openTabs: filtered,
          activeTabId: activeTabId === tab.id ? (filtered[filtered.length - 1]?.id ?? null) : activeTabId,
        });
      }
      await get().loadAssets();
    } catch (err) {
      console.error("Failed to delete asset:", err);
    }
  },

  deleteUnlinkedAssets: async () => {
    try {
      const candidatePaths = get().assets
        .filter((asset) => asset.referencedBy.length === 0)
        .map((asset) => asset.path);
      const deleted = await invoke<number>("delete_orphaned_images");
      const { openTabs, activeTabId } = get();
      const filtered = openTabs.filter((tab) => tab.type !== "asset" || !candidatePaths.includes(tab.path));
      set({
        openTabs: filtered,
        activeTabId: filtered.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : (filtered[filtered.length - 1]?.id ?? null),
      });
      await get().loadAssets();
      return deleted;
    } catch (err) {
      console.error("Failed to delete unlinked assets:", err);
      throw err;
    }
  },

  deleteUnlinkedNarrationAssets: async () => {
    try {
      const candidatePaths = get().narrationAssets
        .filter((asset) => asset.referencedBy.length === 0 && asset.path.startsWith(".cutready/narration/"))
        .map((asset) => asset.path);
      const deleted = await invoke<number>("delete_orphaned_narration_assets");
      const { openTabs, activeTabId } = get();
      const filtered = openTabs.filter((tab) => tab.type !== "asset" || !candidatePaths.includes(tab.path));
      set({
        openTabs: filtered,
        activeTabId: filtered.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : (filtered[filtered.length - 1]?.id ?? null),
      });
      await get().loadNarrationAssets();
      return deleted;
    } catch (err) {
      console.error("Failed to delete unlinked narration assets:", err);
      throw err;
    }
  },

  addActivityEntries: (entries) => {
    recordActivityEntries(entries);
    set((s) => ({ activityLog: [...s.activityLog, ...entries].slice(-MAX_ACTIVITY_ENTRIES) }));
  },
  clearActivityLog: () => set({ activityLog: [] }),
  addDebugEntry: (entry) => set((s) => ({ debugLog: [...s.debugLog.slice(-499), entry] })),
  clearDebugLog: () => set({ debugLog: [] }),

  // ── Layout actions ─────────────────────────────────────

  toggleSecondaryPanel: () => {
    set((state) => {
      saveLayout({ showSecondaryPanel: !state.showSecondaryPanel });
      return { showSecondaryPanel: !state.showSecondaryPanel };
    });
  },
  setSecondaryPanelVisible: (visible) => {
    saveLayout({ showSecondaryPanel: visible });
    set({ showSecondaryPanel: visible });
  },

  // ── Clone ───────────────────────────────────────────────

  cloneFromUrl: async (url, destPath) => {
    set({ loading: true });
    try {
      await invoke("clone_from_url", { url, dest: destPath });
      // Open the cloned project
      await get().openProject(destPath);
      return true;
    } catch (err) {
      console.error("Failed to clone:", err);
      set({ error: String(err) });
      return false;
    } finally {
      set({ loading: false });
    }
  },

  // ── Sidebar order actions ──────────────────────────────────

  loadSidebarOrder: async () => {
    try {
      const order = await invoke<SidebarOrder>("get_sidebar_order");
      set({ sidebarOrder: order });
    } catch {
      set({ sidebarOrder: null });
    }
  },

  saveSidebarOrder: async (order) => {
    set({ sidebarOrder: order });
    try {
      await invoke("set_sidebar_order", { order });
    } catch (err) {
      console.error("Failed to save sidebar order:", err);
    }
  },
}));

// Expose store on window in dev mode for Playwright/debugging
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__CUTREADY_STORE__ = useAppStore;
}
