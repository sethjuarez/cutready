import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";

/** Palette of lane colours for timelines. */
const LANE_COLORS = [
  "var(--color-accent)",      // purple — main
  "#10b981",                  // emerald
  "#f59e0b",                  // amber
  "#ef4444",                  // red
  "#3b82f6",                  // blue
  "#ec4899",                  // pink
  "#14b8a6",                  // teal
  "#8b5cf6",                  // violet
];

function laneColor(index: number) {
  return LANE_COLORS[index % LANE_COLORS.length];
}

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
    // If forking, require a timeline name
    const forkLabel = isRewound ? forkLabelInput.trim() || undefined : undefined;
    if (isRewound && !forkLabel) return;
    setSaving(true);
    await saveVersion(label, forkLabel);
    setLabelInput("");
    setForkLabelInput("");
    setShowLabelInput(false);
    setSaving(false);
    const navTarget = pendingNavRef.current;
    if (navTarget) {
      pendingNavRef.current = null;
      await navigateToSnapshot(navTarget);
    }
  }, [labelInput, forkLabelInput, isRewound, saveVersion, navigateToSnapshot]);

  const handleNodeClick = useCallback(async (commitId: string, isHead: boolean) => {
    if (isHead) return;
    const dirty = useAppStore.getState().isDirty;
    if (dirty) {
      setPendingNavTarget(commitId);
      return;
    }
    await navigateToSnapshot(commitId);
  }, [navigateToSnapshot]);

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
  }, [pendingNavTarget, navigateToSnapshot]);

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
        {graphNodes.length === 0 && !isDirty ? (
          <div className="px-3 py-8 text-center">
            <div className="text-[var(--color-text-secondary)] text-xs">No snapshots yet</div>
            <div className="text-[var(--color-text-secondary)]/60 text-[10px] mt-1">
              Save a snapshot of the entire project
            </div>
          </div>
        ) : (
          <div className="py-1">
            {/* Dirty indicator at top — only when NOT rewound (linear unsaved changes) */}
            {isDirty && !isRewound && (
              <div className="group relative flex" style={{ minHeight: 36 }}>
                <div className="w-8 shrink-0 relative flex items-center justify-center">
                  {graphNodes.length > 0 && (
                    <div
                      className="absolute left-1/2 -translate-x-1/2 w-px border-l border-dashed border-[var(--color-text-secondary)]/30"
                      style={{ top: "50%", bottom: 0 }}
                    />
                  )}
                  <div
                    className="relative z-10 shrink-0 w-2.5 h-2.5 rounded-full border-2 border-dashed border-[var(--color-text-secondary)]/60 bg-[var(--color-surface)]"
                    style={{ boxShadow: "0 0 0 2px var(--color-surface)" }}
                  />
                </div>
                <div className="flex-1 min-w-0 pr-3 flex items-center py-1.5">
                  <span className="text-xs italic text-[var(--color-text-secondary)]">
                    Unsaved changes
                  </span>
                </div>
              </div>
            )}

            {/* All graph nodes — ghost branch node inserted after HEAD when rewound + dirty */}
            {graphNodes.flatMap((node, idx) => {
              const isFirst = idx === 0;
              const isLast = idx === graphNodes.length - 1;
              const isSingle = graphNodes.length === 1 && !(isDirty && !isRewound);
              const dotColor = laneColor(node.lane);
              const tlInfo = timelineMap.get(node.timeline);
              const tlLabel = tlInfo?.label ?? node.timeline;
              const hasMultipleTimelines = timelines.length > 1;
              const showGhostAfter = node.is_head && isRewound && isDirty;

              const elements = [(
                <div key={node.id} className="group relative flex" style={{ minHeight: node.is_head ? 44 : 36 }}>
                  {/* Graph column */}
                  <div className="w-8 shrink-0 relative flex items-center justify-center">
                    {!isSingle && (
                      <div
                        className="absolute left-1/2 -translate-x-1/2 w-px"
                        style={{
                          top: (isFirst && !(isDirty && !isRewound)) ? "50%" : 0,
                          bottom: isLast ? "50%" : 0,
                          backgroundColor: dotColor,
                          opacity: 0.3,
                        }}
                      />
                    )}
                    <button
                      onClick={() => handleNodeClick(node.id, node.is_head)}
                      className={`relative z-10 shrink-0 rounded-full border-2 transition-colors ${
                        node.is_head ? "cursor-default" : "cursor-pointer"
                      }`}
                      style={{
                        width: node.is_head ? 12 : 10,
                        height: node.is_head ? 12 : 10,
                        backgroundColor: node.is_head ? dotColor : "var(--color-surface)",
                        borderColor: node.is_head ? dotColor : dotColor,
                        boxShadow: node.is_head
                          ? `0 0 0 2px var(--color-surface), 0 0 0 4px ${dotColor}40`
                          : "0 0 0 2px var(--color-surface)",
                      }}
                      onMouseEnter={(e) => {
                        if (!node.is_head) {
                          e.currentTarget.style.backgroundColor = dotColor;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!node.is_head) {
                          e.currentTarget.style.backgroundColor = "var(--color-surface)";
                        }
                      }}
                      title={node.is_head ? "Current snapshot (HEAD)" : `Navigate to: ${node.message}`}
                    />
                  </div>

                  {/* Content */}
                  <div className={`flex-1 min-w-0 pr-3 flex flex-col justify-center ${node.is_head ? "py-2" : "py-1.5"}`}>
                    <div className={`text-xs truncate ${node.is_head ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-secondary)]"}`}>
                      {node.message}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-[var(--color-text-secondary)]/70">
                        {formatRelativeDate(node.timestamp)}
                      </span>
                      {hasMultipleTimelines && (
                        <span
                          className="text-[9px] px-1 py-px rounded-sm"
                          style={{
                            color: dotColor,
                            backgroundColor: `${dotColor}15`,
                          }}
                        >
                          {tlLabel}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )];

              // Insert ghost branch node right after the HEAD node when rewound + dirty
              if (showGhostAfter) {
                elements.push(
                  <div key="ghost-branch" className="group relative flex" style={{ minHeight: 32 }}>
                    <div className="w-8 shrink-0 relative flex items-center justify-center">
                      <div
                        className="absolute left-1/2 -translate-x-1/2 w-px border-l border-dashed"
                        style={{ top: 0, bottom: "50%", borderColor: `${dotColor}50` }}
                      />
                    </div>
                    <div className="flex-1 min-w-0 pr-3 flex items-center py-1">
                      <div
                        className="shrink-0 w-2 h-2 rounded-full border-[1.5px] border-dashed mr-1.5"
                        style={{ borderColor: dotColor, opacity: 0.6 }}
                      />
                      <span className="text-[11px] italic text-[var(--color-text-secondary)]">
                        New direction
                      </span>
                      <span className="ml-1.5 text-[9px] px-1 py-px rounded-sm bg-amber-500/10 text-amber-500">
                        branching
                      </span>
                    </div>
                  </div>
                );
              }

              return elements;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelativeDate(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
