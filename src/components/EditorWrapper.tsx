/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * Since 0.13.1, the editor threads the content theme through to the canvas
 * scene (fixing the previous gap where the scene always used built-in
 * DARK_THEME/LIGHT_THEME). We pass concrete hex themes (getCutReadyTheme)
 * so the canvas can generate proper --elucim-* vars.
 */
import { memo, lazy, Suspense, useState, useEffect, useCallback, useRef } from "react";
import type { ElucimDocument } from "@elucim/dsl";
import { getCutReadyTheme } from "../theme/elucimTheme";
import { useElucimImageResolver } from "../hooks/useElucimImageResolver";
import { useAppStore, type AssetInfo } from "../stores/appStore";
import { ErrorBoundary } from "./ErrorBoundary";
import { ProjectImagePicker } from "./ProjectImagePicker";

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

  // Promise-based picker: onBrowseImage opens the modal and returns a promise
  // that resolves when the user picks an image or cancels.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerResolver = useRef<((result: { ref: string; displayName: string } | null) => void) | null>(null);

  const handleBrowseImage = useCallback(async () => {
    setPickerOpen(true);
    return new Promise<{ ref: string; displayName: string } | null>((resolve) => {
      pickerResolver.current = resolve;
    });
  }, []);

  const handlePickerSelect = useCallback((asset: AssetInfo) => {
    const displayName = asset.path.split("/").pop() ?? asset.path;
    pickerResolver.current?.({ ref: asset.path, displayName });
    pickerResolver.current = null;
    setPickerOpen(false);
  }, []);

  const handlePickerCancel = useCallback(() => {
    pickerResolver.current?.(null);
    pickerResolver.current = null;
    setPickerOpen(false);
  }, []);

  const theme = getCutReadyTheme(isDark);

  return (
    <ErrorBoundary
      fallback={
        <div className="w-full h-full flex items-center justify-center text-sm text-[rgb(var(--color-error))]">
          Editor failed to render
        </div>
      }
    >
      <Suspense
        fallback={
          <div className="w-full h-full flex items-center justify-center text-[rgb(var(--color-text-secondary))]">
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
      {pickerOpen && (
        <ProjectImagePicker onSelect={handlePickerSelect} onCancel={handlePickerCancel} />
      )}
    </ErrorBoundary>
  );
});
