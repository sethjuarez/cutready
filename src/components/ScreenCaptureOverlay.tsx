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

/**
 * Fullscreen overlay for screen region capture.
 *
 * Takes a fullscreen screenshot immediately, displays it as
 * the overlay background, then lets the user draw a selection
 * rectangle. The selected region is cropped and saved.
 */
export function ScreenCaptureOverlay({ onCapture, onCancel }: ScreenCaptureOverlayProps) {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [selectedMonitor, setSelectedMonitor] = useState<MonitorInfo | null>(null);
  const [bgImage, setBgImage] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selStart, setSelStart] = useState<{ x: number; y: number } | null>(null);
  const [selEnd, setSelEnd] = useState<{ x: number; y: number } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Step 1: list monitors and capture primary as background
  useEffect(() => {
    (async () => {
      try {
        const mons = await invoke<MonitorInfo[]>("list_monitors");
        setMonitors(mons);
        const primary = mons.find((m) => m.is_primary) ?? mons[0];
        if (!primary) return;
        setSelectedMonitor(primary);

        // Capture fullscreen to use as selection background
        const relPath = await invoke<string>("capture_fullscreen", {
          monitorId: primary.id,
        });

        // Get project root to build absolute path
        const project = await invoke<{ root: string }>("get_current_project");
        const absPath = `${project.root}/${relPath}`;
        setBgImage(convertFileSrc(absPath));
      } catch (err) {
        console.error("Failed to init capture:", err);
        onCancel();
      }
    })();
  }, [onCancel]);

  // Escape key to cancel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setSelecting(true);
    setSelStart({ x: e.clientX, y: e.clientY });
    setSelEnd({ x: e.clientX, y: e.clientY });
  }, []);

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
    if (rect.w < 10 || rect.h < 10) return; // too small, ignore

    setCapturing(true);
    try {
      // Convert screen coordinates to absolute coords accounting for monitor position
      // The overlay fills the browser viewport; the background image is the full monitor
      // Scale selection to monitor coordinates
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
        x: absX,
        y: absY,
        width: absW,
        height: absH,
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
      const path = await invoke<string>("capture_fullscreen", {
        monitorId: selectedMonitor.id,
      });
      onCapture(path);
    } catch (err) {
      console.error("Fullscreen capture failed:", err);
      onCancel();
    }
  }, [selectedMonitor, onCapture, onCancel]);

  const rect = selStart && selEnd ? getSelRect(selStart, selEnd) : null;

  // Loading state while capturing background
  if (!bgImage) {
    return (
      <div className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center">
        <div className="text-white text-sm animate-pulse">Preparing capture...</div>
      </div>
    );
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] select-none"
      style={{
        cursor: capturing ? "wait" : "crosshair",
        backgroundImage: `url(${bgImage})`,
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
          {/* Clear window in the selection */}
          <div
            className="absolute border-2 border-white/80 pointer-events-none"
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.4)",
              backgroundImage: `url(${bgImage})`,
              backgroundSize: `${overlayRef.current?.clientWidth}px ${overlayRef.current?.clientHeight}px`,
              backgroundPosition: `-${rect.x}px -${rect.y}px`,
            }}
          />
          {/* Dimension badge */}
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
        {monitors.length > 1 && (
          <select
            className="text-xs bg-white/10 text-white border border-white/20 rounded px-2 py-1"
            value={selectedMonitor?.id ?? ""}
            onChange={(e) => {
              const m = monitors.find((mon) => mon.id === Number(e.target.value));
              if (m) setSelectedMonitor(m);
            }}
          >
            {monitors.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} {m.is_primary ? "(Primary)" : ""}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={handleFullScreen}
          className="text-xs text-white bg-white/10 hover:bg-white/20 px-3 py-1 rounded transition-colors"
        >
          Full Screen
        </button>
        <button
          onClick={onCancel}
          className="text-xs text-white/60 hover:text-white px-2 py-1 transition-colors"
        >
          Cancel (Esc)
        </button>
      </div>
    </div>
  );
}

/** Get normalized rect from two points. */
function getSelRect(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}
