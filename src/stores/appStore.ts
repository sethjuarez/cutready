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
} from "../types/sketch";

/** The panels / views available in the app. */
export type AppView = "home" | "sketch" | "editor" | "recording" | "settings";

/** Sidebar display mode for the sketch panel. */
export type SidebarMode = "list" | "tree";

/** Sidebar position. */
export type SidebarPosition = "left" | "right";

/** An open tab in the editor area. */
export interface EditorTab {
  id: string;
  type: "sketch" | "storyboard";
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

  /** Version history for the current project. */
  versions: VersionEntry[];
  /** Whether the version history sidebar is visible. */
  showVersionHistory: boolean;
  /** Whether the snapshot name prompt should be shown (triggered by Ctrl+S). */
  snapshotPromptOpen: boolean;
  /** Which snapshot is currently checked out for viewing (null = latest). */
  viewingSnapshotId: string | null;
  /** Whether there are unsaved changes since the last snapshot. */
  isDirty: boolean;

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

  // ── Versioning actions ───────────────────────────────────

  /** Load version history. */
  loadVersions: () => Promise<void>;
  /** Check if working directory has unsaved changes. */
  checkDirty: () => Promise<void>;
  /** Save a labeled version. */
  saveVersion: (label: string) => Promise<void>;
  /** Browse to a snapshot (checkout files without committing). */
  checkoutSnapshot: (commitId: string) => Promise<void>;
  /** Return to the latest snapshot. */
  returnToLatest: () => Promise<void>;
  /** Permanently restore a historical version (creates a commit). */
  restoreVersion: (commitId: string) => Promise<void>;
  /** Toggle version history sidebar. */
  toggleVersionHistory: () => void;
  /** Open snapshot name prompt (and ensure panel is visible). */
  promptSnapshot: () => void;

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

export const useAppStore = create<AppStoreState>((set, get) => ({
  view: "home",
  currentProject: null,
  recentProjects: [],
  loading: false,
  error: null,
  sidebarMode: "list",
  sidebarWidth: 240,
  sidebarVisible: true,
  outputVisible: false,
  outputHeight: 200,
  sidebarPosition: "left",

  openTabs: [],
  activeTabId: null,

  sketches: [],
  activeSketchPath: null,
  activeSketch: null,
  storyboards: [],
  activeStoryboardPath: null,
  activeStoryboard: null,
  versions: [],
  showVersionHistory: false,
  snapshotPromptOpen: false,
  viewingSnapshotId: null,
  isDirty: false,

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
  setSidebarWidth: (width) => set({ sidebarWidth: Math.min(400, Math.max(180, width)) }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleOutput: () => set((s) => ({ outputVisible: !s.outputVisible })),
  setOutputHeight: (height) => set({ outputHeight: Math.min(500, Math.max(80, height)) }),
  toggleSidebarPosition: () => set((s) => ({ sidebarPosition: s.sidebarPosition === "left" ? "right" : "left" })),

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
      }
    } else {
      set({ activeSketchPath: null, activeSketch: null, activeStoryboardPath: null, activeStoryboard: null });
    }
  },
  setActiveTab: (tabId) => {
    const { openTabs } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    if (!tab) return;
    set({ activeTabId: tabId });
    if (tab.type === "sketch") {
      set({ activeStoryboardPath: null, activeStoryboard: null });
      get().openSketch(tab.path);
    } else if (tab.type === "storyboard") {
      set({ activeSketchPath: null, activeSketch: null });
      get().openStoryboard(tab.path);
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

  createProject: async (path) => {
    set({ loading: true });
    try {
      const project = await invoke<ProjectView>("create_project_folder", { path });
      set({ currentProject: project, view: "sketch" });
      await get().loadRecentProjects();
      await get().loadSketches();
      await get().loadStoryboards();
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
      await get().loadSketches();
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to open project:", err);
      set({ error: String(err) });
    } finally {
      set({ loading: false });
    }
  },

  closeProject: () => {
    invoke("close_project").catch(console.error);
    set({
      currentProject: null,
      view: "home",
      sketches: [],
      activeSketchPath: null,
      activeSketch: null,
      storyboards: [],
      activeStoryboardPath: null,
      activeStoryboard: null,
      versions: [],
      snapshotPromptOpen: false,
      viewingSnapshotId: null,
      isDirty: false,
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

  saveVersion: async (label) => {
    try {
      await invoke<string>("save_with_label", { label });
      set({ viewingSnapshotId: null, isDirty: false });
      await get().loadVersions();
    } catch (err) {
      console.error("Failed to save version:", err);
    }
  },

  checkoutSnapshot: async (commitId) => {
    try {
      await invoke("checkout_version", { commitId });
      set({ viewingSnapshotId: commitId });
      // Reload file lists to reflect checked-out state
      await get().loadSketches();
      await get().loadStoryboards();
      const { activeSketchPath } = get();
      if (activeSketchPath) {
        await get().openSketch(activeSketchPath);
      }
    } catch (err) {
      console.error("Failed to checkout snapshot:", err);
    }
  },

  returnToLatest: async () => {
    try {
      const { versions } = get();
      if (versions.length > 0) {
        await invoke("checkout_version", { commitId: versions[0].id });
      }
      set({ viewingSnapshotId: null });
      await get().loadSketches();
      await get().loadStoryboards();
      const { activeSketchPath } = get();
      if (activeSketchPath) {
        await get().openSketch(activeSketchPath);
      }
    } catch (err) {
      console.error("Failed to return to latest:", err);
    }
  },

  restoreVersion: async (commitId) => {
    try {
      await invoke("restore_version", { commitId });
      set({ viewingSnapshotId: null });
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadVersions();
      const { activeSketchPath } = get();
      if (activeSketchPath) {
        await get().openSketch(activeSketchPath);
      }
    } catch (err) {
      console.error("Failed to restore version:", err);
    }
  },

  toggleVersionHistory: () => {
    set((state) => ({ showVersionHistory: !state.showVersionHistory }));
  },

  promptSnapshot: () => {
    set({ showVersionHistory: true, snapshotPromptOpen: true });
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
