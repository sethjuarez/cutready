import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { PencilIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import VisualCell, { type VisualControlHandle } from "./VisualCell";
import type { AssetInfo } from "../stores/appStore";
import { useAppStore } from "../stores/appStore";

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

/** View-only visual with replay + edit button. */
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
  const [editMode, setEditMode] = useState(false);
  const [editorDsl, setEditorDsl] = useState<Record<string, unknown> | null>(null);

  // Load DSL for editor mode
  useEffect(() => {
    if (!editMode) return;
    invoke<Record<string, unknown>>("get_visual", { relativePath: assetPath })
      .then(setEditorDsl)
      .catch(console.error);
  }, [editMode, assetPath]);

  const handleReplay = useCallback(() => {
    controlRef.current?.replay();
  }, []);

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)]">
      {/* Metadata bar with controls */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-alt)] shrink-0">
        <MetadataBar filename={filename} asset={asset} inline />
        <div className="flex items-center gap-1.5">
          {!editMode && (
            <button
              onClick={handleReplay}
              disabled={isPlaying}
              className="p-1.5 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)] transition-colors disabled:opacity-40"
              title="Replay animation"
            >
              <ArrowPathIcon className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => setEditMode(!editMode)}
            className={`p-1.5 rounded-lg transition-colors ${
              editMode
                ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
            }`}
            title={editMode ? "Back to preview" : "Edit DSL"}
          >
            <PencilIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {editMode ? (
          <div className="h-full p-4 overflow-auto">
            <pre className="text-[12px] font-mono text-[var(--color-text)] whitespace-pre-wrap">
              {editorDsl ? JSON.stringify(editorDsl, null, 2) : "Loading..."}
            </pre>
          </div>
        ) : (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--color-text-secondary)]">Loading...</div>}>
            <VisualCell
              visualPath={assetPath}
              mode="full"
              controlRef={controlRef}
              onPlayStateChange={setIsPlaying}
              className="w-full h-full"
            />
          </Suspense>
        )}
      </div>
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
