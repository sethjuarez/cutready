import { useEffect } from "react";
import { useAppStore, type ActivityEntry } from "../stores/appStore";

let installed = false;

/** Map tauri-plugin-log numeric levels to our level type. */
function mapLogLevel(level: number): ActivityEntry["level"] {
  // tauri-plugin-log levels: 1=trace, 2=debug, 3=info, 4=warn, 5=error
  if (level >= 5) return "error";
  if (level >= 4) return "warn";
  return "info";
}

function makeEntry(
  source: string,
  level: ActivityEntry["level"],
  content: string,
): ActivityEntry {
  return {
    id: `dbg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date(),
    source,
    level,
    content,
  };
}

/**
 * Installs debug log capture for:
 * 1. JavaScript console.log/warn/error/debug → "js" source
 * 2. Rust backend logs via tauri-plugin-log attachLogger → "rust" source
 *
 * Call once at app root. Idempotent.
 */
export function useDebugLog() {
  useEffect(() => {
    if (installed) return;
    installed = true;

    const add = useAppStore.getState().addDebugEntry;

    // --- 1. Intercept JS console methods ---
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origDebug = console.debug;

    function wrap(
      original: (...args: unknown[]) => void,
      level: ActivityEntry["level"],
    ) {
      return (...args: unknown[]) => {
        original(...args);
        const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
        add(makeEntry("js", level, msg));
      };
    }

    console.log = wrap(origLog, "info");
    console.warn = wrap(origWarn, "warn");
    console.error = wrap(origError, "error");
    console.debug = wrap(origDebug, "info");

    // --- 2. Attach Rust backend log listener via tauri-plugin-log ---
    if ((window as any).__TAURI_INTERNALS__) {
      import("@tauri-apps/plugin-log").then(({ attachLogger }) => {
        attachLogger(({ level, message }) => {
          add(makeEntry("rust", mapLogLevel(level), message));
        });
      }).catch(() => {
        // plugin not available in dev mode without Tauri
      });
    }
  }, []);
}
