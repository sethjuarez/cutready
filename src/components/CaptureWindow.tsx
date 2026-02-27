import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

type Phase = "loading" | "choose-mode" | "select-region";

interface CaptureParams {
  monitor_id: number;
  monitor_w: number;
  monitor_h: number;
  monitor_x: number;
  monitor_y: number;
  bg_path: string;
  project_root: string;
}

/**
 * Standalone capture window that opens fullscreen on the target monitor.
 * Reads params from Rust managed state via invoke("get_capture_params").
 * Communicates results back to main window via Tauri events.
 */
export function CaptureWindow() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [params, setParams] = useState<CaptureParams | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selStart, setSelStart] = useState<{ x: number; y: number } | null>(null);
  const [selEnd, setSelEnd] = useState<{ x: number; y: number } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Load params from Rust managed state on mount
  useEffect(() => {
    (async () => {
      try {
        const p = await invoke<CaptureParams>("get_capture_params");
        console.log("[CaptureWindow] params loaded:", p);
        setParams(p);
        setPhase("choose-mode");
      } catch (err) {
        console.error("[CaptureWindow] Failed to get params:", err);
        await emit("capture-cancel", {});
        await invoke("close_capture_window");
      }
    })();
  }, []);

  const monitorW = params?.monitor_w ?? 1920;
  const monitorH = params?.monitor_h ?? 1080;
  const bgRelPath = params?.bg_path ?? "";
  const projectRoot = params?.project_root ?? "";

  const bgImage = bgRelPath && projectRoot
    ? convertFileSrc(projectRoot + "/" + bgRelPath)
    : null;

  const finish = useCallback(async (path: string) => {
    console.log("[CaptureWindow] finish:", path);
    await emit("capture-complete", { path });
    await invoke("close_capture_window");
  }, []);

  const cancel = useCallback(async () => {
    console.log("[CaptureWindow] cancel");
    await emit("capture-cancel", {});
    await invoke("close_capture_window");
  }, []);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (phase === "select-region") {
          setSelecting(false);
          setSelStart(null);
          setSelEnd(null);
          setPhase("choose-mode");
        } else if (phase === "choose-mode") {
          cancel();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [phase, cancel]);

  const handleFullScreen = useCallback(async () => {
    setCapturing(true);
    await finish(bgRelPath);
  }, [bgRelPath, finish]);

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
    if (!selecting || !selStart || !selEnd) return;
    setSelecting(false);

    const rect = getSelRect(selStart, selEnd);
    if (rect.w < 10 || rect.h < 10) return;

    setCapturing(true);
    try {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const scaleX = monitorW / overlay.clientWidth;
      const scaleY = monitorH / overlay.clientHeight;

      const cropX = Math.round(rect.x * scaleX);
      const cropY = Math.round(rect.y * scaleY);
      const cropW = Math.round(rect.w * scaleX);
      const cropH = Math.round(rect.h * scaleY);

      const path = await invoke<string>("crop_screenshot", {
        sourcePath: bgRelPath,
        x: cropX, y: cropY, width: cropW, height: cropH,
      });
      await finish(path);
    } catch (err) {
      console.error("Region capture failed:", err);
      cancel();
    }
  }, [selecting, selStart, selEnd, monitorW, monitorH, bgRelPath, finish, cancel]);

  const rect = selStart && selEnd ? getSelRect(selStart, selEnd) : null;

  // ── Loading ──
  if (phase === "loading") {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="text-white/60 text-sm animate-pulse">Loading capture...</div>
      </div>
    );
  }

  // ── Choose mode ──
  if (phase === "choose-mode") {
    return (
      <div
        className="fixed inset-0 select-none"
        style={{
          backgroundImage: bgImage ? `url(${bgImage})` : undefined,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        <div className="absolute inset-0 bg-black/50 pointer-events-none" />

        <div className="absolute top-6 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/80 backdrop-blur-md rounded-xl px-5 py-3 shadow-2xl">
          <button
            onClick={handleFullScreen}
            disabled={capturing}
            className="flex items-center gap-2 text-sm text-white bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
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
          <div className="w-px h-6 bg-white/20" />
          <button
            onClick={cancel}
            className="text-xs text-white/50 hover:text-white px-2 py-1 transition-colors"
          >
            Cancel (Esc)
          </button>
        </div>
      </div>
    );
  }

  // ── Region selection ──
  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 select-none"
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
