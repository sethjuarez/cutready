import { Suspense, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowDownTrayIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useAppStore, type AssetInfo } from "../stores/appStore";
import VisualCell from "./VisualCell";

/** Sidebar pane listing all project assets (screenshots + visuals). */
export function AssetList() {
  const assets = useAppStore((s) => s.assets);
  const loadAssets = useAppStore((s) => s.loadAssets);
  const openAsset = useAppStore((s) => s.openAsset);
  const importAsset = useAppStore((s) => s.importAsset);
  const deleteAsset = useAppStore((s) => s.deleteAsset);
  const currentProject = useAppStore((s) => s.currentProject);
  const activeTabId = useAppStore((s) => s.activeTabId);

  useEffect(() => {
    if (currentProject) loadAssets();
  }, [currentProject, loadAssets]);

  // Listen for sidebar-refresh events to reload assets
  useEffect(() => {
    const handler = () => loadAssets();
    window.addEventListener("sidebar-refresh", handler);
    return () => window.removeEventListener("sidebar-refresh", handler);
  }, [loadAssets]);

  const screenshots = assets.filter((a) => a.assetType === "screenshot");
  const visuals = assets.filter((a) => a.assetType === "visual");

  return (
    <div className="flex flex-col h-full bg-[var(--color-surface)] text-[var(--color-text)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-10 shrink-0 border-b border-[var(--color-border)]">
        <span className="text-[11px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          Assets
        </span>
        <button
          onClick={importAsset}
          className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          title="Import image"
        >
          <ArrowDownTrayIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Asset list */}
      <div className="flex-1 overflow-y-auto">
        {assets.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12px] text-[var(--color-text-secondary)]">
            No assets yet.
            <br />
            <button
              onClick={importAsset}
              className="mt-2 text-[var(--color-accent)] hover:underline"
            >
              Import an image
            </button>
          </div>
        ) : (
          <>
            {/* Visuals section */}
            {visuals.length > 0 && (
              <AssetSection
                title="Visuals"
                items={visuals}
                activeTabId={activeTabId}
                onOpen={openAsset}
                onDelete={deleteAsset}
              />
            )}

            {/* Screenshots section */}
            {screenshots.length > 0 && (
              <AssetSection
                title="Screenshots"
                items={screenshots}
                activeTabId={activeTabId}
                onOpen={openAsset}
                onDelete={deleteAsset}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AssetSection({
  title,
  items,
  activeTabId,
  onOpen,
  onDelete,
}: {
  title: string;
  items: AssetInfo[];
  activeTabId: string | null;
  onOpen: (path: string, assetType: "screenshot" | "visual") => void;
  onDelete: (path: string) => Promise<void>;
}) {
  return (
    <div>
      <div className="px-3 h-7 flex items-center border-b border-[var(--color-border)]">
        <span className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          {title} ({items.length})
        </span>
      </div>
      <div className="py-1">
        {items.map((asset) => (
          <AssetItem
            key={asset.path}
            asset={asset}
            isActive={activeTabId === `asset-${asset.path}`}
            onOpen={() => onOpen(asset.path, asset.assetType)}
            onDelete={() => onDelete(asset.path)}
          />
        ))}
      </div>
    </div>
  );
}

function AssetItem({
  asset,
  isActive,
  onOpen,
  onDelete,
}: {
  asset: AssetInfo;
  isActive: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);
  const filename = asset.path.split("/").pop() ?? asset.path;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors ${
        isActive
          ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
          : "text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]"
      }`}
    >
      {/* Thumbnail */}
      <div className="w-10 h-7 rounded border border-[var(--color-border)] overflow-hidden shrink-0 bg-[var(--color-surface-alt)]">
        {asset.assetType === "visual" ? (
          <Suspense fallback={<div className="w-full h-full animate-pulse" />}>
            <VisualCell
              visualPath={asset.path}
              mode="thumbnail"
              className="!w-full !h-full !rounded-none"
            />
          </Suspense>
        ) : (
          <img
            src={projectRoot ? convertFileSrc(`${projectRoot}/${asset.path}`) : asset.path}
            alt=""
            className="w-full h-full object-cover"
          />
        )}
      </div>

      {/* Name + refs */}
      <div className="flex-1 min-w-0">
        <div className="text-[12px] truncate">{filename}</div>
        {asset.referencedBy.length > 0 && (
          <div className="text-[10px] text-[var(--color-text-secondary)] truncate">
            {asset.referencedBy.map((r) => r.split("/").pop()).join(", ")}
          </div>
        )}
      </div>

      {/* Delete button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="p-1 rounded opacity-0 group-hover:opacity-100 text-[var(--color-text-secondary)] hover:text-[var(--color-error)] transition-all"
        title="Delete asset"
      >
        <TrashIcon className="w-3 h-3" />
      </button>
    </div>
  );
}
