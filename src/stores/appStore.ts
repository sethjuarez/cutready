import { create } from "zustand";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useToastStore } from "./toastStore";
import type { ProjectView, ProjectEntry, RecentProject } from "../types/project";
import type {
  BrowserProfile,
  BrowserRunningStatus,
  CapturedAction,
  RecordedSession,
} from "../types/recording";
import type {
  Sketch,
  SketchSummary,
  Storyboard,
  StoryboardSummary,
  StoryboardItem,
  VersionEntry,
  TimelineInfo,
  GraphNode,
  NoteSummary,
  ChatMessage,
  ChatSessionSummary,
  RemoteInfo,
  SyncStatus,
  IncomingCommit,
  DiffEntry,
  ConflictFile,
  MergeResult,
  FileResolution,
} from "../types/sketch";

/** The panels / views available in the app. */
export type AppView = "home" | "project" | "sketch" | "assets" | "editor" | "recording" | "settings" | "chat" | "changes";

/** Sidebar position. */
export type SidebarPosition = "left" | "right";

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
  type: "sketch" | "storyboard" | "note" | "history" | "asset" | "diff";
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

function buildShareUrl(remoteUrl: string, branch: string): string | null {
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match) return null;
  const repo = match[1];
  if (branch === "main" || branch === "master") return `https://github.com/${repo}`;
  return `https://github.com/${repo}/compare/${branch}?expand=1`;
}

/** A project asset (screenshot or visual) with reference info. */
export interface AssetInfo {
  path: string;
  size: number;
  assetType: "screenshot" | "visual";
  referencedBy: string[];
  modifiedAt: number;
}

interface AppStoreState {
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
  /** Last error message to display in the UI. */
  error: string | null;
  /** Width of the sidebar panel in pixels. */
  sidebarWidth: number;
  /** Whether the sidebar panel is visible. */
  sidebarVisible: boolean;
  /** Whether the output/activity panel is visible. */
  outputVisible: boolean;
  /** Height of the output panel in pixels. */
  outputHeight: number;
  /** Width of the secondary chat/history panel in pixels. */
  secondaryWidth: number;
  /** Sidebar position: left or right. */
  sidebarPosition: SidebarPosition;

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

  // ── Asset state ──────────────────────────────────────────
  /** All project assets (screenshots + visuals) with reference info. */
  assets: AssetInfo[];

  // ── Chat state ──────────────────────────────────────────────
  /** Messages in the current chat session. */
  chatMessages: ChatMessage[];
  /** Relative path of the current chat session file (null = unsaved). */
  chatSessionPath: string | null;
  /** Whether the chat is waiting for a response. */
  chatLoading: boolean;
  /** Last chat error message. */
  chatError: string | null;
  /** A prompt queued from outside the chat (e.g. sparkle buttons). ChatPanel picks this up and sends it. */
  pendingChatPrompt: { text: string; silent?: boolean; agent?: string } | null;
  /** Activity log entries for the output panel. */
  activityLog: ActivityEntry[];
  /** Debug log entries for the debug panel. */
  debugLog: ActivityEntry[];

  /** Version history for the current project. */
  versions: VersionEntry[];
  /** All timelines (branches) in the project. */
  timelines: TimelineInfo[];
  /** Full graph data for SVG rendering. */
  graphNodes: GraphNode[];
  /** Whether the secondary panel is visible. */
  showSecondaryPanel: boolean;
  /** Whether the snapshot name prompt should be shown (triggered by Ctrl+S). */
  snapshotPromptOpen: boolean;
  /** Whether the identity prompt dialog should be shown. */
  identityPromptOpen: boolean;
  /** Callback to run after identity is set (opens snapshot dialog). */
  identityPromptCallback: (() => void) | null;
  /** After saving a snapshot, navigate to this commit ID (used by nav-save flow). */
  pendingNavAfterSave: string | null;
  /** Whether there are unsaved changes since the last snapshot. */
  isDirty: boolean;
  /** List of changed files since last snapshot (for Changes panel). */
  changedFiles: DiffEntry[];
  /** Whether a quickSave is in progress. */
  saving: boolean;
  /** Whether a stash (temporarily saved work) exists. */
  hasStash: boolean;
  /** Whether we are viewing a rewound snapshot (prev-tip exists). */
  isRewound: boolean;

  // ── Remote sync ─────────────────────────────────────────
  /** Detected/configured remote, null if none. */
  currentRemote: RemoteInfo | null;
  /** Ahead/behind counts vs remote tracking branch. */
  syncStatus: SyncStatus | null;
  /** Whether a fetch/push/pull is in progress. */
  isSyncing: boolean;
  /** Last error from a sync operation. */
  syncError: string | null;
  /** Incoming snapshots discovered by the latest fetch. */
  incomingCommits: IncomingCommit[];
  /** Share/PR URL for the latest successful share operation. */
  shareUrl: string | null;

  // ── Merge ──────────────────────────────────────────────────
  /** Whether a merge is in progress (conflicts being resolved). */
  isMerging: boolean;
  /** Source timeline for the in-progress merge. */
  mergeSource: string | null;
  /** Target timeline for the in-progress merge. */
  mergeTarget: string | null;
  /** Conflict files from the merge engine (empty = clean merge). */
  mergeConflicts: ConflictFile[];

  // ── Diff ──────────────────────────────────────────────────
  /** Currently selected diff result (file changes between two snapshots). */
  diffResult: DiffEntry[] | null;
  /** The two commit IDs being compared for diff. */
  diffSelection: { from: string; to: string } | null;

  // ── Sidebar order ────────────────────────────────────────
  /** Sidebar display order manifest (paths per category). */
  sidebarOrder: SidebarOrder | null;

  // ── Profile detection ─────────────────────────────────────

  /** Browser profiles detected on the system. */
  profiles: BrowserProfile[];
  /** Which profile the user has selected (null for fresh browser). */
  selectedProfile: BrowserProfile | null;
  /** Which browsers are currently running. */
  browserRunning: BrowserRunningStatus | null;

  // ── Browser lifecycle ─────────────────────────────────────

  /** Whether a recording browser is connected and ready. */
  isBrowserReady: boolean;
  /** Which browser channel was used ("chrome", "msedge", "chromium"). */
  browserChannel: string | null;

  // ── Recording lifecycle ───────────────────────────────────

  /** Whether a recording (observation) is currently active. */
  isRecording: boolean;
  /** The ID of the active recording session. */
  recordingSessionId: string | null;
  /** Captured actions from the active (or most recent) recording session. */
  capturedActions: CapturedAction[];
  /** The most recently completed session. */
  lastSession: RecordedSession | null;
  /** Active channel reference (prevents GC during recording). */
  _activeChannel: Channel<CapturedAction> | null;

  /** Clear the current error. */
  clearError: () => void;
  /** Switch to a different view. */
  setView: (view: AppView) => void;
  /** Set sidebar width. */
  setSidebarWidth: (width: number) => void;
  /** Toggle sidebar visibility. */
  toggleSidebar: () => void;
  /** Toggle output panel visibility. */
  toggleOutput: () => void;
  /** Set output panel height. */
  setOutputHeight: (height: number) => void;
  /** Set secondary chat/history panel width. */
  setSecondaryWidth: (width: number | ((current: number) => number)) => void;
  /** Toggle sidebar position (left/right). */
  toggleSidebarPosition: () => void;

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
  openProject: (path: string) => Promise<void>;
  closeProject: () => void;

  // ── Multi-project actions ──────────────────────────────────

  /** Load the list of projects in the current repo. */
  loadProjects: () => Promise<void>;
  /** Switch to a different project within the repo. */
  switchProject: (projectPath: string) => Promise<void>;
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
  updateSketch: (update: { description?: unknown; rows?: import("../types/sketch").PlanningRow[] }) => Promise<void>;
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
  updateStoryboard: (update: { title?: string; description?: string }) => Promise<void>;
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
  updateNote: (content: string) => Promise<void>;
  /** Lock or unlock a note. */
  setNoteLocked: (notePath: string, locked: boolean) => Promise<void>;
  /** Delete a note. */
  deleteNote: (notePath: string) => Promise<void>;
  /** Close the active note. */
  closeNote: () => void;
  /** Set preview mode for a note path. */
  setNotePreview: (notePath: string, preview: boolean) => void;

  // ── Asset actions ──────────────────────────────────────────

  /** Load assets (screenshots + visuals) for current project. */
  loadAssets: () => Promise<void>;
  /** Open an asset in a new tab. */
  openAsset: (path: string, assetType: "screenshot" | "visual") => void;
  /** Import an image from the filesystem into the project. */
  importAsset: () => Promise<void>;
  /** Delete an asset file. */
  deleteAsset: (path: string) => Promise<void>;

  // ── Chat actions ────────────────────────────────────────────

  /** Set chat messages (updates store + auto-saves to disk). */
  setChatMessages: (messages: ChatMessage[]) => void;
  /** Start a new chat session (clears messages, assigns path). */
  newChatSession: () => void;
  /** Load a saved chat session by path. */
  loadChatSession: (sessionPath: string) => Promise<void>;
  /** Save the current chat session to disk. */
  saveChatSession: () => Promise<void>;
  /** Set chat loading state. */
  setChatLoading: (loading: boolean) => void;
  /** Set chat error. */
  setChatError: (error: string | null) => void;
  /** Queue a prompt to be sent by the chat panel. */
  sendChatPrompt: (prompt: string, opts?: { silent?: boolean; agent?: string }) => void;
  /** Add entries to activity log. */
  addActivityEntries: (entries: ActivityEntry[]) => void;
  /** Clear activity log. */
  clearActivityLog: () => void;
  /** Add a debug log entry. */
  addDebugEntry: (entry: ActivityEntry) => void;
  /** Clear debug log. */
  clearDebugLog: () => void;
  /** List saved chat sessions. */
  listChatSessions: () => Promise<ChatSessionSummary[]>;
  /** Delete a chat session. */
  deleteChatSession: (sessionPath: string) => Promise<void>;

  // ── Versioning actions ───────────────────────────────────

  /** Load version history. */
  loadVersions: () => Promise<void>;
  /** Check if working directory has unsaved changes. */
  checkDirty: () => Promise<void>;
  /** Refresh list of changed files since last snapshot. */
  refreshChangedFiles: () => Promise<void>;
  /** Save a labeled version. Optional forkLabel for naming the old timeline when forking. */
  saveVersion: (label: string, forkLabel?: string) => Promise<void>;
  /** Stash dirty working tree before browsing snapshots. */
  stashChanges: () => Promise<void>;
  /** Discard all working-directory changes, resetting to last snapshot. */
  discardChanges: () => Promise<void>;
  /** Discard changes for one file. */
  discardFile: (filePath: string) => Promise<void>;
  /** Pop stash (restore stashed work). */
  popStash: () => Promise<void>;
  /** Check whether a stash exists. */
  checkStash: () => Promise<void>;
  /** Check whether we are in a rewound state (prev-tip exists). */
  checkRewound: () => Promise<void>;
  /** Navigate to any snapshot. Defers fork until commit. */
  navigateToSnapshot: (commitId: string) => Promise<void>;
  /** Create a new timeline from a snapshot. */
  createTimeline: (fromCommitId: string, name: string) => Promise<void>;
  /** Load all timelines. */
  loadTimelines: () => Promise<void>;
  /** Switch to a different timeline. */
  switchTimeline: (name: string) => Promise<void>;
  /** Delete a non-active timeline. */
  deleteTimeline: (name: string) => Promise<void>;
  /** Promote a fork timeline to become the new main. */
  promoteTimeline: (name: string) => Promise<void>;
  /** Load full graph data for SVG rendering. */
  loadGraphData: () => Promise<void>;
  /** Toggle the secondary panel. */
  toggleSecondaryPanel: () => void;
  /** Open the named snapshot flow for legacy quick-save callers. */
  quickSave: () => Promise<void>;
  /** Open snapshot name prompt (and ensure panel is visible). */
  promptSnapshot: () => Promise<void>;
  /** Squash a HEAD-anchored range of snapshots into one named snapshot. */
  squashSnapshots: (oldestCommitId: string, newestCommitId: string, label: string) => Promise<void>;

  // ── Remote sync actions ────────────────────────────────────
  /** Detect configured remote for the project. */
  detectRemote: () => Promise<void>;
  /** Fetch from the remote. */
  fetchFromRemote: () => Promise<void>;
  /** Push current timeline to the remote. */
  pushToRemote: () => Promise<void>;
  /** Pull from remote (fast-forward merge). */
  pullFromRemote: () => Promise<void>;
  /** Sync: fetch then push (or pull if behind). */
  syncWithRemote: () => Promise<void>;
  /** Share local changes safely with collaborators. */
  shareChanges: () => Promise<void>;
  /** Refresh incoming remote snapshot preview. */
  refreshIncomingCommits: () => Promise<void>;
  /** Refresh the ahead/behind sync status. */
  refreshSyncStatus: () => Promise<void>;
  /** List branches available on the remote. */
  loadRemoteBranches: () => Promise<string[]>;
  /** Checkout a remote-only branch as a local tracking branch. */
  checkoutRemoteTimeline: (branch: string) => Promise<void>;
  /** Publish (push) the current local-only timeline to the remote. */
  publishTimeline: () => Promise<void>;

  // ── Diff ──────────────────────────────────────────────────
  /** Compare two snapshots and return file-level diffs. */
  diffSnapshots: (fromCommit: string, toCommit: string) => Promise<DiffEntry[]>;
  /** Compare HEAD against the working directory. */
  diffWorkingTree: () => Promise<DiffEntry[]>;
  /** Check for large files before pushing. Returns list of (path, size). */
  checkLargeFiles: () => Promise<Array<[string, number]>>;
  /** Clone a workspace from a GitHub URL. */
  cloneFromUrl: (url: string, destPath: string) => Promise<boolean>;

  // ── Merge actions ────────────────────────────────────────
  /** Merge source timeline into target timeline. */
  mergeTimelines: (source: string, target: string) => Promise<MergeResult>;
  /** Apply user-provided conflict resolutions and create merge commit. */
  applyMergeResolution: (resolutions: FileResolution[]) => Promise<string>;
  /** Cancel an in-progress merge. */
  cancelMerge: () => void;

  // ── Sidebar order actions ──────────────────────────────────

  /** Load sidebar order manifest from project. */
  loadSidebarOrder: () => Promise<void>;
  /** Save sidebar order manifest. */
  saveSidebarOrder: (order: SidebarOrder) => Promise<void>;

  // ── Profile actions ───────────────────────────────────────

  /** Detect browser profiles available on the system. */
  detectProfiles: () => Promise<void>;
  /** Check which browsers are currently running. */
  checkBrowsersRunning: () => Promise<void>;
  /** Select a profile (or null for fresh browser). */
  setSelectedProfile: (profile: BrowserProfile | null) => void;

  // ── Browser actions ───────────────────────────────────────

  /** Launch a recording browser (with selected profile or fresh). */
  prepareBrowser: () => Promise<void>;
  /** Close the recording browser and disconnect. */
  disconnectBrowser: () => Promise<void>;

  // ── Recording actions ─────────────────────────────────────

  /** Start observing in the prepared browser. */
  startRecording: () => Promise<void>;
  /** Stop the active recording (browser stays open). */
  stopRecording: () => Promise<void>;
}

// ── Layout persistence helpers ─────────────────────────────────
const LAYOUT_KEY = "cutready:layout";

function loadLayout(): Partial<{
  sidebarWidth: number;
  sidebarVisible: boolean;
  sidebarPosition: "left" | "right";
  outputVisible: boolean;
  outputHeight: number;
  secondaryWidth: number;
  showSecondaryPanel: boolean;
}> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const legacySecondary = typeof parsed["showSecondaryPanel"] === "boolean"
      ? parsed["showSecondaryPanel"]
      : typeof parsed["showVersionHistory"] === "boolean"
        ? parsed["showVersionHistory"]
        : undefined;
    return {
      ...parsed,
      ...(legacySecondary === undefined ? {} : { showSecondaryPanel: legacySecondary }),
    };
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

export const useAppStore = create<AppStoreState>((set, get) => ({
  view: "home",
  currentProject: null,
  recentProjects: [],
  projects: [],
  isMultiProject: false,
  loading: false,
  error: null,
  sidebarWidth: savedLayout.sidebarWidth ?? 240,
  sidebarVisible: savedLayout.sidebarVisible ?? true,
  outputVisible: savedLayout.outputVisible ?? false,
  outputHeight: savedLayout.outputHeight ?? 200,
  secondaryWidth: savedLayout.secondaryWidth ?? 420,
  sidebarPosition: savedLayout.sidebarPosition ?? "left",

  openTabs: [],
  activeTabId: null,
  splitTabs: [],
  splitActiveTabId: null,
  activeEditorGroup: "main",
  editorReloadKey: 0,

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
  assets: [],
  chatMessages: [],
  chatSessionPath: null,
  chatLoading: false,
  chatError: null,
  pendingChatPrompt: null,
  activityLog: [],
  debugLog: [],
  versions: [],
  timelines: [],
  graphNodes: [],
  showSecondaryPanel: savedLayout.showSecondaryPanel ?? false,
  snapshotPromptOpen: false,
  identityPromptOpen: false,
  identityPromptCallback: null,
  pendingNavAfterSave: null,
  isDirty: false,
  changedFiles: [],
  saving: false,
  hasStash: false,
  isRewound: false,
  currentRemote: null,
  syncStatus: null,
  isSyncing: false,
  syncError: null,
  incomingCommits: [],
  shareUrl: null,
  isMerging: false,
  mergeSource: null,
  mergeTarget: null,
  mergeConflicts: [],
  diffResult: null,
  diffSelection: null,
  sidebarOrder: null,

  profiles: [],

  selectedProfile: null,
  browserRunning: null,

  isBrowserReady: false,
  browserChannel: null,

  isRecording: false,
  recordingSessionId: null,
  capturedActions: [],
  lastSession: null,
  _activeChannel: null,

  clearError: () => set({ error: null }),
  setView: (view) => set({ view }),
  setSidebarWidth: (width) => {
    const w = Math.min(400, Math.max(180, width));
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
  setOutputHeight: (height) => {
    const h = Math.min(500, Math.max(80, height));
    set({ outputHeight: h });
    saveLayout({ outputHeight: h });
  },
  setSecondaryWidth: (width) => {
    const next = typeof width === "function" ? width(get().secondaryWidth) : width;
    const w = Math.min(720, Math.max(320, next));
    set({ secondaryWidth: w });
    saveLayout({ secondaryWidth: w });
  },
  toggleSidebarPosition: () => set((s) => {
    const pos = s.sidebarPosition === "left" ? "right" : "left";
    saveLayout({ sidebarPosition: pos });
    return { sidebarPosition: pos };
  }),

  // Persist workspace state (tabs + chat session) to .cutready/workspace.json
  _persistTabs: () => {
    const { openTabs, activeTabId, chatSessionPath } = get();
    invoke("set_workspace_state", {
      workspace: {
        open_tabs: openTabs.map((t) => ({ id: t.id, type: t.type, path: t.path, title: t.title })),
        active_tab_id: activeTabId,
        chat_session_path: chatSessionPath,
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
    if (view === "settings" || view === "home") {
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
    set({ openTabs: next, activeTabId: nextActive });
    // Split tabs are independent — closing a main tab does not close its split counterpart
    // Load the new active tab's content
    if (nextActive) {
      const nextTab = next.find((t) => t.id === nextActive);
      if (nextTab?.type === "sketch") {
        get().openSketch(nextTab.path);
      } else if (nextTab?.type === "storyboard") {
        get().openStoryboard(nextTab.path);
      } else if (nextTab?.type === "note") {
        get().openNote(nextTab.path);
      }
    } else {
      set({ activeSketchPath: null, activeSketch: null, activeStoryboardPath: null, activeStoryboard: null, activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
    }
    get()._persistTabs();
  },
  closeOtherTabs: (tabId) => {
    const { openTabs } = get();
    const keep = openTabs.find((t) => t.id === tabId);
    if (!keep) return;
    set({ openTabs: [keep], activeTabId: tabId });
    if (keep.type === "sketch") get().openSketch(keep.path);
    else if (keep.type === "storyboard") get().openStoryboard(keep.path);
    else if (keep.type === "note") get().openNote(keep.path);
    get()._persistTabs();
  },
  closeTabsToRight: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = openTabs.slice(0, idx + 1);
    const nextActive = next.find((t) => t.id === activeTabId) ? activeTabId : next[next.length - 1]?.id ?? null;
    set({ openTabs: next, activeTabId: nextActive });
    if (nextActive && nextActive !== activeTabId) get().setActiveTab(nextActive);
    get()._persistTabs();
  },
  closeTabsToLeft: (tabId) => {
    const { openTabs, activeTabId } = get();
    const idx = openTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const next = openTabs.slice(idx);
    const nextActive = next.find((t) => t.id === activeTabId) ? activeTabId : next[0]?.id ?? null;
    set({ openTabs: next, activeTabId: nextActive });
    if (nextActive && nextActive !== activeTabId) get().setActiveTab(nextActive);
    get()._persistTabs();
  },
  closeAllTabs: () => {
    set({
      openTabs: [], activeTabId: null, splitTabs: [], splitActiveTabId: null, activeEditorGroup: "main",
      activeSketchPath: null, activeSketch: null,
      activeStoryboardPath: null, activeStoryboard: null,
      activeNotePath: null, activeNoteContent: null, activeNoteLocked: false,
    });
    get()._persistTabs();
  },
  setActiveTab: (tabId) => {
    const { openTabs } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    set({ activeTabId: tabId });
    if (tab.type === "sketch") {
      set({ activeStoryboardPath: null, activeStoryboard: null, activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
      get().openSketch(tab.path);
    } else if (tab.type === "storyboard") {
      set({ activeSketchPath: null, activeSketch: null, activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
      get().openStoryboard(tab.path);
    } else if (tab.type === "note") {
      set({ activeSketchPath: null, activeSketch: null, activeStoryboardPath: null, activeStoryboard: null });
      get().openNote(tab.path);
    } else if (tab.type === "history") {
      set({ activeSketchPath: null, activeSketch: null, activeStoryboardPath: null, activeStoryboard: null, activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
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
    // Guard: only splittable types
    if (tab.type === "history" || tab.type === "asset") return;

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
      set({ openTabs: newOpenTabs, activeTabId: newActiveTabId, splitActiveTabId: existing.id, activeEditorGroup: "split" });
    } else {
      const splitId = makeSplitTabId(tab.type, tab.path);
      const newSplitTab: EditorTab = { ...tab, id: splitId };
      set({ openTabs: newOpenTabs, activeTabId: newActiveTabId, splitTabs: [...splitTabs, newSplitTab], splitActiveTabId: splitId, activeEditorGroup: "split" });
    }

    // Load content for the new active main tab (or clear)
    if (newActiveTabId) get().setActiveTab(newActiveTabId);
    else set({ activeSketchPath: null, activeSketch: null, activeStoryboardPath: null, activeStoryboard: null, activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });

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
    set({ loading: true });
    try {
      const project = await invoke<ProjectView>("create_project_folder", { path });
      set({
        currentProject: project,
        view: "project",
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
        chatMessages: [],
        chatSessionPath: null,
      });
      localStorage.setItem("cutready:lastProject", path);
      await get().loadRecentProjects();
      await get().loadProjects();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadSidebarOrder();
    } catch (err) {
      console.error("Failed to create project:", err);
      set({ error: String(err) });
    } finally {
      set({ loading: false });
    }
  },

  openProject: async (path) => {
    set({ loading: true });
    try {
      const project = await invoke<ProjectView>("open_project_folder", { path });
      set({
        currentProject: project,
        view: "project",
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
      });
      localStorage.setItem("cutready:lastProject", path);
      // Load multi-project state
      await get().loadProjects();
      // Load workspace settings
      const { useSettingsStore } = await import("../hooks/useSettings");
      await useSettingsStore.getState()._loadWorkspaceSettings();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadSidebarOrder();
      // Restore workspace state (open tabs + chat session) from disk
      try {
        const ws = await invoke<{ open_tabs: { id: string; type: string; path: string; title: string }[]; active_tab_id: string | null; chat_session_path: string | null }>("get_workspace_state");
        const { sketches, storyboards, notes } = get();
        const validTabs: EditorTab[] = (ws.open_tabs ?? [])
          .map((t) => ({ id: t.id, type: t.type as EditorTab["type"], path: t.path, title: t.title }))
          .filter((t) => {
            if (t.type === "sketch") return sketches.some((s) => s.path === t.path);
            if (t.type === "storyboard") return storyboards.some((s) => s.path === t.path);
            if (t.type === "note") return notes.some((n) => n.path === t.path);
            return false;
          });
        if (validTabs.length > 0) {
          const activeId = validTabs.find((t) => t.id === ws.active_tab_id) ? ws.active_tab_id! : validTabs[0].id;
          set({ openTabs: validTabs, activeTabId: activeId });
          const active = validTabs.find((t) => t.id === activeId);
          if (active?.type === "sketch") await get().openSketch(active.path);
          else if (active?.type === "storyboard") await get().openStoryboard(active.path);
          else if (active?.type === "note") await get().openNote(active.path);
        }
        // Restore last chat session
        if (ws.chat_session_path) {
          get().loadChatSession(ws.chat_session_path).catch(() => {});
        }
      } catch { /* first launch or corrupted — ignore */ }
      // Auto-detect remote and fetch in background (non-blocking)
      get().detectRemote().then(() => {
        if (get().currentRemote) {
          get().fetchFromRemote().catch(() => {});
        }
      });
    } catch (err) {
      console.error("Failed to open project:", err);
      set({ error: String(err) });
    } finally {
      set({ loading: false });
    }
  },

  closeProject: () => {
    invoke("close_project").catch(console.error);
    localStorage.removeItem("cutready:lastProject");
    // Clear workspace settings
    import("../hooks/useSettings").then(({ useSettingsStore }) => {
      useSettingsStore.getState()._clearWorkspaceSettings();
    });
    set({
      currentProject: null,
      projects: [],
      isMultiProject: false,
      view: "home",
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
      assets: [],
      chatMessages: [],
      chatSessionPath: null,
      chatLoading: false,
      chatError: null,
      pendingChatPrompt: null,
      activityLog: [],
      debugLog: [],
      versions: [],
      timelines: [],
      graphNodes: [],
      snapshotPromptOpen: false,
      identityPromptOpen: false,
      identityPromptCallback: null,
      isDirty: false,
      changedFiles: [],
      hasStash: false,
      isRewound: false,
      currentRemote: null,
      isSyncing: false,
      syncError: null,
      isMerging: false,
      mergeSource: null,
      mergeTarget: null,
      mergeConflicts: [],
      diffResult: null,
      diffSelection: null,
      sidebarOrder: null,
      openTabs: [],
      activeTabId: null,
      splitTabs: [],
      splitActiveTabId: null,
      activeEditorGroup: "main",
    });
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
    set({ loading: true });
    try {
      // Save current workspace state before switching
      const { openTabs, activeTabId, chatSessionPath } = get();
      await invoke("set_workspace_state", {
        workspace: {
          open_tabs: openTabs.map((t) => ({
            id: t.id,
            type: t.type,
            path: t.path,
            title: t.title,
          })),
          active_tab_id: activeTabId,
          chat_session_path: chatSessionPath,
        },
      }).catch(() => {});

      const project = await invoke<ProjectView>("switch_project", { projectPath });
      set({
        currentProject: project,
        openTabs: [],
        activeTabId: null,
        splitTabs: [],
        splitActiveTabId: null,
        activeEditorGroup: "main",
        activeSketchPath: null,
        activeSketch: null,
        activeStoryboardPath: null,
        activeStoryboard: null,
        activeNotePath: null,
        activeNoteContent: null,
        activeNoteLocked: false,
        chatMessages: [],
        chatSessionPath: null,
      });
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadSidebarOrder();
    } catch (err) {
      console.error("Failed to switch project:", err);
      set({ error: String(err) });
    } finally {
      set({ loading: false });
    }
  },

  createProjectInRepo: async (name, description) => {
    try {
      await invoke("create_project_in_repo", { name, description: description ?? null });
      await get().loadProjects();
    } catch (err) {
      console.error("Failed to create project:", err);
      set({ error: String(err) });
    }
  },

  deleteProjectFromRepo: async (projectPath, deleteFiles = false) => {
    try {
      await invoke("delete_project", { projectPath, deleteFiles });
      await get().loadProjects();
    } catch (err) {
      console.error("Failed to delete project:", err);
      set({ error: String(err) });
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
      });
      get().openTab({ type: "sketch", path: relativePath, title });
      await get().loadSketches();
    } catch (err) {
      console.error("Failed to create sketch:", err);
    }
  },

  openSketch: async (sketchPath) => {
    try {
      const sketch = await invoke<Sketch>("get_sketch", { relativePath: sketchPath });
      set({
        activeSketchPath: sketchPath,
        activeSketch: sketch,
      });
      get().openTab({ type: "sketch", path: sketchPath, title: sketch.title });
    } catch (err) {
      console.error("Failed to open sketch:", err);
    }
  },

  updateSketch: async (update) => {
    const { activeSketchPath } = get();
    if (!activeSketchPath) return;
    try {
      await invoke("update_sketch", { relativePath: activeSketchPath, ...update });
      set({ isDirty: true });
    } catch (err) {
      console.error("Failed to update sketch:", err);
    }
  },

  updateSketchTitle: async (sketchPath, title) => {
    // Guard: skip if navigation has cleared the active sketch
    if (!get().activeSketchPath) return;
    try {
      await invoke("update_sketch_title", { relativePath: sketchPath, title });
      await get().loadSketches();
      const { activeSketch, activeSketchPath } = get();
      if (activeSketch && activeSketchPath === sketchPath) {
        set({ activeSketch: { ...activeSketch, title } });
      }
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
      });
      get().openTab({ type: "storyboard", path: relativePath, title });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to create storyboard:", err);
    }
  },

  openStoryboard: async (storyboardPath) => {
    try {
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: storyboardPath });
      set({
        activeStoryboardPath: storyboardPath,
        activeStoryboard: storyboard,
        activeSketchPath: null,
        activeSketch: null,
      });
      get().openTab({ type: "storyboard", path: storyboardPath, title: storyboard.title });
    } catch (err) {
      console.error("Failed to open storyboard:", err);
    }
  },

  updateStoryboard: async (update) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      await invoke("update_storyboard", { relativePath: activeStoryboardPath, ...update });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to update storyboard:", err);
    }
  },

  setStoryboardLocked: async (locked) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      const storyboard = await invoke<Storyboard>("set_storyboard_lock", { relativePath: activeStoryboardPath, locked });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
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
      await invoke("add_sketch_to_storyboard", {
        storyboardPath: activeStoryboardPath,
        sketchPath,
        position: position ?? null,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to add sketch to storyboard:", err);
    }
  },

  removeFromStoryboard: async (position) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      await invoke("remove_sketch_from_storyboard", {
        storyboardPath: activeStoryboardPath,
        position,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to remove from storyboard:", err);
    }
  },

  addSectionToStoryboard: async (title, position) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      await invoke("add_section_to_storyboard", {
        storyboardPath: activeStoryboardPath,
        title,
        position: position ?? null,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      set({ activeStoryboard: storyboard });
    } catch (err) {
      console.error("Failed to add section:", err);
    }
  },

  reorderStoryboardItems: async (items) => {
    const { activeStoryboardPath } = get();
    if (!activeStoryboardPath) return;
    try {
      await invoke("reorder_storyboard_items", {
        storyboardPath: activeStoryboardPath,
        items,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { relativePath: activeStoryboardPath });
      set({ activeStoryboard: storyboard });
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
    try {
      const [content, lock] = await Promise.all([
        invoke<string>("get_note", { relativePath: notePath }),
        invoke<{ locked: boolean }>("get_note_lock", { relativePath: notePath }),
      ]);
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
      get().openTab({ type: "note", path: notePath, title });
    } catch (err) {
      console.error("Failed to open note:", err);
    }
  },

  updateNote: async (content) => {
    const { activeNotePath, activeNoteLocked } = get();
    if (!activeNotePath) return;
    if (activeNoteLocked) return;
    try {
      await invoke("update_note", { relativePath: activeNotePath, content });
      set({ activeNoteContent: content, isDirty: true });
    } catch (err) {
      console.error("Failed to update note:", err);
    }
  },

  setNoteLocked: async (notePath, locked) => {
    try {
      const lock = await invoke<{ locked: boolean }>("set_note_lock", { relativePath: notePath, locked });
      if (get().activeNotePath === notePath) {
        set({ activeNoteLocked: lock.locked });
      }
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

  openAsset: (path, _assetType) => {
    const filename = path.split("/").pop() ?? path;
    get().openTab({ type: "asset", path, title: filename });
    // Navigate to assets view if not already there
    if (get().view !== "assets" && get().view !== "sketch" && get().view !== "project") {
      set({ view: "assets" });
    }
  },

  importAsset: async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
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

  // ── Chat actions ──────────────────────────────────────────

  setChatMessages: (messages) => {
    set({ chatMessages: messages, chatError: null });
    // Auto-save after a short delay
    const state = get();
    if (state.chatSessionPath && messages.length > 0) {
      state.saveChatSession().catch(console.error);
    }
  },

  newChatSession: () => {
    // Archive the previous session if it had messages
    const { chatMessages, chatSessionPath } = get();
    if (chatSessionPath && chatMessages.length > 1) {
      const userMsgs = chatMessages.filter((m) => m.role === "user");
      const summary = userMsgs.map((m) => m.content?.slice(0, 100)).filter(Boolean).join("; ");
      if (summary) {
        invoke("archive_chat_session", {
          sessionId: chatSessionPath,
          summary: `Topics discussed: ${summary}`,
        }).catch(() => {});
      }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const sessionPath = `.chats/chat-${ts}.chat`;
    set({
      chatMessages: [],
      chatSessionPath: sessionPath,
      chatLoading: false,
      chatError: null,
      activityLog: [],
    });
    get()._persistTabs();
  },

  loadChatSession: async (sessionPath) => {
    try {
      const session = await invoke<{
        title: string;
        messages: ChatMessage[];
        created_at: string;
        updated_at: string;
        author_name?: string | null;
        author_email?: string | null;
      }>(
        "get_chat_session",
        { relativePath: sessionPath },
      );
      set({
        chatMessages: session.messages,
        chatSessionPath: sessionPath,
        chatError: null,
      });
      get()._persistTabs();
    } catch {
      // Session file doesn't exist (e.g., new session with no messages yet) — start fresh
      get().newChatSession();
    }
  },

  saveChatSession: async () => {
    const { chatMessages, chatSessionPath } = get();
    if (!chatSessionPath || chatMessages.length === 0) return;
    // Derive title from first user message
    const firstUser = chatMessages.find((m) => m.role === "user");
    const title = firstUser?.content?.slice(0, 80) || "Chat session";
    const now = new Date().toISOString();
    try {
      await invoke("save_chat_session", {
        relativePath: chatSessionPath,
        session: {
          title,
          messages: chatMessages,
          created_at: now,
          updated_at: now,
        },
      });
    } catch (err) {
      console.error("Failed to save chat session:", err);
    }
  },

  setChatLoading: (loading) => set({ chatLoading: loading }),
  setChatError: (error) => set({ chatError: error }),
  sendChatPrompt: (prompt, opts) => set({ pendingChatPrompt: { text: prompt, silent: opts?.silent, agent: opts?.agent } }),
  addActivityEntries: (entries) => set((s) => ({ activityLog: [...s.activityLog, ...entries] })),
  clearActivityLog: () => set({ activityLog: [] }),
  addDebugEntry: (entry) => set((s) => ({ debugLog: [...s.debugLog.slice(-499), entry] })),
  clearDebugLog: () => set({ debugLog: [] }),

  listChatSessions: async () => {
    try {
      return await invoke<ChatSessionSummary[]>("list_chat_sessions");
    } catch (err) {
      console.error("Failed to list chat sessions:", err);
      return [];
    }
  },

  deleteChatSession: async (sessionPath) => {
    try {
      await invoke("delete_chat_session", { relativePath: sessionPath });
    } catch (err) {
      console.error("Failed to delete chat session:", err);
    }
  },

  // ── Versioning actions ───────────────────────────────────

  loadVersions: async () => {
    try {
      const versions = await invoke<VersionEntry[]>("list_versions");
      set({ versions });
      await get().checkDirty();
    } catch (err) {
      console.error("Failed to load versions:", err);
    }
  },

  checkDirty: async () => {
    try {
      const isDirty = await invoke<boolean>("has_unsaved_changes");
      set({ isDirty });
      // Also refresh the changed files list
      get().refreshChangedFiles();
    } catch (err) {
      console.error("Failed to check dirty state:", err);
      useToastStore.getState().show(`Could not check project changes: ${err}`, 5000, "error");
    }
  },

  refreshChangedFiles: async () => {
    try {
      const files = await invoke<DiffEntry[]>("diff_working_tree");
      set({ changedFiles: files });
    } catch {
      set({ changedFiles: [] });
    }
  },

  saveVersion: async (label, forkLabel?) => {
    try {
      const commitId = await invoke<string>("save_with_label", {
        label,
        forkLabel: forkLabel || null,
      });
      set({ isDirty: false, isRewound: false, changedFiles: [] });
      const { openTabs, activeTabId } = get();
      const editorState = JSON.stringify({ openTabs, activeTabId });
      await invoke("save_editor_state", { commitId, editorState }).catch(() => {});
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      await get().checkRewound();
      await get().refreshSyncStatus();
    } catch (err) {
      console.error("Failed to save version:", err);
    }
  },

  stashChanges: async () => {
    try {
      await invoke("stash_changes");
      set({ hasStash: true });
    } catch (err) {
      console.error("Failed to stash changes:", err);
    }
  },

  discardChanges: async () => {
    try {
      // Clear active editors FIRST to cancel pending debounced saves
      set({ activeSketch: null, activeSketchPath: null, activeStoryboard: null, activeStoryboardPath: null, activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
      await invoke("discard_changes");
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      // Clear tabs (files may have changed)
      set({ openTabs: [], activeTabId: null });
      await get().checkDirty();
    } catch (err) {
      console.error("Failed to discard changes:", err);
      useToastStore.getState().show(`Discard failed: ${err}`, 5000, "error");
      await get().checkDirty();
    }
  },

  discardFile: async (filePath) => {
    try {
      await invoke("discard_file", { filePath });
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      const {
        activeSketchPath,
        activeStoryboardPath,
        activeNotePath,
        sketches,
        storyboards,
        notes,
        openTabs,
      } = get();
      if (activeSketchPath === filePath) {
        set((state) => ({ editorReloadKey: state.editorReloadKey + 1 }));
        if (sketches.some((sketch) => sketch.path === filePath)) {
          await get().openSketch(filePath);
        } else {
          const tab = openTabs.find((candidate) => candidate.type === "sketch" && candidate.path === filePath);
          if (tab) get().closeTab(tab.id);
          else set({ activeSketchPath: null, activeSketch: null });
        }
      } else if (activeStoryboardPath === filePath) {
        set((state) => ({ editorReloadKey: state.editorReloadKey + 1 }));
        if (storyboards.some((storyboard) => storyboard.path === filePath)) {
          await get().openStoryboard(filePath);
        } else {
          const tab = openTabs.find((candidate) => candidate.type === "storyboard" && candidate.path === filePath);
          if (tab) get().closeTab(tab.id);
          else set({ activeStoryboardPath: null, activeStoryboard: null });
        }
      } else if (activeNotePath === filePath) {
        set((state) => ({ editorReloadKey: state.editorReloadKey + 1 }));
        if (notes.some((note) => note.path === filePath)) {
          await get().openNote(filePath);
        } else {
          const tab = openTabs.find((candidate) => candidate.type === "note" && candidate.path === filePath);
          if (tab) get().closeTab(tab.id);
          else set({ activeNotePath: null, activeNoteContent: null, activeNoteLocked: false });
        }
      }
      await get().checkDirty();
    } catch (err) {
      console.error("Failed to discard file:", err);
      useToastStore.getState().show(`Discard failed: ${err}`, 5000, "error");
      await get().checkDirty();
    }
  },

  popStash: async () => {
    try {
      const hadStash = await invoke<boolean>("pop_stash");
      set({ hasStash: false, isDirty: hadStash });
      if (hadStash) {
        await get().loadSketches();
        await get().loadStoryboards();
        const { activeSketchPath } = get();
        if (activeSketchPath) {
          await get().openSketch(activeSketchPath);
        }
      }
    } catch (err) {
      console.error("Failed to pop stash:", err);
    }
  },

  checkStash: async () => {
    try {
      const hasStash = await invoke<boolean>("has_stash");
      set({ hasStash });
    } catch (err) {
      console.error("Failed to check stash:", err);
    }
  },

  checkRewound: async () => {
    try {
      const isRewound = await invoke<boolean>("is_rewound");
      set({ isRewound });
    } catch (err) {
      set({ isRewound: false });
    }
  },

  navigateToSnapshot: async (commitId) => {
    try {
      // Clear active editors FIRST to cancel pending debounced saves
      set({ activeSketch: null, activeSketchPath: null, activeStoryboard: null, activeStoryboardPath: null, isDirty: false });
      await invoke("navigate_to_snapshot", { commitId });
      // Reload file lists
      await get().loadSketches();
      await get().loadStoryboards();
      // Restore editor state saved with this snapshot
      const raw = await invoke<string | null>("load_editor_state", { commitId });
      if (raw) {
        try {
          const saved = JSON.parse(raw) as { openTabs?: EditorTab[]; activeTabId?: string | null };
          const { sketches, storyboards } = get();
          // Only restore tabs whose files still exist in this snapshot
          const validTabs = (saved.openTabs ?? []).filter((t) =>
            t.type === "sketch"
              ? sketches.some((s) => s.path === t.path)
              : storyboards.some((s) => s.path === t.path),
          );
          set({ openTabs: validTabs, activeTabId: saved.activeTabId ?? null });
          // Open the active tab's content
          const active = validTabs.find((t) => t.id === saved.activeTabId);
          if (active) {
            if (active.type === "sketch") await get().openSketch(active.path);
            else await get().openStoryboard(active.path);
          }
        } catch { /* ignore parse errors */ }
      } else {
        // No saved state — clear tabs
        set({ openTabs: [], activeTabId: null });
      }
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      await get().checkRewound();
    } catch (err) {
      console.error("Failed to navigate to snapshot:", err);
    }
  },

  createTimeline: async (fromCommitId, name) => {
    try {
      await invoke("create_timeline", { fromCommitId, name });
      await get().loadSketches();
      await get().loadStoryboards();
      const { activeSketchPath, sketches } = get();
      if (activeSketchPath) {
        const stillExists = sketches.some((s) => s.path === activeSketchPath);
        if (stillExists) {
          await get().openSketch(activeSketchPath);
        } else {
          set({ activeSketch: null, activeSketchPath: null });
        }
      }
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadGraphData();
    } catch (err) {
      console.error("Failed to create timeline:", err);
    }
  },

  loadTimelines: async () => {
    try {
      const timelines = await invoke<TimelineInfo[]>("list_timelines");
      set({ timelines });
    } catch (err) {
      console.error("Failed to load timelines:", err);
    }
  },

  switchTimeline: async (name) => {
    try {
      await invoke("switch_timeline", { name });
      await get().loadSketches();
      await get().loadStoryboards();
      const { activeSketchPath, sketches } = get();
      if (activeSketchPath) {
        const stillExists = sketches.some((s) => s.path === activeSketchPath);
        if (stillExists) {
          await get().openSketch(activeSketchPath);
        } else {
          set({ activeSketch: null, activeSketchPath: null });
        }
      }
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadGraphData();
    } catch (err) {
      console.error("Failed to switch timeline:", err);
    }
  },

  deleteTimeline: async (name) => {
    try {
      await invoke("delete_timeline", { name });
      await get().loadTimelines();
      await get().loadGraphData();
    } catch (err) {
      console.error("Failed to delete timeline:", err);
    }
  },

  promoteTimeline: async (name) => {
    try {
      await invoke("promote_timeline", { name });
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadGraphData();
      await get().checkDirty();
      await get().checkRewound();
    } catch (err) {
      console.error("Failed to promote timeline:", err);
    }
  },

  loadGraphData: async () => {
    try {
      const graphNodes = await invoke<GraphNode[]>("get_timeline_graph");
      set({ graphNodes });
    } catch (err) {
      console.error("Failed to load graph data:", err);
    }
  },

  toggleSecondaryPanel: () => {
    set((state) => {
      saveLayout({ showSecondaryPanel: !state.showSecondaryPanel });
      return { showSecondaryPanel: !state.showSecondaryPanel };
    });
  },

  quickSave: async () => {
    await get().promptSnapshot();
  },

  promptSnapshot: async () => {
    // Check if identity is resolved — if fallback, prompt the user first
    try {
      const status = await invoke<{ name: string; email: string; is_fallback: boolean }>("check_git_identity");
      if (status.is_fallback) {
        set({
          identityPromptOpen: true,
          identityPromptCallback: () => set({ snapshotPromptOpen: true }),
        });
        return;
      }
    } catch {
      // If check fails (e.g., no project open), proceed to snapshot dialog
    }
    set({ snapshotPromptOpen: true });
  },

  squashSnapshots: async (oldestCommitId, newestCommitId, label) => {
    try {
      await invoke<string>("squash_snapshots", {
        oldestCommitId,
        newestCommitId,
        label,
      });
      await get().loadGraphData();
      await get().loadTimelines();
      await get().loadVersions();
      await get().checkDirty();
      await get().checkRewound();
    } catch (err) {
      console.error("Failed to squash snapshots:", err);
      throw err;
    }
  },

  // ── Remote sync actions ────────────────────────────────────

  detectRemote: async () => {
    try {
      const info = await invoke<RemoteInfo | null>("detect_git_remote");
      set({ currentRemote: info ?? null });
      if (info) {
        await get().refreshSyncStatus();
      }
    } catch {
      set({ currentRemote: null });
    }
  },

  fetchFromRemote: async () => {
    const { currentRemote } = get();
    if (!currentRemote) return;
    set({ isSyncing: true, syncError: null });
    try {
      // Try gh CLI token first, then no token (SSH/credential helper)
      let token: string | null = null;
      try {
        token = await invoke<string | null>("get_github_token");
      } catch { /* ignore */ }
      await invoke("fetch_git_remote", {
        remoteName: currentRemote.name,
        token,
      });
      await get().refreshSyncStatus();
      await get().refreshIncomingCommits();
      await get().loadGraphData();
      await get().loadTimelines();
      await get().loadVersions();
    } catch (err) {
      set({ syncError: String(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  pushToRemote:async () => {
    const { currentRemote, timelines } = get();
    if (!currentRemote) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    set({ isSyncing: true, syncError: null });
    try {
      // Large-file check before push
      const largeFiles = await get().checkLargeFiles();
      if (largeFiles.length > 0) {
        const names = largeFiles.map(([p, s]) => `${p} (${(s / 1024 / 1024).toFixed(1)} MB)`).join(", ");
        set({ syncError: `Large files detected: ${names}. Remove or add to .gitignore before pushing.`, isSyncing: false });
        return;
      }
      let token: string | null = null;
      try {
        token = await invoke<string | null>("get_github_token");
      } catch { /* ignore */ }
      await invoke("push_git_remote", {
        remoteName: currentRemote.name,
        branch: active.name,
        token,
      });
      await get().refreshSyncStatus();
      await get().checkDirty();
      await get().refreshChangedFiles();
      await get().loadGraphData();
      await get().loadTimelines();
      await get().loadVersions();
    } catch (err) {
      set({ syncError: String(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  syncWithRemote: async () => {
    // Fetch first to get latest state
    await get().fetchFromRemote();
    const updated = get().syncStatus;
    if (!updated) return;
    // If behind, pull first
    if (updated.behind > 0) {
      await get().pullFromRemote();
    }
    // If ahead (and not diverged), push
    const afterPull = get().syncStatus;
    if (afterPull && afterPull.ahead > 0 && afterPull.behind === 0) {
      await get().pushToRemote();
    }
  },

  shareChanges: async () => {
    const { currentRemote, timelines } = get();
    if (!currentRemote) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    await get().pushToRemote();
    const url = buildShareUrl(currentRemote.url, active.name);
    set({ shareUrl: url });
    if (url) {
      try {
        await navigator.clipboard.writeText(url);
        useToastStore.getState().show("Share link copied. Your work is safely published.", 4000, "success");
      } catch {
        useToastStore.getState().show("Your work is safely published.", 4000, "success");
      }
    }
  },

  pullFromRemote: async () => {
    const { currentRemote, timelines } = get();
    if (!currentRemote) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    set({ isSyncing: true, syncError: null });
    try {
      let token: string | null = null;
      try {
        token = await invoke<string | null>("get_github_token");
      } catch { /* ignore */ }
      const result = await invoke<{ type: string; ahead?: number; behind?: number; commits?: number; commit_id?: string; conflicts?: any[] }>(
        "pull_git_remote",
        { remoteName: currentRemote.name, branch: active.name, token },
      );
      if (result.type === "Conflicts" && result.conflicts) {
        // Pull resulted in merge conflicts — enter merge mode
        set({
          isMerging: true,
          mergeSource: `${currentRemote.name}/${active.name}`,
          mergeTarget: active.name,
          mergeConflicts: result.conflicts,
          syncError: null,
        });
      } else if (result.type === "Diverged") {
        set({ syncError: `Your changes and remote changes can't be merged automatically (${result.ahead} local, ${result.behind} remote snapshots). Try taking a snapshot first, then pull again.` });
      }
      // Merged and FastForward are handled automatically
      await get().refreshSyncStatus();
      await get().refreshIncomingCommits();
      await get().checkDirty();
      await get().refreshChangedFiles();
      await get().loadGraphData();
      await get().loadTimelines();
      await get().loadVersions();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
    } catch (err) {
      set({ syncError: String(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  loadRemoteBranches: async () => {
    const { currentRemote } = get();
    if (!currentRemote) return [];
    try {
      return await invoke<string[]>("list_remote_branches", {
        remoteName: currentRemote.name,
      });
    } catch {
      return [];
    }
  },

  checkoutRemoteTimeline: async (branch: string) => {
    const { currentRemote } = get();
    if (!currentRemote) return;
    try {
      await invoke("checkout_remote_branch", {
        remoteName: currentRemote.name,
        branch,
      });
      await get().loadTimelines();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadGraphData();
      await get().loadVersions();
    } catch (err) {
      console.error("Failed to checkout remote timeline:", err);
    }
  },

  publishTimeline: async () => {
    const { currentRemote, timelines } = get();
    if (!currentRemote) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) return;
    set({ isSyncing: true, syncError: null });
    try {
      let token: string | null = null;
      try {
        token = await invoke<string | null>("get_github_token");
      } catch { /* ignore */ }
      await invoke("push_git_remote", {
        remoteName: currentRemote.name,
        branch: active.name,
        token,
      });
      await get().refreshSyncStatus();
    } catch (err) {
      set({ syncError: String(err) });
    } finally {
      set({ isSyncing: false });
    }
  },

  refreshSyncStatus: async () => {
    const { currentRemote, timelines } = get();
    if (!currentRemote) return;
    const active = timelines.find((t) => t.is_active);
    if (!active) {
      set({ syncStatus: null });
      return;
    }
    try {
      const status = await invoke<SyncStatus>("get_sync_status", {
        branch: active.name,
        remoteName: currentRemote.name,
      });
      set({ syncStatus: status });
    } catch {
      set({ syncStatus: null });
    }
  },

  refreshIncomingCommits: async () => {
    const { currentRemote, timelines, syncStatus } = get();
    if (!currentRemote || !syncStatus || syncStatus.behind === 0) {
      set({ incomingCommits: [] });
      return;
    }
    const active = timelines.find((t) => t.is_active);
    if (!active) {
      set({ incomingCommits: [] });
      return;
    }
    try {
      const incoming = await invoke<IncomingCommit[]>("list_incoming_commits", {
        remoteName: currentRemote.name,
        branch: active.name,
        limit: 10,
      });
      set({ incomingCommits: incoming });
    } catch {
      set({ incomingCommits: [] });
    }
  },

  // ── Diff & bookmarks ──────────────────────────────────────

  diffSnapshots: async (fromCommit, toCommit) => {
    try {
      const entries = await invoke<DiffEntry[]>("diff_snapshots", { fromCommit, toCommit });
      set({ diffResult: entries, diffSelection: { from: fromCommit, to: toCommit } });
      return entries;
    } catch (err) {
      console.error("Failed to diff snapshots:", err);
      return [];
    }
  },

  diffWorkingTree: async () => {
    try {
      const entries = await invoke<DiffEntry[]>("diff_working_tree");
      set({ diffResult: entries, diffSelection: { from: "HEAD", to: "working" } });
      return entries;
    } catch (err) {
      console.error("Failed to diff working tree:", err);
      return [];
    }
  },

  checkLargeFiles: async () => {
    try {
      return await invoke<Array<[string, number]>>("check_large_files", { thresholdMb: 50 });
    } catch {
      return [];
    }
  },

  cloneFromUrl: async (url, destPath) => {
    set({ loading: true });
    try {
      let token: string | null = null;
      try {
        token = await invoke<string | null>("get_github_token");
      } catch { /* ignore */ }
      await invoke("clone_from_url", { url, dest: destPath, token });
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

  // ── Merge actions ─────────────────────────────────────────

  mergeTimelines: async (source, target) => {
    try {
      const result = await invoke<MergeResult>("merge_timelines", {
        sourceTimeline: source,
        targetTimeline: target,
      });

      if (result.status === "conflicts") {
        // Enter merge mode with conflicts for user resolution
        set({
          isMerging: true,
          mergeSource: source,
          mergeTarget: target,
          mergeConflicts: result.conflicts,
        });
      } else if (result.status === "clean" || result.status === "fast_forward") {
        // Merge succeeded — refresh everything
        await get().loadTimelines();
        await get().loadGraphData();
        await get().loadSketches();
        await get().loadStoryboards();
        await get().loadNotes();
      }

      return result;
    } catch (err) {
      console.error("Merge failed:", err);
      throw err;
    }
  },

  applyMergeResolution: async (resolutions) => {
    const { mergeSource, mergeTarget } = get();
    if (!mergeSource || !mergeTarget) throw new Error("No merge in progress");

    try {
      const commitId = await invoke<string>("apply_merge_resolution", {
        sourceTimeline: mergeSource,
        targetTimeline: mergeTarget,
        resolutions,
      });

      // Exit merge mode and refresh
      set({
        isMerging: false,
        mergeSource: null,
        mergeTarget: null,
        mergeConflicts: [],
      });
      await get().loadTimelines();
      await get().loadGraphData();
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();

      return commitId;
    } catch (err) {
      console.error("Apply merge resolution failed:", err);
      throw err;
    }
  },

  cancelMerge: () => {
    set({
      isMerging: false,
      mergeSource: null,
      mergeTarget: null,
      mergeConflicts: [],
    });
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

  // ── Profile actions ───────────────────────────────────────

  detectProfiles: async () => {
    try {
      const profiles = await invoke<BrowserProfile[]>(
        "detect_browser_profiles"
      );
      const { selectedProfile } = get();
      const newSelected =
        selectedProfile ??
        (profiles.length > 0 ? profiles[0] : null);
      set({ profiles, selectedProfile: newSelected });
    } catch (err) {
      console.error("Failed to detect profiles:", err);
    }
  },

  checkBrowsersRunning: async () => {
    try {
      const status = await invoke<BrowserRunningStatus>(
        "check_browsers_running"
      );
      set({ browserRunning: status });
    } catch (err) {
      console.error("Failed to check browsers:", err);
    }
  },

  setSelectedProfile: (profile) => set({ selectedProfile: profile }),

  // ── Browser actions ───────────────────────────────────────

  prepareBrowser: async () => {
    set({ loading: true, error: null });
    try {
      const { selectedProfile } = get();
      const channel = await invoke<string>("prepare_browser", {
        userDataDir: selectedProfile?.user_data_dir ?? null,
        profileDirectory: selectedProfile?.profile_directory ?? null,
        browserChannel: selectedProfile?.browser ?? null,
      });
      set({
        isBrowserReady: true,
        browserChannel: channel,
        capturedActions: [],
        lastSession: null,
        view: "recording",
      });
    } catch (err) {
      console.error("Failed to prepare browser:", err);
      set({ error: String(err) });
    } finally {
      set({ loading: false });
    }
  },

  disconnectBrowser: async () => {
    set({ loading: true });
    try {
      await invoke("disconnect_browser");
    } catch (err) {
      console.error("Failed to disconnect browser:", err);
    } finally {
      set({
        loading: false,
        isBrowserReady: false,
        browserChannel: null,
        isRecording: false,
        recordingSessionId: null,
        capturedActions: [],
        lastSession: null,
        _activeChannel: null,
      });
    }
  },

  // ── Recording actions ─────────────────────────────────────

  startRecording: async () => {
    set({ loading: true, capturedActions: [], lastSession: null });
    try {
      const channel = new Channel<CapturedAction>();
      channel.onmessage = (action) => {
        set((state) => ({
          capturedActions: [...state.capturedActions, action],
        }));
      };

      const sessionId = await invoke<string>("start_recording_session", {
        onAction: channel,
      });

      set({
        isRecording: true,
        recordingSessionId: sessionId,
        _activeChannel: channel,
      });
    } catch (err) {
      console.error("Failed to start recording:", err);
    } finally {
      set({ loading: false });
    }
  },

  stopRecording: async () => {
    set({ loading: true });
    try {
      const session = await invoke<RecordedSession>("stop_recording_session");
      set({
        isRecording: false,
        recordingSessionId: null,
        lastSession: session,
        _activeChannel: null,
      });
    } catch (err) {
      console.error("Failed to stop recording:", err);
    } finally {
      set({ loading: false });
    }
  },
}));

// Expose store on window in dev mode for Playwright/debugging
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__CUTREADY_STORE__ = useAppStore;
}
