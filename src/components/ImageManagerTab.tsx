/**
 * ImageManagerTab — settings sub-tab for managing workspace images.
 *
 * Groups images into collapsible sections:
 * - ⚠️ Orphaned section at top (expanded by default, amber highlight)
 * - One section per referencing file (notes, sketches) with image count
 * Images referenced by multiple files appear in each section with a badge.
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { DslRenderer, type ElucimDocument } from "@elucim/dsl";
import { useAppStore } from "../stores/appStore";
import { useTheme } from "../hooks/useTheme";
import { ELUCIM_THEME } from "../theme/elucimTheme";
import { useElucimImageResolver } from "../hooks/useElucimImageResolver";
import { SketchIcon, StoryboardIcon, NoteIcon, AlertTriangleIcon } from "./Icons";

interface ImageInfo {
  path: string;
  size: number;
  referencedBy: string[];
  assetType: "screenshot" | "visual";
}

interface ImageGroup {
  key: string;
  label: string;
  icon: React.ReactNode;
  images: ImageInfo[];
  totalSize: number;
  isOrphaned: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(filename: string): React.ReactNode {
  if (filename.endsWith(".sk")) return <SketchIcon size={14} />;
  if (filename.endsWith(".sb")) return <StoryboardIcon size={14} />;
  if (filename.endsWith(".md")) return <NoteIcon size={14} />;
  return <NoteIcon size={14} />;
}

function buildGroups(images: ImageInfo[]): ImageGroup[] {
  const orphaned = images.filter((img) => img.referencedBy.length === 0);
  const fileMap = new Map<string, ImageInfo[]>();

  for (const img of images) {
    for (const ref of img.referencedBy) {
      const list = fileMap.get(ref) || [];
      list.push(img);
      fileMap.set(ref, list);
    }
  }

  const groups: ImageGroup[] = [];

  if (orphaned.length > 0) {
    groups.push({
      key: "__orphaned__",
      label: "Orphaned",
      icon: <AlertTriangleIcon size={14} />,
      images: orphaned,
      totalSize: orphaned.reduce((s, i) => s + i.size, 0),
      isOrphaned: true,
    });
  }

  const sortedFiles = [...fileMap.keys()].sort((a, b) => a.localeCompare(b));
  for (const file of sortedFiles) {
    const imgs = fileMap.get(file)!;
    groups.push({
      key: file,
      label: file,
      icon: fileIcon(file),
      images: imgs,
      totalSize: imgs.reduce((s, i) => s + i.size, 0),
      isOrphaned: false,
    });
  }

  return groups;
}

export function ImageManagerTab() {
  const currentProject = useAppStore((s) => s.currentProject);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const loadImages = useCallback(async () => {
    if (!currentProject) return;
    setLoading(true);
    setError("");
    try {
      const result = await invoke<ImageInfo[]>("list_project_images");
      setImages(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [currentProject]);

  useEffect(() => {
    loadImages();
  }, [loadImages]);

  const deleteImage = async (path: string) => {
    const fileName = path.split("/").pop() || path;
    if (!window.confirm(`Delete ${fileName}?`)) return;
    try {
      await invoke("delete_project_image", { relativePath: path });
      setImages((prev) => prev.filter((img) => img.path !== path));
    } catch (err) {
      setError(String(err));
    }
  };

  const deleteAllOrphaned = async () => {
    const orphaned = images.filter((img) => img.referencedBy.length === 0);
    if (orphaned.length === 0) return;
    const confirmed = window.confirm(
      `Delete ${orphaned.length} orphaned image${orphaned.length !== 1 ? "s" : ""}?\n\nThis cannot be undone.`
    );
    if (!confirmed) return;
    try {
      const deleted = await invoke<number>("delete_orphaned_images");
      if (deleted > 0) await loadImages();
    } catch (err) {
      setError(String(err));
    }
  };

  const groups = useMemo(() => buildGroups(images), [images]);
  const orphanedCount = images.filter((img) => img.referencedBy.length === 0).length;
  const totalSize = images.reduce((sum, img) => sum + img.size, 0);

  const toggleSection = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!currentProject) {
    return (
      <div className="text-[var(--color-text-secondary)] text-sm py-8 text-center">
        Open a workspace to manage images.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-4 text-sm text-[var(--color-text-secondary)]">
        <span>{images.length} asset{images.length !== 1 ? "s" : ""}</span>
        <span>·</span>
        <span>{formatBytes(totalSize)} total</span>
        {images.some((i) => i.assetType === "screenshot") && (
          <>
            <span>·</span>
            <span>{images.filter((i) => i.assetType === "screenshot").length} screenshot{images.filter((i) => i.assetType === "screenshot").length !== 1 ? "s" : ""}</span>
          </>
        )}
        {images.some((i) => i.assetType === "visual") && (
          <>
            <span>·</span>
            <span>{images.filter((i) => i.assetType === "visual").length} visual{images.filter((i) => i.assetType === "visual").length !== 1 ? "s" : ""}</span>
          </>
        )}
        {orphanedCount > 0 && (
          <>
            <span>·</span>
            <span className="text-warning">{orphanedCount} orphaned</span>
          </>
        )}
      </div>

      {/* Actions bar */}
      <div className="flex items-center gap-3">
        <button
          className="px-3 py-1.5 text-xs rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
          onClick={loadImages}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>

        {orphanedCount > 0 && (
          <button
            className="px-3 py-1.5 text-xs rounded-lg bg-warning/10 border border-warning/30 text-warning hover:bg-warning/20 transition-colors"
            onClick={deleteAllOrphaned}
          >
            Delete all orphaned
          </button>
        )}

        {groups.length > 1 && (
          <div className="ml-auto flex items-center gap-2">
            <button
              className="px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
              onClick={() => setCollapsed(new Set())}
            >
              Expand all
            </button>
            <span className="text-[var(--color-border)]">·</span>
            <button
              className="px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
              onClick={() => setCollapsed(new Set(groups.map((g) => g.key)))}
            >
              Collapse all
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="text-error text-sm bg-error/10 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* Grouped sections */}
      {images.length === 0 && !loading && (
        <div className="text-[var(--color-text-secondary)] text-sm py-8 text-center">
          No images or visuals in this workspace yet.
        </div>
      )}

      <div className="space-y-3">
        {groups.map((group) => (
          <ImageSection
            key={group.key}
            group={group}
            isCollapsed={collapsed.has(group.key)}
            onToggle={() => toggleSection(group.key)}
            projectRoot={currentProject.root}
            onDeleteImage={deleteImage}
            onDeleteAllOrphaned={group.isOrphaned ? deleteAllOrphaned : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function ImageSection({
  group,
  isCollapsed,
  onToggle,
  projectRoot,
  onDeleteImage,
  onDeleteAllOrphaned,
}: {
  group: ImageGroup;
  isCollapsed: boolean;
  onToggle: () => void;
  projectRoot: string;
  onDeleteImage: (path: string) => void;
  onDeleteAllOrphaned?: () => void;
}) {
  return (
    <div
      className={`rounded-xl border overflow-hidden ${
        group.isOrphaned
          ? "border-warning/30 bg-warning/5"
          : "border-[var(--color-border)] bg-[var(--color-surface)]"
      }`}
    >
      {/* Section header */}
      <button
        className={`w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors ${
          group.isOrphaned
            ? "hover:bg-warning/10"
            : "hover:bg-[var(--color-surface-alt)]"
        }`}
        onClick={onToggle}
      >
        <span
          className={`text-xs transition-transform duration-200 ${
            isCollapsed ? "" : "rotate-90"
          }`}
        >
          ▶
        </span>
        <span className={`shrink-0 ${group.isOrphaned ? "text-warning" : "text-[var(--color-text-secondary)]"}`}>{group.icon}</span>
        <span
          className={`text-sm font-medium truncate ${
            group.isOrphaned ? "text-warning" : "text-[var(--color-text)]"
          }`}
        >
          {group.label}
        </span>
        <span className="text-xs text-[var(--color-text-secondary)] tabular-nums">
          {group.images.length} asset{group.images.length !== 1 ? "s" : ""}
        </span>
        <span className="text-xs text-[var(--color-text-secondary)] tabular-nums">
          · {formatBytes(group.totalSize)}
        </span>
        {group.isOrphaned && onDeleteAllOrphaned && (
          <span
            className="ml-auto text-xs text-warning hover:text-warning transition-colors px-2 py-0.5 rounded hover:bg-warning/10"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteAllOrphaned();
            }}
            role="button"
            tabIndex={0}
          >
            Delete orphaned
          </span>
        )}
      </button>

      {/* Collapsible image grid */}
      {!isCollapsed && (
        <div className="px-3 pb-3">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {group.images.map((img) => (
              <ImageCard
                key={img.path}
                image={img}
                projectRoot={projectRoot}
                onDelete={() => onDeleteImage(img.path)}
                contextFile={group.isOrphaned ? undefined : group.key}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ImageCard({
  image,
  projectRoot,
  onDelete,
  contextFile,
}: {
  image: ImageInfo;
  projectRoot: string;
  onDelete: () => void;
  contextFile?: string;
}) {
  const isOrphaned = image.referencedBy.length === 0;
  const isVisual = image.assetType === "visual";
  const fileName = image.path.split("/").pop() || image.path;
  const src = isVisual ? undefined : convertFileSrc(`${projectRoot}/${image.path}`);

  // When shown inside a file section, count how many OTHER files reference this asset
  const otherRefCount = contextFile
    ? image.referencedBy.filter((r) => r !== contextFile).length
    : 0;

  return (
    <div
      className={`rounded-lg border overflow-hidden ${
        isOrphaned
          ? "border-warning/40 bg-warning/5"
          : "border-[var(--color-border)] bg-[var(--color-surface-alt)]"
      }`}
    >
      {/* Thumbnail */}
      {isVisual ? (
        <div className="aspect-video bg-black/20 relative overflow-hidden">
          <div className="absolute inset-0">
            <VisualThumbnail relativePath={image.path} />
          </div>
        </div>
      ) : (
        <div className="aspect-video bg-black/20 flex items-center justify-center overflow-hidden">
          <img
            src={src}
            alt={fileName}
            className="max-w-full max-h-full object-contain"
            loading="lazy"
          />
        </div>
      )}

      {/* Info */}
      <div className="p-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {isVisual && (
              <span className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium">
                DSL
              </span>
            )}
            <span className="text-xs text-[var(--color-text)] truncate font-mono" title={image.path}>
              {fileName}
            </span>
          </div>
          <span className="text-xs text-[var(--color-text-secondary)] shrink-0">
            {formatBytes(image.size)}
          </span>
        </div>

        {isOrphaned ? (
          <div className="text-xs text-warning">Not referenced by any file</div>
        ) : otherRefCount > 0 ? (
          <div className="text-xs text-[var(--color-text-secondary)]">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
              Also in {otherRefCount} other file{otherRefCount !== 1 ? "s" : ""}
            </span>
          </div>
        ) : null}

        <button
          className="w-full mt-1 px-2 py-1 text-xs rounded bg-error/10 text-error hover:bg-error/20 transition-colors"
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** Loads a visual JSON file and renders it as a DslRenderer thumbnail. */
function VisualThumbnail({ relativePath }: { relativePath: string }) {
  const [dsl, setDsl] = useState<ElucimDocument | null>(null);
  const [error, setError] = useState(false);
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const imageResolver = useElucimImageResolver();

  useEffect(() => {
    let cancelled = false;
    invoke<Record<string, unknown>>("get_visual", { relativePath })
      .then((data) => { if (!cancelled) setDsl(data as unknown as ElucimDocument); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [relativePath]);

  if (error) {
    return (
      <div className="flex items-center justify-center w-full h-full text-[10px] text-[var(--color-text-secondary)]">
        Failed to load
      </div>
    );
  }

  if (!dsl) {
    return (
      <div className="flex items-center justify-center w-full h-full text-[10px] text-[var(--color-text-secondary)]">
        Loading…
      </div>
    );
  }

  return (
    <div className="w-full h-full">
      <DslRenderer
        dsl={dsl}
        poster="last"
        colorScheme={isDark ? "dark" : "light"}
        theme={ELUCIM_THEME}
        fitToContainer
        imageResolver={imageResolver}
        fallback={
          <div className="flex items-center justify-center w-full h-full text-[10px] text-[var(--color-text-secondary)]">
            Render error
          </div>
        }
      />
    </div>
  );
}
