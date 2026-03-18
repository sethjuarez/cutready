/**
 * Wraps @elucim/editor to bridge document changes back to ScriptTable.
 *
 * Uses EditorProvider directly (not ElucimEditor) so a child component
 * can call useEditorDocument() from inside the context and forward
 * changes to the parent via onDocumentChange.
 */
import React, { useEffect, useRef, memo, lazy, Suspense } from "react";
import type { ElucimDocument } from "@elucim/dsl";

export interface EditorWrapperProps {
  dsl: ElucimDocument;
  theme: Record<string, string>;
  onDocumentChange: (doc: ElucimDocument) => void;
}

/**
 * Single lazy chunk: imports @elucim/editor once and returns a
 * composed component with EditorProvider + canvas + toolbar + inspector
 * + a hidden DocumentSync child that pipes useEditorDocument() upstream.
 */
const LazyComposed = lazy(() =>
  import("@elucim/editor").then((mod) => {
    // DocumentSync lives inside the provider context → can call hooks
    function DocumentSync({ onChange }: { onChange: (doc: ElucimDocument) => void }) {
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

    // The composed editor UI
    function ComposedEditor({
      initialDocument,
      theme,
      onDocumentChange,
    }: {
      initialDocument: ElucimDocument;
      theme: Record<string, string>;
      onDocumentChange: (doc: ElucimDocument) => void;
    }) {
      // Map theme keys to --elucim-editor-* CSS variables
      const themeVars: Record<string, string> = {};
      for (const [key, value] of Object.entries(theme)) {
        const varName = key.startsWith("--") ? key : `--elucim-editor-${key}`;
        themeVars[varName] = value;
      }

      return (
        <mod.EditorProvider initialDocument={initialDocument}>
          <DocumentSync onChange={onDocumentChange} />
          <div
            className="w-full h-full flex flex-col overflow-hidden"
            style={themeVars as React.CSSProperties}
          >
            <mod.Toolbar className="shrink-0" />
            <div className="flex-1 min-h-0 flex overflow-hidden">
              <mod.ElucimCanvas
                className="flex-1 min-w-0"
                style={{ width: "100%", height: "100%" }}
              />
              <mod.Inspector className="shrink-0 w-[260px] overflow-y-auto" />
            </div>
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
  onDocumentChange,
}: EditorWrapperProps) {
  return (
    <Suspense
      fallback={
        <div className="w-full h-full flex items-center justify-center text-[var(--color-text-secondary)]">
          Loading editor…
        </div>
      }
    >
      <LazyComposed
        initialDocument={dsl}
        theme={theme}
        onDocumentChange={onDocumentChange}
      />
    </Suspense>
  );
});
