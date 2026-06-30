import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  GitBranch,
  GitPullRequestArrow,
  LocateFixed,
  RotateCcw,
  Search,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { GraphNode } from "../types/sketch";
import { useAppStore } from "../stores/appStore";
import { useConfirmDialog } from "./ConfirmDialog";
import { FullHistoryGraph } from "./FullHistoryGraph";
import { TimelineSelector } from "./TimelineSelector";
import { UnsavedWorkspaceDialog } from "./UnsavedWorkspaceDialog";
import type { DraftlineHistoryCleanupPreview } from "../services/draftlineVersioning";
import { errorMessage } from "../stores/appStore";
import { isExactCleanupSelection, twoPointCleanupSelection } from "../utils/historyCleanupSelection";

export function HistoryGraphTab() {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const timelines = useAppStore((s) => s.timelines);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const checkDirty = useAppStore((s) => s.checkDirty);
  const checkRewound = useAppStore((s) => s.checkRewound);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const switchTimeline = useAppStore((s) => s.switchTimeline);
  const isDirty = useAppStore((s) => s.isDirty);
  const isRewound = useAppStore((s) => s.isRewound);
  const discardChanges = useAppStore((s) => s.discardChanges);
  const deleteTimeline = useAppStore((s) => s.deleteTimeline);
  const previewSnapshotCleanup = useAppStore((s) => s.previewSnapshotCleanup);
  const applySnapshotCleanup = useAppStore((s) => s.applySnapshotCleanup);
  const currentRemote = useAppStore((s) => s.currentRemote);
  const syncStatus = useAppStore((s) => s.syncStatus);
  const currentProject = useAppStore((s) => s.currentProject);
  const startedBranchFromSnapshot = useAppStore((s) => s.startedBranchFromSnapshot);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState("all");
  const [cleanupMode, setCleanupMode] = useState(false);
  const [cleanupPointIds, setCleanupPointIds] = useState<string[]>([]);
  const [selectedForCleanup, setSelectedForCleanup] = useState<Set<string>>(new Set());
  const [cleanupLabel, setCleanupLabel] = useState("");
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<DraftlineHistoryCleanupPreview | null>(null);
  const [previewingCleanup, setPreviewingCleanup] = useState(false);
  const [applyingCleanup, setApplyingCleanup] = useState(false);
  const [graphZoom, setGraphZoom] = useState(1);
  const { confirm, confirmationDialog } = useConfirmDialog();

  useEffect(() => {
    loadGraphData();
    loadTimelines();
    checkDirty();
    checkRewound();
  }, [checkDirty, checkRewound, loadGraphData, loadTimelines]);

  const activeTimeline = timelines.find((timeline) => timeline.is_active);
  const head = graphNodes.find((node) => node.is_head);
  const workspaceName = currentProject ? getPathBasename(currentProject.repo_root) : "workspace";
  const emptyStartedBranch = startedBranchFromSnapshot
    && activeTimeline?.name === startedBranchFromSnapshot.branchName
    && head?.id === startedBranchFromSnapshot.snapshotId
    ? startedBranchFromSnapshot
    : null;

  const activeNodes = useMemo(() => {
    if (!activeTimeline) return graphNodes;
    const branchNodes = graphNodes.filter((node) => node.timeline === activeTimeline.name);
    const nodeMap = new Map(graphNodes.map((node) => [node.id, node]));
    const branchIds = new Set(branchNodes.map((node) => node.id));
    const ancestorIds = new Set<string>();
    const frontier: string[] = [];

    for (const node of branchNodes) {
      for (const parentId of node.parents) {
        if (!branchIds.has(parentId) && nodeMap.has(parentId)) frontier.push(parentId);
      }
    }

    while (frontier.length > 0) {
      const id = frontier.pop()!;
      if (ancestorIds.has(id)) continue;
      ancestorIds.add(id);
      const node = nodeMap.get(id);
      if (!node) continue;
      for (const parentId of node.parents) {
        if (!ancestorIds.has(parentId) && nodeMap.has(parentId)) frontier.push(parentId);
      }
    }

    const ancestors = graphNodes.filter((node) => ancestorIds.has(node.id));
    return [...branchNodes, ...ancestors];
  }, [activeTimeline, graphNodes]);
  const activeCleanupNodes = useMemo(() => uniqueGraphNodes(activeNodes), [activeNodes]);

  const snapshotCount = useMemo(
    () => new Set(graphNodes.map((node) => node.id)).size,
    [graphNodes],
  );
  const remoteTipCount = graphNodes.filter((node) => node.is_remote_tip).length;

  const timelineMap = useMemo(
    () => new Map(
      timelines.map((timeline) => [
        timeline.name,
        { label: timeline.label, colorIndex: timeline.color_index },
      ]),
    ),
    [timelines],
  );

  const authorOptions = useMemo(
    () => Array.from(new Set(graphNodes.map((node) => node.author).filter((author): author is string => !!author)))
      .sort((a, b) => a.localeCompare(b)),
    [graphNodes],
  );

  const authorHighlightedIds = useMemo(() => {
    if (authorFilter === "all") return new Set<string>();
    return new Set(graphNodes.filter((node) => node.author === authorFilter).map((node) => node.id));
  }, [authorFilter, graphNodes]);

  const selectedNodes = useMemo(
    () => activeCleanupNodes
      .filter((node) => selectedForCleanup.has(node.id))
      .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp)),
    [activeCleanupNodes, selectedForCleanup],
  );
  const selectedNewest = selectedNodes[0];
  const selectedOldest = selectedNodes[selectedNodes.length - 1];
  const hasContiguousCleanupSelection = isExactCleanupSelection(activeCleanupNodes, selectedForCleanup);
  const selectedRangeEndsAtHead = selectedNewest?.is_head === true;
  const cleanupSelectableIds = useMemo(() => {
    if (!cleanupMode) return new Set<string>();
    if (cleanupPointIds.length !== 1) return new Set(activeCleanupNodes.map((node) => node.id));
    const [firstId] = cleanupPointIds;
    const first = activeCleanupNodes.find((node) => node.id === firstId);
    if (!first) return new Set<string>();
    if (!first.is_head) {
      return new Set(activeCleanupNodes.filter((node) => node.is_head).map((node) => node.id));
    }
    return new Set(activeCleanupNodes
      .filter((node) => !node.is_head && twoPointCleanupSelection(activeCleanupNodes, firstId, node.id).size >= 2)
      .map((node) => node.id));
  }, [activeCleanupNodes, cleanupMode, cleanupPointIds]);
  const effectiveCleanupLabel = useMemo(() => {
    const explicit = cleanupLabel.trim();
    if (explicit) return explicit;
    if (selectedOldest && selectedNewest) {
      return `Compact ${selectedOldest.message} to ${selectedNewest.message}`;
    }
    return "Compacted history";
  }, [cleanupLabel, selectedNewest, selectedOldest]);
  const canPreviewCleanup = cleanupMode
    && hasContiguousCleanupSelection
    && selectedRangeEndsAtHead
    && !isDirty
    && !isRewound
    && cleanupPointIds.length === 2
    && !previewingCleanup;

  const filteredGraphNodes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return graphNodes;
    return graphNodes.filter((node) =>
      node.message.toLowerCase().includes(query)
      || node.timeline.toLowerCase().includes(query)
      || (node.author?.toLowerCase().includes(query) ?? false)
    );
  }, [graphNodes, searchQuery]);

  const focusCurrentSnapshot = useCallback(() => {
    const current = scrollRef.current?.querySelector<HTMLElement>('[data-snapshot-head="true"]');
    current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (graphNodes.length === 0) return;
    const frame = requestAnimationFrame(focusCurrentSnapshot);
    return () => cancelAnimationFrame(frame);
  }, [focusCurrentSnapshot, graphNodes.length]);

  const handleNodeClick = useCallback(async (commitId: string, isHead: boolean) => {
    if (isHead) return;
    await navigateToSnapshot(commitId);
    await loadGraphData();
    await loadTimelines();
  }, [loadGraphData, loadTimelines, navigateToSnapshot]);

  const toggleCleanupSelection = useCallback((commitId: string) => {
    if (cleanupPointIds.length === 0) {
      setCleanupPointIds([commitId]);
      setSelectedForCleanup(new Set([commitId]));
      setCleanupPreview(null);
      setCleanupError(null);
      return;
    }

    if (cleanupPointIds.includes(commitId)) {
      setCleanupPointIds([]);
      setSelectedForCleanup(new Set());
      setCleanupPreview(null);
      setCleanupError(null);
      return;
    }

    const anchorId = cleanupPointIds[cleanupPointIds.length - 1];
    const selection = twoPointCleanupSelection(activeCleanupNodes, anchorId, commitId);
    setCleanupPointIds([anchorId, commitId]);
    setSelectedForCleanup(selection);
    setCleanupPreview(null);
    setCleanupError(selection.size > 1 ? null : "Choose two snapshots on the active timeline to compact.");
  }, [activeCleanupNodes, cleanupPointIds]);

  const cancelCleanup = useCallback(() => {
    setCleanupMode(false);
    setCleanupPointIds([]);
    setSelectedForCleanup(new Set());
    setCleanupLabel("");
    setCleanupError(null);
    setCleanupPreview(null);
  }, []);

  const handlePreviewCleanup = useCallback(async () => {
    if (!selectedNewest || !selectedOldest) return;
    setPreviewingCleanup(true);
    setCleanupError(null);
    setCleanupPreview(null);
    try {
      const preview = await previewSnapshotCleanup(
        selectedOldest.id,
        selectedNewest.id,
        effectiveCleanupLabel,
        selectedNodes.map((node) => node.id),
      );
      setCleanupPreview(preview);
    } catch (err) {
      setCleanupError(errorMessage(err));
    } finally {
      setPreviewingCleanup(false);
    }
  }, [effectiveCleanupLabel, previewSnapshotCleanup, selectedNewest, selectedNodes, selectedOldest]);

  const handleApplyCleanup = useCallback(async () => {
    if (!cleanupPreview) return;
    const warningText = cleanupPreview.warnings.length > 0
      ? `\n\nWarnings:\n${cleanupPreview.warnings.map((warning) => `- ${warning.message}`).join("\n")}`
      : "";
    const remoteText = currentRemote
      ? "\n\nThis compacts local history first. Publishing rewritten history to the remote may require a guarded force/lease push workflow; normal sync may reject it if the remote already has the old snapshots."
      : "";
    const confirmed = await confirm({
      title: "Apply compacted history?",
      message: `Draftline will replace ${cleanupPreview.graph_diff.old_commit_count} selected snapshots with ${cleanupPreview.graph_diff.new_commit_count} milestone snapshot and create a backup ref before moving the timeline.${warningText}${remoteText}`,
      confirmLabel: "Apply compacted history",
      cancelLabel: "Cancel",
      variant: "warning",
    });
    if (!confirmed) return;

    setApplyingCleanup(true);
    try {
      await applySnapshotCleanup(cleanupPreview.plan_id);
      cancelCleanup();
    } catch (err) {
      setCleanupError(errorMessage(err));
    } finally {
      setApplyingCleanup(false);
    }
  }, [applySnapshotCleanup, cancelCleanup, cleanupPreview, confirm, currentRemote]);

  if (graphNodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-[rgb(var(--color-text-secondary))]">
        <ArrowLeftRight className="mb-3 h-12 w-12 opacity-30" />
        <p className="text-xs">No snapshots yet</p>
        <p className="mt-1 text-[10px] opacity-60">Save your first snapshot to see the history graph</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[rgb(var(--color-bg))]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-accent))]">
            <GitBranch className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[rgb(var(--color-text))]">{workspaceName} workspace history graph</div>
            <div className="truncate text-[10px] text-[rgb(var(--color-text-secondary))]">
              {snapshotCount} snapshot{snapshotCount !== 1 ? "s" : ""} across {timelines.length} branch{timelines.length !== 1 ? "es" : ""}
              {remoteTipCount > 0 ? ` - ${remoteTipCount} remote tip${remoteTipCount !== 1 ? "s" : ""}` : ""}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end">
          <div className="flex max-w-full items-center gap-1 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/80 p-1">
            <TimelineSelector />
            {authorOptions.length > 0 && (
              <label className="relative flex h-6 min-w-0 max-w-[180px] items-center gap-1.5 rounded-md px-1.5 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]">
                <Users className="h-3 w-3 shrink-0" />
                <select
                  value={authorFilter}
                  onChange={(event) => setAuthorFilter(event.target.value)}
                  className="min-w-0 flex-1 appearance-none truncate bg-transparent pr-3 text-[10px] text-inherit outline-none"
                  title="Highlight snapshots by author"
                >
                  <option value="all">Everyone</option>
                  {authorOptions.map((author) => (
                    <option key={author} value={author}>{author}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1 h-2 w-2 opacity-50" />
              </label>
            )}
            <div className="mx-0.5 h-4 w-px bg-[rgb(var(--color-border-subtle))]" />
            <button
              type="button"
              onClick={() => setGraphZoom((value) => Math.max(0.7, +(value - 0.1).toFixed(2)))}
              className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              title="Zoom out"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setGraphZoom(1)}
              className="inline-flex h-6 min-w-10 items-center justify-center rounded-md px-1.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              title="Reset zoom"
            >
              {Math.round(graphZoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setGraphZoom((value) => Math.min(1.6, +(value + 0.1).toFixed(2)))}
              className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              title="Zoom in"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
            {graphZoom !== 1 && (
              <button
                type="button"
                onClick={() => setGraphZoom(1)}
                className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                title="Reset zoom"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            )}
            <div className="mx-0.5 h-4 w-px bg-[rgb(var(--color-border-subtle))]" />
            <button
              type="button"
              onClick={() => setCleanupMode((value) => {
                if (value) cancelCleanup();
                return !value;
              })}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                cleanupMode
                  ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
                  : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              }`}
              title="Compact selected timeline history"
            >
              <GitPullRequestArrow className="h-3.5 w-3.5" />
              Compact
            </button>
            <button
              type="button"
              onClick={focusCurrentSnapshot}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              title="Focus current snapshot"
            >
              <LocateFixed className="h-3.5 w-3.5" />
              Current
            </button>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/80 px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))] px-2 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-text-secondary))]" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search snapshots, branches, or authors..."
            className="min-w-0 flex-1 bg-transparent text-xs text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/60"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="rounded p-0.5 text-[rgb(var(--color-text-secondary))] transition-colors hover:text-[rgb(var(--color-text))]"
              title="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {currentRemote && (
          <div className="hidden rounded-lg border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))] px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] md:block">
            Remote: {currentRemote.name}
            {syncStatus ? ` - ahead ${syncStatus.ahead} / behind ${syncStatus.behind}` : ""}
          </div>
        )}
      </div>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-hidden">
        {cleanupMode && (
          <FloatingCleanupPanel
            label={cleanupLabel}
            cleanupError={cleanupError}
            cleanupPointCount={cleanupPointIds.length}
            canPreview={canPreviewCleanup}
            currentRemote={!!currentRemote}
            hasContiguousSelection={hasContiguousCleanupSelection}
            rangeEndsAtHead={selectedRangeEndsAtHead}
            isDirty={isDirty}
            isRewound={isRewound}
            previewing={previewingCleanup}
            selectedNodes={selectedNodes}
            endpointIds={new Set(cleanupPointIds)}
            preview={cleanupPreview}
            applying={applyingCleanup}
            onApply={handleApplyCleanup}
            onCancel={cancelCleanup}
            onLabelChange={(value) => {
              setCleanupLabel(value);
              setCleanupPreview(null);
            }}
            previewLabel={effectiveCleanupLabel}
            onPreview={handlePreviewCleanup}
          />
        )}
        <div className="px-4 py-4">
          {authorFilter !== "all" && (
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-3 py-1.5 text-[11px] text-[rgb(var(--color-text-secondary))] shadow-sm">
              <Users className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />
              Highlighting <span className="font-medium text-[rgb(var(--color-text))]">{authorFilter}</span>
              <span className="text-[rgb(var(--color-text-secondary))]/70">
                {authorHighlightedIds.size} snapshot{authorHighlightedIds.size === 1 ? "" : "s"}
              </span>
            </div>
          )}
          <FullHistoryGraph
            nodes={filteredGraphNodes}
            timelineMap={timelineMap}
            hasMultipleTimelines={timelines.length > 1}
            zoomLevel={graphZoom}
            onZoomChange={setGraphZoom}
            showRemoteBadges
            selectionMode={cleanupMode}
            selectedIds={selectedForCleanup}
            endpointIds={new Set(cleanupPointIds)}
            highlightedIds={authorHighlightedIds}
            selectableIds={cleanupSelectableIds}
            onToggleSelect={toggleCleanupSelection}
            onNodeClick={handleNodeClick}
          />
          <p className="mt-3 text-[11px] text-[rgb(var(--color-text-secondary))]">
            Branches live in the toolbar dropdown. Colored rails show timelines, and remote badges mark tracking tips.
          </p>
        </div>
      </div>

      <UnsavedWorkspaceDialog
        open={!!pendingSwitch}
        targetLabel={timelines.find((timeline) => timeline.name === pendingSwitch)?.label ?? pendingSwitch ?? "that branch"}
        onCancel={() => setPendingSwitch(null)}
        onSaveFirst={() => {
          if (!pendingSwitch) return;
          useAppStore.setState({ pendingTimelineAfterSave: pendingSwitch, snapshotPromptOpen: true });
          setPendingSwitch(null);
        }}
        onDiscardAndContinue={async () => {
          if (!pendingSwitch) return;
          const target = pendingSwitch;
          const branchToDelete = emptyStartedBranch;
          setPendingSwitch(null);
          await discardChanges();
          await switchTimeline(target);
          if (branchToDelete) {
            const shouldDelete = await confirm({
              title: "Delete the empty branch too?",
              message: `You discarded the unsaved work on ${branchToDelete.branchName}. This branch has no new saved snapshots beyond where it started. Delete it as well?`,
              confirmLabel: "Delete branch",
              cancelLabel: "Keep branch",
              variant: "warning",
            });
            if (shouldDelete) await deleteTimeline(branchToDelete.branchName);
          }
        }}
      />
      {confirmationDialog}
    </div>
  );
}

function FloatingCleanupPanel({
  label,
  cleanupError,
  cleanupPointCount,
  canPreview,
  currentRemote,
  hasContiguousSelection,
  rangeEndsAtHead,
  isDirty,
  isRewound,
  previewing,
  selectedNodes,
  endpointIds,
  preview,
  applying,
  onApply,
  onCancel,
  onLabelChange,
  previewLabel,
  onPreview,
}: {
  label: string;
  cleanupError: string | null;
  cleanupPointCount: number;
  canPreview: boolean;
  currentRemote: boolean;
  hasContiguousSelection: boolean;
  rangeEndsAtHead: boolean;
  isDirty: boolean;
  isRewound: boolean;
  previewing: boolean;
  selectedNodes: GraphNode[];
  endpointIds: Set<string>;
  preview: DraftlineHistoryCleanupPreview | null;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
  onLabelChange: (value: string) => void;
  previewLabel: string;
  onPreview: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(getInitialCleanupPanelPosition);
  const [dragging, setDragging] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const width = panelRef.current?.offsetWidth ?? 560;
    setPosition({
      x: Math.max(16, window.innerWidth - width - 280),
      y: 112,
    });
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,select,textarea")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOffsetRef.current = {
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
    setDragging(true);
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const width = panelRef.current?.offsetWidth ?? 560;
    const height = panelRef.current?.offsetHeight ?? 280;
    setPosition({
      x: Math.min(Math.max(8, event.clientX - dragOffsetRef.current.x), Math.max(8, window.innerWidth - width - 8)),
      y: Math.min(Math.max(8, event.clientY - dragOffsetRef.current.y), Math.max(8, window.innerHeight - height - 8)),
    });
  };

  const stopDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  return (
    <div
      ref={panelRef}
      className="fixed z-[100] w-[min(560px,calc(100vw-2rem))] rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/95 p-3 shadow-xl shadow-black/10 backdrop-blur"
      style={{ left: position.x, top: position.y }}
    >
      <div
        className={`mb-2 flex touch-none select-none items-start justify-between gap-3 ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        title="Drag to move compact history panel"
      >
        <div>
          <div className="text-xs font-semibold text-[rgb(var(--color-accent))]">Compact history</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-[rgb(var(--color-text-secondary))]">
            Pick two snapshots. One endpoint must be the current snapshot because Draftline can only compact ranges ending at the branch head.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          title="Cancel compact mode"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={label}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder="Milestone snapshot name (optional)..."
          className="min-w-[220px] flex-1 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-xs text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:border-[rgb(var(--color-accent))]"
        />
        <button
          type="button"
          onClick={onPreview}
          disabled={!canPreview}
          className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-2 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:pointer-events-none disabled:opacity-40"
        >
          {previewing ? "Previewing..." : "Preview"}
        </button>
      </div>
      <CleanupStatus
        cleanupError={cleanupError}
        cleanupPointCount={cleanupPointCount}
        currentRemote={currentRemote}
        hasContiguousSelection={hasContiguousSelection}
        rangeEndsAtHead={rangeEndsAtHead}
        isDirty={isDirty}
        isRewound={isRewound}
      />
      <CleanupPreviewPanel
        label={previewLabel}
        selectedNodes={selectedNodes}
        endpointIds={endpointIds}
        preview={preview}
        applying={applying}
        onApply={onApply}
      />
    </div>
  );
}

function getInitialCleanupPanelPosition() {
  if (typeof window === "undefined") return { x: 16, y: 112 };
  const width = Math.min(560, Math.max(0, window.innerWidth - 32));
  return {
    x: Math.max(16, window.innerWidth - width - 280),
    y: 112,
  };
}

function CleanupStatus({
  cleanupError,
  cleanupPointCount,
  currentRemote,
  hasContiguousSelection,
  rangeEndsAtHead,
  isDirty,
  isRewound,
}: {
  cleanupError: string | null;
  cleanupPointCount: number;
  currentRemote: boolean;
  hasContiguousSelection: boolean;
  rangeEndsAtHead: boolean;
  isDirty: boolean;
  isRewound: boolean;
}) {
  let message = "Highlighted graph nodes can start a compact range.";
  let className = "text-[rgb(var(--color-text-secondary))]";

  if (isDirty) {
    message = "Save or discard unsaved workspace changes before compacting.";
    className = "text-warning";
  } else if (isRewound) {
    message = "Return to the current timeline tip before compacting.";
    className = "text-warning";
  } else if (cleanupPointCount === 1) {
    message = "First point selected. Choose a second point; one picked point must be the current snapshot to preview.";
  } else if (cleanupPointCount === 2 && !hasContiguousSelection) {
    message = "Choose two points that form a contiguous active-timeline range.";
    className = "text-warning";
  } else if (cleanupPointCount === 2 && !rangeEndsAtHead) {
    message = "One selected point must be the current snapshot; Draftline cannot compact a middle-only range yet.";
    className = "text-warning";
  } else if (currentRemote) {
    message = "Compaction is local-first. Publishing rewritten history may need a guarded remote update.";
  }

  if (cleanupError) {
    message = cleanupError;
    className = "text-[rgb(var(--color-error))]";
  }

  return <div className={`mb-2 min-h-4 text-[11px] leading-relaxed ${className}`}>{message}</div>;
}

function CleanupPreviewPanel({
  label,
  selectedNodes,
  endpointIds,
  preview,
  applying,
  onApply,
}: {
  label: string;
  selectedNodes: GraphNode[];
  endpointIds: Set<string>;
  preview: DraftlineHistoryCleanupPreview | null;
  applying: boolean;
  onApply: () => void;
}) {
  return (
    <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[rgb(var(--color-text-secondary))]">Preview</div>
        {preview && (
          <button
            type="button"
            onClick={onApply}
            disabled={applying}
            className="rounded-md bg-[rgb(var(--color-accent))] px-2.5 py-1.5 text-[10px] font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:opacity-40"
          >
            {applying ? "Applying..." : "Accept compact"}
          </button>
        )}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2">
        <div className="min-w-0 rounded-lg bg-[rgb(var(--color-surface-alt))] p-2">
          <div className="mb-1 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">Before</div>
          {selectedNodes.length < 2 ? (
            <p className="text-[11px] text-[rgb(var(--color-text-secondary))]">Pick two points to define a compact range.</p>
          ) : (
            <div className="space-y-1">
              <div className="mb-1 rounded border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-2 py-1 text-[10px] font-medium text-[rgb(var(--color-text))]">
                {endpointIds.size} picked points define {selectedNodes.length} included snapshots
              </div>
              {selectedNodes.slice(0, 5).map((node) => (
                <div
                  key={node.id}
                  className={`truncate rounded border px-2 py-1 text-[10px] text-[rgb(var(--color-text))] ${
                    endpointIds.has(node.id)
                      ? "border-[rgb(var(--color-warning))]/40 bg-[rgb(var(--color-warning))]/10 font-medium"
                      : "border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]"
                  }`}
                  title={node.message}
                >
                  {endpointIds.has(node.id) ? "Picked point: " : "Included: "}{node.message}
                </div>
              ))}
              {selectedNodes.length > 5 && (
                <div className="text-[10px] text-[rgb(var(--color-text-secondary))]">+{selectedNodes.length - 5} more included snapshots</div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center text-[rgb(var(--color-text-secondary))]">
          <ArrowRight className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 rounded-lg bg-[rgb(var(--color-surface-alt))] p-2">
          <div className="mb-1 text-[10px] font-medium text-[rgb(var(--color-text-secondary))]">After</div>
          <div className="truncate rounded border border-[rgb(var(--color-accent))]/30 bg-[rgb(var(--color-accent))]/10 px-2 py-1 text-[10px] font-medium text-[rgb(var(--color-accent))]" title={label || "Milestone"}>
            {label || "Milestone"}
          </div>
          <div className="mt-1 text-[10px] text-[rgb(var(--color-text-secondary))]">
            {preview
              ? `${preview.graph_diff.old_commit_count} old snapshot${preview.graph_diff.old_commit_count === 1 ? "" : "s"} to ${preview.graph_diff.new_commit_count} milestone snapshot${preview.graph_diff.new_commit_count === 1 ? "" : "s"}`
              : "Generate a Draftline preview before applying."}
          </div>
        </div>
      </div>
      {preview?.warnings.length ? (
        <div className="mt-2 rounded-lg border border-warning/25 bg-warning/5 px-2 py-1.5 text-[10px] text-warning">
          {preview.warnings.map((warning) => warning.message).join(" ")}
        </div>
      ) : null}
    </div>
  );
}

function getPathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function uniqueGraphNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const unique: GraphNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    unique.push(node);
  }
  return unique;
}
