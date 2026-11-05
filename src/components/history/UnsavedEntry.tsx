import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { summaryChips, type SummaryChip } from "../../domain/changes";
import { loadWorkspaceChangeSummary } from "../../services/workspaceChangeSummary";
import { useChangeSummaryStore } from "../../stores/changeSummaryStore";
import { useVersioningStore } from "../../stores/versioningStore";
import { ChangeChips } from "../versioning/ChangeChips";

/** The "Unsaved changes" entry at the top of the timeline, shown while the workspace has unsaved work. */
export function UnsavedEntry() {
  const isDirty = useVersioningStore((s) => s.isDirty);
  const changedFiles = useVersioningStore((s) => s.changedFiles);
  const openForSave = useChangeSummaryStore((s) => s.openForSave);
  const [chips, setChips] = useState<SummaryChip[]>([]);

  useEffect(() => {
    setChips([]);
    if (!isDirty) return;
    let cancelled = false;
    loadWorkspaceChangeSummary()
      .then((summary) => { if (!cancelled) setChips(summaryChips(summary.totals)); })
      .catch(() => { if (!cancelled) setChips([]); });
    return () => { cancelled = true; };
  }, [isDirty, changedFiles]);

  if (!isDirty) return null;
  return (
    <li className="relative pl-6" data-testid="history-unsaved-entry">
      <span aria-hidden className="absolute left-[5px] top-3 h-2.5 w-2.5 rounded-full border-2 border-dashed border-warning bg-[rgb(var(--color-surface))]" />
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-control px-2 py-1.5">
        <span className="text-sm font-medium text-[rgb(var(--color-text))]">Unsaved changes</span>
        <ChangeChips chips={chips} />
        <button
          type="button"
          onClick={openForSave}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-control bg-[rgb(var(--color-accent))] px-2.5 text-xs font-medium text-[rgb(var(--color-accent-fg))] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] focus-visible:ring-offset-1"
        >
          <Save className="h-3.5 w-3.5" aria-hidden /> Save version
        </button>
      </div>
    </li>
  );
}
