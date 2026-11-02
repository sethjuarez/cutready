// Typed browser-observation commands (architecture v3 F5). recordingStore calls
// these instead of raw `invoke`; they are the same calls appStore made before
// the split. devMock doesn't implement them.
import { invoke, type Channel } from "../services/tauri";
import type {
  BrowserProfile,
  BrowserRunningStatus,
  CapturedAction,
  RecordedSession,
} from "../types/recording";

export interface PrepareBrowserArgs {
  userDataDir: string | null;
  profileDirectory: string | null;
  browserChannel: string | null;
}

export const browserRecordingIpc = {
  detectProfiles: () => invoke<BrowserProfile[]>("detect_browser_profiles"),
  checkBrowsersRunning: () => invoke<BrowserRunningStatus>("check_browsers_running"),
  prepareBrowser: (args: PrepareBrowserArgs) => invoke<string>("prepare_browser", { ...args }),
  disconnectBrowser: () => invoke("disconnect_browser"),
  startSession: (onAction: Channel<CapturedAction>) => invoke<string>("start_recording_session", { onAction }),
  stopSession: () => invoke<RecordedSession>("stop_recording_session"),
};
