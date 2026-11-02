import { useEffect } from "react";
import { listenEvent } from "../ipc/events";
import { useAppStore } from "../stores/appStore";
import { useRecordingStore } from "../stores/recordingStore";
import { useSettingsStore } from "../hooks/useSettings";

/**
 * Main-window recording event subscriptions (architecture v3 F5), moved
 * unchanged from useGlobalHotkeys. Renders nothing.
 *
 * - `toggle-recording` (Ctrl+Shift+R) — starts or stops a recording session.
 *   Only works when recording feature is enabled, a browser is prepared, and a project is open.
 */
export function RecordingEventsHost() {
  useEffect(() => {
    const unlisten = listenEvent("toggle-recording", () => {
      const settings = useSettingsStore.getState().settings;
      if (!settings.featureRecording) return;

      const { currentProject, loading } = useAppStore.getState();
      const {
        isRecording,
        isBrowserReady,
        startRecording,
        stopRecording,
      } = useRecordingStore.getState();

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

  return null;
}
