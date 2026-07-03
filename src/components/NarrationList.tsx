import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDownAZ, ArrowUpAZ, AudioLines, ChevronRight, Clock, Mic2, RefreshCw } from "lucide-react";
import { useAppStore, type NarrationAssetInfo } from "../stores/appStore";
import { convertFileSrc } from "../services/tauri";
import { useConfirmDialog } from "./ConfirmDialog";
import { NarrationPlayback } from "./NarrationPlayback";

type SortBy = "type" | "reference" | "recency";
type SortDir = "asc" | "desc";

interface NarrationGroup {
  label: string;
  items: NarrationAssetInfo[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function formatModified(ms: number): string {
  if (!ms) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

function projectAssetSrc(projectRoot: string | undefined | null, relativePath: string): string {
  if (!projectRoot || !relativePath) return "";
  const separator = projectRoot.includes("\\") ? "\\" : "/";
  const root = projectRoot.replace(/[\\/]+$/, "");
  const relative = relativePath.replace(/[\\/]+/g, separator);
  return convertFileSrc(`${root}${separator}${relative}`);
}

function isManagedNarrationAsset(path: string): boolean {
  return path.startsWith(".cutready/narration/");
}

function sortNarrations(assets: NarrationAssetInfo[], by: SortBy, dir: SortDir): NarrationGroup[] {
  const sorted = [...assets];
  const flip = dir === "asc" ? 1 : -1;

  if (by === "reference") {
    return groupByReference(sorted, flip);
  }

  if (by === "type") {
    const groups = new Map<string, NarrationAssetInfo[]>();
    for (const asset of sorted) {
      const group = groups.get(asset.mimeType) ?? [];
      group.push(asset);
      groups.set(asset.mimeType, group);
    }
    return [...groups.entries()]
      .sort((a, b) => flip * a[0].localeCompare(b[0]))
      .map(([label, items]) => ({
        label,
        items: items.sort((a, b) => flip * a.path.localeCompare(b.path)),
      }));
  }

  sorted.sort((a, b) => flip * (a.modifiedAt - b.modifiedAt || a.path.localeCompare(b.path)));
  return [{ label: "All Narrations", items: sorted }];
}

function groupByReference(items: NarrationAssetInfo[], flip: number): NarrationGroup[] {
  const unlinked: NarrationAssetInfo[] = [];
  const byRef = new Map<string, NarrationAssetInfo[]>();

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

  const groups: NarrationGroup[] = [...byRef.entries()]
    .sort((a, b) => flip * a[0].localeCompare(b[0]))
    .map(([label, groupItems]) => ({
      label,
      items: groupItems.sort((a, b) => flip * a.path.localeCompare(b.path)),
    }));
  if (unlinked.length > 0) {
    groups.push({
      label: "Unlinked",
      items: unlinked.sort((a, b) => flip * a.path.localeCompare(b.path)),
    });
  }
  return groups;
}

export function NarrationList() {
  const narrationAssets = useAppStore((s) => s.narrationAssets);
  const loadNarrationAssets = useAppStore((s) => s.loadNarrationAssets);
  const deleteUnlinkedNarrationAssets = useAppStore((s) => s.deleteUnlinkedNarrationAssets);
  const openTab = useAppStore((s) => s.openTab);
  const currentProject = useAppStore((s) => s.currentProject);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const { confirm, confirmationDialog } = useConfirmDialog();
  const [sortBy, setSortBy] = useState<SortBy>("type");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useEffect(() => {
    if (currentProject) void loadNarrationAssets();
  }, [currentProject, loadNarrationAssets]);

  useEffect(() => {
    const handler = () => void loadNarrationAssets();
    window.addEventListener("sidebar-refresh", handler);
    return () => window.removeEventListener("sidebar-refresh", handler);
  }, [loadNarrationAssets]);

  const groups = useMemo(() => sortNarrations(narrationAssets, sortBy, sortDir), [narrationAssets, sortBy, sortDir]);

  const toggleDir = useCallback(() => setSortDir((dir) => (dir === "asc" ? "desc" : "asc")), []);
  const handleDeleteUnlinked = useCallback(
    async (count: number) => {
      const ok = await confirm({
        title: "Delete unlinked narrations?",
        message: `This will permanently delete ${count} unlinked managed narration ${count === 1 ? "cut" : "cuts"} from .cutready/narration. Workspace audio and raw recording takes will be kept.`,
        confirmLabel: "Delete",
        variant: "error",
      });
      if (!ok) return;
      await deleteUnlinkedNarrationAssets();
    },
    [confirm, deleteUnlinkedNarrationAssets],
  );
  const SortDirIcon = sortDir === "asc" ? ArrowUpAZ : ArrowDownAZ;

  return (
    <div className="flex h-full flex-col bg-[rgb(var(--color-surface-inset))] text-[rgb(var(--color-text))]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
          Narrations
        </span>
        <button
          onClick={() => void loadNarrationAssets()}
          className="rounded-md p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))]"
          title="Refresh narrations"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        {narrationAssets.length > 0 && (
          <>
            <div className="flex-1" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="cursor-pointer rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--color-text-secondary))] outline-none transition-colors hover:text-[rgb(var(--color-text))] focus:border-[rgb(var(--color-accent))]"
            >
              <option value="type">Type</option>
              <option value="reference">Reference</option>
              <option value="recency">Recency</option>
            </select>
            <button
              onClick={toggleDir}
              className="rounded p-0.5 text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
              title={sortDir === "asc" ? "Oldest first" : "Newest first"}
            >
              <SortDirIcon className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {narrationAssets.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12px] text-[rgb(var(--color-text-secondary))]">
            <Mic2 className="mx-auto mb-2 h-5 w-5 opacity-40" />
            No narrations yet.
            <br />
            <span className="text-[11px]">Record a row narration to create the first cut.</span>
          </div>
        ) : (
          <div className="space-y-2 p-2">
            {groups.map((group) => (
              <NarrationGroupSection
                key={group.label}
                group={group}
                showGroupHeader={groups.length > 1}
                activeTabId={activeTabId}
                projectRoot={currentProject?.root ?? null}
                onOpen={(asset) => openTab({ type: "asset", path: asset.path, title: asset.path.split("/").pop() ?? asset.path })}
                onDeleteUnlinked={handleDeleteUnlinked}
              />
            ))}
          </div>
        )}
      </div>
     {confirmationDialog}
    </div>
  );
}

function NarrationGroupSection({
  group,
  showGroupHeader,
  activeTabId,
  projectRoot,
  onOpen,
  onDeleteUnlinked,
}: {
  group: NarrationGroup;
  showGroupHeader: boolean;
  activeTabId: string | null;
  projectRoot: string | null;
  onOpen: (asset: NarrationAssetInfo) => void;
  onDeleteUnlinked: (count: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const isUnlinked = group.label === "Unlinked";
  const managedUnlinkedCount = isUnlinked
    ? group.items.filter((asset) => isManagedNarrationAsset(asset.path)).length
    : 0;

  return (
    <div>
      {showGroupHeader && (
        <div
          className={`flex h-8 w-full items-center gap-1.5 border-b border-[rgb(var(--color-border))] px-1 text-[11px] font-semibold uppercase tracking-wider transition-colors ${
            isUnlinked
              ? "text-[rgb(var(--color-warning))]"
              : "text-[rgb(var(--color-text-secondary))]"
          }`}
        >
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors ${
              isUnlinked
                ? "hover:bg-[rgb(var(--color-warning))]/5"
                : "hover:bg-[rgb(var(--color-surface-alt))]"
            }`}
          >
            <ChevronRight className={`h-2.5 w-2.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
            <span className="truncate">{group.label}</span>
            <span className="ml-auto opacity-60">{group.items.length}</span>
          </button>
          {managedUnlinkedCount > 0 && (
            <button
              type="button"
              onClick={() => onDeleteUnlinked(managedUnlinkedCount)}
              className="mr-2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-[rgb(var(--color-error))] transition-colors hover:bg-[rgb(var(--color-error))]/10"
              title="Delete all unlinked narrations"
            >
              Delete
            </button>
          )}
        </div>
      )}
      {!collapsed && (
        <div className="space-y-2 py-0.5">
          {group.items.map((asset) => (
            <NarrationItem
              key={asset.path}
              asset={asset}
              isActive={activeTabId === `asset-${asset.path}`}
              projectRoot={projectRoot}
              onOpen={() => onOpen(asset)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NarrationItem({
  asset,
  isActive,
  projectRoot,
  onOpen,
}: {
  asset: NarrationAssetInfo;
  isActive: boolean;
  projectRoot: string | null;
  onOpen: () => void;
}) {
  const filename = asset.path.split("/").pop() ?? asset.path;
  const src = projectAssetSrc(projectRoot, asset.path);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`group w-full rounded-xl border p-2 text-left shadow-sm transition-colors ${
        isActive
          ? "border-[rgb(var(--color-accent))]/40 bg-[rgb(var(--color-accent))]/10"
          : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] hover:border-[rgb(var(--color-accent))]/30 hover:bg-[rgb(var(--color-surface-alt))]"
      }`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
          <AudioLines className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-[rgb(var(--color-text))] group-hover:text-[rgb(var(--color-accent))]" title={asset.path}>
            {filename}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-[rgb(var(--color-text-secondary))]">
            <span>{formatBytes(asset.size)}</span>
            <span className="opacity-50">|</span>
            <Clock className="h-2.5 w-2.5" />
            <span className="truncate">{formatModified(asset.modifiedAt)}</span>
          </div>
        </div>
      </div>
      {src && <NarrationPlayback src={src} waveformHeight="h-16" className="mt-2" showControls={false} />}
    </div>
  );
}
