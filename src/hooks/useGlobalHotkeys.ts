import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/appStore";
import { useSettingsStore } from "../hooks/useSettings";

/**
 * Registers listeners for global hotkeys emitted by the Rust backend.
 *
 * Currently handles:
 * - `toggle-recording` (Ctrl+Shift+R) — starts or stops a recording session.
 *   Only works when recording feature is enabled, a browser is prepared, and a project is open.
 */
export function useGlobalHotkeys() {
  useEffect(() => {
    const unlisten = listen("toggle-recording", () => {
      const settings = useSettingsStore.getState().settings;
      if (!settings.featureRecording) return;

      const {
        isRecording,
        isBrowserReady,
        currentProject,
        loading,
        startRecording,
        stopRecording,
      } = useAppStore.getState();

      // Need a project and a prepared browser
      if (!currentProject || !isBrowserReady || loading) return;

      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
