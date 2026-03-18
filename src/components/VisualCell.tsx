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

/** Static theme using CSS var() strings. */
const THEME = {
  foreground: "var(--color-text)",
  background: "var(--color-surface)",
  accent: "var(--color-accent)",
  "scene-bg": "var(--color-surface)",
  "scene-fg": "var(--color-text)",
  muted: "var(--color-text-secondary)",
  surface: "var(--color-surface-alt)",
  border: "var(--color-border)",
  primary: "var(--color-accent)",
  secondary: "var(--color-secondary)",
  tertiary: "var(--color-tertiary)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
};

/**
 * Build a preview-mode DSL: hides built-in controls, auto-plays once.
 * Strips root background so theme's scene-bg takes effect.
 * (DslRenderer 0.11.0 override props exist but have issues — mutate for now.)
 */
function buildPreviewDsl(dsl: ElucimDocument): ElucimDocument {
  const root = { ...dsl.root } as Record<string, unknown>;
  root.controls = false;
  root.autoPlay = true;
  root.loop = false;
  delete root.background;
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
  const previewDsl = useMemo(() => dsl ? buildPreviewDsl(dsl) : null, [dsl]);

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
              colorScheme={isDark ? "dark" : "light"}
              theme={THEME}
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
          colorScheme={isDark ? "dark" : "light"}
          theme={THEME}
          onError={handleError}
          onPlayStateChange={setIsPlaying}
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
