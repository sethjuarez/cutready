/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * With 0.11.0:
 * - $token resolution handled by the editor itself
 * - onDocumentChange callback provides live document for saving
 * - initialFrame="last" auto-resolves to the final frame
 * - theme accepts CSS var() strings directly
 */
import { memo, lazy, Suspense } from "react";
import type { ElucimDocument } from "@elucim/dsl";

export interface EditorWrapperProps {
  dsl: ElucimDocument;
  theme: Record<string, string>;
  onDocumentChange: (doc: ElucimDocument) => void;
}

const LazyElucimEditor = lazy(() =>
  import("@elucim/editor").then((mod) => ({ default: mod.ElucimEditor }))
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
      <LazyElucimEditor
        initialDocument={dsl}
        initialFrame="last"
        theme={theme}
        onDocumentChange={onDocumentChange}
        className="w-full h-full"
        style={{ width: "100%", height: "100%" }}
      />
    </Suspense>
  );
});
