/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * Uses the convenience ElucimEditor component which handles all internal
 * layout (floating panels, canvas positioning, theme resolution, scrollbar
 * styles). Document change tracking is interaction-based since ElucimEditor
 * doesn't expose an onChange callback.
 *
 * Resolves $token color references (e.g. $foreground, $surface) to actual
 * hex values before passing to the editor, since the editor renders SVG
 * directly and doesn't understand the DSL token syntax.
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

/** Deep-clone a DSL document, resolving $token color references to hex values. */
function resolveTokens(doc: ElucimDocument, tokens: Record<string, string>): ElucimDocument {
  function walk(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(walk);
    if (typeof obj === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (COLOR_KEYS.has(key) && typeof val === "string" && val.startsWith("$")) {
          const tokenName = val.slice(1); // strip $
          out[key] = tokens[tokenName] ?? val;
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

  // Resolve $token colors so they're visible in the editor canvas
  const resolvedDsl = useMemo(() => resolveTokens(dsl, tokenColors), [dsl, tokenColors]);

  // Mark dirty on first real interaction inside the editor
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
