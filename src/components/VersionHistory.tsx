import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { SnapshotGraph } from "./SnapshotGraph";
import { SnapshotDiffPanel } from "./SnapshotDiffPanel";
import { SyncBar } from "./SyncBar";
import { TimelineSelector } from "./TimelineSelector";
import { RefreshCw, Search, Clock, Download } from "lucide-react";

export function VersionHistory() {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const isDirty = useAppStore((s) => s.isDirty);
  const isRewound = useAppStore((s) => s.isRewound);
  const checkDirty = useAppStore((s) => s.checkDirty);
  const openTab = useAppStore((s) => s.openTab);
  const checkRewound = useAppStore((s) => s.checkRewound);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const discardChanges = useAppStore((s) => s.discardChanges);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const timelines = useAppStore((s) => s.timelines);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const currentRemote = useAppStore((s) => s.currentRemote);
  const saving = useAppStore((s) => s.saving);
  const hasRemote = !!currentRemote;

  const [pendingNavTarget, setPendingNavTarget] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  // Show active branch + its ancestor history from the originating branch
  const activeTimeline = timelines.find((t) => t.is_active);
  const activeNodes = (() => {
    if (!activeTimeline) return graphNodes;
    const branchNodes = graphNodes.filter((n) => n.timeline === activeTimeline.name);
    const nodeMap = new Map(graphNodes.map((n) => [n.id, n]));
    const branchIds = new Set(branchNodes.map((n) => n.id));

    // Walk parent chain from fork points to collect ancestor commits
    const ancestorIds = new Set<string>();
    const frontier: string[] = [];
    for (const n of branchNodes) {
      for (const pid of n.parents) {
        if (!branchIds.has(pid) && nodeMap.has(pid)) frontier.push(pid);
      }
    }
    while (frontier.length > 0) {
      const id = frontier.pop()!;
      if (ancestorIds.has(id)) continue;
      ancestorIds.add(id);
      const node = nodeMap.get(id);
      if (node) {
        for (const pid of node.parents) {
          if (!ancestorIds.has(pid) && nodeMap.has(pid)) frontier.push(pid);
        }
      }
    }

    const ancestors = graphNodes.filter((n) => ancestorIds.has(n.id));
    return [...branchNodes, ...ancestors];
  })();

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
    <div className={`flex flex-col h-full ${borderClass} border-[rgb(var(--color-border))]`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[rgb(var(--color-border))]">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">
            Snapshots
          </span>
          {timelines.length > 1 && <TimelineSelector />}
        </div>
        <div className="flex items-center gap-0.5">
          {isDirty && !pendingNavTarget && (
            <button
              onClick={() => setConfirmDiscard(true)}
              className="group/btn flex items-center gap-1 p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-error transition-colors"
              title="Discard changes"
            >
              <RefreshCw className="shrink-0 w-3.5 h-3.5" />
              <span className="max-w-0 overflow-hidden group-hover/btn:max-w-[10rem] transition-all duration-200 whitespace-nowrap text-[10px]">
                Discard
              </span>
            </button>
          )}
          <button
            onClick={() => { setShowSearch(!showSearch); if (showSearch) setSearchQuery(""); }}
            className={`p-1 rounded transition-colors ${showSearch ? "text-[rgb(var(--color-accent))]" : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"}`}
            title="Search snapshots"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => openTab({ type: "history", path: "__history__", title: "History" })}
            className="group/btn flex items-center gap-1 p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors"
            title="Open full history graph"
          >
            <Clock className="shrink-0 w-3.5 h-3.5" />
            <span className="max-w-0 overflow-hidden group-hover/btn:max-w-[10rem] transition-all duration-200 whitespace-nowrap text-[10px]">
              History
            </span>
          </button>
          <button
            onClick={() => useAppStore.setState({ snapshotPromptOpen: true })}
            className="group/btn flex items-center gap-1 p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors disabled:opacity-50 disabled:pointer-events-none"
            title="Save Workspace Snapshot (Ctrl+S)"
            disabled={saving}
          >
            {saving ? (
              <svg className="shrink-0 w-3.5 h-3.5 animate-spin text-[rgb(var(--color-accent))]" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <Download className="shrink-0 w-3.5 h-3.5" />
            )}
            <span className="max-w-0 overflow-hidden group-hover/btn:max-w-[10rem] transition-all duration-200 whitespace-nowrap text-[10px]">
              Save
            </span>
          </button>
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="px-3 py-1.5 border-b border-[rgb(var(--color-border))]">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter snapshots…"
            className="w-full px-2 py-1 rounded text-[10px] bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 outline-none focus:border-[rgb(var(--color-accent))]"
            autoFocus
          />
        </div>
      )}

      {/* Sync Bar — only visible when remote is configured */}
      <SyncBar />

      {/* Discard confirmation */}
      {confirmDiscard && (
        <div className="px-3 py-2 border-b border-error/20 bg-error/5">
          <div className="text-[10px] font-medium text-error mb-1.5">
            Discard all changes since last snapshot?
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleDiscard}
              disabled={discarding}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium text-accent-fg bg-error hover:bg-error/80 disabled:opacity-40 transition-colors"
            >
              {discarding ? "Discarding..." : "Discard"}
            </button>
            <button
              onClick={() => setConfirmDiscard(false)}
              className="px-2 py-1 rounded-md text-[10px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Navigation prompt: dirty + clicking a different snapshot */}
      {pendingNavTarget && (
        <div className="px-3 py-2 border-b border-warning/20 bg-warning/5">
          <div className="text-[10px] font-medium text-warning mb-1.5">
            You have unsaved changes
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleNavSave}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium bg-[rgb(var(--color-accent))] text-white hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
            >
              Save snapshot
            </button>
            <button
              onClick={handleNavDiscard}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium text-[rgb(var(--color-text-secondary))] hover:text-error border border-[rgb(var(--color-border))] hover:border-error/30 transition-colors"
            >
              Discard changes
            </button>
            <button
              onClick={() => setPendingNavTarget(null)}
              className="px-2 py-1 rounded-md text-[10px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Active branch — linear snapshot list */}
      <div className="flex-1 overflow-y-auto">
        {activeNodes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <div className="w-10 h-10 rounded-full bg-[rgb(var(--color-accent))]/10 flex items-center justify-center mb-3">
              <Clock className="w-5 h-5 text-[rgb(var(--color-accent))]" />
            </div>
            <p className="text-sm font-medium text-[rgb(var(--color-text))] mb-1">No snapshots yet</p>
            <p className="text-xs text-[rgb(var(--color-text-secondary))] max-w-[240px] leading-relaxed">
              Save a snapshot to create a restore point. Press <kbd className="px-1 py-0.5 rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] text-[10px] font-mono">Ctrl+S</kbd> to quick-save.
            </p>
          </div>
        ) : (
        <div className="py-1">
          <SnapshotGraph
            nodes={searchQuery
              ? activeNodes.filter((n) => n.message.toLowerCase().includes(searchQuery.toLowerCase()))
              : activeNodes}
            isDirty={isDirty}
            isRewound={isRewound}
            timelineMap={timelineMap}
            hasMultipleTimelines={timelines.length > 1}
            showRemoteBadges={hasRemote}
            onNodeClick={handleNodeClick}
          />
          {searchQuery && activeNodes.length > 0 && activeNodes.filter((n) => n.message.toLowerCase().includes(searchQuery.toLowerCase())).length === 0 && (
            <div className="px-4 py-6 text-center text-[10px] text-[rgb(var(--color-text-secondary))]">
              No snapshots match "{searchQuery}"
            </div>
          )}
        </div>
        )}
      </div>

      {/* Diff panel — shows file changes between two selected snapshots */}
      <SnapshotDiffPanel />
    </div>
  );
}
