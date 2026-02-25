import { create } from "zustand";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { Project, ProjectSummary } from "../types/project";
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

interface AppStoreState {
  /** Current active view. */
  view: AppView;
  /** Currently open project (null if none). */
  currentProject: Project | null;
  /** List of project summaries for the home screen. */
  projects: ProjectSummary[];
  /** Whether an operation is in progress. */
  loading: boolean;
  /** Last error message to display in the UI. */
  error: string | null;

  // ── Sketch state ───────────────────────────────────────


  /** Sketch summaries for the current project. */
  sketches: SketchSummary[];
  /** The currently active sketch ID. */
  activeSketchId: string | null;
  /** The full active sketch (loaded when editing). */
  activeSketch: Sketch | null;

  // ── Storyboard state ─────────────────────────────────

  /** Storyboard summaries for the current project. */
  storyboards: StoryboardSummary[];
  /** The currently active storyboard ID. */
  activeStoryboardId: string | null;
  /** The full active storyboard (loaded when viewing). */
  activeStoryboard: Storyboard | null;

  /** Version history for the current project. */
  versions: VersionEntry[];
  /** Whether the version history sidebar is visible. */
  showVersionHistory: boolean;

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

  // ── Project actions ───────────────────────────────────────

  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<void>;
  openProject: (projectId: string) => Promise<void>;
  saveProject: () => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  closeProject: () => void;

  // ── Sketch actions ─────────────────────────────────────

  /** Load sketch list for current project. */
  loadSketches: () => Promise<void>;
  /** Create a new sketch and open it. */
  createSketch: (title: string) => Promise<void>;
  /** Open a sketch for editing. */
  openSketch: (sketchId: string) => Promise<void>;
  /** Update the active sketch (description and/or rows). */
  updateSketch: (update: { description?: unknown; rows?: import("../types/sketch").PlanningRow[] }) => Promise<void>;
  /** Update a sketch's title. */
  updateSketchTitle: (sketchId: string, title: string) => Promise<void>;
  /** Delete a sketch. */
  deleteSketch: (sketchId: string) => Promise<void>;
  /** Close the active sketch (return to storyboard). */
  closeSketch: () => void;

  // ── Storyboard actions ───────────────────────────────

  /** Load storyboard list for current project. */
  loadStoryboards: () => Promise<void>;
  /** Create a new storyboard and open it. */
  createStoryboard: (title: string) => Promise<void>;
  /** Open a storyboard for viewing. */
  openStoryboard: (storyboardId: string) => Promise<void>;
  /** Update storyboard title/description. */
  updateStoryboard: (update: { title?: string; description?: string }) => Promise<void>;
  /** Delete a storyboard. */
  deleteStoryboard: (storyboardId: string) => Promise<void>;
  /** Add a sketch to the active storyboard. */
  addSketchToStoryboard: (sketchId: string, position?: number) => Promise<void>;
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
  /** Save a labeled version. */
  saveVersion: (label: string) => Promise<void>;
  /** Restore a historical version. */
  restoreVersion: (commitId: string) => Promise<void>;
  /** Toggle version history sidebar. */
  toggleVersionHistory: () => void;

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
  projects: [],
  loading: false,
  error: null,

  sketches: [],
  activeSketchId: null,
  activeSketch: null,
  storyboards: [],
  activeStoryboardId: null,
  activeStoryboard: null,
  versions: [],
  showVersionHistory: false,

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

  // ── Project actions ───────────────────────────────────────

  loadProjects: async () => {
    set({ loading: true });
    try {
      const projects = await invoke<ProjectSummary[]>("list_projects");
      set({ projects });
    } catch (err) {
      console.error("Failed to load projects:", err);
    } finally {
      set({ loading: false });
    }
  },

  createProject: async (name) => {
    set({ loading: true });
    try {
      const project = await invoke<Project>("create_project", { name });
      set({ currentProject: project, view: "sketch" });
      await get().loadProjects();
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      set({ loading: false });
    }
  },

  openProject: async (projectId) => {
    set({ loading: true });
    try {
      const project = await invoke<Project>("open_project", { projectId });
      set({ currentProject: project, view: "sketch" });
    } catch (err) {
      console.error("Failed to open project:", err);
    } finally {
      set({ loading: false });
    }
  },

  saveProject: async () => {
    try {
      await invoke("save_project");
    } catch (err) {
      console.error("Failed to save project:", err);
    }
  },

  deleteProject: async (projectId) => {
    try {
      await invoke("delete_project", { projectId });
      const { currentProject } = get();
      if (currentProject?.id === projectId) {
        set({ currentProject: null, view: "home" });
      }
      await get().loadProjects();
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  },

  closeProject: () => {
    set({
      currentProject: null,
      view: "home",
      sketches: [],
      activeSketchId: null,
      activeSketch: null,
      storyboards: [],
      activeStoryboardId: null,
      activeStoryboard: null,
      versions: [],
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
      const sketch = await invoke<Sketch>("create_sketch", { title });
      set({
        activeSketchId: sketch.id,
        activeSketch: sketch,
      });
      await get().loadSketches();
    } catch (err) {
      console.error("Failed to create sketch:", err);
    }
  },

  openSketch: async (sketchId) => {
    try {
      const sketch = await invoke<Sketch>("get_sketch", { id: sketchId });
      set({
        activeSketchId: sketch.id,
        activeSketch: sketch,
      });
    } catch (err) {
      console.error("Failed to open sketch:", err);
    }
  },

  updateSketch: async (update) => {
    const { activeSketchId } = get();
    if (!activeSketchId) return;
    try {
      await invoke("update_sketch", { id: activeSketchId, ...update });
    } catch (err) {
      console.error("Failed to update sketch:", err);
    }
  },

  updateSketchTitle: async (sketchId, title) => {
    try {
      await invoke("update_sketch_title", { id: sketchId, title });
      await get().loadSketches();
      const { activeSketch } = get();
      if (activeSketch?.id === sketchId) {
        set({ activeSketch: { ...activeSketch, title } });
      }
    } catch (err) {
      console.error("Failed to update sketch title:", err);
    }
  },

  deleteSketch: async (sketchId) => {
    try {
      await invoke("delete_sketch", { id: sketchId });
      const { activeSketchId } = get();
      if (activeSketchId === sketchId) {
        set({ activeSketchId: null, activeSketch: null });
      }
      await get().loadSketches();
    } catch (err) {
      console.error("Failed to delete sketch:", err);
    }
  },

  closeSketch: () => {
    set({ activeSketchId: null, activeSketch: null });
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
      const storyboard = await invoke<Storyboard>("create_storyboard", { title });
      set({
        activeStoryboardId: storyboard.id,
        activeStoryboard: storyboard,
      });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to create storyboard:", err);
    }
  },

  openStoryboard: async (storyboardId) => {
    try {
      const storyboard = await invoke<Storyboard>("get_storyboard", { id: storyboardId });
      set({
        activeStoryboardId: storyboard.id,
        activeStoryboard: storyboard,
        activeSketchId: null,
        activeSketch: null,
      });
    } catch (err) {
      console.error("Failed to open storyboard:", err);
    }
  },

  updateStoryboard: async (update) => {
    const { activeStoryboardId } = get();
    if (!activeStoryboardId) return;
    try {
      await invoke("update_storyboard", { id: activeStoryboardId, ...update });
      // Reload to get updated data
      const storyboard = await invoke<Storyboard>("get_storyboard", { id: activeStoryboardId });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to update storyboard:", err);
    }
  },

  deleteStoryboard: async (storyboardId) => {
    try {
      await invoke("delete_storyboard", { id: storyboardId });
      const { activeStoryboardId } = get();
      if (activeStoryboardId === storyboardId) {
        set({ activeStoryboardId: null, activeStoryboard: null });
      }
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to delete storyboard:", err);
    }
  },

  addSketchToStoryboard: async (sketchId, position) => {
    const { activeStoryboardId } = get();
    if (!activeStoryboardId) return;
    try {
      await invoke("add_sketch_to_storyboard", {
        storyboardId: activeStoryboardId,
        sketchId,
        position: position ?? null,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { id: activeStoryboardId });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to add sketch to storyboard:", err);
    }
  },

  removeFromStoryboard: async (position) => {
    const { activeStoryboardId } = get();
    if (!activeStoryboardId) return;
    try {
      await invoke("remove_sketch_from_storyboard", {
        storyboardId: activeStoryboardId,
        position,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { id: activeStoryboardId });
      set({ activeStoryboard: storyboard });
      await get().loadStoryboards();
    } catch (err) {
      console.error("Failed to remove from storyboard:", err);
    }
  },

  addSectionToStoryboard: async (title, position) => {
    const { activeStoryboardId } = get();
    if (!activeStoryboardId) return;
    try {
      await invoke("add_section_to_storyboard", {
        storyboardId: activeStoryboardId,
        title,
        position: position ?? null,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { id: activeStoryboardId });
      set({ activeStoryboard: storyboard });
    } catch (err) {
      console.error("Failed to add section:", err);
    }
  },

  reorderStoryboardItems: async (items) => {
    const { activeStoryboardId } = get();
    if (!activeStoryboardId) return;
    try {
      await invoke("reorder_storyboard_items", {
        storyboardId: activeStoryboardId,
        items,
      });
      const storyboard = await invoke<Storyboard>("get_storyboard", { id: activeStoryboardId });
      set({ activeStoryboard: storyboard });
    } catch (err) {
      console.error("Failed to reorder items:", err);
    }
  },

  closeStoryboard: () => {
    set({ activeStoryboardId: null, activeStoryboard: null, activeSketchId: null, activeSketch: null });
  },

  // ── Versioning actions ───────────────────────────────────

  loadVersions: async () => {
    try {
      const versions = await invoke<VersionEntry[]>("list_versions");
      set({ versions });
    } catch (err) {
      console.error("Failed to load versions:", err);
    }
  },

  saveVersion: async (label) => {
    try {
      await invoke<string>("save_with_label", { label });
      await get().loadVersions();
    } catch (err) {
      console.error("Failed to save version:", err);
    }
  },

  restoreVersion: async (commitId) => {
    try {
      await invoke("restore_version", { commitId });
      // Reload everything after restore
      await get().loadSketches();
      await get().loadStoryboards();
      await get().loadVersions();
      const { activeSketchId } = get();
      if (activeSketchId) {
        await get().openSketch(activeSketchId);
      }
    } catch (err) {
      console.error("Failed to restore version:", err);
    }
  },

  toggleVersionHistory: () => {
    set((state) => ({ showVersionHistory: !state.showVersionHistory }));
  },

  // ── Profile actions ───────────────────────────────────────

  detectProfiles: async () => {
    try {
      const profiles = await invoke<BrowserProfile[]>(
        "detect_browser_profiles"
      );
      const { selectedProfile } = get();
      // Auto-select the first profile if none selected yet
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
