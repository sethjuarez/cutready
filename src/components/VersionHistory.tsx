import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { SnapshotGraph } from "./SnapshotGraph";

export function VersionHistory() {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const isDirty = useAppStore((s) => s.isDirty);
  const isRewound = useAppStore((s) => s.isRewound);
  const saveVersion = useAppStore((s) => s.saveVersion);
  const checkDirty = useAppStore((s) => s.checkDirty);
  const checkRewound = useAppStore((s) => s.checkRewound);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const snapshotPromptOpen = useAppStore((s) => s.snapshotPromptOpen);
  const timelines = useAppStore((s) => s.timelines);
  const loadTimelines = useAppStore((s) => s.loadTimelines);

  const [labelInput, setLabelInput] = useState("");
  const [forkLabelInput, setForkLabelInput] = useState("");
  const [showLabelInput, setShowLabelInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingNavTarget, setPendingNavTarget] = useState<string | null>(null);

  const pendingNavRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (snapshotPromptOpen) {
      setShowLabelInput(true);
      useAppStore.setState({ snapshotPromptOpen: false });
    }
  }, [snapshotPromptOpen]);

  // Whether this save will create a fork (rewound + saving new work)
  const willFork = isRewound && showLabelInput;

  const handleSave = useCallback(async () => {
    const label = labelInput.trim();
    if (!label) return;
    const forkLabel = isRewound ? forkLabelInput.trim() || undefined : undefined;
    if (isRewound && !forkLabel) return;
    setSaving(true);
    await saveVersion(label, forkLabel);
    setLabelInput("");
    setForkLabelInput("");
    setShowLabelInput(false);
    setSaving(false);
    // Force full refresh
    await loadGraphData();
    await loadTimelines();
    const navTarget = pendingNavRef.current;
    if (navTarget) {
      pendingNavRef.current = null;
      await navigateToSnapshot(navTarget);
      await loadGraphData();
      await loadTimelines();
    }
  }, [labelInput, forkLabelInput, isRewound, saveVersion, navigateToSnapshot, loadGraphData, loadTimelines]);

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
    setShowLabelInput(true);
    pendingNavRef.current = target;
  }, [pendingNavTarget]);

  const handleNavDiscard = useCallback(async () => {
    const target = pendingNavTarget;
    if (!target) return;
    setPendingNavTarget(null);
    await navigateToSnapshot(target);
    await loadGraphData();
    await loadTimelines();
  }, [pendingNavTarget, navigateToSnapshot, loadGraphData, loadTimelines]);

  const borderClass = sidebarPosition === "left" ? "border-l" : "border-r";

  return (
    <div className={`flex flex-col h-full ${borderClass} border-[var(--color-border)]`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Snapshots
        </span>
        <button
          onClick={() => setShowLabelInput(true)}
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

      {/* Save dialog — snapshot name + optional fork/timeline name */}
      {showLabelInput && (
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
          {willFork && (
            <div className="mb-2">
              <div className="flex items-center gap-1.5 mb-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 shrink-0">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  You're starting a new direction
                </span>
              </div>
              <input
                type="text"
                value={forkLabelInput}
                onChange={(e) => setForkLabelInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setShowLabelInput(false);
                    setLabelInput("");
                    setForkLabelInput("");
                    pendingNavRef.current = null;
                  }
                }}
                placeholder="Name this line of thinking..."
                autoFocus
                className="w-full px-2 py-1 rounded-md bg-[var(--color-surface)] border border-amber-500/30 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
              />
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              type="text"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") {
                  setShowLabelInput(false);
                  setLabelInput("");
                  setForkLabelInput("");
                  pendingNavRef.current = null;
                }
              }}
              placeholder="Snapshot name..."
              autoFocus={!willFork}
              className="flex-1 min-w-0 px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
            />
            <button
              onClick={handleSave}
              disabled={!labelInput.trim() || (isRewound && !forkLabelInput.trim()) || saving}
              className="px-2 py-1 rounded-md text-xs font-medium bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors"
            >
              {saving ? "..." : "Save"}
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
