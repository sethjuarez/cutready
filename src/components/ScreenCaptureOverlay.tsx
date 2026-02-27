import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { info as logInfo, error as logError } from "@tauri-apps/plugin-log";

interface MonitorInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
}

interface ScreenCaptureOverlayProps {
  onCapture: (screenshotPath: string) => void;
  onCancel: () => void;
}

/**
 * Screen capture controller.
 * - Single monitor: immediately opens capture window on that monitor.
 * - Multi-monitor: shows a picker, then opens capture window on chosen monitor.
 * The actual capture UI (choose-mode / region-select) lives in CaptureWindow.tsx,
 * rendered in a separate borderless Tauri window on the target monitor.
 */
export function ScreenCaptureOverlay({ onCapture, onCancel }: ScreenCaptureOverlayProps) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [monitorPreviews, setMonitorPreviews] = useState<Map<number, string>>(new Map());
  const [previewPaths, setPreviewPaths] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [waitingForCapture, setWaitingForCapture] = useState(false);
  const mountedRef = useRef(false);
  const callbacksRef = useRef({ onCapture, onCancel });
  callbacksRef.current = { onCapture, onCancel };

  // Listen for capture events from the capture window (stable — no deps on callbacks)
  useEffect(() => {
    logInfo("[Overlay] Setting up event listeners");
    const unlistenComplete = listen<{ path: string }>("capture-complete", (event) => {
      logInfo(`[Overlay] capture-complete event: ${event.payload.path}`);
      callbacksRef.current.onCapture(event.payload.path);
    });
    const unlistenCancel = listen("capture-cancel", () => {
      logInfo("[Overlay] capture-cancel event received");
      callbacksRef.current.onCancel();
    });
    return () => {
      logInfo("[Overlay] Cleaning up event listeners");
      unlistenComplete.then((fn) => fn());
      unlistenCancel.then((fn) => fn());
    };
  }, []);

  // Load monitors and preview thumbnails (guarded against StrictMode double-fire)
  useEffect(() => {
    if (mountedRef.current) {
      logInfo("[Overlay] Skipping duplicate mount (StrictMode)");
      return;
    }
    mountedRef.current = true;
    (async () => {
      try {
        logInfo("[Overlay] Listing monitors...");
        const mons = await invoke<MonitorInfo[]>("list_monitors");
        logInfo(`[Overlay] Found ${mons.length} monitor(s)`);
        setMonitors(mons);

        if (mons.length === 1) {
          logInfo("[Overlay] Single monitor — opening capture directly");
          await openCaptureOnMonitor(mons[0]);
          return;
        }

        // Capture preview of each monitor
        logInfo("[Overlay] Multi-monitor — capturing previews (parallel)");
        const project = await invoke<{ root: string }>("get_current_project");
        const ids = mons.map((m) => m.id);
        const pathMap = await invoke<Record<number, string>>("capture_all_monitors", { monitorIds: ids });
        const previews = new Map<number, string>();
        const paths = new Map<number, string>();
        for (const m of mons) {
          const relPath = pathMap[m.id];
          if (relPath) {
            previews.set(m.id, convertFileSrc(`${project.root}/${relPath}`));
            paths.set(m.id, relPath);
          }
        }
        setMonitorPreviews(previews);
        setPreviewPaths(paths);
        setLoading(false);
      } catch (err) {
        logError(`[Overlay] Monitor loading failed: ${err}`);
        console.error("Failed to list monitors:", err);
        callbacksRef.current.onCancel();
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape to cancel (only in picker phase)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !waitingForCapture) {
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, waitingForCapture]);

  const openCaptureOnMonitor = useCallback(async (monitor: MonitorInfo) => {
    logInfo(`[Overlay] openCaptureOnMonitor: id=${monitor.id} ${monitor.width}x${monitor.height}`);
    setWaitingForCapture(true);
    try {
      // Reuse existing preview if available; otherwise capture fresh
      let bgRelPath = previewPaths.get(monitor.id);
      if (bgRelPath) {
        logInfo(`[Overlay] Reusing preview: ${bgRelPath}`);
      } else {
        logInfo("[Overlay] No preview — capturing fullscreen...");
        bgRelPath = await invoke<string>("capture_fullscreen", { monitorId: monitor.id });
        logInfo(`[Overlay] Captured: ${bgRelPath}`);
      }
      const project = await invoke<{ root: string }>("get_current_project");
      logInfo(`[Overlay] Project root: ${project.root}`);

      // Open capture window on the target monitor
      logInfo("[Overlay] Opening capture window...");
      await invoke("open_capture_window", {
        monitorId: monitor.id,
        physX: monitor.x,
        physY: monitor.y,
        physW: monitor.width,
        physH: monitor.height,
        bgPath: bgRelPath,
        projectRoot: project.root,
      });
      logInfo("[Overlay] Capture window opened successfully");
    } catch (err) {
      logError(`[Overlay] openCaptureOnMonitor failed: ${err}`);
      console.error("Failed to open capture window:", err);
      onCancel();
    }
  }, [onCancel, previewPaths]);

  // ── Waiting for capture window ──
  if (waitingForCapture) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center">
        <div className="text-white/60 text-sm animate-pulse">Capture in progress...</div>
      </div>
    );
  }

  // ── Loading ──
  if (loading) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center">
        <div className="text-white text-sm animate-pulse">Preparing capture...</div>
      </div>
    );
  }

  // ── Monitor picker (multi-monitor only) ──
  return (
    <div className="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center gap-6">
      <div className="text-white text-base font-medium">Select a screen to capture</div>
      <div className="flex gap-4">
        {monitors.map((m) => (
          <button
            key={m.id}
            onClick={() => openCaptureOnMonitor(m)}
            className="group flex flex-col items-center gap-2 p-2 rounded-lg border-2 border-transparent hover:border-[var(--color-accent)] transition-colors"
          >
            <div className="w-48 h-28 rounded-md overflow-hidden bg-black/50 border border-white/10 group-hover:border-white/30 transition-colors">
              {monitorPreviews.get(m.id) ? (
                <img src={monitorPreviews.get(m.id)} alt={m.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-white/30 text-xs">No preview</div>
              )}
            </div>
            <div className="text-white/80 text-xs">
              {m.name} {m.is_primary ? "(Primary)" : ""} — {m.width}×{m.height}
            </div>
          </button>
        ))}
      </div>
      <button
        onClick={onCancel}
        className="text-white/50 hover:text-white text-xs mt-2 transition-colors"
      >
        Cancel (Esc)
      </button>
    </div>
  );
}
