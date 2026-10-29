import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeftRight,
  ChevronDown,
  GitBranch,
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
import {
  FullHistoryGraph,
  type HistoryGraphNodeType,
} from "./FullHistoryGraph";
import { TimelineSelector } from "./TimelineSelector";
import { UnsavedWorkspaceDialog } from "./UnsavedWorkspaceDialog";
import { firstParentTimelineNodes } from "../utils/timelineNodes";

export function HistoryGraphTab() {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const timelines = useAppStore((s) => s.timelines);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const checkDirty = useAppStore((s) => s.checkDirty);
  const checkRewound = useAppStore((s) => s.checkRewound);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const switchTimeline = useAppStore((s) => s.switchTimeline);
  const discardChanges = useAppStore((s) => s.discardChanges);
  const stashChanges = useAppStore((s) => s.stashChanges);
  const hasStash = useAppStore((s) => s.hasStash);
  const deleteTimeline = useAppStore((s) => s.deleteTimeline);
  const currentRemote = useAppStore((s) => s.currentRemote);
  const syncStatus = useAppStore((s) => s.syncStatus);
  const currentProject = useAppStore((s) => s.currentProject);
  const startedBranchFromSnapshot = useAppStore(
    (s) => s.startedBranchFromSnapshot,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState("all");
  const [graphZoom, setGraphZoom] = useState(1);
  const [graphFiltersOpen, setGraphFiltersOpen] = useState(false);
  const [showSideAncestry, setShowSideAncestry] = useState(false);
  const [showRemoteOnly, setShowRemoteOnly] = useState(false);
  const [showRecoveryRefs, setShowRecoveryRefs] = useState(false);
  const { confirm, confirmationDialog } = useConfirmDialog();

  useEffect(() => {
    loadGraphData();
    loadTimelines();
    checkDirty();
    checkRewound();
  }, [checkDirty, checkRewound, loadGraphData, loadTimelines]);

  const activeTimeline = timelines.find((timeline) => timeline.is_active);
  const head = graphNodes.find((node) => node.is_head);
  const workspaceName = currentProject
    ? getPathBasename(currentProject.repo_root)
    : "workspace";
  const emptyStartedBranch =
    startedBranchFromSnapshot &&
    activeTimeline?.name === startedBranchFromSnapshot.branchName &&
    head?.id === startedBranchFromSnapshot.snapshotId
      ? startedBranchFromSnapshot
      : null;

  const fullAncestryNodes = useMemo(() => {
    if (!activeTimeline) return graphNodes;
    const branchNodes = graphNodes.filter(
      (node) => node.timeline === activeTimeline.name,
    );
    const nodeMap = new Map(graphNodes.map((node) => [node.id, node]));
    const branchIds = new Set(branchNodes.map((node) => node.id));
    const ancestorIds = new Set<string>();
    const frontier: string[] = [];

    for (const node of branchNodes) {
      for (const parentId of node.parents) {
        if (!branchIds.has(parentId) && nodeMap.has(parentId))
          frontier.push(parentId);
      }
    }

    while (frontier.length > 0) {
      const id = frontier.pop()!;
      if (ancestorIds.has(id)) continue;
      ancestorIds.add(id);
      const node = nodeMap.get(id);
      if (!node) continue;
      for (const parentId of node.parents) {
        if (!ancestorIds.has(parentId) && nodeMap.has(parentId))
          frontier.push(parentId);
      }
    }

    const ancestors = graphNodes.filter((node) => ancestorIds.has(node.id));
    return [...branchNodes, ...ancestors];
  }, [activeTimeline, graphNodes]);
  const firstParentNodes = useMemo(
    () => firstParentTimelineNodes(graphNodes),
    [graphNodes],
  );
  const allGraphNodeTypes = useMemo(
    () =>
      classifyGraphNodes(uniqueGraphNodes(fullAncestryNodes), firstParentNodes),
    [firstParentNodes, fullAncestryNodes],
  );
  const visibleGraphNodes = useMemo(
    () =>
      uniqueGraphNodes(fullAncestryNodes).filter((node) => {
        const nodeType = allGraphNodeTypes.get(node.id) ?? "first-parent";
        return (
          nodeType === "first-parent" ||
          (nodeType === "side-ancestry" && showSideAncestry) ||
          (nodeType === "remote-only" && showRemoteOnly) ||
          (nodeType === "support-ref" && showRecoveryRefs)
        );
      }),
    [
      allGraphNodeTypes,
      fullAncestryNodes,
      showRecoveryRefs,
      showRemoteOnly,
      showSideAncestry,
    ],
  );
  const snapshotCount = useMemo(
    () => new Set(visibleGraphNodes.map((node) => node.id)).size,
    [visibleGraphNodes],
  );
  const graphNodeTypes = useMemo(
    () =>
      new Map(
        visibleGraphNodes.map((node) => [
          node.id,
          allGraphNodeTypes.get(node.id) ?? "first-parent",
        ]),
      ),
    [allGraphNodeTypes, visibleGraphNodes],
  );
  const graphNodeTypeCounts = useMemo(() => {
    const counts: Record<HistoryGraphNodeType, number> = {
      "first-parent": 0,
      "side-ancestry": 0,
      "remote-only": 0,
      "support-ref": 0,
    };
    for (const nodeType of allGraphNodeTypes.values()) {
      counts[nodeType] += 1;
    }
    return counts;
  }, [allGraphNodeTypes]);
  const hiddenGraphLayerCount =
    (showSideAncestry ? 0 : graphNodeTypeCounts["side-ancestry"]) +
    (showRemoteOnly ? 0 : graphNodeTypeCounts["remote-only"]) +
    (showRecoveryRefs ? 0 : graphNodeTypeCounts["support-ref"]);
  const remoteTipCount = graphNodes.filter((node) => node.is_remote_tip).length;

  const timelineMap = useMemo(
    () =>
      new Map(
        timelines.map((timeline) => [
          timeline.name,
          { label: timeline.label, colorIndex: timeline.color_index },
        ]),
      ),
    [timelines],
  );

  const authorOptions = useMemo(
    () =>
      Array.from(
        new Set(
          graphNodes
            .map((node) => node.author)
            .filter((author): author is string => !!author),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [graphNodes],
  );

  const authorHighlightedIds = useMemo(() => {
    if (authorFilter === "all") return new Set<string>();
    return new Set(
      graphNodes
        .filter((node) => node.author === authorFilter)
        .map((node) => node.id),
    );
  }, [authorFilter, graphNodes]);

  const filteredGraphNodes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return visibleGraphNodes;
    return visibleGraphNodes.filter(
      (node) =>
        node.message.toLowerCase().includes(query) ||
        node.timeline.toLowerCase().includes(query) ||
        (node.author?.toLowerCase().includes(query) ?? false),
    );
  }, [searchQuery, visibleGraphNodes]);

  const focusCurrentSnapshot = useCallback(() => {
    const current = scrollRef.current?.querySelector<HTMLElement>(
      '[data-snapshot-head="true"]',
    );
    current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  useEffect(() => {
    if (graphNodes.length === 0) return;
    const frame = requestAnimationFrame(focusCurrentSnapshot);
    return () => cancelAnimationFrame(frame);
  }, [focusCurrentSnapshot, graphNodes.length]);

  const handleNodeClick = useCallback(
    async (commitId: string, isHead: boolean) => {
      if (isHead) return;
      await navigateToSnapshot(commitId);
      await loadGraphData();
      await loadTimelines();
    },
    [loadGraphData, loadTimelines, navigateToSnapshot],
  );

  if (graphNodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-[rgb(var(--color-text-secondary))]">
        <ArrowLeftRight className="mb-3 h-12 w-12 opacity-30" />
        <p className="text-xs">No snapshots yet</p>
        <p className="mt-1 text-[10px] opacity-60">
          Save your first snapshot to see the history graph
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[rgb(var(--color-bg))]">
      <div className="history-graph-header flex shrink-0 items-center gap-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-4 py-2">
        <div className="history-graph-title flex min-w-0 flex-1 items-center gap-2">
          <div className="history-graph-title-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-accent))]">
            <GitBranch className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[rgb(var(--color-text))]">
              {workspaceName} workspace history graph
            </div>
            <div className="history-graph-subtitle truncate text-[10px] text-[rgb(var(--color-text-secondary))]">
              {snapshotCount} visible snapshot{snapshotCount !== 1 ? "s" : ""}{" "}
              across {timelines.length} branch
              {timelines.length !== 1 ? "es" : ""}
              {hiddenGraphLayerCount > 0
                ? ` - ${hiddenGraphLayerCount} hidden`
                : ""}
              {remoteTipCount > 0
                ? ` - ${remoteTipCount} remote tip${remoteTipCount !== 1 ? "s" : ""}`
                : ""}
            </div>
          </div>
        </div>

        <div className="history-graph-toolbar-wrap flex shrink-0 items-center justify-end">
          <div className="history-graph-toolbar flex max-w-full items-center justify-end gap-1 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/80 p-1">
            <div className="history-graph-timeline-control min-w-0 max-w-44">
              <TimelineSelector />
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setGraphFiltersOpen((open) => !open)}
                aria-expanded={graphFiltersOpen}
                aria-label="Choose which graph layers are visible"
                className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[10px] font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                title="Choose which graph layers are visible"
              >
                <GitBranch className="h-3 w-3" />
                <span className="history-graph-toolbar-label">View</span>
                <ChevronDown className="h-2.5 w-2.5 opacity-60" />
              </button>
              {graphFiltersOpen && (
                <div className="absolute right-0 top-8 z-40 w-64 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-2 text-xs shadow-xl shadow-black/10">
                  <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--color-text-secondary))]">
                    Graph layers
                  </div>
                  <GraphLayerCheckbox
                    label="First-parent timeline"
                    description={`${graphNodeTypeCounts["first-parent"]} main snapshot${graphNodeTypeCounts["first-parent"] === 1 ? "" : "s"}`}
                    checked
                    disabled
                  />
                  <GraphLayerCheckbox
                    label="Merged history"
                    description={`${graphNodeTypeCounts["side-ancestry"]} snapshot${graphNodeTypeCounts["side-ancestry"] === 1 ? "" : "s"} brought in through merges`}
                    checked={showSideAncestry}
                    disabled={graphNodeTypeCounts["side-ancestry"] === 0}
                    onChange={setShowSideAncestry}
                  />
                  <GraphLayerCheckbox
                    label="Remote history"
                    description={`${graphNodeTypeCounts["remote-only"]} snapshot${graphNodeTypeCounts["remote-only"] === 1 ? "" : "s"} only known from the remote`}
                    checked={showRemoteOnly}
                    disabled={graphNodeTypeCounts["remote-only"] === 0}
                    onChange={setShowRemoteOnly}
                  />
                  <GraphLayerCheckbox
                    label="Recovery history"
                    description={`${graphNodeTypeCounts["support-ref"]} snapshot${graphNodeTypeCounts["support-ref"] === 1 ? "" : "s"} preserved for undo or audit`}
                    checked={showRecoveryRefs}
                    disabled={graphNodeTypeCounts["support-ref"] === 0}
                    onChange={setShowRecoveryRefs}
                  />
                </div>
              )}
            </div>
            {authorOptions.length > 0 && (
              <label className="history-graph-author-control relative flex h-6 min-w-0 max-w-[180px] items-center gap-1.5 rounded-md px-1.5 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]">
                <Users className="h-3 w-3 shrink-0" />
                <select
                  value={authorFilter}
                  onChange={(event) => setAuthorFilter(event.target.value)}
                  className="min-w-0 flex-1 appearance-none truncate bg-transparent pr-3 text-[10px] text-inherit outline-none"
                  title="Highlight snapshots by author"
                >
                  <option value="all">Everyone</option>
                  {authorOptions.map((author) => (
                    <option key={author} value={author}>
                      {author}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1 h-2 w-2 opacity-50" />
              </label>
            )}
            <div className="mx-0.5 h-4 w-px bg-[rgb(var(--color-border-subtle))]" />
            <button
              type="button"
              onClick={() =>
                setGraphZoom((value) =>
                  Math.max(0.7, +(value - 0.1).toFixed(2)),
                )
              }
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
              onClick={() =>
                setGraphZoom((value) =>
                  Math.min(1.6, +(value + 0.1).toFixed(2)),
                )
              }
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
              onClick={focusCurrentSnapshot}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              aria-label="Focus current snapshot"
              title="Focus current snapshot"
            >
              <LocateFixed className="h-3.5 w-3.5" />
              <span className="history-graph-toolbar-label">Current</span>
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
            {syncStatus
              ? ` - ahead ${syncStatus.ahead} / behind ${syncStatus.behind}`
              : ""}
          </div>
        )}
      </div>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className="px-4 py-4">
          {authorFilter !== "all" && (
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-3 py-1.5 text-[11px] text-[rgb(var(--color-text-secondary))] shadow-sm">
              <Users className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />
              Highlighting{" "}
              <span className="font-medium text-[rgb(var(--color-text))]">
                {authorFilter}
              </span>
              <span className="text-[rgb(var(--color-text-secondary))]/70">
                {authorHighlightedIds.size} snapshot
                {authorHighlightedIds.size === 1 ? "" : "s"}
              </span>
            </div>
          )}
          <FullHistoryGraph
            nodes={filteredGraphNodes}
            timelineMap={timelineMap}
            hasMultipleTimelines={timelines.length > 1}
            nodeTypes={graphNodeTypes}
            zoomLevel={graphZoom}
            onZoomChange={setGraphZoom}
            showRemoteBadges
            highlightedIds={authorHighlightedIds}
            onNodeClick={handleNodeClick}
          />
          <p className="mt-3 text-[11px] text-[rgb(var(--color-text-secondary))]">
            The graph starts on the first-parent timeline. Use View to reveal
            merged, remote, and recovery history.
          </p>
        </div>
      </div>

      <UnsavedWorkspaceDialog
        open={!!pendingSwitch}
        targetLabel={
          timelines.find((timeline) => timeline.name === pendingSwitch)
            ?.label ??
          pendingSwitch ??
          "that branch"
        }
        onCancel={() => setPendingSwitch(null)}
        onSaveFirst={() => {
          if (!pendingSwitch) return;
          useAppStore.setState({
            pendingTimelineAfterSave: pendingSwitch,
            snapshotPromptOpen: true,
          });
          setPendingSwitch(null);
        }}
        onShelveAndContinue={hasStash ? undefined : async () => {
          if (!pendingSwitch) return;
          const target = pendingSwitch;
          setPendingSwitch(null);
          if (await stashChanges()) await switchTimeline(target);
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

function GraphLayerCheckbox({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors ${
        disabled
          ? "opacity-45"
          : "cursor-pointer hover:bg-[rgb(var(--color-surface-alt))]"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-[rgb(var(--color-accent))]"
      />
      <span className="min-w-0">
        <span className="block text-[11px] font-medium text-[rgb(var(--color-text))]">
          {label}
        </span>
        <span className="block text-[10px] leading-snug text-[rgb(var(--color-text-secondary))]">
          {description}
        </span>
      </span>
    </label>
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

function classifyGraphNodes(
  nodes: GraphNode[],
  firstParentNodes: GraphNode[],
): Map<string, HistoryGraphNodeType> {
  const firstParentIds = new Set(firstParentNodes.map((node) => node.id));
  const types = new Map<string, HistoryGraphNodeType>();

  for (const node of nodes) {
    if (
      node.reachable_from_support_ref &&
      !node.reachable_from_local_variation
    ) {
      types.set(node.id, "support-ref");
    } else if (
      node.reachable_from_remote_variation &&
      !node.reachable_from_local_variation
    ) {
      types.set(node.id, "remote-only");
    } else if (!firstParentIds.has(node.id)) {
      types.set(node.id, "side-ancestry");
    } else {
      types.set(node.id, "first-parent");
    }
  }

  return types;
}
