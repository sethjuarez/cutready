import { firstParentTimelineNodes } from "../../utils/timelineNodes";
import { formatRelativeDate } from "../../utils/relativeDate";
import { useAppStore } from "../../stores/appStore";
import { useVersioningStore } from "../../stores/versioningStore";

/** The last three versions, each opening a preview, plus "Open history". */
export function RecentVersions({ onNavigate }: { onNavigate: () => void }) {
  const graphNodes = useVersioningStore((s) => s.graphNodes);
  const openSnapshotPreview = useVersioningStore((s) => s.openSnapshotPreview);
  const openTab = useAppStore((s) => s.openTab);
  const recent = firstParentTimelineNodes(graphNodes).slice(0, 3);

  return (
    <div className="border-t border-[rgb(var(--color-border-subtle))] px-3 py-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-2xs font-medium text-[rgb(var(--color-text-secondary))]">Recent versions</span>
        <button
          type="button"
          onClick={() => {
            onNavigate();
            openTab({ type: "history", path: "__history__", title: "History Graph" });
          }}
          className="rounded-control px-1 text-2xs font-medium text-[rgb(var(--color-accent))] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
          data-testid="open-history"
        >
          Open history →
        </button>
      </div>
      {recent.length === 0 ? (
        <p className="text-2xs text-[rgb(var(--color-text-secondary))]">No versions yet.</p>
      ) : (
        <ul aria-label="Recent versions">
          {recent.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => {
                  onNavigate();
                  void openSnapshotPreview(node.id);
                }}
                className="flex w-full min-w-0 items-baseline gap-2 rounded-control px-1.5 py-1 text-left hover:bg-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
                title={node.comment ? `Preview “${node.message.split(/\r?\n/, 1)[0]}”\n\n${node.comment}` : `Preview “${node.message}”`}
                aria-label={`Preview version: ${node.message.split(/\r?\n/, 1)[0]}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-[rgb(var(--color-text))]">{node.message.split(/\r?\n/, 1)[0]}</span>
                  {node.comment && (
                    <span className="block truncate text-2xs text-[rgb(var(--color-text-secondary))]" data-testid="recent-version-comment">{node.comment}</span>
                  )}
                </span>
                <span className="shrink-0 text-2xs text-[rgb(var(--color-text-secondary))]">{formatRelativeDate(node.timestamp)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
