import { useState } from "react";
import { Check, GitMerge, Pencil, Trash2 } from "lucide-react";
import { timelineNameProblem } from "../../domain/versioning";
import type { TimelineInfo } from "../../types/sketch";

export const menuRowClass =
  "group flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs transition-colors duration-fast hover:bg-fill-hover focus-visible:bg-fill-hover focus-visible:outline-none";
const iconButtonClass =
  "grid h-5 w-5 shrink-0 place-items-center rounded text-[rgb(var(--color-text-secondary))] opacity-0 hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] group-hover:opacity-100 group-focus-within:opacity-100";
export const menuInputClass =
  "w-full rounded-control border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 py-1 text-xs text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))] focus:border-[rgb(var(--color-accent))]";

interface TimelineRowsProps {
  timelines: TimelineInfo[];
  all: readonly TimelineInfo[];
  onSwitch: (timeline: TimelineInfo) => void;
  onRename: (timeline: TimelineInfo, to: string) => Promise<boolean>;
  onDelete: (timeline: TimelineInfo) => void;
  /** Merge this timeline into the current one. */
  onMerge: (timeline: TimelineInfo) => void;
}

/** Local timelines: switch on click; merge, rename and delete on hover. */
export function TimelineRows({ timelines, all, onSwitch, onRename, onDelete, onMerge }: TimelineRowsProps) {
  const current = all.find((timeline) => timeline.is_active);
  const currentLabel = current ? current.label || current.name : "the current timeline";
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const problem = renaming ? timelineNameProblem(draft, all, renaming) : null;

  const commit = async (timeline: TimelineInfo) => {
    const to = draft.trim();
    if (problem) return;
    if (to === timeline.name || await onRename(timeline, to)) setRenaming(null);
  };

  return (
    <ul className="py-1" aria-label="Timelines">
      {timelines.map((timeline) => {
        const label = timeline.label || timeline.name;
        if (renaming === timeline.name) {
          return (
            <li key={timeline.name} className="px-2 py-1">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void commit(timeline);
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setRenaming(null);
                  }
                }}
                aria-label={`Rename ${label}`}
                aria-invalid={!!problem}
                className={menuInputClass}
                autoFocus
              />
              {problem && draft.trim() && <p className="mt-1 text-2xs text-error">{problem}</p>}
            </li>
          );
        }
        return (
          <li key={timeline.name} className="group flex items-center gap-0.5 pr-1">
            <button
              type="button"
              onClick={() => onSwitch(timeline)}
              aria-current={timeline.is_active ? "true" : undefined}
              aria-label={timeline.is_active ? `${label} (current timeline)` : `Switch to timeline ${label}`}
              className={`${menuRowClass} ${timeline.is_active ? "font-medium text-[rgb(var(--color-accent))]" : "text-[rgb(var(--color-text))]"}`}
            >
              <span className="grid w-3 shrink-0 place-items-center">
                {timeline.is_active
                  ? <Check className="h-3 w-3" aria-hidden="true" />
                  : <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--color-text-secondary))]/40" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="shrink-0 text-2xs tabular-nums text-[rgb(var(--color-text-secondary))]">
                {timeline.snapshot_count} {timeline.snapshot_count === 1 ? "version" : "versions"}
              </span>
            </button>
            {!timeline.is_active && (
              <button
                type="button"
                className={iconButtonClass}
                onClick={() => onMerge(timeline)}
                aria-label={`Merge ${label} into ${currentLabel}`}
                title={`Merge into ${currentLabel}`}
              >
                <GitMerge className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className={iconButtonClass}
              onClick={() => {
                setDraft(timeline.name);
                setRenaming(timeline.name);
              }}
              aria-label={`Rename timeline ${label}`}
              title="Rename"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" />
            </button>
            {!timeline.is_active && (
              <button
                type="button"
                className={iconButtonClass}
                onClick={() => onDelete(timeline)}
                aria-label={`Delete timeline ${label}`}
                title="Delete"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
