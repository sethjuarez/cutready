import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { DslRenderer, type ElucimDocument, type DslRendererRef } from "@elucim/dsl";
import { invoke } from "@tauri-apps/api/core";

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
}

/** Exposed to parent (SketchPreview) for replay button in header. */
export interface VisualControlHandle {
  replay: () => void;
  isPlaying: boolean;
}

/** Read CutReady CSS variables and build an elucim theme object. */
function useCutReadyTheme() {
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

  return useMemo(() => {
    const s = getComputedStyle(document.documentElement);
    const fg = s.getPropertyValue("--color-text").trim() || (isDark ? "#e8e4df" : "#2c2925");
    const bg = s.getPropertyValue("--color-surface").trim() || (isDark ? "#2b2926" : "#faf9f7");
    const accent = s.getPropertyValue("--color-accent").trim() || (isDark ? "#a49afa" : "#6b5ce7");
    const secondary = s.getPropertyValue("--color-text-secondary").trim() || (isDark ? "#a09b93" : "#78756f");
    const surfaceAlt = s.getPropertyValue("--color-surface-alt").trim() || (isDark ? "#353230" : "#f0efed");
    const border = s.getPropertyValue("--color-border").trim() || (isDark ? "#4a4644" : "#e2e0dd");

    return {
      // Core theme keys (read by Scene via --elucim-scene-bg/fg)
      foreground: fg,
      background: bg,
      accent,
      "scene-bg": bg,
      "scene-fg": fg,
      // Semantic tokens for $token resolution in DSL color fields
      muted: secondary,
      surface: surfaceAlt,
      border,
      primary: accent,
      secondary: isDark ? "#a78bfa" : "#7c3aed",
      tertiary: isDark ? "#f472b6" : "#db2777",
      success: isDark ? "#34d399" : "#16a34a",
      warning: isDark ? "#fbbf24" : "#d97706",
      error: isDark ? "#f87171" : "#dc2626",
    };
  }, [isDark]);
}

/**
 * Build a preview-mode DSL: hides built-in controls, auto-plays once.
 * Strips root background so --elucim-scene-bg (from theme) takes effect.
 */
function buildPreviewDsl(dsl: ElucimDocument): ElucimDocument {
  const root = { ...dsl.root } as Record<string, unknown>;
  root.controls = false;
  root.autoPlay = true;
  root.loop = false;
  delete root.background; // Let theme --elucim-scene-bg control it
  return { ...dsl, root: root as unknown as ElucimDocument["root"] };
}

/**
 * Renders an elucim animation inline.
 *
 * - **thumbnail**: static last-frame poster for the planning table (no animation loop).
 * - **full**: auto-plays once, CutReady themed, scales to fill container.
 *   Parent uses `controlRef` to render replay button elsewhere.
 */
export default function VisualCell({ visualPath, mode, onClick, className, controlRef }: VisualCellProps) {
  const rendererRef = useRef<DslRendererRef>(null);
  const [visual, setVisual] = useState<Record<string, unknown> | null>(null);
  const [hasError, setHasError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const theme = useCutReadyTheme();

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
  const previewDsl = useMemo(() => dsl ? buildPreviewDsl(dsl) : null, [dsl]);

  // Poll play state and expose control handle to parent
  useEffect(() => {
    if (mode !== "full") return;
    setIsPlaying(true);
    const interval = setInterval(() => {
      const playing = rendererRef.current?.isPlaying() ?? false;
      setIsPlaying(playing);
    }, 250);
    return () => clearInterval(interval);
  }, [mode, visual]);

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

  if (hasError) {
    return (
      <div
        className={`flex items-center justify-center text-[10px] text-red-400 ${
          mode === "thumbnail" ? "w-40 h-24" : "w-full h-full"
        } rounded-md border border-red-300/30 bg-red-500/5 ${className ?? ""}`}
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
        {/* Static last-frame poster — no animation loop, saves CPU */}
        <div className="w-[960px] h-[540px] origin-top-left" style={{ transform: `scale(${160 / 960})` }}>
          <ErrorBoundary onError={() => setHasError(true)}>
            <DslRenderer
              dsl={dsl}
              poster="last"
              theme={theme}
              onError={handleError}
              style={{ width: 960, height: 540 }}
            />
          </ErrorBoundary>
        </div>

        {/* Hover overlay with play icon */}
        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/vis:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-white/90">
            <polygon points="5,3 19,12 5,21" />
          </svg>
        </div>
      </div>
    );
  }

  // Full mode — fills container, CutReady themed, no built-in controls
  return (
    <div className={`visual-cell-full w-full h-full flex items-center justify-center ${className ?? ""}`}>
      <ErrorBoundary onError={() => setHasError(true)}>
        <DslRenderer
          ref={rendererRef}
          dsl={previewDsl!}
          theme={theme}
          onError={handleError}
          className="w-full h-full rounded-lg shadow-lg"
        />
      </ErrorBoundary>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimal error boundary for catching DslRenderer render errors
// ---------------------------------------------------------------------------
import { Component, type ReactNode, type ErrorInfo } from "react";

interface EBProps {
  children: ReactNode;
  onError: () => void;
}
interface EBState {
  hasError: boolean;
}

class ErrorBoundary extends Component<EBProps, EBState> {
  state: EBState = { hasError: false };

  static getDerivedStateFromError(): EBState {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.props.onError();
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
