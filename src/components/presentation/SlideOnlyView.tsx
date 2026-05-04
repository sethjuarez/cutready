/**
 * SlideOnlyView — full-bleed audience-style view. Just the screenshot/visual,
 * black backdrop, minimal chrome. Click anywhere to advance, ←/→ to navigate,
 * Esc to exit, T = teleprompter, P = full slide preview.
 *
 * Mouse cursor and the corner overlay auto-hide after a few seconds of
 * inactivity to keep the view clean during recording.
 */
import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { X, MonitorPlay, Layout, Image as ImageIcon } from "lucide-react";
import type { PreviewSlide, PresentationMode } from "./types";

const VisualCell = lazy(() => import("../VisualCell"));

interface SlideOnlyViewProps {
  slides: PreviewSlide[];
  currentIdx: number;
  setCurrentIdx: (i: number | ((prev: number) => number)) => void;
  projectRoot: string;
  onClose: () => void;
  onSwitchMode: (m: PresentationMode) => void;
}

const HIDE_AFTER_MS = 2500;

export function SlideOnlyView({
  slides,
  currentIdx,
  setCurrentIdx,
  projectRoot,
  onClose,
  onSwitchMode,
}: SlideOnlyViewProps) {
  const total = slides.length;
  const slide = slides[currentIdx];
  const [chromeVisible, setChromeVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);

  const goPrev = useCallback(() => {
    setCurrentIdx((i) => Math.max(0, i - 1));
  }, [setCurrentIdx]);

  const goNext = useCallback(() => {
    setCurrentIdx((i) => Math.min(total - 1, i + 1));
  }, [total, setCurrentIdx]);

  const showChrome = useCallback(() => {
    setChromeVisible(true);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setChromeVisible(false), HIDE_AFTER_MS);
  }, []);

  // Auto-hide chrome on mount + reset timer on mouse activity.
  useEffect(() => {
    showChrome();
    return () => {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, [showChrome]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      showChrome();
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "Home") {
        setCurrentIdx(0);
      } else if (e.key === "End") {
        setCurrentIdx(total - 1);
      } else if (e.key === "t" || e.key === "T") {
        onSwitchMode("teleprompter");
      } else if (e.key === "p" || e.key === "P") {
        onSwitchMode("slides");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, goNext, goPrev, total, onSwitchMode, setCurrentIdx, showChrome]);

  if (!slide) return null;

  const isTitle = slide.type === "title";
  const row = slide.type === "row" ? slide.row : null;
  const screenshotSrc =
    row?.screenshot && projectRoot
      ? convertFileSrc(`${projectRoot}/${row.screenshot}`)
      : null;

  // Click halves: left half = prev, right half = next. Anywhere advances if
  // already on first slide. This matches the typical fullscreen-presentation
  // mental model.
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    showChrome();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width * 0.25 && currentIdx > 0) {
      goPrev();
    } else {
      goNext();
    }
  };

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center select-none"
      style={{
        backgroundColor: "#000",
        cursor: chromeVisible ? "default" : "none",
      }}
      onMouseMove={showChrome}
      onClick={handleClick}
    >
      {/* Slide content */}
      <div className="relative w-full h-full flex items-center justify-center p-8">
        {isTitle ? (
          <div className="flex flex-col items-center justify-center text-center gap-6 max-w-4xl px-8">
            <h1 className="text-6xl font-bold text-white">{slide.heading}</h1>
            {slide.subtitle && (
              <p className="text-2xl text-white/70 whitespace-pre-wrap leading-relaxed">{slide.subtitle}</p>
            )}
          </div>
        ) : row?.visual ? (
          <Suspense fallback={null}>
            <VisualCell visualPath={row.visual} mode="full" className="max-w-full max-h-full" />
          </Suspense>
        ) : screenshotSrc ? (
          <img
            src={screenshotSrc}
            alt={`Slide ${currentIdx + 1}`}
            className="max-w-full max-h-full object-contain"
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-white/40">
            <ImageIcon className="w-16 h-16 opacity-50" />
            <span className="text-sm">No screenshot</span>
          </div>
        )}
      </div>

      {/* Top-right corner chrome (auto-hide) */}
      <div
        className="absolute top-3 right-3 flex items-center gap-1 transition-opacity duration-300"
        style={{ opacity: chromeVisible ? 1 : 0, pointerEvents: chromeVisible ? "auto" : "none" }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="px-2.5 py-1 text-xs tabular-nums text-white/70 bg-white/10 rounded-md backdrop-blur">
          {currentIdx + 1} / {total}
        </span>
        <button
          onClick={() => onSwitchMode("slides")}
          className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors backdrop-blur"
          title="Slide preview (P)"
        >
          <Layout className="w-4 h-4" />
        </button>
        <button
          onClick={() => onSwitchMode("teleprompter")}
          className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors backdrop-blur"
          title="Teleprompter (T)"
        >
          <MonitorPlay className="w-4 h-4" />
        </button>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-white/10 transition-colors backdrop-blur"
          title="Exit (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom hint (auto-hide) */}
      <div
        className="absolute bottom-3 left-1/2 -translate-x-1/2 text-xs text-white/40 transition-opacity duration-300 pointer-events-none"
        style={{ opacity: chromeVisible ? 1 : 0 }}
      >
        ←/→ navigate · click to advance · T teleprompter · P preview · Esc exit
      </div>
    </div>
  );
}
