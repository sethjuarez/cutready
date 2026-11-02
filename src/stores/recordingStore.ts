// Browser observation ("legacy recording") state (architecture v3 F5). Moved
// unchanged from appStore: the shared `loading`, `error` and `view` fields stay
// in appStore and are written with getState()/setState() inside actions only.
// Project open, close and switch never reset this state, before or after the split.
import { create } from "zustand";
import { Channel } from "../services/tauri";
import { browserRecordingIpc } from "../ipc/browserRecording";
import { useAppStore } from "./appStore";
import type {
  BrowserProfile,
  BrowserRunningStatus,
  CapturedAction,
  RecordedSession,
} from "../types/recording";

export interface RecordingState {
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
}

export interface RecordingActions {
  /** Detect browser profiles available on the system. */
  detectProfiles: () => Promise<void>;
  /** Check which browsers are currently running. */
  checkBrowsersRunning: () => Promise<void>;
  /** Select a profile (or null for fresh browser). */
  setSelectedProfile: (profile: BrowserProfile | null) => void;
  /** Launch a recording browser (with selected profile or fresh). */
  prepareBrowser: () => Promise<void>;
  /** Close the recording browser and disconnect. */
  disconnectBrowser: () => Promise<void>;
  /** Start observing in the prepared browser. */
  startRecording: () => Promise<void>;
  /** Stop the active recording (browser stays open). */
  stopRecording: () => Promise<void>;
}

export type RecordingStoreState = RecordingState & RecordingActions;

/** Recording state as it is at app start. */
export function initialRecordingState(): RecordingState {
  return {
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
  };
}

export const useRecordingStore = create<RecordingStoreState>((set, get) => ({
  ...initialRecordingState(),

  // ── Profile actions ───────────────────────────────────────

  detectProfiles: async () => {
    try {
      const profiles = await browserRecordingIpc.detectProfiles();
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
      const status = await browserRecordingIpc.checkBrowsersRunning();
      set({ browserRunning: status });
    } catch (err) {
      console.error("Failed to check browsers:", err);
    }
  },

  setSelectedProfile: (profile) => set({ selectedProfile: profile }),

  // ── Browser actions ───────────────────────────────────────

  prepareBrowser: async () => {
    useAppStore.setState({ loading: true, error: null });
    try {
      const { selectedProfile } = get();
      const channel = await browserRecordingIpc.prepareBrowser({
        userDataDir: selectedProfile?.user_data_dir ?? null,
        profileDirectory: selectedProfile?.profile_directory ?? null,
        browserChannel: selectedProfile?.browser ?? null,
      });
      set({
        isBrowserReady: true,
        browserChannel: channel,
        capturedActions: [],
        lastSession: null,
      });
      useAppStore.setState({ view: "recording" });
    } catch (err) {
      console.error("Failed to prepare browser:", err);
      useAppStore.setState({ error: String(err) });
    } finally {
      useAppStore.setState({ loading: false });
    }
  },

  disconnectBrowser: async () => {
    useAppStore.setState({ loading: true });
    try {
      await browserRecordingIpc.disconnectBrowser();
    } catch (err) {
      console.error("Failed to disconnect browser:", err);
    } finally {
      useAppStore.setState({ loading: false });
      set({
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
    useAppStore.setState({ loading: true });
    set({ capturedActions: [], lastSession: null });
    try {
      const channel = new Channel<CapturedAction>();
      channel.onmessage = (action) => {
        set((state) => ({
          capturedActions: [...state.capturedActions, action],
        }));
      };

      const sessionId = await browserRecordingIpc.startSession(channel);

      set({
        isRecording: true,
        recordingSessionId: sessionId,
        _activeChannel: channel,
      });
    } catch (err) {
      console.error("Failed to start recording:", err);
    } finally {
      useAppStore.setState({ loading: false });
    }
  },

  stopRecording: async () => {
    useAppStore.setState({ loading: true });
    try {
      const session = await browserRecordingIpc.stopSession();
      set({
        isRecording: false,
        recordingSessionId: null,
        lastSession: session,
        _activeChannel: null,
      });
    } catch (err) {
      console.error("Failed to stop recording:", err);
    } finally {
      useAppStore.setState({ loading: false });
    }
  },
}));
