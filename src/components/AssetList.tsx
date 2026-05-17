import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Download,
  Trash2,
  ChevronRight,
  ArrowDownAZ,
  ArrowUpAZ,
} from "lucide-react";
import { useAppStore, type AssetInfo } from "../stores/appStore";
import VisualCell from "./VisualCell";

type SortBy = "type" | "reference" | "recency";
type SortDir = "asc" | "desc";

interface AssetGroup {
  label: string;
  items: AssetInfo[];
}

// ── Sorting helpers ──────────────────────────────────────────

function sortAssets(assets: AssetInfo[], by: SortBy, dir: SortDir): AssetGroup[] {
  const sorted = [...assets];
  const flip = dir === "asc" ? 1 : -1;

  if (by === "type") {
    return groupByType(sorted, flip);
  }
  if (by === "reference") {
    return groupByReference(sorted, flip);
  }
  // recency — flat list sorted by modifiedAt
  sorted.sort((a, b) => flip * (a.modifiedAt - b.modifiedAt));
  return [{ label: "All Assets", items: sorted }];
}

function groupByType(items: AssetInfo[], flip: number): AssetGroup[] {
  const visuals = items.filter((a) => a.assetType === "visual");
  const images = items.filter((a) => a.assetType === "screenshot");
  visuals.sort((a, b) => flip * a.path.localeCompare(b.path));
  images.sort((a, b) => flip * a.path.localeCompare(b.path));
  const groups: AssetGroup[] = [];
  if (visuals.length > 0) groups.push({ label: "Visuals", items: visuals });
  if (images.length > 0) groups.push({ label: "Images", items: images });
  return groups;
}

function groupByReference(items: AssetInfo[], flip: number): AssetGroup[] {
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
  const entries = [...byRef.entries()].sort((a, b) => flip * a[0].localeCompare(b[0]));
  for (const [label, groupItems] of entries) {
    groupItems.sort((a, b) => flip * a.path.localeCompare(b.path));
    groups.push({ label, items: groupItems });
  }
  if (unlinked.length > 0) {
    unlinked.sort((a, b) => flip * a.path.localeCompare(b.path));
    groups.push({ label: "Unlinked", items: unlinked });
  }
  return groups;
}

// ── Components ───────────────────────────────────────────────

/** Sidebar pane listing all project assets grouped by type, reference, or recency. */
export function AssetList() {
  const assets = useAppStore((s) => s.assets);
  const loadAssets = useAppStore((s) => s.loadAssets);
  const openAsset = useAppStore((s) => s.openAsset);
  const importAsset = useAppStore((s) => s.importAsset);
  const deleteAsset = useAppStore((s) => s.deleteAsset);
  const currentProject = useAppStore((s) => s.currentProject);
  const activeTabId = useAppStore((s) => s.activeTabId);

  const [sortBy, setSortBy] = useState<SortBy>("type");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    if (currentProject) loadAssets();
  }, [currentProject, loadAssets]);

  useEffect(() => {
    const handler = () => loadAssets();
    window.addEventListener("sidebar-refresh", handler);
    return () => window.removeEventListener("sidebar-refresh", handler);
  }, [loadAssets]);

  const groups = useMemo(() => sortAssets(assets, sortBy, sortDir), [assets, sortBy, sortDir]);

  const toggleDir = useCallback(() => setSortDir((d) => (d === "asc" ? "desc" : "asc")), []);

  const SortDirIcon = sortDir === "asc" ? ArrowUpAZ : ArrowDownAZ;

  return (
    <div className="flex flex-col h-full bg-[rgb(var(--color-surface-inset))] text-[rgb(var(--color-text))]">
      {/* Header */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[rgb(var(--color-border))] px-3">
        <span className="text-[11px] font-semibold text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">
          Assets
        </span>
        <button
          onClick={importAsset}
          className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
          title="Import image"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
        {assets.length > 0 && (
          <>
            <div className="flex-1" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="text-[10px] bg-transparent text-[rgb(var(--color-text-secondary))] border-none outline-none cursor-pointer"
            >
              <option value="type">Type</option>
              <option value="reference">Reference</option>
              <option value="recency">Recency</option>
            </select>
            <button
              onClick={toggleDir}
              className="p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
              title={sortDir === "asc" ? "Ascending" : "Descending"}
            >
              <SortDirIcon className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Asset list */}
      <div className="flex-1 overflow-y-auto">
        {assets.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12px] text-[rgb(var(--color-text-secondary))]">
            No assets yet.
            <br />
            <button
              onClick={importAsset}
              className="mt-2 text-[rgb(var(--color-accent))] hover:underline"
            >
              Import an image
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <AssetGroupSection
              key={group.label}
              group={group}
              showGroupHeader={groups.length > 1}
              activeTabId={activeTabId}
              onOpen={openAsset}
              onDelete={deleteAsset}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Collapsible group with header and asset items. */
function AssetGroupSection({
  group,
  showGroupHeader,
  activeTabId,
  onOpen,
  onDelete,
}: {
  group: AssetGroup;
  showGroupHeader: boolean;
  activeTabId: string | null;
  onOpen: (path: string, assetType: "screenshot" | "visual") => void;
  onDelete: (path: string) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isUnlinked = group.label === "Unlinked";

  return (
    <div>
      {showGroupHeader && (
        <button
          onClick={() => setCollapsed((c) => !c)}
          className={`flex h-8 w-full items-center gap-1.5 border-b border-[rgb(var(--color-border))] px-3 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
            isUnlinked
              ? "text-[rgb(var(--color-warning))] hover:bg-[rgb(var(--color-warning))]/5"
              : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))]"
          }`}
        >
          <ChevronRight
            className={`w-2.5 h-2.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
          />
          <span className="truncate">{group.label}</span>
          <span className="ml-auto opacity-60">{group.items.length}</span>
        </button>
      )}
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
          ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
          : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
      }`}
    >
      {/* Thumbnail */}
      <div className="w-10 h-7 rounded border border-[rgb(var(--color-border))] overflow-hidden shrink-0 bg-[rgb(var(--color-surface-alt))]">
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
        className="p-1 rounded opacity-0 group-hover:opacity-100 text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-error))] transition-all"
        title="Delete asset"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}
