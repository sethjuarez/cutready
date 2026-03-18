/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * Since 0.13.1, the editor threads the content theme through to the canvas
 * scene (fixing the previous gap where the scene always used built-in
 * DARK_THEME/LIGHT_THEME). We pass concrete hex themes (getCutReadyTheme)
 * so the canvas can generate proper --elucim-* vars.
 */
import { memo, lazy, Suspense, useState, useEffect } from "react";
import type { ElucimDocument } from "@elucim/dsl";
import { getCutReadyTheme } from "../theme/elucimTheme";

export interface EditorWrapperProps {
  dsl: ElucimDocument;
  onDocumentChange: (doc: ElucimDocument) => void;
}

const LazyElucimEditor = lazy(() =>
  import("@elucim/editor").then((mod) => ({ default: mod.ElucimEditor }))
);

export default memo(function EditorWrapper({
  dsl,
  onDocumentChange,
}: EditorWrapperProps) {
  // Detect light/dark for explicit colorScheme (auto can't parse var() strings)
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark")
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const theme = getCutReadyTheme(isDark);

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
        editorTheme={{
          "color-scheme": isDark ? "dark" : "light",
          "--elucim-editor-bg": isDark ? "#252220" : "#eae7e2",
        }}
        onDocumentChange={onDocumentChange}
        className="w-full h-full"
        style={{ width: "100%", height: "100%" }}
      />
    </Suspense>
  );
});
