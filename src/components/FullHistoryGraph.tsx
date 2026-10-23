import { SnapshotGraph, type HistoryGraphNodeType } from "./SnapshotGraph";
import type { GraphNode } from "../types/sketch";

export type { HistoryGraphNodeType };

interface TimelineMeta {
  label: string;
  colorIndex: number;
}

interface FullHistoryGraphProps {
  nodes: GraphNode[];
  timelineMap: Map<string, TimelineMeta>;
  hasMultipleTimelines: boolean;
  nodeTypes?: Map<string, HistoryGraphNodeType>;
  showRemoteBadges?: boolean;
  highlightedIds?: Set<string>;
  zoomLevel: number;
  onZoomChange: (zoomLevel: number) => void;
  onNodeClick: (commitId: string, isHead: boolean) => void;
}

export function FullHistoryGraph({
  nodes,
  timelineMap,
  hasMultipleTimelines,
  nodeTypes,
  showRemoteBadges,
  highlightedIds,
  zoomLevel,
  onZoomChange,
  onNodeClick,
}: FullHistoryGraphProps) {
  void onZoomChange;
  return (
    <SnapshotGraph
      nodes={nodes}
      isDirty={false}
      isRewound={false}
      timelineMap={timelineMap}
      hasMultipleTimelines={hasMultipleTimelines}
      variant="expanded"
      zoom={zoomLevel}
      showRemoteBadges={showRemoteBadges}
      highlightedIds={highlightedIds}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
    />
  );
}
