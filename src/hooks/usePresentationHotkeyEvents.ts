import { useEffect } from "react";
import { listenEvent } from "../ipc/events";

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
      handlers.next ? listenEvent("presentation-hotkey-next", handlers.next) : null,
      handlers.previous ? listenEvent("presentation-hotkey-previous", handlers.previous) : null,
      handlers.playPause ? listenEvent("presentation-hotkey-play-pause", handlers.playPause) : null,
      handlers.speedUp ? listenEvent("presentation-hotkey-speed-up", handlers.speedUp) : null,
      handlers.slowDown ? listenEvent("presentation-hotkey-slow-down", handlers.slowDown) : null,
      handlers.toggleMode ? listenEvent("presentation-hotkey-toggle-mode", handlers.toggleMode) : null,
      handlers.exit ? listenEvent("presentation-hotkey-exit", handlers.exit) : null,
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
