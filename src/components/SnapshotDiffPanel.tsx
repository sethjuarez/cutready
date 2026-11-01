import { useVersioningStore } from "../stores/versioningStore";
import { RotateCcw, X } from "lucide-react";

/**
 * SnapshotDiffPanel — shows file-level changes between two snapshots.
 * Rendered below the graph when a diff is active.
 */
export function SnapshotDiffPanel() {
  const diffResult = useVersioningStore((s) => s.diffResult);
  const diffSelection = useVersioningStore((s) => s.diffSelection);

  if (!diffResult || !diffSelection) return null;

  const totalAdded = diffResult.reduce((s, e) => s + e.additions, 0);
  const totalRemoved = diffResult.reduce((s, e) => s + e.deletions, 0);
  const close = () => useVersioningStore.setState({ diffResult: null, diffSelection: null });
  const title = diffSelection.to === "working" ? "Unsaved changes" : "Snapshot comparison";
  const description = diffSelection.to === "working"
    ? "These files have changed since your last saved snapshot."
    : `This compares ${diffSelection.from.slice(0, 7)} to ${diffSelection.to.slice(0, 7)}.`;

  return (
    <div className="cr-modal-backdrop fixed inset-0 z-modal flex items-center justify-center px-4 py-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshot-diff-title"
        className="cr-modal-surface flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl"
      >
        <div className="flex items-start gap-3 border-b border-[rgb(var(--color-border))] px-4 py-3">
          <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
            <RotateCcw className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="snapshot-diff-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
              {title}
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
              {description}
            </p>
          </div>
          <button
            onClick={close}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[rgb(var(--color-border))] px-4 py-2">
          <div className="min-w-0 truncate text-[10px] font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
            {diffSelection.to === "working"
              ? "Working tree"
              : `${diffSelection.from.slice(0, 7)} -> ${diffSelection.to.slice(0, 7)}`}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[10px] font-medium text-success">+{totalAdded}</span>
            <span className="text-[10px] font-medium text-error">-{totalRemoved}</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {diffResult.map((entry) => (
            <div key={entry.path} className="flex items-center gap-2 px-4 py-1.5 text-[11px] hover:bg-[rgb(var(--color-surface-alt))]">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                entry.status === "added" ? "bg-success" :
                entry.status === "deleted" ? "bg-error" :
                "bg-warning"
              }`} />
              <span className="min-w-0 flex-1 truncate text-[rgb(var(--color-text))]">{entry.path}</span>
              {entry.additions > 0 && <span className="shrink-0 text-[10px] text-success">+{entry.additions}</span>}
              {entry.deletions > 0 && <span className="shrink-0 text-[10px] text-error">-{entry.deletions}</span>}
            </div>
          ))}
          {diffResult.length === 0 && (
            <div className="px-4 py-8 text-center text-[11px] text-[rgb(var(--color-text-secondary))]">
              {diffSelection.to === "working" ? "No unsaved changes" : "No changes between these snapshots"}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--color-border))] px-4 py-3">
          <button
            onClick={close}
            className="rounded-lg px-3 py-1.5 text-[11px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
