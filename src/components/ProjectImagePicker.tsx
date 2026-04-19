/**
 * ProjectImagePicker — modal overlay for selecting a project screenshot.
 *
 * Used by EditorWrapper's `onBrowseImage` callback to let users pick
 * from existing project images instead of the OS file dialog.
 */
import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { X, Image as ImageIcon, Search } from "lucide-react";
import { useAppStore, type AssetInfo } from "../stores/appStore";

interface ProjectImagePickerProps {
  onSelect: (asset: AssetInfo) => void;
  onCancel: () => void;
}

export function ProjectImagePicker({ onSelect, onCancel }: ProjectImagePickerProps) {
  const assets = useAppStore((s) => s.assets);
  const loadAssets = useAppStore((s) => s.loadAssets);
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  // Refresh asset list on mount
  useEffect(() => { loadAssets(); }, [loadAssets]);

  // Filter to screenshots only, apply search
  const images = useMemo(() => {
    const screenshots = assets.filter((a) => a.assetType === "screenshot");
    if (!search.trim()) return screenshots;
    const q = search.toLowerCase();
    return screenshots.filter((a) => a.path.toLowerCase().includes(q));
  }, [assets, search]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleConfirm = () => {
    const asset = images.find((a) => a.path === selected);
    if (asset) onSelect(asset);
  };

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-[rgb(var(--color-overlay-scrim)/0.6)] backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="flex flex-col rounded-xl overflow-hidden shadow-2xl bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))]"
        style={{ width: "min(640px, calc(100vw - 80px))", maxHeight: "calc(100vh - 120px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] shrink-0">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-[rgb(var(--color-accent))]" />
            <span className="text-[13px] font-medium text-[rgb(var(--color-text))]">Choose project image</span>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded-lg text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-[rgb(var(--color-border))] shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[rgb(var(--color-text-secondary))]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter images…"
              autoFocus
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-[12px] text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:border-[rgb(var(--color-accent))]/50 transition-colors"
            />
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-3 min-h-0">
          {images.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-[rgb(var(--color-text-secondary))] gap-2">
              <ImageIcon className="w-8 h-8 opacity-30" />
              <span className="text-xs">
                {assets.some((a) => a.assetType === "screenshot")
                  ? "No images match your search"
                  : "No images in this project yet"}
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {images.map((asset) => {
                const filename = asset.path.split("/").pop() ?? asset.path;
                const isSelected = selected === asset.path;
                const src = projectRoot ? convertFileSrc(`${projectRoot}/${asset.path}`) : asset.path;

                return (
                  <button
                    key={asset.path}
                    onClick={() => setSelected(asset.path)}
                    onDoubleClick={() => onSelect(asset)}
                    className={`group relative flex flex-col rounded-lg overflow-hidden border-2 transition-all text-left ${
                      isSelected
                        ? "border-[rgb(var(--color-accent))] ring-1 ring-[rgb(var(--color-accent))]/30"
                        : "border-transparent hover:border-[rgb(var(--color-border))]"
                    }`}
                  >
                    {/* Thumbnail */}
                    <div className="aspect-video bg-[rgb(var(--color-surface-alt))] flex items-center justify-center overflow-hidden">
                      <img
                        src={src}
                        alt={filename}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </div>
                    {/* Label */}
                    <div className="px-2 py-1.5 bg-[rgb(var(--color-surface))]">
                      <span className="text-[10px] text-[rgb(var(--color-text-secondary))] truncate block" title={filename}>
                        {filename}
                      </span>
                    </div>
                    {/* Selection indicator */}
                    {isSelected && (
                      <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[rgb(var(--color-accent))] flex items-center justify-center">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] shrink-0">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selected}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-40 transition-colors"
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
