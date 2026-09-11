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
  selectionMode?: boolean;
  selectedIds?: Set<string>;
  endpointIds?: Set<string>;
  highlightedIds?: Set<string>;
  selectableIds?: Set<string>;
  zoomLevel: number;
  onZoomChange: (zoomLevel: number) => void;
  onToggleSelect?: (commitId: string) => void;
  onNodeClick: (commitId: string, isHead: boolean) => void;
}

export function FullHistoryGraph({
  nodes,
  timelineMap,
  hasMultipleTimelines,
  nodeTypes,
  showRemoteBadges,
  selectionMode,
  selectedIds,
  endpointIds,
  highlightedIds,
  selectableIds,
  zoomLevel,
  onZoomChange,
  onToggleSelect,
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
      selectionMode={selectionMode}
      selectedIds={selectedIds}
      endpointIds={endpointIds}
      highlightedIds={highlightedIds}
      selectableIds={selectableIds}
      nodeTypes={nodeTypes}
      onToggleSelect={onToggleSelect}
      onNodeClick={onNodeClick}
    />
  );
}
