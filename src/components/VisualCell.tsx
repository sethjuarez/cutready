import { useRef, useCallback, useState, useEffect } from "react";
import { DslRenderer, type ElucimDocument } from "@elucim/dsl";

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

/**
 * Renders an elucim animation inline.
 *
 * - **thumbnail**: compact w-40 h-24 container for the planning table.
 *   Hover shows play controls overlay.
 * - **full**: fills parent, used in SketchPreview.
 */
export default function VisualCell({ visual, mode, onClick, className }: VisualCellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasError, setHasError] = useState(false);

  // Reset error state when visual changes
  useEffect(() => setHasError(false), [visual]);

  const handleClick = useCallback(() => {
    if (mode === "thumbnail" && onClick) onClick();
  }, [mode, onClick]);

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
        ref={containerRef}
        className={`relative group/vis w-40 h-24 rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] overflow-hidden cursor-pointer ${className ?? ""}`}
        onClick={handleClick}
      >
        {/* Scaled-down DslRenderer — pointer-events off so clicks pass to container */}
        <div className="w-[640px] h-[384px] origin-top-left" style={{ transform: "scale(0.25)" }}>
          <ErrorBoundary onError={() => setHasError(true)}>
            <DslRenderer dsl={visual as unknown as ElucimDocument} style={{ width: 640, height: 384 }} />
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

  // Full mode
  return (
    <div ref={containerRef} className={`w-full h-full flex items-center justify-center ${className ?? ""}`}>
      <ErrorBoundary onError={() => setHasError(true)}>
        <DslRenderer
          dsl={visual as unknown as ElucimDocument}
          className="max-w-full max-h-full rounded-lg shadow-lg"
          style={{ width: "100%", height: "100%" }}
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
