/**
 * ImageManagerTab — settings sub-tab for managing project images.
 *
 * Lists all images in .cutready/screenshots/ with thumbnails, sizes,
 * and which notes reference each image. Orphaned images (unreferenced)
 * are highlighted for easy cleanup.
 */
import { useState, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";

interface ImageInfo {
  path: string;
  size: number;
  referencedBy: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImageManagerTab() {
  const currentProject = useAppStore((s) => s.currentProject);
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "orphaned" | "referenced">("all");

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

  const filtered = images.filter((img) => {
    if (filter === "orphaned") return img.referencedBy.length === 0;
    if (filter === "referenced") return img.referencedBy.length > 0;
    return true;
  });

  const orphanedCount = images.filter((img) => img.referencedBy.length === 0).length;
  const totalSize = images.reduce((sum, img) => sum + img.size, 0);

  if (!currentProject) {
    return (
      <div className="text-[var(--color-text-secondary)] text-sm py-8 text-center">
        Open a project to manage images.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-4 text-sm text-[var(--color-text-secondary)]">
        <span>{images.length} image{images.length !== 1 ? "s" : ""}</span>
        <span>·</span>
        <span>{formatBytes(totalSize)} total</span>
        {orphanedCount > 0 && (
          <>
            <span>·</span>
            <span className="text-amber-500">{orphanedCount} orphaned</span>
          </>
        )}
      </div>

      {/* Filter + actions bar */}
      <div className="flex items-center gap-3">
        <div className="flex items-stretch rounded-lg border border-[var(--color-border)] overflow-hidden text-xs">
          {(["all", "orphaned", "referenced"] as const).map((f) => (
            <button
              key={f}
              className={`px-3 py-1.5 capitalize transition-colors ${
                filter === f
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-[var(--color-surface-alt)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
              }`}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <button
          className="ml-auto px-3 py-1.5 text-xs rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
          onClick={loadImages}
          disabled={loading}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>

        {orphanedCount > 0 && (
          <button
            className="px-3 py-1.5 text-xs rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-500 hover:bg-amber-500/20 transition-colors"
            onClick={deleteAllOrphaned}
          >
            Delete all orphaned
          </button>
        )}
      </div>

      {error && (
        <div className="text-red-400 text-sm bg-red-500/10 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* Image grid */}
      {filtered.length === 0 && !loading && (
        <div className="text-[var(--color-text-secondary)] text-sm py-8 text-center">
          {images.length === 0
            ? "No images in this project yet."
            : `No ${filter} images found.`}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((img) => (
          <ImageCard
            key={img.path}
            image={img}
            projectRoot={currentProject.root}
            onDelete={() => deleteImage(img.path)}
          />
        ))}
      </div>
    </div>
  );
}

function ImageCard({
  image,
  projectRoot,
  onDelete,
}: {
  image: ImageInfo;
  projectRoot: string;
  onDelete: () => void;
}) {
  const isOrphaned = image.referencedBy.length === 0;
  const fileName = image.path.split("/").pop() || image.path;
  const src = convertFileSrc(`${projectRoot}/${image.path}`);

  return (
    <div
      className={`rounded-lg border overflow-hidden ${
        isOrphaned
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-[var(--color-border)] bg-[var(--color-surface-alt)]"
      }`}
    >
      {/* Thumbnail */}
      <div className="aspect-video bg-black/20 flex items-center justify-center overflow-hidden">
        <img
          src={src}
          alt={fileName}
          className="max-w-full max-h-full object-contain"
          loading="lazy"
        />
      </div>

      {/* Info */}
      <div className="p-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--color-text)] truncate font-mono" title={image.path}>
            {fileName}
          </span>
          <span className="text-xs text-[var(--color-text-secondary)] shrink-0">
            {formatBytes(image.size)}
          </span>
        </div>

        {image.referencedBy.length > 0 ? (
          <div className="text-xs text-[var(--color-text-secondary)]">
            Referenced by:{" "}
            {image.referencedBy.map((note, i) => (
              <span key={note}>
                {i > 0 && ", "}
                <span className="text-[var(--color-accent)]">{note}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="text-xs text-amber-500">Orphaned — not referenced by any file</div>
        )}

        <button
          className="w-full mt-1 px-2 py-1 text-xs rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
