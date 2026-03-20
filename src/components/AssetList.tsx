import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ArrowDownTrayIcon, TrashIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useAppStore, type AssetInfo } from "../stores/appStore";
import VisualCell from "./VisualCell";

interface AssetGroup {
  label: string;
  items: AssetInfo[];
}

/** Build groups: first by type (Visuals, Images), then within each by reference. */
function buildGroups(assets: AssetInfo[]): { visuals: AssetGroup[]; images: AssetGroup[] } {
  const visuals = assets.filter((a) => a.assetType === "visual");
  const images = assets.filter((a) => a.assetType === "screenshot");
  return {
    visuals: groupByReference(visuals),
    images: groupByReference(images),
  };
}

function groupByReference(items: AssetInfo[]): AssetGroup[] {
  const unlinked: AssetInfo[] = [];
  const byRef = new Map<string, AssetInfo[]>();

  for (const item of items) {
    if (item.referencedBy.length === 0) {
      unlinked.push(item);
    } else {
      for (const ref of item.referencedBy) {
        const label = ref.split("/").pop() ?? ref;
        const group = byRef.get(label) ?? [];
        group.push(item);
        byRef.set(label, group);
      }
    }
  }

  const groups: AssetGroup[] = [];
  // Referenced groups sorted alphabetically
  for (const [label, groupItems] of [...byRef.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.push({ label, items: groupItems });
  }
  // Unlinked at the end
  if (unlinked.length > 0) {
    groups.push({ label: "Unlinked", items: unlinked });
  }
  return groups;
}

/** Sidebar pane listing all project assets grouped by type and reference. */
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

  const { visuals, images } = useMemo(() => buildGroups(assets), [assets]);

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
            {visuals.length > 0 && (
              <TypeSection
                title="Visuals"
                count={visuals.reduce((n, g) => n + g.items.length, 0)}
                groups={visuals}
                activeTabId={activeTabId}
                onOpen={openAsset}
                onDelete={deleteAsset}
              />
            )}
            {images.length > 0 && (
              <TypeSection
                title="Images"
                count={images.reduce((n, g) => n + g.items.length, 0)}
                groups={images}
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

/** Top-level type section (Visuals / Images) — always visible, contains reference sub-groups. */
function TypeSection({
  title,
  count,
  groups,
  activeTabId,
  onOpen,
  onDelete,
}: {
  title: string;
  count: number;
  groups: AssetGroup[];
  activeTabId: string | null;
  onOpen: (path: string, assetType: "screenshot" | "visual") => void;
  onDelete: (path: string) => Promise<void>;
}) {
  return (
    <div>
      <div className="px-3 h-7 flex items-center border-b border-[var(--color-border)] bg-[var(--color-surface-alt)]">
        <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">
          {title} ({count})
        </span>
      </div>
      {groups.map((group) => (
        <ReferenceGroup
          key={group.label}
          group={group}
          isUnlinked={group.label === "Unlinked"}
          activeTabId={activeTabId}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

/** Collapsible sub-group by reference file (or "Unlinked"). */
function ReferenceGroup({
  group,
  isUnlinked,
  activeTabId,
  onOpen,
  onDelete,
}: {
  group: AssetGroup;
  isUnlinked: boolean;
  activeTabId: string | null;
  onOpen: (path: string, assetType: "screenshot" | "visual") => void;
  onDelete: (path: string) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  return (
    <div>
      <button
        onClick={toggle}
        className={`w-full flex items-center gap-1.5 px-3 h-6 text-[10px] transition-colors ${
          isUnlinked
            ? "text-[var(--color-warning)] hover:bg-[var(--color-warning)]/5"
            : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)]"
        }`}
      >
        <ChevronRightIcon
          className={`w-2.5 h-2.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
        />
        <span className="truncate font-medium">{group.label}</span>
        <span className="ml-auto opacity-60">{group.items.length}</span>
      </button>
      {!collapsed && (
        <div className="py-0.5">
          {group.items.map((asset) => (
            <AssetItem
              key={asset.path}
              asset={asset}
              isActive={activeTabId === `asset-${asset.path}`}
              onOpen={() => onOpen(asset.path, asset.assetType)}
              onDelete={() => onDelete(asset.path)}
            />
          ))}
        </div>
      )}
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

      {/* Name */}
      <div className="flex-1 min-w-0">
        <div className="text-[12px] truncate">{filename}</div>
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
