import { FolderOpen, X } from "lucide-react";
import type { RecentProject } from "../types/project";
import { formatRelativeDate } from "../utils/relativeDate";

function workspaceName(path: string): string {
  return path.split(/[/\\]/).pop() || "workspace";
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[/\\]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

export function RecentWorkspaceList({
  projects,
  currentPath,
  onOpen,
  onRemove,
}: {
  projects: RecentProject[];
  /** Root of the open workspace, tagged "Open now". */
  currentPath?: string | null;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  return (
    <ul
      aria-label="Recent workspaces"
      className="overflow-hidden rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] shadow-card"
    >
      {projects.map((p) => {
        const name = workspaceName(p.path);
        const isOpen = currentPath ? samePath(currentPath, p.path) : false;
        return (
          <li
            key={p.path}
            className="group grid grid-cols-[minmax(0,1fr)_28px] items-center gap-3.5 border-t border-[rgb(var(--color-border-subtle))] pr-3 transition-colors duration-fast ease-fluent first:border-t-0 hover:bg-fill-pressed"
          >
            <button
              type="button"
              onClick={() => onOpen(p.path)}
              className="grid min-w-0 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3.5 py-2.5 pl-3.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[rgb(var(--color-accent))]"
              aria-label={`Open ${name} workspace`}
              title={p.path}
            >
              <span
                aria-hidden="true"
                className="grid h-9 w-9 place-items-center rounded-control bg-[rgb(var(--color-content-note))]/15 text-[rgb(var(--color-content-note))]"
              >
                <FolderOpen className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                  <span className="truncate">{name}</span>
                  {isOpen && (
                    <span className="inline-flex h-[22px] shrink-0 items-center rounded-control bg-fill-hover px-2 text-xs font-normal text-[rgb(var(--color-text-secondary))]">
                      Open now
                    </span>
                  )}
                </span>
                <span className="mt-px block truncate text-xs text-[rgb(var(--color-text-secondary))]">{p.path}</span>
              </span>
              <span className="whitespace-nowrap text-right text-xs tabular-nums text-[rgb(var(--color-text-secondary))]">
                {formatRelativeDate(p.last_opened)}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onRemove(p.path)}
              className="grid h-7 w-7 place-items-center rounded-control text-[rgb(var(--color-text-secondary))] opacity-0 transition-opacity duration-fast hover:bg-fill-hover hover:text-error focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] group-hover:opacity-100"
              title="Remove from recent"
              aria-label={`Remove ${name} from recent`}
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}