import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, PhysicalPosition } from "@tauri-apps/api/window";
import { ChevronLeft, ChevronRight, GripVertical, Lock, PanelLeft, PanelRight, X } from "lucide-react";
import { SafeMarkdown } from "./SafeMarkdown";
import { isMac } from "../utils/platform";
import type { PrompterScript } from "../types/recording";

interface RecordingPrompterParams {
  document_title: string;
  script: PrompterScript;
  read_mode: boolean;
  monitor_x: number;
  monitor_y: number;
  monitor_w: number;
  monitor_h: number;
}

type PrompterSide = "left" | "right";

const OPACITY_V3_KEY = "cutready-recording-prompter-opacity-v3";
const TEXT_SIZE_KEY = "cutready-recording-prompter-text-size";
const SIDE_KEY = "cutready-recording-prompter-side";

function storedNumber(key: string, fallback: number, min: number, max: number) {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return fallback;
  const value = Number(stored);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function storedSide(): PrompterSide {
  return window.localStorage.getItem(SIDE_KEY) === "left" ? "left" : "right";
}

export function RecordingPrompterWindow() {
  const [params, setParams] = useState<RecordingPrompterParams | null>(null);
  const [index, setIndex] = useState(0);
  const [readMode, setReadMode] = useState(false);
  const [visible, setVisible] = useState(true);
  const [opacity, setOpacity] = useState(() => storedNumber(OPACITY_V3_KEY, 18, 0, 70));
  const [textSize, setTextSize] = useState(() => storedNumber(TEXT_SIZE_KEY, 18, 12, 34));
  const [side, setSide] = useState<PrompterSide>(() => storedSide());
  const [error, setError] = useState<string | null>(null);
  const currentWindow = useMemo(() => getCurrentWindow(), []);
  const stepsLengthRef = useRef(0);
  const dragRef = useRef<{ startX: number; startY: number; winX: number; winY: number } | null>(null);

  const steps = params?.script.steps ?? [];
  const current = steps[index] ?? null;
  const progress = steps.length > 0 ? `${index + 1}/${steps.length}` : "0/0";
  stepsLengthRef.current = steps.length;

  // Manual window drag for macOS (startDragging() fails on WKWebView with decorations:false)
  const handleDragStart = useCallback(async (e: React.MouseEvent) => {
    if (!isMac) {
      void currentWindow.startDragging();
      return;
    }
    e.preventDefault();
    const pos = await currentWindow.outerPosition();
    const scale = window.devicePixelRatio || 1;
    // Convert physical position to logical (CSS points) to match screenX/screenY
    dragRef.current = { startX: e.screenX, startY: e.screenY, winX: pos.x / scale, winY: pos.y / scale };

    const onMouseMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = ev.screenX - drag.startX;
      const dy = ev.screenY - drag.startY;
      void currentWindow.setPosition(
        new LogicalPosition(
          Math.round(drag.winX + dx),
          Math.round(drag.winY + dy),
        ),
      );
    };
    const onMouseUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [currentWindow]);

  const move = useCallback((delta: number) => {
    setIndex((value) => {
      const stepsLength = stepsLengthRef.current;
      if (stepsLength === 0) return 0;
      return Math.min(Math.max(value + delta, 0), stepsLength - 1);
    });
  }, []);

  const close = useCallback(async () => {
    await currentWindow.setIgnoreCursorEvents(false).catch(() => undefined);
    await invoke("close_recording_prompter_window").catch(() => currentWindow.close());
  }, [currentWindow]);

  useEffect(() => {
    invoke<RecordingPrompterParams>("get_recording_prompter_params")
      .then((nextParams) => {
        setParams(nextParams);
        setIndex(0);
        setReadMode(nextParams.read_mode);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(OPACITY_V3_KEY, String(opacity));
  }, [opacity]);

  useEffect(() => {
    window.localStorage.setItem(TEXT_SIZE_KEY, String(textSize));
  }, [textSize]);

  useEffect(() => {
    window.localStorage.setItem(SIDE_KEY, side);
  }, [side]);

  useEffect(() => {
    let cancelled = false;
    const applyClickThrough = async () => {
      await currentWindow.setIgnoreCursorEvents(readMode).catch((err) => {
        console.warn("Failed to toggle prompter click-through mode:", err);
      });
    };
    void applyClickThrough();
    if (readMode) {
      for (const delay of [80, 250, 600]) {
        window.setTimeout(() => {
          if (!cancelled) void applyClickThrough();
        }, delay);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [currentWindow, readMode]);

  useEffect(() => {
    if (!params) return;
    let cancelled = false;
    const moveToSide = async () => {
      const size = await currentWindow.outerSize();
      if (cancelled) return;
      const x = side === "left"
        ? params.monitor_x
        : params.monitor_x + params.monitor_w - size.width;
      const y = params.monitor_y;
      await currentWindow.setPosition(new PhysicalPosition(Math.round(x), Math.round(y))).catch(() => undefined);
    };
    void moveToSide();
    return () => {
      cancelled = true;
    };
  }, [currentWindow, params, side]);

  useEffect(() => {
    const unlisteners = [
      listen("recording-prompter-next", () => move(1)),
      listen("recording-prompter-previous", () => move(-1)),
      listen("recording-prompter-toggle-visibility", () => setVisible((value) => !value)),
      listen("recording-prompter-toggle-mode", () => setReadMode((value) => !value)),
      listen("recording-prompter-read", () => setReadMode(true)),
      listen("recording-prompter-adjust", () => setReadMode(false)),
      listen("recording-prompter-close", () => void close()),
    ];

    return () => {
      void currentWindow.setIgnoreCursorEvents(false).catch(() => undefined);
      for (const unlisten of unlisteners) {
        void unlisten.then((fn) => fn());
      }
    };
  }, [close, currentWindow, move]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (readMode) {
          setReadMode(false);
        } else {
          void close();
        }
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") move(1);
      if (event.key === "ArrowLeft" || event.key === "PageUp") move(-1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [close, move, readMode]);

  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-transparent p-4 text-white">
        <div className="rounded-xl border border-[rgb(var(--color-error)/0.5)] bg-black/80 px-4 py-3 text-sm shadow-2xl">
          {error}
        </div>
      </div>
    );
  }

  if (!params || !current) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-transparent p-4 text-white">
        <div className="rounded-full bg-black/70 px-4 py-2 text-sm shadow-2xl">Loading prompter...</div>
      </div>
    );
  }

  return (
    <div className={`fixed inset-0 bg-transparent text-white transition-opacity duration-150 ${visible ? "opacity-100" : "opacity-0"}`}>
      <aside
        className="flex h-full min-h-0 flex-col overflow-hidden"
        style={{ backgroundColor: `rgba(0,0,0,${opacity / 100})` }}
      >
        {!readMode && (
          <div className="flex shrink-0 items-center gap-1 bg-black/25 px-2 py-1.5 text-white/72">
            <button
              type="button"
              onMouseDown={(e) => void handleDragStart(e)}
              className="mr-auto inline-flex cursor-grab items-center gap-1.5 rounded-lg px-1.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors hover:bg-white/10 active:cursor-grabbing"
            >
              <GripVertical className="h-3.5 w-3.5" />
              Prompter
            </button>
            <button type="button" onClick={() => setSide("left")} className={`rounded-lg p-1 transition-colors hover:bg-white/10 ${side === "left" ? "text-white" : ""}`} aria-label="Move prompter left">
              <PanelLeft className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setSide("right")} className={`rounded-lg p-1 transition-colors hover:bg-white/10 ${side === "right" ? "text-white" : ""}`} aria-label="Move prompter right">
              <PanelRight className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setReadMode(true)} className="rounded-lg p-1 transition-colors hover:bg-white/10" aria-label="Click through prompter">
              <Lock className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={close} className="rounded-lg p-1 transition-colors hover:bg-white/10" aria-label="Close prompter">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {!readMode && (
          <div className="grid shrink-0 grid-cols-2 gap-2 bg-black/20 px-2 py-2 text-[10px] uppercase tracking-[0.12em] text-white/55">
            <label className="space-y-1">
              <span>Backdrop {opacity}%</span>
              <input aria-label="Prompter backdrop opacity" type="range" min={0} max={70} value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} className="w-full accent-white" />
            </label>
            <label className="space-y-1">
              <span>Text {textSize}px</span>
              <input aria-label="Prompter text size" type="range" min={12} max={34} value={textSize} onChange={(event) => setTextSize(Number(event.target.value))} className="w-full accent-white" />
            </label>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-white/45">
          <span className="truncate">{current.section ?? current.title}</span>
          <span className="ml-auto tabular-nums">{progress}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div
            className="prose-teleprompter max-w-none text-white [&_*]:text-white [&_a]:text-white [&_blockquote]:border-white/20 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_h1]:mb-2 [&_h1]:text-[1.25em] [&_h2]:mb-2 [&_h2]:text-[1.12em] [&_li]:my-1 [&_ol]:pl-5 [&_p]:my-2 [&_pre]:bg-white/10 [&_strong]:font-semibold [&_ul]:pl-5"
            style={{
              fontSize: `${textSize}px`,
              lineHeight: 1.42,
              textShadow: "0 1px 2px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.8)",
            }}
          >
            <SafeMarkdown>{current.narrative}</SafeMarkdown>
          </div>
          {current.cue && (
            <div
              className="mt-3 border-t border-white/10 pt-3 text-white/58"
              style={{
                fontSize: `${Math.max(11, Math.round(textSize * 0.72))}px`,
                lineHeight: 1.35,
                textShadow: "0 1px 2px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.75)",
              }}
            >
              <SafeMarkdown>{current.cue}</SafeMarkdown>
            </div>
          )}
        </div>

        {!readMode && (
          <div className="grid shrink-0 grid-cols-2 gap-1 bg-black/20 p-2">
            <button type="button" onClick={() => move(-1)} disabled={index === 0} className="flex items-center justify-center gap-1 rounded-lg bg-white/[0.08] px-2 py-1.5 text-xs font-semibold text-white/75 transition-colors hover:bg-white/[0.14] disabled:opacity-30">
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </button>
            <button type="button" onClick={() => move(1)} disabled={index >= steps.length - 1} className="flex items-center justify-center gap-1 rounded-lg bg-white/[0.12] px-2 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/[0.18] disabled:opacity-30">
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
