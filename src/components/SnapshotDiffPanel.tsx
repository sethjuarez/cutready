import { useAppStore } from "../stores/appStore";

/**
 * SnapshotDiffPanel — shows file-level changes between two snapshots.
 * Rendered below the graph when a diff is active.
 */
export function SnapshotDiffPanel() {
  const diffResult = useAppStore((s) => s.diffResult);
  const diffSelection = useAppStore((s) => s.diffSelection);
  const restoreSnapshotAsNewSave = useAppStore((s) => s.restoreSnapshotAsNewSave);

  if (!diffResult || !diffSelection) return null;

  const totalAdded = diffResult.reduce((s, e) => s + e.additions, 0);
  const totalRemoved = diffResult.reduce((s, e) => s + e.deletions, 0);
  const canRestorePreview = diffSelection.to === "preview";
  const restoreLabel = `Restore ${diffSelection.from.slice(0, 7)}`;

  return (
    <div className="border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">
          {diffSelection.to === "working"
            ? "Unsaved changes"
            : `Diff: ${diffSelection.from.slice(0, 7)} → ${diffSelection.to.slice(0, 7)}`}
        </span>
        <div className="flex items-center gap-2">
          {canRestorePreview && (
            <button
              data-testid="restore-snapshot-as-new-save"
              onClick={() => void restoreSnapshotAsNewSave(diffSelection.from, restoreLabel)}
              className="rounded px-2 py-0.5 text-[10px] font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
            >
              Restore as new save
            </button>
          )}
          <span className="text-[10px] text-success">+{totalAdded}</span>
          <span className="text-[10px] text-error">-{totalRemoved}</span>
          <button
            onClick={() => useAppStore.setState({ diffResult: null, diffSelection: null })}
            className="text-[10px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
          >✕</button>
        </div>
      </div>
      <div className="max-h-40 overflow-y-auto">
        {diffResult.map((entry) => (
          <div key={entry.path} className="flex items-center gap-2 px-3 py-1 text-[10px] hover:bg-[rgb(var(--color-border))]/20">
            <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${
              entry.status === "added" ? "bg-success" :
              entry.status === "deleted" ? "bg-error" :
              "bg-warning"
            }`} />
            <span className="flex-1 truncate text-[rgb(var(--color-text))]">{entry.path}</span>
            {entry.additions > 0 && <span className="text-success">+{entry.additions}</span>}
            {entry.deletions > 0 && <span className="text-error">-{entry.deletions}</span>}
          </div>
        ))}
        {diffResult.length === 0 && (
          <div className="px-3 py-4 text-center text-[10px] text-[rgb(var(--color-text-secondary))]">
            {diffSelection.to === "working" ? "No unsaved changes" : "No changes between these snapshots"}
          </div>
        )}
      </div>
    </div>
  );
}
