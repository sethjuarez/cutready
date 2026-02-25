import { create } from "zustand";
import { invoke, Channel } from "@tauri-apps/api/core";
import type { Project, ProjectSummary } from "../types/project";
import type {
  BrowserProfile,
  BrowserRunningStatus,
  CapturedAction,
  RecordedSession,
} from "../types/recording";

/** The panels / views available in the app. */
export type AppView = "home" | "editor" | "recording" | "settings";

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
      set({ currentProject: project, view: "editor" });
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
      set({ currentProject: project, view: "editor" });
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
    set({ currentProject: null, view: "home" });
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
