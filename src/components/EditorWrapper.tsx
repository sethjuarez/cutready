/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * Resolves $token color references to hex values before passing to the
 * editor. The editor renders SVG directly and doesn't understand DSL tokens.
 *
 * TODO: Once @elucim/editor adds an `initialFrame` prop, pass
 * `durationInFrames - 1` so all animated elements are visible on open.
 */
import { useMemo, useRef, memo, lazy, Suspense, useCallback } from "react";
import type { ElucimDocument } from "@elucim/dsl";

export interface EditorWrapperProps {
  dsl: ElucimDocument;
  theme: Record<string, string>;
  /** Token map for resolving $foreground, $surface, etc. */
  tokenColors: Record<string, string>;
  onDocumentChange: (doc: ElucimDocument) => void;
}

const LazyElucimEditor = lazy(() =>
  import("@elucim/editor").then((mod) => ({ default: mod.ElucimEditor }))
);

/** Color fields that may contain $token references */
const COLOR_KEYS = new Set(["fill", "stroke", "background", "color", "axisColor", "gridColor", "labelColor"]);

/**
 * Deep-clone a DSL document for the editor, resolving $token color
 * references to hex values.
 */
function resolveForEditor(doc: ElucimDocument, tokens: Record<string, string>): ElucimDocument {
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

export default memo(function EditorWrapper({
  dsl,
  theme,
  tokenColors,
  onDocumentChange,
}: EditorWrapperProps) {
  const interacted = useRef(false);

  const resolvedDsl = useMemo(() => resolveForEditor(dsl, tokenColors), [dsl, tokenColors]);

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
          theme={theme}
          className="w-full h-full"
          style={{ width: "100%", height: "100%" }}
        />
      </div>
    </Suspense>
  );
});
