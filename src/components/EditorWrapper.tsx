/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * - Resolves $token color references in element fill/stroke to hex values
 * - Sets initialFrame to durationInFrames-1 so all animated elements visible
 * - Passes light/dark theme from CutReady
 */
import { useMemo, useRef, memo, lazy, Suspense, useCallback } from "react";
import type { ElucimDocument } from "@elucim/dsl";

export interface EditorWrapperProps {
  dsl: ElucimDocument;
  theme: Record<string, string>;
  /** Token map for resolving $foreground, $surface, etc. in element colors */
  tokenColors: Record<string, string>;
  onDocumentChange: (doc: ElucimDocument) => void;
}

const LazyElucimEditor = lazy(() =>
  import("@elucim/editor").then((mod) => ({ default: mod.ElucimEditor }))
);

/** Color fields that may contain $token references */
const COLOR_KEYS = new Set(["fill", "stroke", "color", "axisColor", "gridColor", "labelColor"]);

/** Resolve $token color references in element properties to hex values. */
function resolveTokenColors(doc: ElucimDocument, tokens: Record<string, string>): ElucimDocument {
  function walk(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(walk);
    if (typeof obj === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (COLOR_KEYS.has(key) && typeof val === "string" && val.startsWith("$")) {
          out[key] = tokens[val.slice(1)] ?? val;
        } else {
          out[key] = walk(val);
        }
      }
      return out;
    }
    return obj;
  }
  return walk(doc) as ElucimDocument;
}

/** Extract durationInFrames from the document root. */
function getLastFrame(doc: ElucimDocument): number {
  const root = doc?.root as unknown as Record<string, unknown> | undefined;
  const dur = root && typeof root.durationInFrames === "number" ? root.durationInFrames : 120;
  return Math.max(0, dur - 1);
}

export default memo(function EditorWrapper({
  dsl,
  theme,
  tokenColors,
  onDocumentChange,
}: EditorWrapperProps) {
  const interacted = useRef(false);

  const resolvedDsl = useMemo(() => resolveTokenColors(dsl, tokenColors), [dsl, tokenColors]);
  const lastFrame = useMemo(() => getLastFrame(dsl), [dsl]);

  const handleInteraction = useCallback(() => {
    if (!interacted.current) {
      interacted.current = true;
      onDocumentChange(dsl);
    }
  }, [dsl, onDocumentChange]);

  return (
    <Suspense
      fallback={
        <div className="w-full h-full flex items-center justify-center text-[var(--color-text-secondary)]">
          Loading editor…
        </div>
      }
    >
      <div
        className="w-full h-full"
        onPointerDown={handleInteraction}
        onKeyDown={handleInteraction}
      >
        <LazyElucimEditor
          initialDocument={resolvedDsl}
          initialFrame={lastFrame}
          theme={theme}
          className="w-full h-full"
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </Suspense>
  );
});
