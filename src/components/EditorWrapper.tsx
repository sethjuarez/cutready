/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * With 0.10.0:
 * - $token resolution handled by the editor itself
 * - onDocumentChange callback provides live document for saving
 * - initialFrame seeks to the last frame so all elements are visible
 */
import { useMemo, memo, lazy, Suspense } from "react";
import type { ElucimDocument } from "@elucim/dsl";

export interface EditorWrapperProps {
  dsl: ElucimDocument;
  theme: Record<string, string>;
  onDocumentChange: (doc: ElucimDocument) => void;
}

const LazyElucimEditor = lazy(() =>
  import("@elucim/editor").then((mod) => ({ default: mod.ElucimEditor }))
);

/** Extract durationInFrames from the document root. */
function getLastFrame(doc: ElucimDocument): number {
  const root = doc?.root as unknown as Record<string, unknown> | undefined;
  const dur = root && typeof root.durationInFrames === "number" ? root.durationInFrames : 120;
  return Math.max(0, dur - 1);
}

export default memo(function EditorWrapper({
  dsl,
  theme,
  onDocumentChange,
}: EditorWrapperProps) {
  const lastFrame = useMemo(() => getLastFrame(dsl), [dsl]);

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
        initialFrame={lastFrame}
        theme={theme}
        onDocumentChange={onDocumentChange}
        className="w-full h-full"
        style={{ width: "100%", height: "100%" }}
      />
    </Suspense>
  );
});
