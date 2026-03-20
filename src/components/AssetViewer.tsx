import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ArrowPathIcon, PencilIcon, CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { ElucimDocument } from "@elucim/dsl";
import VisualCell, { type VisualControlHandle } from "./VisualCell";
import type { AssetInfo } from "../stores/appStore";
import { useAppStore } from "../stores/appStore";

const EditorWrapper = lazy(() => import("./EditorWrapper"));

interface AssetViewerProps {
  /** Relative path to the asset file. */
  assetPath: string;
}

/** Tab content for viewing a project asset (image or visual). */
export function AssetViewer({ assetPath }: AssetViewerProps) {
  const assets = useAppStore((s) => s.assets);
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);

  const asset = assets.find((a) => a.path === assetPath);
  const assetType = asset?.assetType ?? (assetPath.endsWith(".json") ? "visual" : "screenshot");

  if (assetType === "visual") {
    return <VisualAssetViewer assetPath={assetPath} asset={asset} />;
  }

  return <ImageAssetViewer assetPath={assetPath} asset={asset} projectRoot={projectRoot} />;
}

/** View-only image with zoom. */
function ImageAssetViewer({
  assetPath,
  asset,
  projectRoot,
}: {
  assetPath: string;
  asset?: AssetInfo;
  projectRoot: string | null;
}) {
  const src = projectRoot ? convertFileSrc(`${projectRoot}/${assetPath}`) : assetPath;
  const filename = assetPath.split("/").pop() ?? assetPath;

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)]">
      {/* Metadata bar */}
      <MetadataBar filename={filename} asset={asset} />

      {/* Image viewer */}
      <div className="flex-1 flex items-center justify-center overflow-auto p-4 bg-[var(--color-surface-alt)]">
        <img
          src={src}
          alt={filename}
          className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
        />
      </div>
    </div>
  );
}

/** Visual viewer with replay + edit-in-lightbox. */
function VisualAssetViewer({
  assetPath,
  asset,
}: {
  assetPath: string;
  asset?: AssetInfo;
}) {
  const filename = assetPath.split("/").pop() ?? assetPath;
  const controlRef = useRef<VisualControlHandle | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [visualVersion, setVisualVersion] = useState(0);

  // Lightbox editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDsl, setEditorDsl] = useState<ElucimDocument | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load DSL when editor lightbox opens
  useEffect(() => {
    if (!editorOpen) {
      setEditorDsl(null);
      setEditorDirty(false);
      return;
    }
    invoke<Record<string, unknown>>("get_visual", { relativePath: assetPath })
      .then((data) => setEditorDsl(data as unknown as ElucimDocument))
      .catch(console.error);
  }, [editorOpen, assetPath]);

  const handleReplay = useCallback(() => {
    controlRef.current?.replay();
  }, []);

  const saveEditorChanges = useCallback(async (doc: ElucimDocument) => {
    setSaving(true);
    try {
      await invoke("write_visual_doc", { relativePath: assetPath, document: doc });
      setEditorDirty(false);
      setVisualVersion((v) => v + 1);
    } catch (err) {
      console.error("[AssetViewer] Failed to save visual:", err);
    } finally {
      setSaving(false);
    }
  }, [assetPath]);

  const closeLightbox = useCallback(() => {
    setEditorOpen(false);
  }, []);

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)]">
      {/* Metadata bar with controls */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-alt)] shrink-0">
        <MetadataBar filename={filename} asset={asset} inline />
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleReplay}
            disabled={isPlaying}
            className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors disabled:opacity-40"
            title="Replay animation"
          >
            <ArrowPathIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => setEditorOpen(true)}
            className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors"
            title="Edit visual"
          >
            <PencilIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Preview */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--color-text-secondary)]">Loading...</div>}>
          <VisualCell
            visualPath={assetPath}
            mode="full"
            controlRef={controlRef}
            onPlayStateChange={setIsPlaying}
            className="w-full h-full"
            key={`${assetPath}-v${visualVersion}`}
          />
        </Suspense>
      </div>

      {/* Editor lightbox */}
      {editorOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
          onClick={() => { if (!editorDirty && !saving) closeLightbox(); }}
        >
          <div
            className="relative flex flex-col rounded-xl overflow-hidden shadow-2xl bg-[var(--color-surface)]"
            style={{ width: "calc(100vw - 60px)", height: "calc(100vh - 60px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-alt)] shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-[13px] font-medium text-[var(--color-text)]">{filename}</span>
                {editorDirty && (
                  <span className="text-[11px] text-[var(--color-accent)] font-medium">● Unsaved</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {editorDirty && editorDsl && (
                  <button
                    onClick={() => saveEditorChanges(editorDsl)}
                    disabled={saving}
                    title="Save changes"
                    className="p-1.5 rounded-lg text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:bg-[var(--color-surface)] transition-colors disabled:opacity-40"
                  >
                    <CheckIcon className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={closeLightbox}
                  disabled={saving}
                  className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors disabled:opacity-40"
                >
                  <XMarkIcon className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Editor */}
            <div className="flex-1 min-h-0 relative overflow-hidden">
              <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-[var(--color-text-secondary)]">Loading editor…</div>}>
                {editorDsl ? (
                  <EditorWrapper
                    dsl={editorDsl}
                    onDocumentChange={(doc) => { setEditorDsl(doc); setEditorDirty(true); }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[var(--color-text-secondary)]">Loading…</div>
                )}
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared metadata display. */
function MetadataBar({
  filename,
  asset,
  inline = false,
}: {
  filename: string;
  asset?: AssetInfo;
  inline?: boolean;
}) {
  const sizeLabel = asset ? formatBytes(asset.size) : "";
  const refs = asset?.referencedBy ?? [];

  if (inline) {
    return (
      <div className="flex items-center gap-3 text-[12px]">
        <span className="font-medium text-[var(--color-text)]">{filename}</span>
        {sizeLabel && <span className="text-[var(--color-text-secondary)]">{sizeLabel}</span>}
        {refs.length > 0 && (
          <span className="text-[var(--color-text-secondary)]">
            Used in: {refs.map((r) => r.split("/").pop()).join(", ")}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-alt)] shrink-0 text-[12px]">
      <span className="font-medium text-[var(--color-text)]">{filename}</span>
      {sizeLabel && <span className="text-[var(--color-text-secondary)]">{sizeLabel}</span>}
      {refs.length > 0 && (
        <span className="text-[var(--color-text-secondary)]">
          Used in: {refs.map((r) => r.split("/").pop()).join(", ")}
        </span>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
