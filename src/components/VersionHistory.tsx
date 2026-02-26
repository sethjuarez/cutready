import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { TimelineInfo } from "../types/sketch";

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
  const versions = useAppStore((s) => s.versions);
  const isDirty = useAppStore((s) => s.isDirty);
  const hasStash = useAppStore((s) => s.hasStash);
  const loadVersions = useAppStore((s) => s.loadVersions);
  const saveVersion = useAppStore((s) => s.saveVersion);
  const stashChanges = useAppStore((s) => s.stashChanges);
  const popStash = useAppStore((s) => s.popStash);
  const checkStash = useAppStore((s) => s.checkStash);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const snapshotPromptOpen = useAppStore((s) => s.snapshotPromptOpen);
  const timelines = useAppStore((s) => s.timelines);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const switchTimeline = useAppStore((s) => s.switchTimeline);
  const deleteTimeline = useAppStore((s) => s.deleteTimeline);

  const [labelInput, setLabelInput] = useState("");
  const [showLabelInput, setShowLabelInput] = useState(false);
  const [saving, setSaving] = useState(false);
  // Navigation prompt: when dirty and clicking a different snapshot
  const [pendingNavTarget, setPendingNavTarget] = useState<string | null>(null);
  // Show timeline list expanded
  const [showTimelines, setShowTimelines] = useState(false);

  // Ref to hold pending nav target while label input is open
  const pendingNavRef = useRef<string | null>(null);

  useEffect(() => {
    loadVersions();
    loadTimelines();
    checkStash();
  }, [loadVersions, loadTimelines, checkStash]);

  // React to Ctrl+S prompt trigger
  useEffect(() => {
    if (snapshotPromptOpen) {
      setShowLabelInput(true);
      useAppStore.setState({ snapshotPromptOpen: false });
    }
  }, [snapshotPromptOpen]);

  const handleSave = useCallback(async () => {
    const label = labelInput.trim();
    if (!label) return;
    setSaving(true);
    await saveVersion(label);
    setLabelInput("");
    setShowLabelInput(false);
    setSaving(false);
    // If we were saving before navigating, go there now
    const navTarget = pendingNavRef.current;
    if (navTarget) {
      pendingNavRef.current = null;
      await navigateToSnapshot(navTarget);
    }
  }, [labelInput, saveVersion, navigateToSnapshot]);

  const handleCircleClick = useCallback(async (commitId: string, isHead: boolean) => {
    // Clicking HEAD node — no-op (already there)
    if (isHead) return;

    // If dirty, ask to stash/save first
    const dirty = useAppStore.getState().isDirty;
    if (dirty) {
      setPendingNavTarget(commitId);
      return;
    }

    await navigateToSnapshot(commitId);
  }, [navigateToSnapshot]);

  // Navigation prompt: "Save Snapshot" — save first, then navigate
  const handleNavSave = useCallback(async () => {
    const target = pendingNavTarget;
    if (!target) return;
    setPendingNavTarget(null);
    setShowLabelInput(true);
    pendingNavRef.current = target;
  }, [pendingNavTarget]);

  // Navigation prompt: "Stash & Browse" — stash dirty tree, then navigate
  const handleNavStash = useCallback(async () => {
    const target = pendingNavTarget;
    if (!target) return;
    setPendingNavTarget(null);
    await stashChanges();
    await navigateToSnapshot(target);
  }, [pendingNavTarget, stashChanges, navigateToSnapshot]);

  // Navigation prompt: "Discard & Browse" — just navigate, losing changes
  const handleNavDiscard = useCallback(async () => {
    const target = pendingNavTarget;
    if (!target) return;
    setPendingNavTarget(null);
    await navigateToSnapshot(target);
  }, [pendingNavTarget, navigateToSnapshot]);

  const showDirtyNode = isDirty;
  const activeTimeline = timelines.find((t) => t.is_active);
  const hasMultipleTimelines = timelines.length > 1;

  // Border on the side facing the editor
  const borderClass = sidebarPosition === "left" ? "border-l" : "border-r";

  return (
    <div className={`flex flex-col h-full ${borderClass} border-[var(--color-border)]`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
            Snapshots
          </span>
          {/* Active timeline pill */}
          {activeTimeline && hasMultipleTimelines && (
            <button
              onClick={() => setShowTimelines(!showTimelines)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium transition-colors hover:opacity-80"
              style={{
                backgroundColor: `${laneColor(activeTimeline.color_index)}20`,
                color: laneColor(activeTimeline.color_index),
              }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: laneColor(activeTimeline.color_index) }}
              />
              {activeTimeline.label}
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                className={`transition-transform ${showTimelines ? "rotate-180" : ""}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Stash indicator */}
          {hasStash && (
            <button
              onClick={popStash}
              className="group/stash flex items-center gap-0.5 p-1 rounded text-amber-500 hover:text-amber-400 transition-colors"
              title="You have stashed work — click to restore"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="M21 8V21H3V8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
              <span className="max-w-0 overflow-hidden group-hover/stash:max-w-[6rem] transition-all duration-200 whitespace-nowrap text-[10px]">
                Restore
              </span>
            </button>
          )}
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
      </div>

      {/* Timeline switcher */}
      {showTimelines && hasMultipleTimelines && (
        <div className="px-2 py-1.5 border-b border-[var(--color-border)] space-y-0.5">
          {timelines.map((tl) => (
            <TimelinePill
              key={tl.name}
              timeline={tl}
              onSwitch={() => {
                switchTimeline(tl.name);
                setShowTimelines(false);
              }}
              onDelete={tl.is_active ? undefined : () => deleteTimeline(tl.name)}
            />
          ))}
        </div>
      )}

      {/* Snapshot name input (shown when saving) */}
      {showLabelInput && (
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
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
                  pendingNavRef.current = null;
                }
              }}
              placeholder="Snapshot name..."
              autoFocus
              className="flex-1 min-w-0 px-2 py-1 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
            />
            <button
              onClick={handleSave}
              disabled={!labelInput.trim() || saving}
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
              onClick={handleNavStash}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-text-secondary)] transition-colors"
            >
              Stash &amp; go
            </button>
            <button
              onClick={handleNavDiscard}
              className="px-2 py-1 rounded-md text-[10px] text-[var(--color-text-secondary)] hover:text-red-400 transition-colors"
              title="Discard unsaved changes and navigate"
            >
              Discard
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

      {/* Commit graph */}
      <div className="flex-1 overflow-y-auto">
        {versions.length === 0 && !showDirtyNode ? (
          <div className="px-3 py-8 text-center">
            <div className="text-[var(--color-text-secondary)] text-xs">No snapshots yet</div>
            <div className="text-[var(--color-text-secondary)]/60 text-[10px] mt-1">
              Save a snapshot of the entire project
            </div>
          </div>
        ) : (
          <div className="py-1">
            {/* Dirty / unsaved changes node */}
            {showDirtyNode && (
              <div className="group relative flex" style={{ minHeight: 36 }}>
                <div className="w-8 shrink-0 relative flex items-center justify-center">
                  {versions.length > 0 && (
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

            {/* Committed snapshots */}
            {versions.map((version, idx) => {
              const isHead = idx === 0;
              const isLast = idx === versions.length - 1;
              const isSingle = versions.length === 1 && !showDirtyNode;
              // HEAD is always the active one (no "viewing" concept)
              const isActive = isHead && !showDirtyNode;
              const dotColor = activeTimeline
                ? laneColor(activeTimeline.color_index)
                : "var(--color-accent)";
              return (
                <div key={version.id} className="group relative flex" style={{ minHeight: isHead ? 44 : 36 }}>
                  {/* Graph column */}
                  <div className="w-8 shrink-0 relative flex items-center justify-center">
                    {/* Continuous vertical line */}
                    {!isSingle && (
                      <div
                        className="absolute left-1/2 -translate-x-1/2 w-px"
                        style={{
                          top: (isHead && !showDirtyNode) ? "50%" : 0,
                          bottom: isLast ? "50%" : 0,
                          backgroundColor: dotColor,
                          opacity: 0.3,
                        }}
                      />
                    )}
                    {/* Dot — click to navigate */}
                    <button
                      onClick={() => handleCircleClick(version.id, isHead)}
                      className={`relative z-10 shrink-0 rounded-full border-2 transition-colors ${
                        isHead ? "cursor-default" : "cursor-pointer"
                      }`}
                      style={{
                        width: isActive ? 12 : 10,
                        height: isActive ? 12 : 10,
                        backgroundColor: isActive ? dotColor : "var(--color-surface)",
                        borderColor: isActive ? dotColor : "var(--color-text-secondary)",
                        boxShadow: "0 0 0 2px var(--color-surface)",
                      }}
                      onMouseEnter={(e) => {
                        if (!isHead) {
                          e.currentTarget.style.backgroundColor = dotColor;
                          e.currentTarget.style.borderColor = dotColor;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.backgroundColor = "var(--color-surface)";
                          e.currentTarget.style.borderColor = "var(--color-text-secondary)";
                        }
                      }}
                      title={isHead ? "Current snapshot" : "Navigate to this snapshot"}
                    />
                  </div>

                  {/* Content */}
                  <div className={`flex-1 min-w-0 pr-3 flex flex-col justify-center ${isHead ? "py-2" : "py-1.5"}`}>
                    <div className={`text-xs truncate ${isActive ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-secondary)]"}`}>
                      {version.message}
                    </div>
                    <div className="text-[10px] text-[var(--color-text-secondary)]/70 mt-0.5">
                      {formatRelativeDate(version.timestamp)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** A single timeline pill in the switcher. */
function TimelinePill({
  timeline,
  onSwitch,
  onDelete,
}: {
  timeline: TimelineInfo;
  onSwitch: () => void;
  onDelete?: () => void;
}) {
  const color = laneColor(timeline.color_index);
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors cursor-pointer group ${
        timeline.is_active
          ? "bg-[var(--color-surface-active)]"
          : "hover:bg-[var(--color-surface-hover)]"
      }`}
      onClick={!timeline.is_active ? onSwitch : undefined}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className={`text-[11px] truncate flex-1 ${
        timeline.is_active ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-secondary)]"
      }`}>
        {timeline.label}
      </span>
      <span className="text-[9px] text-[var(--color-text-secondary)]/60 tabular-nums">
        {timeline.snapshot_count}
      </span>
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--color-text-secondary)] hover:text-red-400 transition-all"
          title="Delete timeline"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
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
