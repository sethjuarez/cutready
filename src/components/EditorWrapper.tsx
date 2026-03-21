/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * Since 0.13.1, the editor threads the content theme through to the canvas
 * scene (fixing the previous gap where the scene always used built-in
 * DARK_THEME/LIGHT_THEME). We pass concrete hex themes (getCutReadyTheme)
 * so the canvas can generate proper --elucim-* vars.
 */
import { memo, lazy, Suspense, useState, useEffect, useCallback } from "react";
import type { ElucimDocument } from "@elucim/dsl";
import { invoke } from "@tauri-apps/api/core";
import { getCutReadyTheme } from "../theme/elucimTheme";
import { useElucimImageResolver } from "../hooks/useElucimImageResolver";
import { useAppStore } from "../stores/appStore";
import { ErrorBoundary } from "./ErrorBoundary";

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
  const imageResolver = useElucimImageResolver();
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);

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

  // Browse image callback — opens file picker for images only (no visuals)
  const handleBrowseImage = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
    });
    if (!selected) return null;
    const filePath = typeof selected === "string" ? selected : selected;
    try {
      const relativePath = await invoke<string>("import_image", { sourcePath: filePath });
      return { ref: relativePath, displayName: relativePath.split("/").pop() ?? relativePath };
    } catch (err) {
      console.error("Failed to import image for editor:", err);
      return null;
    }
  }, []);

  const theme = getCutReadyTheme(isDark);

  return (
    <ErrorBoundary
      fallback={
        <div className="w-full h-full flex items-center justify-center text-sm text-[var(--color-error)]">
          Editor failed to render
        </div>
      }
    >
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
          onBrowseImage={projectRoot ? handleBrowseImage : undefined}
          imageResolver={imageResolver}
          className="w-full h-full"
          style={{ width: "100%", height: "100%" }}
        />
      </Suspense>
    </ErrorBoundary>
  );
});
