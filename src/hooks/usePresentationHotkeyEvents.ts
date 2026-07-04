import { useEffect } from "react";
import { listen } from "../services/tauri";

interface PresentationHotkeyHandlers {
  next?: () => void;
  previous?: () => void;
  playPause?: () => void;
  speedUp?: () => void;
  slowDown?: () => void;
  toggleMode?: () => void;
  exit?: () => void;
}

export function usePresentationHotkeyEvents(handlers: PresentationHotkeyHandlers) {
  useEffect(() => {
    const listeners = [
      handlers.next ? listen("presentation-hotkey-next", handlers.next) : null,
      handlers.previous ? listen("presentation-hotkey-previous", handlers.previous) : null,
      handlers.playPause ? listen("presentation-hotkey-play-pause", handlers.playPause) : null,
      handlers.speedUp ? listen("presentation-hotkey-speed-up", handlers.speedUp) : null,
      handlers.slowDown ? listen("presentation-hotkey-slow-down", handlers.slowDown) : null,
      handlers.toggleMode ? listen("presentation-hotkey-toggle-mode", handlers.toggleMode) : null,
      handlers.exit ? listen("presentation-hotkey-exit", handlers.exit) : null,
    ].filter((listener): listener is Promise<() => void> => listener !== null);

    return () => {
      for (const unlisten of listeners) {
        unlisten.then((fn) => fn());
      }
    };
  }, [
    handlers.next,
    handlers.previous,
    handlers.playPause,
    handlers.speedUp,
    handlers.slowDown,
    handlers.toggleMode,
    handlers.exit,
  ]);
}
