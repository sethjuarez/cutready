import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, GitBranch, LocateFixed } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { useConfirmDialog } from "./ConfirmDialog";
import { SnapshotGraph } from "./SnapshotGraph";
import { UnsavedWorkspaceDialog } from "./UnsavedWorkspaceDialog";

const LANE_COLORS = [
  "rgb(var(--color-accent))",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#ec4899",
  "#14b8a6",
  "#8b5cf6",
];

function laneColor(index: number) {
  return LANE_COLORS[index % LANE_COLORS.length];
}

export function HistoryGraphTab() {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const timelines = useAppStore((s) => s.timelines);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const switchTimeline = useAppStore((s) => s.switchTimeline);
  const isDirty = useAppStore((s) => s.isDirty);
  const isRewound = useAppStore((s) => s.isRewound);
  const discardChanges = useAppStore((s) => s.discardChanges);
  const deleteTimeline = useAppStore((s) => s.deleteTimeline);
  const startedBranchFromSnapshot = useAppStore((s) => s.startedBranchFromSnapshot);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const { confirm, confirmationDialog } = useConfirmDialog();

  useEffect(() => {
    loadGraphData();
    loadTimelines();
  }, [loadGraphData, loadTimelines]);

  const activeTimeline = timelines.find((timeline) => timeline.is_active);
  const head = graphNodes.find((node) => node.is_head);
  const emptyStartedBranch = startedBranchFromSnapshot
    && activeTimeline?.name === startedBranchFromSnapshot.branchName
    && head?.id === startedBranchFromSnapshot.snapshotId
    ? startedBranchFromSnapshot
    : null;

  const snapshotCount = useMemo(
    () => new Set(graphNodes.map((node) => node.id)).size,
    [graphNodes],
  );

  const snapshotGraphTimelineMap = useMemo(
    () => new Map(
      timelines.map((timeline) => [
        timeline.name,
        { label: timeline.label, colorIndex: timeline.color_index },
      ]),
    ),
    [timelines],
  );

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

  const requestTimelineSwitch = useCallback((name: string) => {
    if (isDirty) {
      setPendingSwitch(name);
      return;
    }
    void switchTimeline(name);
  }, [isDirty, switchTimeline]);

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
      <div className="flex shrink-0 items-center gap-3 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-4 py-1.5">
        <span className="text-[10px] text-[rgb(var(--color-text-secondary))]">
          {snapshotCount} snapshot{snapshotCount !== 1 ? "s" : ""} · {timelines.length} timeline{timelines.length !== 1 ? "s" : ""}
        </span>

        <div className="flex-1" />

        <button
          onClick={focusCurrentSnapshot}
          className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-border))]"
          title="Focus current snapshot"
        >
          <LocateFixed className="h-3 w-3" />
          Current
        </button>

        <div className="flex min-w-0 items-center gap-2">
          {timelines.map((timeline) => (
            <button
              key={timeline.name}
              onClick={() => requestTimelineSwitch(timeline.name)}
              className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[10px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-border))] hover:text-[rgb(var(--color-text))]"
              title={`Switch to ${timeline.label}`}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: laneColor(timeline.color_index) }}
              />
              <span className={`max-w-40 truncate ${timeline.is_active ? "font-medium text-[rgb(var(--color-text))]" : ""}`}>
                {timeline.label}
              </span>
              {timeline.is_active && <span className="text-[8px] opacity-50">(active)</span>}
            </button>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-8 py-8">
          <div className="mb-4 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[rgb(var(--color-text-secondary))]">
            <GitBranch className="h-3.5 w-3.5" />
            Workspace history
          </div>
          <div className="rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-3 shadow-sm">
            <SnapshotGraph
              nodes={graphNodes}
              isDirty={isDirty}
              isRewound={isRewound}
              timelineMap={snapshotGraphTimelineMap}
              hasMultipleTimelines={timelines.length > 1}
              showRemoteBadges
              onNodeClick={handleNodeClick}
            />
          </div>
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
