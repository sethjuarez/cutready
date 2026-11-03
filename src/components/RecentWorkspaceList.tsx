import { X } from "lucide-react";
import type { RecentProject } from "../types/project";
import { formatRelativeDate } from "../utils/relativeDate";

const TILE_HUES = [260, 200, 330, 170, 20, 45];

function workspaceName(path: string): string {
  return path.split(/[/\\]/).pop() || "workspace";
}

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
}: {
  projects: RecentProject[];
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  return (
    <ul
      aria-label="Recent workspaces"
      className="overflow-hidden rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] shadow-layer"
    >
      {projects.map((p) => {
        const name = workspaceName(p.path);
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
                <span className="block truncate text-sm font-semibold">{name}</span>
                <span className="mt-px block truncate text-xs text-[rgb(var(--color-text-secondary))]">{p.path}</span>
              </span>
              <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-[rgb(var(--color-text-secondary))]">
                {formatRelativeDate(p.last_opened)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onRemove(p.path)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-control text-[rgb(var(--color-text-secondary))] opacity-0 transition-opacity duration-fast hover:bg-fill-hover hover:text-error focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] group-hover:opacity-100"
              title="Remove from recent"
              aria-label={`Remove ${name} from recent`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
