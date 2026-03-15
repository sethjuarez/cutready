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
    return {
      foreground: s.getPropertyValue("--color-text").trim() || (isDark ? "#e8e4df" : "#2c2925"),
      background: s.getPropertyValue("--color-surface").trim() || (isDark ? "#2b2926" : "#faf9f7"),
      accent: s.getPropertyValue("--color-accent").trim() || (isDark ? "#a49afa" : "#6b5ce7"),
    };
  }, [isDark]);
}

/**
 * Build a preview-mode DSL: hides built-in controls, auto-plays once.
 * CutReady renders its own mini player bar instead.
 */
function buildPreviewDsl(dsl: ElucimDocument): ElucimDocument {
  const root = { ...dsl.root } as Record<string, unknown>;
  root.controls = false;
  root.autoPlay = true;
  root.loop = false;
  return { ...dsl, root: root as unknown as ElucimDocument["root"] };
}

/**
 * Renders an elucim animation inline.
 *
 * - **thumbnail**: static last-frame poster for the planning table (no animation loop).
 * - **full**: interactive player filling its container with CutReady theme,
 *   auto-plays once, with a minimal restart bar.
 */
export default function VisualCell({ visual, mode, onClick, className }: VisualCellProps) {
  const rendererRef = useRef<DslRendererRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasError, setHasError] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
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

  // Patch SVG with viewBox for responsive scaling & track play state
  useEffect(() => {
    if (mode !== "full") return;
    const id = requestAnimationFrame(() => {
      const svg = rendererRef.current?.getSvgElement();
      if (!svg) return;
      const w = svg.getAttribute("width") || svg.viewBox?.baseVal?.width?.toString();
      const h = svg.getAttribute("height") || svg.viewBox?.baseVal?.height?.toString();
      if (w && h && !svg.getAttribute("viewBox")) {
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.removeAttribute("width");
        svg.removeAttribute("height");
      }
    });

    // Poll play state for the mini bar
    setIsPlaying(true);
    const interval = setInterval(() => {
      const playing = rendererRef.current?.isPlaying() ?? false;
      setIsPlaying(playing);
    }, 250);

    return () => {
      cancelAnimationFrame(id);
      clearInterval(interval);
    };
  }, [mode, visual]);

  const handleRestart = useCallback(() => {
    rendererRef.current?.seekToFrame(0);
    rendererRef.current?.play();
    setIsPlaying(true);
  }, []);

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

  // Full mode — auto-plays once, CutReady theme, responsive SVG, mini restart bar
  return (
    <div ref={containerRef} className={`w-full h-full flex flex-col items-center justify-center ${className ?? ""}`}>
      <div className="flex-1 w-full flex items-center justify-center min-h-0 overflow-hidden rounded-lg">
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

      {/* Mini restart bar — appears when animation finishes */}
      {!isPlaying && (
        <button
          onClick={handleRestart}
          className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-full
            text-xs font-medium text-[var(--color-text-secondary)]
            hover:text-[var(--color-accent)] bg-[var(--color-surface-alt)]
            border border-[var(--color-border)] hover:border-[var(--color-accent)]/40
            transition-colors shadow-sm"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          Replay
        </button>
      )}
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
