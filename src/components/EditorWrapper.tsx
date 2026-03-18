/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * Known limitation: The editor's canvas scene wrapper uses elucim's built-in
 * DARK_THEME/LIGHT_THEME for --elucim-* tokens instead of the content theme
 * prop. This means the scene background inside the editor won't match
 * CutReady's palette. Tracked upstream — needs a fix in @elucim/editor to
 * pass the content theme through to the canvas scene's themeToVars() call.
 */
import { memo, lazy, Suspense, useState, useEffect } from "react";
import type { ElucimDocument } from "@elucim/dsl";
import type { ElucimTheme } from "@elucim/core";

export interface EditorWrapperProps {
  dsl: ElucimDocument;
  theme: ElucimTheme;
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
