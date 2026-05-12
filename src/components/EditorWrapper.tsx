/**
 * Wraps @elucim/editor's ElucimEditor for use in ScriptTable's lightbox.
 *
 * Since 0.13.1, the editor threads the content theme through to the canvas
 * scene (fixing the previous gap where the scene always used built-in
 * DARK_THEME/LIGHT_THEME). We pass concrete colors derived from the active
 * CutReady theme palette so the canvas can generate proper --elucim-* vars.
 */
import { memo, lazy, Suspense, useState, useCallback, useRef } from "react";
import type { ComponentType } from "react";
import type { ElucimEditorProps } from "@elucim/editor";
import type { CutReadyElucimDocument } from "../types/elucim";
import { elucimThemeFromTokens } from "../theme/elucimTheme";
import { getThemePalette } from "../theme/appThemePalettes";
import { useElucimImageResolver } from "../hooks/useElucimImageResolver";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useAppStore, type AssetInfo } from "../stores/appStore";
import { ErrorBoundary } from "./ErrorBoundary";
import { ProjectImagePicker } from "./ProjectImagePicker";

export interface EditorWrapperProps {
  dsl: CutReadyElucimDocument;
  onDocumentChange: (doc: CutReadyElucimDocument) => void;
  onV2DocumentChange?: (doc: CutReadyElucimDocument) => void;
}

type ElucimEditorCompatProps = Omit<
  ElucimEditorProps,
  "initialDocument" | "onDocumentChange" | "onV2DocumentChange"
> & {
  initialDocument?: CutReadyElucimDocument;
  onDocumentChange?: (document: CutReadyElucimDocument, details?: unknown) => void;
  onV2DocumentChange?: (document: CutReadyElucimDocument, details?: unknown) => void;
};

const LazyElucimEditor = lazy(() =>
  import("@elucim/editor").then((mod) => ({
    default: mod.ElucimEditor as ComponentType<ElucimEditorCompatProps>,
  }))
);

export default memo(function EditorWrapper({
  dsl,
  onDocumentChange,
  onV2DocumentChange,
}: EditorWrapperProps) {
  const imageResolver = useElucimImageResolver();
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);
  const { settings } = useSettings();
  const { theme: resolvedTheme } = useTheme();

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

  const palette = getThemePalette(settings.displayThemePalette);
  const colors = palette[resolvedTheme];
  const theme = elucimThemeFromTokens(colors);
  const handleEditorDocumentChange = useCallback((doc: CutReadyElucimDocument) => {
    onDocumentChange(doc);
    onV2DocumentChange?.(doc);
  }, [onDocumentChange, onV2DocumentChange]);

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
            "color-scheme": resolvedTheme,
            "--elucim-editor-bg": `rgb(${colors.surfaceInset})`,
          }}
          onDocumentChange={handleEditorDocumentChange}
          onV2DocumentChange={handleEditorDocumentChange}
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
