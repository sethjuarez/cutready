import { useEffect } from "react";
import { invoke, listen } from "../services/tauri";
import { useAppStore } from "../stores/appStore";
import { useSettings, useSettingsStore } from "../hooks/useSettings";
import { useToastStore } from "../stores/toastStore";

/**
 * Registers listeners for global hotkeys emitted by the Rust backend.
 *
 * Currently handles:
 * - `toggle-recording` (Ctrl+Shift+R) — starts or stops a recording session.
 *   Only works when recording feature is enabled, a browser is prepared, and a project is open.
 */
export function useGlobalHotkeys() {
  const { settings, loaded } = useSettings();

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

  useEffect(() => {
    if (!loaded) return;

    const bindings = [
      { action: "next", hotkey: settings.presentationNextHotkey },
      { action: "previous", hotkey: settings.presentationPreviousHotkey },
      { action: "play_pause", hotkey: settings.presentationPlayPauseHotkey },
      { action: "speed_up", hotkey: settings.presentationSpeedUpHotkey },
      { action: "slow_down", hotkey: settings.presentationSlowDownHotkey },
      { action: "toggle_mode", hotkey: settings.presentationToggleModeHotkey },
      { action: "exit", hotkey: settings.presentationExitHotkey },
    ];

    invoke("configure_presentation_hotkeys", { bindings }).catch((error) => {
      console.warn("[hotkeys] Failed to configure presentation hotkeys:", error);
      useToastStore.getState().show(`Presentation hotkey unavailable: ${error}`, 5000, "warning");
    });

    return () => {
      invoke("configure_presentation_hotkeys", { bindings: [] }).catch((error) => {
        console.warn("[hotkeys] Failed to clear presentation hotkeys:", error);
      });
    };
  }, [
    loaded,
    settings.presentationNextHotkey,
    settings.presentationPreviousHotkey,
    settings.presentationPlayPauseHotkey,
    settings.presentationSpeedUpHotkey,
    settings.presentationSlowDownHotkey,
    settings.presentationToggleModeHotkey,
    settings.presentationExitHotkey,
  ]);
}
