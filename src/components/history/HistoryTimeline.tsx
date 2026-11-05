import { useRef } from "react";
import { CloudOff, CloudUpload } from "lucide-react";
import type { TimelineEntry } from "../../domain/history/timeline";
import { formatRelativeDate } from "../../utils/relativeDate";
import { ChangeChips } from "../versioning/ChangeChips";
import { UnsavedEntry } from "./UnsavedEntry";
import { useVersionChips } from "./useVersionChips";

function entryTime(entry: TimelineEntry): string {
  return formatRelativeDate(new Date(entry.timeSeconds * 1000).toISOString());
}

function SentMarker({ sent }: { sent: boolean | null }) {
  if (sent === null) return null;
  const Icon = sent ? CloudUpload : CloudOff;
  return (
    <span className="inline-flex items-center gap-1 text-2xs text-[rgb(var(--color-text-secondary))]" data-sent={sent}>
      <Icon className="h-3 w-3" aria-hidden />
      {sent ? "Sent" : "Not sent"}
    </span>
  );
}

function TimelineEntryRow({ entry, onPreview }: { entry: TimelineEntry; onPreview: (id: string) => void }) {
  const ref = useRef<HTMLLIElement>(null);
  const chips = useVersionChips(ref, entry.id, entry.parentId);
  return (
    <li ref={ref} className="relative pl-6" data-testid="history-entry" data-version-id={entry.id}>
      <span
        aria-hidden
        className={`absolute left-[5px] top-3 h-2.5 w-2.5 rounded-full border-2 ${
          entry.isCurrent
            ? "border-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]"
            : "border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]"
        }`}
      />
      <button
        type="button"
        onClick={() => onPreview(entry.id)}
        className="block w-full min-w-0 rounded-control px-2 py-1.5 text-left hover:bg-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
        aria-current={entry.isCurrent ? "true" : undefined}
      >
        <span className="sr-only">{entry.isCurrent ? "Current version, preview: " : "Preview version: "}</span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[rgb(var(--color-text))]">{entry.name}</span>
          <span className="shrink-0 text-xs text-[rgb(var(--color-text-secondary))]">{entryTime(entry)}</span>
        </span>
        {entry.comment && (
          <span className="block truncate text-xs text-[rgb(var(--color-text-secondary))]" data-testid="history-entry-comment">{entry.comment}</span>
        )}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[rgb(var(--color-text-secondary))]">
          <span>{entry.author}</span>
          <SentMarker sent={entry.sent} />
        </span>
        {chips && chips.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1" data-testid="history-entry-chips">
            <ChangeChips chips={chips} />
          </span>
        )}
      </button>
    </li>
  );
}

/** Vertical list of the current timeline's versions, newest first. */
export function HistoryTimeline({ entries, onPreview, showUnsaved = true }: {
  entries: TimelineEntry[];
  onPreview: (id: string) => void;
  /** Hidden while searching, since unsaved work has no name or comment to match. */
  showUnsaved?: boolean;
}) {
  return (
    <ol aria-label="Versions" className="relative mx-auto max-w-3xl space-y-1 px-4 py-4 before:absolute before:bottom-4 before:left-[25px] before:top-4 before:w-px before:bg-[rgb(var(--color-border-subtle))]">
      {showUnsaved && <UnsavedEntry />}
      {entries.map((entry) => <TimelineEntryRow key={entry.id} entry={entry} onPreview={onPreview} />)}
    </ol>
  );
}
