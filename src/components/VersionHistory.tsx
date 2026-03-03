import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { SnapshotGraph } from "./SnapshotGraph";

export function VersionHistory() {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const isDirty = useAppStore((s) => s.isDirty);
  const isRewound = useAppStore((s) => s.isRewound);
  const checkDirty = useAppStore((s) => s.checkDirty);
  const checkRewound = useAppStore((s) => s.checkRewound);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const discardChanges = useAppStore((s) => s.discardChanges);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const timelines = useAppStore((s) => s.timelines);
  const loadTimelines = useAppStore((s) => s.loadTimelines);

  const [pendingNavTarget, setPendingNavTarget] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // Build a label map: timeline name → { label, color_index }
  const timelineMap = new Map(
    timelines.map((t) => [t.name, { label: t.label, colorIndex: t.color_index }])
  );

  useEffect(() => {
    loadGraphData();
    loadTimelines();
    checkDirty();
    checkRewound();
  }, [loadGraphData, loadTimelines, checkDirty, checkRewound]);

  const handleNodeClick = useCallback(async (commitId: string, isHead: boolean) => {
    if (isHead) return;
    const dirty = useAppStore.getState().isDirty;
    if (dirty) {
      setPendingNavTarget(commitId);
      return;
    }
    await navigateToSnapshot(commitId);
    // Force full refresh after navigation
    await loadGraphData();
    await loadTimelines();
  }, [navigateToSnapshot, loadGraphData, loadTimelines]);

  const handleNavSave = useCallback(async () => {
    const target = pendingNavTarget;
    if (!target) return;
    setPendingNavTarget(null);
    useAppStore.setState({ pendingNavAfterSave: target, snapshotPromptOpen: true });
  }, [pendingNavTarget]);

  const handleNavDiscard = useCallback(async () => {
    const target = pendingNavTarget;
    if (!target) return;
    setPendingNavTarget(null);
    await navigateToSnapshot(target);
    await loadGraphData();
    await loadTimelines();
  }, [pendingNavTarget, navigateToSnapshot, loadGraphData, loadTimelines]);

  const handleDiscard = useCallback(async () => {
    setDiscarding(true);
    await discardChanges();
    setConfirmDiscard(false);
    setDiscarding(false);
    await loadGraphData();
    await loadTimelines();
  }, [discardChanges, loadGraphData, loadTimelines]);

  const borderClass = sidebarPosition === "left" ? "border-l" : "border-r";

  return (
    <div className={`flex flex-col h-full ${borderClass} border-[var(--color-border)]`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Snapshots
        </span>
        <div className="flex items-center gap-0.5">
          {isDirty && !pendingNavTarget && (
            <button
              onClick={() => setConfirmDiscard(true)}
              className="group/btn flex items-center gap-1 p-1 rounded text-[var(--color-text-secondary)] hover:text-red-400 transition-colors"
              title="Discard changes"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              <span className="max-w-0 overflow-hidden group-hover/btn:max-w-[10rem] transition-all duration-200 whitespace-nowrap text-[10px]">
                Discard
              </span>
            </button>
          )}
          <button
            onClick={() => useAppStore.setState({ snapshotPromptOpen: true })}
            className="group/btn flex items-center gap-1 p-1 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
            title="Save Project Snapshot (Ctrl+S)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            <span className="max-w-0 overflow-hidden group-hover/btn:max-w-[10rem] transition-all duration-200 whitespace-nowrap text-[10px]">
              Save
            </span>
          </button>
        </div>
      </div>

      {/* Discard confirmation */}
      {confirmDiscard && (
        <div className="px-3 py-2 border-b border-red-500/20 bg-red-500/5">
          <div className="text-[10px] font-medium text-red-500 dark:text-red-400 mb-1.5">
            Discard all changes since last snapshot?
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleDiscard}
              disabled={discarding}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium text-white bg-red-500 hover:bg-red-600 disabled:opacity-40 transition-colors"
            >
              {discarding ? "Discarding..." : "Discard"}
            </button>
            <button
              onClick={() => setConfirmDiscard(false)}
              className="px-2 py-1 rounded-md text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Navigation prompt: dirty + clicking a different snapshot */}
      {pendingNavTarget && (
        <div className="px-3 py-2 border-b border-amber-500/20 bg-amber-500/5">
          <div className="text-[10px] font-medium text-amber-600 dark:text-amber-400 mb-1.5">
            You have unsaved changes
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleNavSave}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
            >
              Save snapshot
            </button>
            <button
              onClick={handleNavDiscard}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium text-[var(--color-text-secondary)] hover:text-red-400 border border-[var(--color-border)] hover:border-red-400/30 transition-colors"
            >
              Discard changes
            </button>
            <button
              onClick={() => setPendingNavTarget(null)}
              className="px-2 py-1 rounded-md text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Unified graph — all timelines */}
      <div className="flex-1 overflow-y-auto">
        <div className="py-1">
          <SnapshotGraph
            nodes={graphNodes}
            isDirty={isDirty}
            isRewound={isRewound}
            timelineMap={timelineMap}
            hasMultipleTimelines={timelines.length > 1}
            onNodeClick={handleNodeClick}
          />
        </div>
      </div>
    </div>
  );
}
