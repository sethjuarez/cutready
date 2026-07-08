import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { SnapshotGraph } from "./SnapshotGraph";
import { SnapshotDiffPanel } from "./SnapshotDiffPanel";
import { SyncBar } from "./SyncBar";
import { TimelineSelector } from "./TimelineSelector";
import { RefreshCw, Search, Clock, Download, GitPullRequestArrow, X } from "lucide-react";
import { useConfirmDialog } from "./ConfirmDialog";
import { firstParentTimelineNodes, headAnchoredCleanupSelection, isExactHeadCleanupSelection } from "../utils/historyCleanupSelection";

export function VersionHistory() {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const isDirty = useAppStore((s) => s.isDirty);
  const isRewound = useAppStore((s) => s.isRewound);
  const checkDirty = useAppStore((s) => s.checkDirty);
  const openTab = useAppStore((s) => s.openTab);
  const checkRewound = useAppStore((s) => s.checkRewound);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const discardChanges = useAppStore((s) => s.discardChanges);
  const deleteTimeline = useAppStore((s) => s.deleteTimeline);
  const switchTimeline = useAppStore((s) => s.switchTimeline);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const timelines = useAppStore((s) => s.timelines);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const previewSnapshotCleanup = useAppStore((s) => s.previewSnapshotCleanup);
  const applySnapshotCleanup = useAppStore((s) => s.applySnapshotCleanup);
  const currentRemote = useAppStore((s) => s.currentRemote);
  const saving = useAppStore((s) => s.saving);
  const currentProject = useAppStore((s) => s.currentProject);
  const isMultiProject = useAppStore((s) => s.isMultiProject);
  const startedBranchFromSnapshot = useAppStore((s) => s.startedBranchFromSnapshot);
  const hasRemote = !!currentRemote;

  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [squashMode, setSquashMode] = useState(false);
  const [selectedForSquash, setSelectedForSquash] = useState<Set<string>>(new Set());
  const [squashLabel, setSquashLabel] = useState("");
  const [squashError, setSquashError] = useState<string | null>(null);
  const [squashing, setSquashing] = useState(false);

  // Show the product-facing first-parent story, not merged side ancestry.
  const activeTimeline = timelines.find((t) => t.is_active);
  const head = graphNodes.find((node) => node.is_head);
  const emptyStartedBranch = startedBranchFromSnapshot
    && activeTimeline?.name === startedBranchFromSnapshot.branchName
    && head?.id === startedBranchFromSnapshot.snapshotId
    ? startedBranchFromSnapshot
    : null;
  const activeNodes = firstParentTimelineNodes(graphNodes);

  // Build a label map: timeline name → { label, color_index }
  const timelineMap = new Map(
    timelines.map((t) => [t.name, { label: t.label, colorIndex: t.color_index }])
  );

  const selectedNodes = activeNodes
    .filter((node) => selectedForSquash.has(node.id))
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
  const selectedHead = selectedNodes.find((node) => node.is_head);
  const selectedOldest = selectedNodes[selectedNodes.length - 1];
  const hasContiguousCleanupSelection = isExactHeadCleanupSelection(activeNodes, selectedForSquash);
  const canSquash = hasContiguousCleanupSelection && !hasRemote && !isRewound && !isDirty;
  const activeProjectName = currentProject?.name ?? "this project";
  const { confirm, confirmationDialog } = useConfirmDialog();

  useEffect(() => {
    loadGraphData();
    loadTimelines();
    checkDirty();
    checkRewound();
  }, [loadGraphData, loadTimelines, checkDirty, checkRewound]);

  const handleNodeClick = useCallback(async (commitId: string, isHead: boolean) => {
    if (isHead) return;
    await navigateToSnapshot(commitId);
    // Force full refresh after navigation
    await loadGraphData();
    await loadTimelines();
  }, [navigateToSnapshot, loadGraphData, loadTimelines]);

  const handleDiscard = useCallback(async () => {
    const confirmed = await confirm({
      title: "Discard active project changes?",
      message: `This restores ${isMultiProject ? activeProjectName : "this project"} to the last saved snapshot. Unsaved edits will be lost.`,
      confirmLabel: "Discard changes",
      variant: "error",
    });
    if (!confirmed) return;
    const branchToDelete = emptyStartedBranch;
    await discardChanges();
    await loadGraphData();
    await loadTimelines();
    if (branchToDelete) {
      const shouldDelete = await confirm({
        title: "Delete the empty branch too?",
        message: `You discarded the unsaved work on ${branchToDelete.branchName}. This branch has no new saved snapshots beyond where it started. Delete it as well?`,
        confirmLabel: "Delete branch",
        cancelLabel: "Keep branch",
        variant: "warning",
      });
      if (shouldDelete) {
        const fallback = timelines.find((timeline) => timeline.name !== branchToDelete.branchName);
        if (fallback) await switchTimeline(fallback.name);
        await deleteTimeline(branchToDelete.branchName);
      }
    }
  }, [activeProjectName, confirm, deleteTimeline, discardChanges, emptyStartedBranch, isMultiProject, loadGraphData, loadTimelines, switchTimeline, timelines]);

  const toggleSquashSelection = useCallback((commitId: string) => {
    setSelectedForSquash(headAnchoredCleanupSelection(activeNodes, commitId));
    setSquashError(null);
  }, [activeNodes]);

  const cancelSquash = useCallback(() => {
    setSquashMode(false);
    setSelectedForSquash(new Set());
    setSquashLabel("");
    setSquashError(null);
  }, []);

  const handleSquash = useCallback(async () => {
    if (!selectedHead || !selectedOldest || !squashLabel.trim()) return;
    setSquashing(true);
    setSquashError(null);
    try {
      const preview = await previewSnapshotCleanup(
        selectedOldest.id,
        selectedHead.id,
        squashLabel.trim(),
        selectedNodes.map((node) => node.id),
      );
      const warningText = preview.warnings.length > 0
        ? `\n\nWarnings:\n${preview.warnings.map((warning) => `- ${warning.message}`).join("\n")}`
        : "";
      const confirmed = await confirm({
        title: "Create milestone snapshot?",
        message: `Draftline will replace ${preview.graph_diff.old_commit_count} selected snapshots with ${preview.graph_diff.new_commit_count} named milestone and create a local backup before moving the timeline.${warningText}`,
        confirmLabel: "Create milestone",
        cancelLabel: "Cancel",
        variant: "warning",
      });
      if (!confirmed) return;
      await applySnapshotCleanup(preview.plan_id);
      cancelSquash();
    } catch (err) {
      setSquashError(String(err));
    } finally {
      setSquashing(false);
    }
  }, [applySnapshotCleanup, cancelSquash, confirm, previewSnapshotCleanup, selectedHead, selectedNodes, selectedOldest, squashLabel]);

  const borderClass = sidebarPosition === "left" ? "border-l" : "border-r";
  const workspaceName = currentProject ? getPathBasename(currentProject.repo_root) : "workspace";

  return (
    <div className={`flex flex-col h-full ${borderClass} border-[rgb(var(--color-border))]`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[rgb(var(--color-border))]">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider">
            Snapshots
          </span>
          <span className="hidden rounded-full border border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/10 px-1.5 py-0 text-[9px] font-medium text-[rgb(var(--color-accent))] sm:inline">
            Click previews
          </span>
          {isMultiProject && (
            <span
              className="rounded-full border border-[rgb(var(--color-border))] px-1.5 py-0 text-[9px] font-medium text-[rgb(var(--color-text-secondary))]/80"
              title={`Workspace snapshots: ${workspaceName}`}
            >
              Workspace
            </span>
          )}
          {timelines.length > 1 && <TimelineSelector />}
        </div>
        <div className="flex items-center gap-0.5">
          {isDirty && (
            <button
              onClick={() => void handleDiscard()}
              className="group/btn flex items-center gap-1 p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-error transition-colors"
              title="Discard active project changes"
            >
              <RefreshCw className="shrink-0 w-3.5 h-3.5" />
              <span className="max-w-0 overflow-hidden group-hover/btn:max-w-[10rem] transition-all duration-200 whitespace-nowrap text-[10px]">
                Discard
              </span>
            </button>
          )}
          <button
            onClick={() => setSquashMode((value) => {
              if (value) {
                setSelectedForSquash(new Set());
                setSquashLabel("");
                setSquashError(null);
              }
              return !value;
            })}
            className={`group/btn flex items-center gap-1 p-1 rounded transition-colors ${
              squashMode
                ? "text-[rgb(var(--color-accent))] bg-[rgb(var(--color-accent))]/10"
                : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))]"
            }`}
            title="Create a milestone from recent snapshots"
          >
            <GitPullRequestArrow className="shrink-0 w-3.5 h-3.5" />
            <span className="max-w-0 overflow-hidden group-hover/btn:max-w-[10rem] transition-all duration-200 whitespace-nowrap text-[10px]">
              Milestone
            </span>
          </button>
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
            onClick={() => useAppStore.getState().promptSnapshot()}
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

      {/* Sync Bar — only visible when remote is configured */}
      <SyncBar />

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

      {squashMode && (
        <div className="px-3 py-2 border-b border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/5 space-y-2">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <div className="text-[10px] font-medium text-[rgb(var(--color-accent))]">
                Select recent snapshots ending at HEAD
              </div>
              <div className="text-[10px] text-[rgb(var(--color-text-secondary))] leading-relaxed">
                Draftline previews a milestone plan, creates a local backup, then replaces selected clean snapshots with one named milestone.
              </div>
            </div>
            <button
              onClick={cancelSquash}
              className="p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
              title="Cancel milestone mode"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <input
            value={squashLabel}
            onChange={(e) => setSquashLabel(e.target.value)}
            placeholder="Milestone snapshot name..."
            className="w-full px-2 py-1 rounded text-[10px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 outline-none focus:border-[rgb(var(--color-accent))]"
          />
          {isDirty && (
            <div className="text-[10px] text-warning">
              Save or discard unsaved workspace changes before creating a milestone.
            </div>
          )}
          {(hasRemote || isRewound) && (
            <div className="text-[10px] text-warning">
              Milestones are available only on local timeline tips that are not rewound.
            </div>
          )}
          {squashError && <div className="text-[10px] text-error">{squashError}</div>}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleSquash}
              disabled={!canSquash || !squashLabel.trim() || squashing}
              className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              {squashing ? "Previewing..." : `Create milestone from ${selectedNodes.length || ""} snapshots`}
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
              Save a workspace snapshot to create a restore point. Press <kbd className="px-1 py-0.5 rounded border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] text-[10px] font-mono">Ctrl+S</kbd> to name and save one.
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
            selectionMode={squashMode}
            selectedIds={selectedForSquash}
            onToggleSelect={toggleSquashSelection}
            onNodeClick={handleNodeClick}
          />
          {!squashMode && (
            <div className="mx-3 mb-2 mt-1 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/70 px-2 py-1.5 text-[10px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
              Click a dot to preview. Switch branches from the branch menu. To write from history, use the preview tab to create a new branch and snapshot.
            </div>
          )}
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
      {confirmationDialog}
    </div>
  );
}

function getPathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
