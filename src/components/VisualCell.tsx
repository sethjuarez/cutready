import { useRef, useCallback, useState, useEffect } from "react";
import { DslRenderer, type ElucimDocument, type DslRendererRef } from "@elucim/dsl";
import { invoke } from "@tauri-apps/api/core";
import { PlayIcon } from "@heroicons/react/24/outline";
import { ELUCIM_THEME } from "../theme/elucimTheme";

interface VisualCellProps {
  /** Path to the visual file (e.g., ".cutready/visuals/abc123.json"). */
  visualPath: string;
  /** Compact thumbnail mode (for table cells) vs full-size (for preview). */
  mode: "thumbnail" | "full";
  /** Click handler (thumbnail mode only) — e.g. to open lightbox/preview. */
  onClick?: () => void;
  /** Optional CSS class name. */
  className?: string;
  /** Ref exposed to parent for replay control (full mode). */
  controlRef?: React.MutableRefObject<VisualControlHandle | null>;
  /** Called when the animation play state changes (playing → stopped or vice versa). */
  onPlayStateChange?: (playing: boolean) => void;
}

/** Exposed to parent (SketchPreview) for replay button in header. */
export interface VisualControlHandle {
  replay: () => void;
  isPlaying: boolean;
}

/** Static theme using CSS var() strings — shared by both thumbnail and full modes. */
const THEME = ELUCIM_THEME;

/** Error fallback shown when DslRenderer crashes. */
const ERROR_FALLBACK = (
  <div className="flex items-center justify-center w-full h-full text-[10px] text-[var(--color-error)]">
    Render error
  </div>
);

/**
 * Renders an elucim animation inline.
 *
 * - **thumbnail**: static last-frame poster for the planning table (no animation loop).
 * - **full**: auto-plays once, CutReady themed, scales to fill container.
 *   Parent uses `controlRef` to render replay button elsewhere.
 */
export default function VisualCell({ visualPath, mode, onClick, className, controlRef, onPlayStateChange }: VisualCellProps) {
  const rendererRef = useRef<DslRendererRef>(null);
  const [visual, setVisual] = useState<Record<string, unknown> | null>(null);
  const [hasError, setHasError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);

  // Detect light/dark for explicit colorScheme (auto can't parse var() strings)
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Load visual JSON from file path
  useEffect(() => {
    let cancelled = false;
    setHasError(false);
    setVisual(null);
    if (visualPath) {
      invoke<Record<string, unknown>>("get_visual", { relativePath: visualPath })
        .then((data) => { if (!cancelled) setVisual(data); })
        .catch(() => { if (!cancelled) setHasError(true); });
    }
    return () => { cancelled = true; };
  }, [visualPath]);

  const handleClick = useCallback(() => {
    if (mode === "thumbnail" && onClick) onClick();
  }, [mode, onClick]);

  const handleError = useCallback((errors: Array<{ path: string; message: string }>) => {
    console.warn("[VisualCell] DSL validation errors:", JSON.stringify(errors));
    setHasError(true);
  }, []);

  const dsl = visual as unknown as ElucimDocument | null;

  const replay = useCallback(() => {
    rendererRef.current?.seekToFrame(0);
    rendererRef.current?.play();
    setIsPlaying(true);
  }, []);

  // Expose control handle to parent
  useEffect(() => {
    if (controlRef) {
      controlRef.current = { replay, isPlaying };
    }
  }, [controlRef, replay, isPlaying]);

  // Notify parent of play state changes
  useEffect(() => {
    onPlayStateChange?.(isPlaying);
  }, [isPlaying, onPlayStateChange]);

  // Full mode: measure container and compute fitted width to prevent overflow.
  // fitToContainer sets SVG width=100% and derives height from viewBox, which
  // overflows height-limited containers. We compute the max width that keeps
  // the scene within bounds: min(containerWidth, containerHeight * aspectRatio).
  const containerRef = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState<number | null>(null);

  useEffect(() => {
    if (mode !== "full") return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width: cw, height: ch } = entry.contentRect;
      if (!dsl || cw === 0 || ch === 0) return;
      const sw = (dsl as unknown as { width?: number }).width || 960;
      const sh = (dsl as unknown as { height?: number }).height || 540;
      const ratio = sw / sh;
      setFitWidth(Math.min(cw, ch * ratio));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [dsl, mode]);

  if (hasError) {
    return (
      <div
        className={`flex items-center justify-center text-[10px] text-[var(--color-error)] ${
          mode === "thumbnail" ? "w-40 h-24" : "w-full h-full"
        } rounded-md border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 ${className ?? ""}`}
      >
        <span>Invalid visual</span>
      </div>
    );
  }

  if (!visual || !dsl) {
    return (
      <div
        className={`flex items-center justify-center text-[10px] text-[var(--color-text-secondary)] ${
          mode === "thumbnail" ? "w-40 h-24" : "w-full h-full"
        } rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] ${className ?? ""}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="animate-spin">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </div>
    );
  }

  if (mode === "thumbnail") {
    return (
      <div
        className={`relative group/vis w-40 h-24 rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] overflow-hidden cursor-pointer ${className ?? ""}`}
        onClick={handleClick}
      >
        <DslRenderer
          dsl={dsl}
          poster="last"
          colorScheme={isDark ? "dark" : "light"}
          theme={THEME}
          fitToContainer
          onError={handleError}
          onRenderError={() => setHasError(true)}
          fallback={ERROR_FALLBACK}
        />

        {/* Hover overlay with play icon */}
        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/vis:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
          <PlayIcon className="w-5 h-5 text-white/90" />
        </div>
      </div>
    );
  }

  // Full mode — fills container, centered, properly sized
  return (
    <div ref={containerRef} className={`w-full h-full flex items-center justify-center ${className ?? ""}`}>
      {fitWidth !== null && (
        <div style={{ width: fitWidth }}>
          <DslRenderer
            ref={rendererRef}
            dsl={dsl}
            controls={false}
            autoPlay
            loop={false}
            colorScheme={isDark ? "dark" : "light"}
            theme={THEME}
            fitToContainer
            onError={handleError}
            onRenderError={() => setHasError(true)}
            fallback={ERROR_FALLBACK}
            onPlayStateChange={setIsPlaying}
          />
        </div>
      )}
    </div>
  );
}
