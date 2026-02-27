import { useCallback, useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  const [loading, setLoading] = useState(true);
  const [waitingForCapture, setWaitingForCapture] = useState(false);

  // Listen for capture events from the capture window
  useEffect(() => {
    const unlistenComplete = listen<{ path: string }>("capture-complete", (event) => {
      onCapture(event.payload.path);
    });
    const unlistenCancel = listen("capture-cancel", () => {
      onCancel();
    });
    return () => {
      unlistenComplete.then((fn) => fn());
      unlistenCancel.then((fn) => fn());
    };
  }, [onCapture, onCancel]);

  // Load monitors and preview thumbnails
  useEffect(() => {
    (async () => {
      try {
        const mons = await invoke<MonitorInfo[]>("list_monitors");
        setMonitors(mons);

        if (mons.length === 1) {
          await openCaptureOnMonitor(mons[0]);
          return;
        }

        // Capture preview of each monitor
        const project = await invoke<{ root: string }>("get_current_project");
        const previews = new Map<number, string>();
        for (const m of mons) {
          const relPath = await invoke<string>("capture_fullscreen", { monitorId: m.id });
          previews.set(m.id, convertFileSrc(`${project.root}/${relPath}`));
        }
        setMonitorPreviews(previews);
        setLoading(false);
      } catch (err) {
        console.error("Failed to list monitors:", err);
        onCancel();
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
    setWaitingForCapture(true);
    try {
      // Capture a fresh screenshot of the monitor for the overlay background
      const bgRelPath = await invoke<string>("capture_fullscreen", { monitorId: monitor.id });
      const project = await invoke<{ root: string }>("get_current_project");

      // Open capture window on the target monitor
      await invoke("open_capture_window", {
        monitorId: monitor.id,
        physX: monitor.x,
        physY: monitor.y,
        physW: monitor.width,
        physH: monitor.height,
        bgPath: bgRelPath,
        projectRoot: project.root,
      });
    } catch (err) {
      console.error("Failed to open capture window:", err);
      onCancel();
    }
  }, [onCancel]);

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
