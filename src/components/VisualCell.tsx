import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { DslRenderer, type ElucimDocument, type DslRendererRef } from "@elucim/dsl";

interface VisualCellProps {
  /** The elucim DSL document to render. */
  visual: Record<string, unknown>;
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
    return {
      foreground: fg,
      background: bg,
      accent,
      // These are the actual CSS var names the Scene/Player reads
      "scene-bg": bg,
      "scene-fg": fg,
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
export default function VisualCell({ visual, mode, onClick, className, controlRef }: VisualCellProps) {
  const rendererRef = useRef<DslRendererRef>(null);
  const [hasError, setHasError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const theme = useCutReadyTheme();

  // Reset error state when visual changes
  useEffect(() => setHasError(false), [visual]);

  const handleClick = useCallback(() => {
    if (mode === "thumbnail" && onClick) onClick();
  }, [mode, onClick]);

  const handleError = useCallback((errors: Array<{ path: string; message: string }>) => {
    console.warn("[VisualCell] DSL validation errors:", JSON.stringify(errors));
    setHasError(true);
  }, []);

  const dsl = visual as unknown as ElucimDocument;
  const previewDsl = useMemo(() => buildPreviewDsl(dsl), [dsl]);

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

  if (mode === "thumbnail") {
    return (
      <div
        className={`relative group/vis w-40 h-24 rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] overflow-hidden cursor-pointer ${className ?? ""}`}
        onClick={handleClick}
      >
        {/* Static last-frame poster — no animation loop, saves CPU */}
        <div className="w-[640px] h-[384px] origin-top-left" style={{ transform: "scale(0.25)" }}>
          <ErrorBoundary onError={() => setHasError(true)}>
            <DslRenderer
              dsl={dsl}
              poster="last"
              theme={theme}
              onError={handleError}
              style={{ width: 640, height: 384 }}
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
          dsl={previewDsl}
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
