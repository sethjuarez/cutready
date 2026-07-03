import { useAppStore } from "../stores/appStore";
import { RotateCcw, X } from "lucide-react";
import { useConfirmDialog } from "./ConfirmDialog";

/**
 * SnapshotDiffPanel — shows file-level changes between two snapshots.
 * Rendered below the graph when a diff is active.
 */
export function SnapshotDiffPanel() {
  const diffResult = useAppStore((s) => s.diffResult);
  const diffSelection = useAppStore((s) => s.diffSelection);
  const restoreSnapshotAsNewSave = useAppStore((s) => s.restoreSnapshotAsNewSave);
  const { confirm, confirmationDialog } = useConfirmDialog();

  if (!diffResult || !diffSelection) return null;

  const totalAdded = diffResult.reduce((s, e) => s + e.additions, 0);
  const totalRemoved = diffResult.reduce((s, e) => s + e.deletions, 0);
  const canRestorePreview = diffSelection.to === "preview";
  const restoreLabel = `Restore ${diffSelection.from.slice(0, 7)}`;
  const close = () => useAppStore.setState({ diffResult: null, diffSelection: null });
  const title = diffSelection.to === "working"
    ? "Unsaved changes"
    : canRestorePreview
      ? "Snapshot preview"
      : "Snapshot comparison";
  const description = diffSelection.to === "working"
    ? "These files have changed since your last saved snapshot."
    : canRestorePreview
      ? "This shows what would change if you restore the selected snapshot as a new save. Your current history is preserved; CutReady creates a new save with the older contents instead of deleting later saves."
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
          {canRestorePreview && (
            <button
              data-testid="restore-snapshot-as-new-save"
              onClick={async () => {
                const confirmed = await confirm({
                  title: "Restore this snapshot?",
                  message: "CutReady will create a new save with the selected snapshot contents. Your history is preserved, but your current workspace will change.",
                  confirmLabel: "Restore as new save",
                  variant: "warning",
                });
                if (confirmed) await restoreSnapshotAsNewSave(diffSelection.from, restoreLabel);
              }}
              className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-1.5 text-[11px] font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
            >
              Restore as new save
            </button>
          )}
        </div>
        {confirmationDialog}
      </div>
    </div>
  );
}
