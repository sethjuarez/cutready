import { useEffect } from "react";
import { invoke } from "../services/tauri";
import { useSettings } from "../hooks/useSettings";
import { useToastStore } from "../stores/toastStore";

/**
 * Configures the presentation hotkeys registered by the Rust backend.
 *
 * The `toggle-recording` (Ctrl+Shift+R) listener lives in RecordingEventsHost.
 */
export function useGlobalHotkeys() {
  const { settings, loaded } = useSettings();

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
