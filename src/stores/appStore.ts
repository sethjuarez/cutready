import { create } from "zustand";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { ProjectView, RecentProject } from "../types/project";
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
} from "../types/sketch";

/** The panels / views available in the app. */
export type AppView = "home" | "sketch" | "editor" | "recording" | "settings";

/** Sidebar display mode for the sketch panel. */
export type SidebarMode = "list" | "tree";

/** Sidebar position. */
export type SidebarPosition = "left" | "right";

/** Sidebar display order manifest. */
export interface SidebarOrder {
  storyboards: string[];
  sketches: string[];
  notes: string[];
}

/** An open tab in the editor area. */
export interface EditorTab {
  id: string;
  type: "sketch" | "storyboard" | "note";
  path: string;
  title: string;
}

interface AppStoreState {
  /** Current active view. */
  view: AppView;
  /** Currently open project (null if none). */
  currentProject: ProjectView | null;
  /** Recent projects for the home screen. */
  recentProjects: RecentProject[];
  /** Whether an operation is in progress. */
  loading: boolean;
  /** Last error message to display in the UI. */
  error: string | null;
  /** Sidebar display mode: categorized list or file tree. */
  sidebarMode: SidebarMode;
  /** Width of the sidebar panel in pixels. */
  sidebarWidth: number;
  /** Whether the sidebar panel is visible. */
  sidebarVisible: boolean;
  /** Whether the output/activity panel is visible. */
  outputVisible: boolean;
  /** Height of the output panel in pixels. */
  outputHeight: number;
  /** Sidebar position: left or right. */
  sidebarPosition: SidebarPosition;

  // ── Tabs ───────────────────────────────────────────────

  /** Open editor tabs. */
  openTabs: EditorTab[];
  /** Currently active tab id. */
  activeTabId: string | null;

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

  /** Version history for the current project. */
  versions: VersionEntry[];
  /** All timelines (branches) in the project. */
  timelines: TimelineInfo[];
  /** Full graph data for SVG rendering. */
  graphNodes: GraphNode[];
  /** Whether the version history sidebar is visible. */
  showVersionHistory: boolean;
  /** Whether the snapshot name prompt should be shown (triggered by Ctrl+S). */
  snapshotPromptOpen: boolean;
  /** Whether there are unsaved changes since the last snapshot. */
  isDirty: boolean;
  /** Whether a stash (temporarily saved work) exists. */
  hasStash: boolean;
  /** Whether we are viewing a rewound snapshot (prev-tip exists). */
  isRewound: boolean;

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
  /** Toggle sidebar between list and tree modes. */
  setSidebarMode: (mode: SidebarMode) => void;
  /** Set sidebar width. */
  setSidebarWidth: (width: number) => void;
  /** Toggle sidebar visibility. */
  toggleSidebar: () => void;
  /** Toggle output panel visibility. */
  toggleOutput: () => void;
  /** Set output panel height. */
  setOutputHeight: (height: number) => void;
  /** Toggle sidebar position (left/right). */
  toggleSidebarPosition: () => void;

  // ── Tab actions ────────────────────────────────────────

  /** Open a tab (or focus if already open). */
  openTab: (tab: Omit<EditorTab, "id">) => void;
  /** Close a tab by id. */
  closeTab: (tabId: string) => void;
  /** Set the active tab. */
  setActiveTab: (tabId: string) => void;
  /** Reorder tabs. */
  reorderTabs: (tabIds: string[]) => void;

  // ── Project actions ───────────────────────────────────────

  loadRecentProjects: () => Promise<void>;
  removeRecentProject: (path: string) => Promise<void>;
  createProject: (path: string) => Promise<void>;
  openProject: (path: string) => Promise<void>;
  closeProject: () => void;

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
  /** Delete a note. */
  deleteNote: (notePath: string) => Promise<void>;
  /** Close the active note. */
  closeNote: () => void;

  // ── Versioning actions ───────────────────────────────────

  /** Load version history. */
  loadVersions: () => Promise<void>;
  /** Check if working directory has unsaved changes. */
  checkDirty: () => Promise<void>;
  /** Save a labeled version. Optional forkLabel for naming the old timeline when forking. */
  saveVersion: (label: string, forkLabel?: string) => Promise<void>;
  /** Stash dirty working tree before browsing snapshots. */
  stashChanges: () => Promise<void>;
  /** Discard all working-directory changes, resetting to last snapshot. */
  discardChanges: () => Promise<void>;
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
  /** Load full graph data for SVG rendering. */
  loadGraphData: () => Promise<void>;
  /** Toggle version history sidebar. */
  toggleVersionHistory: () => void;
  /** Open snapshot name prompt (and ensure panel is visible). */
  promptSnapshot: () => void;

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
  showVersionHistory: boolean;
}> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? JSON.parse(raw) : {};
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
  loading: false,
  error: null,
  sidebarMode: "list",
  sidebarWidth: savedLayout.sidebarWidth ?? 240,
  sidebarVisible: savedLayout.sidebarVisible ?? true,
  outputVisible: savedLayout.outputVisible ?? false,
  outputHeight: savedLayout.outputHeight ?? 200,
  sidebarPosition: savedLayout.sidebarPosition ?? "left",

  openTabs: [],
  activeTabId: null,

  sketches: [],
  activeSketchPath: null,
  activeSketch: null,
  storyboards: [],
  activeStoryboardPath: null,
  activeStoryboard: null,
  notes: [],
  activeNotePath: null,
  activeNoteContent: null,
  versions: [],
  timelines: [],
  graphNodes: [],
  showVersionHistory: savedLayout.showVersionHistory ?? false,
  snapshotPromptOpen: false,
  isDirty: false,
  hasStash: false,
  isRewound: false,
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
  setSidebarMode: (mode) => set({ sidebarMode: mode }),
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
  toggleSidebarPosition: () => set((s) => {
    const pos = s.sidebarPosition === "left" ? "right" : "left";
    saveLayout({ sidebarPosition: pos });
    return { sidebarPosition: pos };
  }),

  openTab: (tab) => {
    const { openTabs } = get();
    const existing = openTabs.find((t) => t.path === tab.path && t.type === tab.type);
    if (existing) {
      set({ activeTabId: existing.id });
    } else {
      const id = `${tab.type}-${tab.path}`;
      const newTab: EditorTab = { ...tab, id };
      set({ openTabs: [...openTabs, newTab], activeTabId: id });
    }
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
      set({ activeSketchPath: null, activeSketch: null, activeStoryboardPath: null, activeStoryboard: null, activeNotePath: null, activeNoteContent: null });
    }
  },
  setActiveTab: (tabId) => {
    const { openTabs } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    set({ activeTabId: tabId });
    if (tab.type === "sketch") {
      set({ activeStoryboardPath: null, activeStoryboard: null, activeNotePath: null, activeNoteContent: null });
      get().openSketch(tab.path);
    } else if (tab.type === "storyboard") {
      set({ activeSketchPath: null, activeSketch: null, activeNotePath: null, activeNoteContent: null });
      get().openStoryboard(tab.path);
    } else if (tab.type === "note") {
      set({ activeSketchPath: null, activeSketch: null, activeStoryboardPath: null, activeStoryboard: null });
      get().openNote(tab.path);
    }
  },
  reorderTabs: (tabIds) => {
    const { openTabs } = get();
    const reordered = tabIds
      .map((id) => openTabs.find((t) => t.id === id))
      .filter(Boolean) as EditorTab[];
    set({ openTabs: reordered });
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
      set({ currentProject: project, view: "sketch" });
      localStorage.setItem("cutready:lastProject", path);
      await get().loadRecentProjects();
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
      set({ currentProject: project, view: "sketch" });
      localStorage.setItem("cutready:lastProject", path);
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      await get().loadSidebarOrder();
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
    set({
      currentProject: null,
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
      versions: [],
      timelines: [],
      graphNodes: [],
      snapshotPromptOpen: false,
      isDirty: false,
      hasStash: false,
      isRewound: false,
      sidebarOrder: null,
      openTabs: [],
      activeTabId: null,
    });
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
      const { activeSketchPath } = get();
      if (activeSketchPath === sketchPath) {
        set({ activeSketchPath: null, activeSketch: null });
      }
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

  deleteStoryboard: async (storyboardPath) => {
    try {
      await invoke("delete_storyboard", { relativePath: storyboardPath });
      const { activeStoryboardPath } = get();
      if (activeStoryboardPath === storyboardPath) {
        set({ activeStoryboardPath: null, activeStoryboard: null });
      }
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
      const content = await invoke<string>("get_note", { relativePath: notePath });
      const title = notePath.replace(/\.md$/, "").split("/").pop() ?? notePath;
      set({
        activeNotePath: notePath,
        activeNoteContent: content,
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
    const { activeNotePath } = get();
    if (!activeNotePath) return;
    try {
      await invoke("update_note", { relativePath: activeNotePath, content });
      set({ activeNoteContent: content, isDirty: true });
    } catch (err) {
      console.error("Failed to update note:", err);
    }
  },

  deleteNote: async (notePath) => {
    try {
      await invoke("delete_note", { relativePath: notePath });
      const { activeNotePath } = get();
      if (activeNotePath === notePath) {
        set({ activeNotePath: null, activeNoteContent: null });
      }
      await get().loadNotes();
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
  },

  closeNote: () => {
    set({ activeNotePath: null, activeNoteContent: null });
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
    } catch {
      set({ isDirty: false });
    }
  },

  saveVersion: async (label, forkLabel?) => {
    try {
      const commitId = await invoke<string>("save_with_label", {
        label,
        forkLabel: forkLabel || null,
      });
      set({ isDirty: false, isRewound: false });
      // Persist editor state for this snapshot
      const { openTabs, activeTabId } = get();
      const editorState = JSON.stringify({ openTabs, activeTabId });
      await invoke("save_editor_state", { commitId, editorState }).catch(() => {});
      await get().loadVersions();
      await get().loadTimelines();
      await get().loadGraphData();
      await get().checkDirty();
      await get().checkRewound();
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
      set({ activeSketch: null, activeSketchPath: null, activeStoryboard: null, activeStoryboardPath: null, activeNotePath: null, activeNoteContent: null });
      await invoke("discard_changes");
      set({ isDirty: false });
      // Reload all file lists
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadNotes();
      // Clear tabs (files may have changed)
      set({ openTabs: [], activeTabId: null });
    } catch (err) {
      console.error("Failed to discard changes:", err);
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

  loadGraphData: async () => {
    try {
      const graphNodes = await invoke<GraphNode[]>("get_timeline_graph");
      set({ graphNodes });
    } catch (err) {
      console.error("Failed to load graph data:", err);
    }
  },

  toggleVersionHistory: () => {
    set((state) => {
      saveLayout({ showVersionHistory: !state.showVersionHistory });
      return { showVersionHistory: !state.showVersionHistory };
    });
  },

  promptSnapshot: () => {
    set({ showVersionHistory: true, snapshotPromptOpen: true });
    saveLayout({ showVersionHistory: true });
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
