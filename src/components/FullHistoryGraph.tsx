import { useEffect, useMemo, useRef, useState } from "react";
import { select, zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior, type ZoomTransform } from "d3";
import type { GraphNode } from "../types/sketch";

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

const TOP_PAD = 48;
const LEFT_PAD = 96;
const ROW_H = 74;
const LANE_W = 132;
const LABEL_W = 420;

function laneColor(index: number) {
  return LANE_COLORS[index % LANE_COLORS.length];
}

function remoteBadges(node: GraphNode): string[] {
  return node.remote_labels?.length ? node.remote_labels : node.is_remote_tip ? ["remote"] : [];
}

function remoteBadgeWidth(label: string) {
  return Math.max(48, label.length * 6 + 14);
}

export type HistoryGraphNodeType = "first-parent" | "side-ancestry" | "remote-only" | "support-ref";

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

interface LayoutNode {
  node: GraphNode;
  x: number;
  y: number;
  lane: number;
  color: string;
  nodeType: HistoryGraphNodeType;
  timelineLabel: string;
  aliases: { timeline: string; label: string }[];
}

interface TimelineMeta {
  label: string;
  colorIndex: number;
}

export function FullHistoryGraph({
  nodes,
  timelineMap,
  hasMultipleTimelines,
  nodeTypes = new Map(),
  showRemoteBadges = false,
  selectionMode = false,
  selectedIds = new Set(),
  endpointIds = new Set(),
  highlightedIds = new Set(),
  selectableIds = new Set(),
  zoomLevel,
  onZoomChange,
  onToggleSelect,
  onNodeClick,
}: FullHistoryGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const currentTransformRef = useRef<ZoomTransform>(zoomIdentity);
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);

  const remoteLabelPad = useMemo(() => {
    if (!showRemoteBadges) return LEFT_PAD;
    const widest = nodes
      .flatMap(remoteBadges)
      .reduce((max, label) => Math.max(max, remoteBadgeWidth(label)), 0);
    return Math.max(LEFT_PAD, widest + 24);
  }, [nodes, showRemoteBadges]);
  const layout = useMemo(() => buildLayout(nodes, timelineMap, remoteLabelPad, nodeTypes), [nodes, timelineMap, remoteLabelPad, nodeTypes]);
  const width = Math.max(900, remoteLabelPad + Math.max(1, layout.laneCount) * LANE_W + LABEL_W);
  const height = Math.max(360, TOP_PAD * 2 + Math.max(1, layout.nodes.length) * ROW_H);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.45, 2.2])
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        currentTransformRef.current = event.transform;
        setTransform(event.transform);
        onZoomChange(Number(event.transform.k.toFixed(2)));
      });

    zoomBehaviorRef.current = behavior;
    svg.call(behavior);
    svg.call(behavior.transform, zoomIdentity.scale(zoomLevel));

    return () => {
      svg.on(".zoom", null);
      zoomBehaviorRef.current = null;
    };
  }, [onZoomChange]);

  useEffect(() => {
    const svg = svgRef.current;
    const behavior = zoomBehaviorRef.current;
    if (!svg || !behavior) return;
    const current = currentTransformRef.current;
    if (Math.abs(current.k - zoomLevel) < 0.01) return;
    const next = zoomIdentity.translate(current.x, current.y).scale(zoomLevel);
    select(svg).transition().duration(120).call(behavior.transform, next);
  }, [zoomLevel]);

  return (
    <svg
      ref={svgRef}
      className="block h-full w-full cursor-grab active:cursor-grabbing"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMinYMin meet"
      role="img"
      aria-label="Workspace history graph"
    >
      <defs>
        <filter id="history-node-shadow" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="2" floodColor="rgb(0 0 0)" floodOpacity="0.16" />
        </filter>
      </defs>
      <g transform={transform.toString()}>
        <GraphGrid height={height} lanes={layout.laneCount} leftPad={remoteLabelPad} />
        <g>
          {layout.edges.map((edge) => (
            <path
              key={`${edge.from.node.id}-${edge.to.node.id}`}
              d={edgePath(edge.from, edge.to)}
              fill="none"
              stroke={edge.from.color}
              strokeLinecap="round"
              strokeWidth={2.35}
              strokeOpacity={edgeOpacity(edge.from.nodeType, edge.to.nodeType)}
              strokeDasharray={edgeDash(edge.from.nodeType, edge.to.nodeType)}
            />
          ))}
        </g>
        <g>
          {layout.nodes.map((item) => {
            const node = item.node;
            const selected = selectedIds.has(node.id);
            const endpoint = endpointIds.has(node.id);
            const highlighted = highlightedIds.has(node.id);
            const selectable = !selectionMode || selectableIds.has(node.id);
            const interactive = selectionMode ? selectable : !node.is_head;
            const radius = node.is_head ? 8 : 6;
            const isSideAncestry = item.nodeType === "side-ancestry";
            const isAuxiliaryNode = item.nodeType === "remote-only" || item.nodeType === "support-ref";
            const isMutedNode = isSideAncestry || isAuxiliaryNode;
            const nodeOpacity = selectionMode && !selected && !selectable ? 0.38 : isSideAncestry ? 0.74 : isAuxiliaryNode ? 0.66 : 1;
            const selectTitle = selected
              ? "Selected compaction range point"
              : selectable
                ? "Select this snapshot for the compaction range"
                : "This snapshot is not on the active timeline compaction path";
            return (
              <g
                key={node.id}
                data-snapshot-id={node.id}
                data-snapshot-head={node.is_head ? "true" : "false"}
                data-snapshot-type={item.nodeType}
                transform={`translate(0 ${item.y})`}
                className={interactive ? "cursor-pointer" : undefined}
                aria-label={selectionMode ? selectTitle : node.message}
                onClick={() => {
                  if (selectionMode) {
                    if (!selectable) return;
                    onToggleSelect?.(node.id);
                    return;
                  }
                  onNodeClick(node.id, node.is_head);
                }}
              >
                {node.parents.length > 1 && (
                  <title>{`Merge snapshot with ${node.parents.length} parent snapshots`}</title>
                )}
                <line
                  x1={item.x}
                  x2={item.x + 26}
                  y1={0}
                  y2={0}
                  stroke={item.color}
                  strokeOpacity={isMutedNode ? 0.12 : 0.22}
                  strokeWidth={1.25}
                  strokeDasharray={isMutedNode ? "3 4" : undefined}
                />
                {node.is_head && (
                  <circle
                    cx={item.x}
                    cy={0}
                    r={15}
                    fill="none"
                    stroke={item.color}
                    strokeOpacity={0.32}
                    strokeWidth={1.5}
                  />
                )}
                {(selected || highlighted) && (
                  <circle
                    cx={item.x}
                    cy={0}
                    r={selected ? 18 : 14}
                    fill={item.color}
                    fillOpacity={selected ? 0.16 : 0.1}
                    stroke={item.color}
                    strokeOpacity={selected ? 0.38 : 0.22}
                  />
                )}
                {selectionMode && !selected && (
                  <circle
                    cx={item.x}
                    cy={0}
                    r={15}
                    fill="none"
                    stroke={item.color}
                    strokeOpacity={selectable ? 0.42 : 0.14}
                    strokeWidth={1.5}
                    strokeDasharray={selectable ? "3 3" : "1 6"}
                  />
                )}
                <circle
                  cx={item.x}
                  cy={0}
                  r={selectionMode ? 18 : 12}
                  fill="transparent"
                  pointerEvents={interactive ? "all" : "none"}
                />
                {selectionMode && selected && (
                  <text
                    x={item.x}
                    y={-22}
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight={700}
                    fill="rgb(var(--color-warning))"
                  >
                    {endpoint ? "picked" : "milestone"}
                  </text>
                )}
                <circle
                  cx={item.x}
                  cy={0}
                  r={radius}
                  fill={selected ? "rgb(var(--color-warning))" : node.is_head || highlighted || selectionMode ? item.color : isMutedNode ? "rgb(var(--color-surface-alt))" : "rgb(var(--color-surface))"}
                  stroke={selected ? "rgb(var(--color-warning))" : item.color}
                  opacity={nodeOpacity}
                  strokeWidth={selected ? 3.2 : isMutedNode ? 1.6 : 2.2}
                  strokeDasharray={isMutedNode ? "2 3" : undefined}
                  filter={node.is_head ? "url(#history-node-shadow)" : undefined}
                />
                {showRemoteBadges && remoteBadges(node).length > 0 && (() => {
                  const labels = remoteBadges(node);
                  const visibleLabels = labels.slice(0, 3);
                  const overflowCount = labels.length - visibleLabels.length;
                  const top = -((visibleLabels.length - 1) * 11 + 10);
                  const badgeLeft = item.x - Math.max(...visibleLabels.map(remoteBadgeWidth)) - 10;
                  return (
                    <g transform={`translate(${badgeLeft} ${top})`}>
                      {visibleLabels.map((label, index) => (
                        <g key={label} transform={`translate(0 ${index * 22})`}>
                          <RemoteSvgBadge label={label} />
                        </g>
                      ))}
                      {overflowCount > 0 && (
                        <text x={74} y={visibleLabels.length * 22 - 8.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#10b981">
                          +{overflowCount}
                        </text>
                      )}
                    </g>
                  );
                })()}
                <g transform={`translate(${item.x + 28} -20)`}>
                  <text
                    x={0}
                    y={13}
                    fontSize={13}
                    fontWeight={node.is_head ? 700 : 560}
                    fill={isMutedNode ? "rgb(var(--color-text-secondary))" : "rgb(var(--color-text))"}
                  >
                    {truncate(node.message, 58)}
                  </text>
                  <text x={0} y={31} fontSize={10.5} fill="rgb(var(--color-text-secondary))">
                    {formatDate(node.timestamp)} - {node.id.slice(0, 7)}
                    {node.author ? ` - ${node.author}` : ""}
                    {node.parents.length > 1 ? " - merge" : ""}
                  </text>
                  <g transform="translate(0 38)">
                    {node.is_head && <SvgBadge x={0} label="HEAD" tone="accent" />}
                    {node.is_branch_tip && <SvgBadge x={node.is_head ? 48 : 0} label="tip" tone="neutral" />}
                    {item.nodeType !== "first-parent" && (
                      <SvgBadge
                        x={(node.is_head ? 48 : 0) + (node.is_branch_tip ? 36 : 0)}
                        label={nodeTypeLabel(item.nodeType)}
                        tone={item.nodeType === "side-ancestry" ? "side" : "neutral"}
                      />
                    )}
                    {hasMultipleTimelines && (
                      <SvgBadge
                        x={(node.is_head ? 48 : 0) + (node.is_branch_tip ? 36 : 0) + (item.nodeType !== "first-parent" ? 86 : 0)}
                        label={item.timelineLabel}
                        tone="timeline"
                        color={item.color}
                      />
                    )}
                    {item.aliases.slice(0, 2).map((alias, index) => (
                      <SvgBadge
                        key={alias.timeline}
                        x={(node.is_head ? 48 : 0) + (node.is_branch_tip ? 36 : 0) + (item.nodeType !== "first-parent" ? 86 : 0) + (hasMultipleTimelines ? 98 : 0) + index * 96}
                        label={`also ${alias.label}`}
                        tone="neutral"
                      />
                    ))}
                  </g>
                </g>
              </g>
            );
          })}
        </g>
      </g>
    </svg>
  );
}

function buildLayout(
  nodes: GraphNode[],
  timelineMap: Map<string, TimelineMeta>,
  leftPad: number,
  nodeTypes: Map<string, HistoryGraphNodeType>,
) {
  const seen = new Set<string>();
  const primary: GraphNode[] = [];
  const aliases = new Map<string, { timeline: string; label: string }[]>();

  for (const node of nodes) {
    if (seen.has(node.id)) {
      const info = timelineMap.get(node.timeline);
      const list = aliases.get(node.id) ?? [];
      list.push({ timeline: node.timeline, label: info?.label ?? node.timeline });
      aliases.set(node.id, list);
    } else {
      seen.add(node.id);
      primary.push(node);
    }
  }

  const lanes = Array.from(new Set(primary.map((node) => renderLane(node, nodeTypes.get(node.id) ?? "first-parent")))).sort((a, b) => a - b);
  const laneMap = new Map(lanes.map((lane, index) => [lane, index]));
  const ordered = [...primary].sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
  const byId = new Map<string, LayoutNode>();
  const layoutNodes = ordered.map((node, index) => {
    const timelineInfo = timelineMap.get(node.timeline);
    const nodeType = nodeTypes.get(node.id) ?? "first-parent";
    const lane = laneMap.get(renderLane(node, nodeType)) ?? 0;
    const item: LayoutNode = {
      node,
      lane,
      x: leftPad + lane * LANE_W,
      y: TOP_PAD + index * ROW_H,
      color: laneColor(timelineInfo?.colorIndex ?? lane),
      nodeType,
      timelineLabel: timelineInfo?.label ?? node.timeline,
      aliases: aliases.get(node.id) ?? [],
    };
    byId.set(node.id, item);
    return item;
  });

  const edges = layoutNodes.flatMap((node) =>
    node.node.parents
      .map((parentId) => byId.get(parentId))
      .filter((parent): parent is LayoutNode => !!parent)
      .map((parent) => ({ from: node, to: parent })),
  );

  return {
    nodes: layoutNodes,
    edges,
    laneCount: Math.max(1, lanes.length),
  };
}

function renderLane(node: GraphNode, nodeType: HistoryGraphNodeType) {
  if (nodeType === "first-parent") return 0;
  if (nodeType === "side-ancestry") return Math.max(1, node.lane);
  if (nodeType === "remote-only") return Math.max(2, node.lane);
  return Math.max(3, node.lane);
}

function edgePath(from: LayoutNode, to: LayoutNode) {
  if (from.x === to.x) {
    return `M ${from.x} ${from.y + 8} L ${to.x} ${to.y - 8}`;
  }
  const midY = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y + 8} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y - 8}`;
}

function edgeOpacity(fromType: HistoryGraphNodeType, toType: HistoryGraphNodeType) {
  if (fromType === "first-parent" && toType === "first-parent") return 0.58;
  if (fromType === "side-ancestry" || toType === "side-ancestry") return 0.34;
  return 0.26;
}

function edgeDash(fromType: HistoryGraphNodeType, toType: HistoryGraphNodeType) {
  if (fromType === "first-parent" && toType === "first-parent") return undefined;
  return fromType === "side-ancestry" || toType === "side-ancestry" ? "5 5" : "2 6";
}

function GraphGrid({ height, lanes, leftPad }: { height: number; lanes: number; leftPad: number }) {
  return (
    <g opacity={0.42}>
      {Array.from({ length: lanes }).map((_, index) => {
        const x = leftPad + index * LANE_W;
        return (
          <line
            key={index}
            x1={x}
            x2={x}
            y1={24}
            y2={height - 24}
            stroke="rgb(var(--color-border-subtle))"
            strokeDasharray="2 10"
            strokeWidth={1}
          />
        );
      })}
    </g>
  );
}

function SvgBadge({
  x,
  label,
  tone,
  color,
}: {
  x: number;
  label: string;
  tone: "accent" | "neutral" | "timeline" | "side";
  color?: string;
}) {
  const displayLabel = tone === "timeline" ? label : truncate(label, 14);
  const width = tone === "timeline"
    ? Math.max(28, displayLabel.length * 5.8 + 10)
    : Math.min(78, Math.max(34, displayLabel.length * 6.5 + 16));
  const fill = tone === "accent"
    ? "rgb(var(--color-accent))"
    : tone === "timeline"
      ? color ?? "rgb(var(--color-accent))"
      : tone === "side"
        ? "rgb(var(--color-text-secondary))"
        : "rgb(var(--color-surface-alt))";
  const textFill = tone === "neutral" ? "rgb(var(--color-text-secondary))" : fill;

  return (
    <g transform={`translate(${x} 0)`}>
      <rect width={width} height={18} rx={9} fill={fill} fillOpacity={tone === "neutral" ? 1 : 0.13} />
      <text x={width / 2} y={12.5} textAnchor="middle" fontSize={9.5} fontWeight={650} fill={textFill}>
        {displayLabel}
      </text>
    </g>
  );
}

function nodeTypeLabel(nodeType: HistoryGraphNodeType) {
  switch (nodeType) {
    case "side-ancestry":
      return "merged history";
    case "remote-only":
      return "remote history";
    case "support-ref":
      return "recovery history";
    case "first-parent":
      return "timeline";
  }
}

function RemoteSvgBadge({ label }: { label: string }) {
  const width = remoteBadgeWidth(label);
  return (
    <g>
      <rect width={width} height={20} rx={10} fill="#10b981" fillOpacity={0.13} />
      <text x={width / 2} y={13.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#10b981">
        {label}
      </text>
    </g>
  );
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}
