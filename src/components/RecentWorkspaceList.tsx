import { useState } from "react";
import { Copy, ExternalLink, GitBranch, MoreHorizontal, X } from "lucide-react";
import type { RecentProject } from "../types/project";
import { formatRelativeDate } from "../utils/relativeDate";
import { samePath, workspaceName } from "../utils/home";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const TILE_HUES = [260, 200, 330, 170, 20, 45];

function WorkspaceTile({ name }: { name: string }) {
  const initials = name
    .split(/[-_ ]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = TILE_HUES[Math.abs(hash) % TILE_HUES.length];

  return (
    <span
      aria-hidden="true"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-control text-xs font-semibold text-[rgb(var(--color-text))]"
      style={{ background: `hsl(${hue} 55% 50% / 0.2)` }}
    >
      {initials || "?"}
    </span>
  );
}

export function RecentWorkspaceList({
  projects,
  onOpen,
  onRemove,
  currentPath,
  currentBranch,
}: {
  projects: RecentProject[];
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  /** The open project's folder, which gets an "Open now" tag. */
  currentPath?: string | null;
  /** The open project's active variation. Recents don't record branches for closed projects. */
  currentBranch?: string | null;
}) {
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

  const menuItems = (path: string): ContextMenuItem[] => [
    { label: "Open", icon: <ExternalLink className="h-3.5 w-3.5" />, action: () => onOpen(path) },
    { label: "Copy path", icon: <Copy className="h-3.5 w-3.5" />, action: () => void navigator.clipboard?.writeText(path) },
    { separator: true },
    { label: "Remove from recent", icon: <X className="h-3.5 w-3.5" />, action: () => onRemove(path) },
  ];

  return (
    <>
      <ul
        aria-label="Recent workspaces"
        className="overflow-hidden rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] shadow-layer"
      >
        {projects.map((p) => {
          const name = workspaceName(p.path);
          const isCurrent = samePath(p.path, currentPath);
          return (
            <li
              key={p.path}
              className="group flex items-center gap-2 border-t border-[rgb(var(--color-border-subtle))] pr-3 transition-colors duration-fast ease-fluent first:border-t-0 hover:bg-fill-pressed"
            >
              <button
                type="button"
                onClick={() => onOpen(p.path)}
                className="flex min-w-0 flex-1 items-center gap-3.5 py-2.5 pl-3.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[rgb(var(--color-accent))]"
                aria-label={`Open ${name} workspace`}
                title={p.path}
              >
                <WorkspaceTile name={name} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold">{name}</span>
                    {isCurrent && (
                      <span className="shrink-0 rounded-pill bg-[rgb(var(--color-accent))]/15 px-1.5 py-px text-2xs font-medium text-[rgb(var(--color-accent))]">
                        Open now
                      </span>
                    )}
                  </span>
                  <span className="mt-px block truncate text-xs text-[rgb(var(--color-text-secondary))]">{p.path}</span>
                </span>
                {isCurrent && currentBranch && (
                  <span className="hidden min-w-0 max-w-[160px] shrink items-center gap-1 text-xs text-[rgb(var(--color-text-secondary))] sm:inline-flex">
                    <GitBranch aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{currentBranch}</span>
                  </span>
                )}
                <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-[rgb(var(--color-text-secondary))]">
                  {formatRelativeDate(p.last_opened)}
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu({ path: p.path, x: rect.left, y: rect.bottom + 4 });
                }}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-control text-[rgb(var(--color-text-secondary))] transition-colors duration-fast hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
                title="More actions"
                aria-label={`More actions for ${name}`}
                aria-haspopup="menu"
                aria-expanded={menu?.path === p.path}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ul>
      {menu && <ContextMenu items={menuItems(menu.path)} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
    </>
  );
}
