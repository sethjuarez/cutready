/**
 * Wraps @elucim/editor for use in ScriptTable's lightbox.
 *
 * Uses EditorProvider directly (not ElucimEditor) so DocumentBridge
 * can call useEditorDocument() to track live changes for saving.
 * ElucimEditor's internal layout (yo) is not exported, so we use
 * the sub-components: ElucimCanvas, Toolbar, Inspector, Timeline.
 *
 * Resolves $token color references in element colors to hex values.
 */
import { useMemo, useRef, useEffect, memo, lazy, Suspense } from "react";
import type { ElucimDocument } from "@elucim/dsl";

export interface EditorWrapperProps {
  dsl: ElucimDocument;
  theme: Record<string, string>;
  tokenColors: Record<string, string>;
  onDocumentChange: (doc: ElucimDocument) => void;
}

/** Color fields that may contain $token references */
const COLOR_KEYS = new Set(["fill", "stroke", "background", "color", "axisColor", "gridColor", "labelColor"]);

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

/**
 * Single lazy chunk: imports editor once, defines DocumentBridge
 * inside the same module scope so it can call useEditorDocument().
 */
const LazyComposedEditor = lazy(() =>
  import("@elucim/editor").then((mod) => {
    /** Reads live document and forwards changes to parent. */
    function DocumentBridge({ onChange }: { onChange: (doc: ElucimDocument) => void }) {
      const doc = mod.useEditorDocument();
      const cbRef = useRef(onChange);
      cbRef.current = onChange;
      const isFirst = useRef(true);

      useEffect(() => {
        if (isFirst.current) { isFirst.current = false; return; }
        cbRef.current(doc);
      }, [doc]);

      return null;
    }

    /** Resolves theme keys to --elucim-editor-* CSS variables. */
    function buildThemeVars(theme: Record<string, string>): React.CSSProperties {
      const vars: Record<string, string> = {};
      for (const [key, value] of Object.entries(theme)) {
        vars[key.startsWith("--") ? key : `--elucim-editor-${key}`] = value;
      }
      return vars as React.CSSProperties;
    }

    function ComposedEditor({
      initialDocument,
      initialFrame,
      theme,
      onDocumentChange,
    }: {
      initialDocument: ElucimDocument;
      initialFrame: number;
      theme: Record<string, string>;
      onDocumentChange: (doc: ElucimDocument) => void;
    }) {
      const themeVars = useMemo(() => buildThemeVars(theme), [theme]);
      const isDark = (theme["color-scheme"] ?? "dark") === "dark";

      return (
        <mod.EditorProvider initialDocument={initialDocument} initialFrame={initialFrame}>
          <DocumentBridge onChange={onDocumentChange} />
          <div
            className="elucim-editor w-full h-full flex flex-col overflow-hidden"
            style={{
              ...themeVars,
              background: `var(--elucim-editor-bg, ${isDark ? "#1a1a2e" : "#faf9f7"})`,
              color: `var(--elucim-editor-fg, ${isDark ? "#e0e0e0" : "#2c2925"})`,
              fontFamily: "system-ui, -apple-system, sans-serif",
              userSelect: "none",
              colorScheme: isDark ? "dark" : "light",
            }}
          >
            <div className="flex-1 min-h-0 relative">
              <mod.ElucimCanvas
                className="absolute inset-0"
                style={{ width: "100%", height: "100%" }}
              />
              {/* Floating toolbar */}
              <div className="absolute top-3 left-3 z-10">
                <mod.Toolbar />
              </div>
              {/* Floating inspector (only when selection) */}
              <div className="absolute top-3 right-3 z-10">
                <mod.Inspector />
              </div>
            </div>
            <mod.Timeline className="shrink-0" />
          </div>
        </mod.EditorProvider>
      );
    }

    return { default: ComposedEditor };
  })
);

export default memo(function EditorWrapper({
  dsl,
  theme,
  tokenColors,
  onDocumentChange,
}: EditorWrapperProps) {
  const resolvedDsl = useMemo(() => resolveTokenColors(dsl, tokenColors), [dsl, tokenColors]);
  const lastFrame = useMemo(() => getLastFrame(dsl), [dsl]);

  return (
    <Suspense
      fallback={
        <div className="w-full h-full flex items-center justify-center text-[var(--color-text-secondary)]">
          Loading editor…
        </div>
      }
    >
      <LazyComposedEditor
        initialDocument={resolvedDsl}
        initialFrame={lastFrame}
        theme={theme}
        onDocumentChange={onDocumentChange}
      />
    </Suspense>
  );
});
