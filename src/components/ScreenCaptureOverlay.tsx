import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

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

type Phase = "pick-monitor" | "choose-mode" | "select-region";

/**
 * Screen capture overlay with three phases:
 * 1. Pick which monitor (thumbnails — skipped for single monitor)
 * 2. Choose capture mode: Full Screen or Select Region
 * 3. Draw selection rectangle (only if region mode chosen)
 */
export function ScreenCaptureOverlay({ onCapture, onCancel }: ScreenCaptureOverlayProps) {
  const [phase, setPhase] = useState<Phase>("pick-monitor");
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [monitorPreviews, setMonitorPreviews] = useState<Map<number, string>>(new Map());
  const [selectedMonitor, setSelectedMonitor] = useState<MonitorInfo | null>(null);
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selStart, setSelStart] = useState<{ x: number; y: number } | null>(null);
  const [selEnd, setSelEnd] = useState<{ x: number; y: number } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [loading, setLoading] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Load monitors and capture preview thumbnails for each
  useEffect(() => {
    (async () => {
      try {
        const mons = await invoke<MonitorInfo[]>("list_monitors");
        setMonitors(mons);

        // If only one monitor, skip picker and go straight to capture
        if (mons.length === 1) {
          await startCapture(mons[0]);
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

  // Escape key — step back through phases
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (phase === "select-region") {
          // Back to choose-mode
          setSelecting(false);
          setSelStart(null);
          setSelEnd(null);
          setPhase("choose-mode");
          return;
        }
        if (phase === "choose-mode" && monitors.length > 1) {
          // Back to monitor picker
          setBgImage(null);
          setSelectedMonitor(null);
          setPhase("pick-monitor");
          return;
        }
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, phase, monitors.length]);

  const startCapture = useCallback(async (monitor: MonitorInfo) => {
    setSelectedMonitor(monitor);
    setLoading(true);
    try {
      const relPath = await invoke<string>("capture_fullscreen", { monitorId: monitor.id });
      const project = await invoke<{ root: string }>("get_current_project");
      setBgImage(convertFileSrc(`${project.root}/${relPath}`));
      setPhase("choose-mode");
      setLoading(false);
    } catch (err) {
      console.error("Failed to capture monitor:", err);
      onCancel();
    }
  }, [onCancel]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (phase !== "select-region") return;
    e.preventDefault();
    setSelecting(true);
    setSelStart({ x: e.clientX, y: e.clientY });
    setSelEnd({ x: e.clientX, y: e.clientY });
  }, [phase]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!selecting) return;
      setSelEnd({ x: e.clientX, y: e.clientY });
    },
    [selecting],
  );

  const handleMouseUp = useCallback(async () => {
    if (!selecting || !selStart || !selEnd || !selectedMonitor) return;
    setSelecting(false);

    const rect = getSelRect(selStart, selEnd);
    if (rect.w < 10 || rect.h < 10) return;

    setCapturing(true);
    try {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const scaleX = selectedMonitor.width / overlay.clientWidth;
      const scaleY = selectedMonitor.height / overlay.clientHeight;

      const absX = Math.round(selectedMonitor.x + rect.x * scaleX);
      const absY = Math.round(selectedMonitor.y + rect.y * scaleY);
      const absW = Math.round(rect.w * scaleX);
      const absH = Math.round(rect.h * scaleY);

      const path = await invoke<string>("capture_region", {
        monitorId: selectedMonitor.id,
        x: absX, y: absY, width: absW, height: absH,
      });
      onCapture(path);
    } catch (err) {
      console.error("Capture region failed:", err);
      onCancel();
    }
  }, [selecting, selStart, selEnd, selectedMonitor, onCapture, onCancel]);

  const handleFullScreen = useCallback(async () => {
    if (!selectedMonitor) return;
    setCapturing(true);
    try {
      const path = await invoke<string>("capture_fullscreen", { monitorId: selectedMonitor.id });
      onCapture(path);
    } catch (err) {
      console.error("Fullscreen capture failed:", err);
      onCancel();
    }
  }, [selectedMonitor, onCapture, onCancel]);

  const rect = selStart && selEnd ? getSelRect(selStart, selEnd) : null;

  // ── Loading state ──
  if (loading) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center">
        <div className="text-white text-sm animate-pulse">Preparing capture...</div>
      </div>
    );
  }

  // ── Phase 1: Monitor picker ──
  if (phase === "pick-monitor") {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center gap-6">
        <div className="text-white text-base font-medium">Select a screen to capture</div>
        <div className="flex gap-4">
          {monitors.map((m) => (
            <button
              key={m.id}
              onClick={() => startCapture(m)}
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

  // ── Phase 2: Choose capture mode ──
  if (phase === "choose-mode") {
    return (
      <div
        className="fixed inset-0 z-[9999] select-none"
        style={{
          backgroundImage: bgImage ? `url(${bgImage})` : undefined,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        <div className="absolute inset-0 bg-black/50 pointer-events-none" />

        {/* Centered toolbar */}
        <div className="absolute top-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/80 backdrop-blur-md rounded-xl px-5 py-3 shadow-2xl">
          <button
            onClick={handleFullScreen}
            className="flex items-center gap-2 text-sm text-white bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg transition-colors"
          >
            <span className="text-base">🖥️</span> Full Screen
          </button>
          <div className="w-px h-6 bg-white/20" />
          <button
            onClick={() => setPhase("select-region")}
            className="flex items-center gap-2 text-sm text-white bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg transition-colors"
          >
            <span className="text-base">✂️</span> Select Region
          </button>
          {monitors.length > 1 && (
            <>
              <div className="w-px h-6 bg-white/20" />
              <button
                onClick={() => {
                  setBgImage(null);
                  setSelectedMonitor(null);
                  setPhase("pick-monitor");
                }}
                className="text-xs text-white/50 hover:text-white px-2 py-1 transition-colors"
              >
                ← Switch Screen
              </button>
            </>
          )}
          <div className="w-px h-6 bg-white/20" />
          <button
            onClick={onCancel}
            className="text-xs text-white/50 hover:text-white px-2 py-1 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Phase 3: Region selection ──
  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] select-none"
      style={{
        cursor: capturing ? "wait" : "crosshair",
        backgroundImage: bgImage ? `url(${bgImage})` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Dark overlay outside selection */}
      <div className="absolute inset-0 bg-black/40 pointer-events-none" />

      {/* Selection rectangle */}
      {rect && rect.w > 2 && rect.h > 2 && (
        <>
          <div
            className="absolute border-2 border-white/80 pointer-events-none"
            style={{
              left: rect.x, top: rect.y, width: rect.w, height: rect.h,
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.4)",
              backgroundImage: bgImage ? `url(${bgImage})` : undefined,
              backgroundSize: overlayRef.current
                ? `${overlayRef.current.clientWidth}px ${overlayRef.current.clientHeight}px`
                : undefined,
              backgroundPosition: `-${rect.x}px -${rect.y}px`,
            }}
          />
          <div
            className="absolute text-[11px] text-white bg-black/70 px-1.5 py-0.5 rounded pointer-events-none"
            style={{ left: rect.x, top: rect.y + rect.h + 4 }}
          >
            {Math.round(rect.w)}×{Math.round(rect.h)}
          </div>
        </>
      )}

      {/* Toolbar */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/70 backdrop-blur-sm rounded-lg px-4 py-2 pointer-events-auto">
        <span className="text-white/80 text-xs">Click & drag to select a region</span>
        <div className="w-px h-4 bg-white/20" />
        <button
          onClick={() => {
            setSelecting(false);
            setSelStart(null);
            setSelEnd(null);
            setPhase("choose-mode");
          }}
          className="text-xs text-white/60 hover:text-white px-2 py-1 transition-colors"
        >
          ← Back (Esc)
        </button>
      </div>
    </div>
  );
}

function getSelRect(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}
