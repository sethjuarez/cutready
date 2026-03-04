import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { GraphNode, TimelineInfo } from "../types/sketch";

/**
 * HistoryGraphTab — Full DAG visualization of the entire git history.
 * This is a singleton tab that shows all timelines, merge points, and
 * allows navigation (checkout) to any snapshot.
 */

/* ── Layout constants ─────────────────────────────────────────────── */
const ROW_H = 48;
const LANE_W = 28;
const GRAPH_LEFT_PAD = 24;
const NODE_R = 6;
const HEAD_R = 8;
const STROKE_W = 2.5;
const TEXT_LEFT_OFFSET = 12;
const BADGE_H = 18;

const LANE_COLORS = [
  "var(--color-accent)",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#3b82f6",
  "#ec4899",
  "#14b8a6",
  "#8b5cf6",
];
function lc(i: number) { return LANE_COLORS[i % LANE_COLORS.length]; }

export function HistoryGraphTab() {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const timelines = useAppStore((s) => s.timelines);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const switchTimeline = useAppStore((s) => s.switchTimeline);

  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Load data on mount
  useEffect(() => {
    loadGraphData();
    loadTimelines();
  }, [loadGraphData, loadTimelines]);

  const handleNodeClick = useCallback(async (node: GraphNode) => {
    try {
      await navigateToSnapshot(node.id);
      await loadGraphData();
    } catch (err) {
      console.error("Navigation failed:", err);
    }
  }, [navigateToSnapshot, loadGraphData]);

  // Build timeline map for labels
  const timelineMap = useMemo(() => {
    const m = new Map<string, TimelineInfo>();
    for (const t of timelines) m.set(t.name, t);
    return m;
  }, [timelines]);

  // Compute layout
  const { rows, lanes, edges } = useMemo(() =>
    computeDAGLayout(graphNodes, timelineMap),
    [graphNodes, timelineMap]
  );

  const numLanes = lanes + 1;
  const graphWidth = GRAPH_LEFT_PAD + numLanes * LANE_W;
  const totalHeight = rows.length * ROW_H;
  const svgWidth = Math.max(graphWidth + 420, 600);

  if (graphNodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)]">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-30 mb-3">
          <circle cx="12" cy="12" r="3" /><line x1="12" y1="3" x2="12" y2="9" /><line x1="12" y1="15" x2="12" y2="21" />
          <line x1="3" y1="12" x2="9" y2="12" /><line x1="15" y1="12" x2="21" y2="12" />
        </svg>
        <p className="text-xs">No snapshots yet</p>
        <p className="text-[10px] opacity-60 mt-1">Save your first snapshot to see the history graph</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="3" x2="12" y2="9" />
          <line x1="12" y1="15" x2="12" y2="21" />
        </svg>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">History</h2>
        <span className="text-[10px] text-[var(--color-text-secondary)]">
          {graphNodes.length} snapshot{graphNodes.length !== 1 ? "s" : ""} · {timelines.length} timeline{timelines.length !== 1 ? "s" : ""}
        </span>

        {/* Legend */}
        <div className="flex-1" />
        <div className="flex items-center gap-3">
          {timelines.map((t) => (
            <button
              key={t.name}
              onClick={() => switchTimeline(t.name)}
              className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
              title={`Switch to ${t.label}`}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: lc(t.color_index) }}
              />
              <span className={t.is_active ? "font-medium text-[var(--color-text)]" : ""}>
                {t.label}
              </span>
              {t.is_active && <span className="text-[8px] opacity-50">(active)</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Graph */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        <svg
          width={svgWidth}
          height={totalHeight + 32}
          className="select-none"
        >
          {/* Edge lines (drawn first, behind nodes) */}
          {edges.map((edge, i) => (
            <path
              key={i}
              d={edge.d}
              fill="none"
              stroke={edge.color}
              strokeWidth={STROKE_W}
              opacity={0.5}
            />
          ))}

          {/* Nodes */}
          {rows.map((row, i) => {
            const y = i * ROW_H + ROW_H / 2;
            const x = GRAPH_LEFT_PAD + row.lane * LANE_W;
            const color = lc(row.colorIndex);
            const isHead = row.node.is_head;
            const isHovered = hoveredNode === row.node.id;
            const r = isHead ? HEAD_R : NODE_R;

            return (
              <g
                key={row.node.id}
                onMouseEnter={() => setHoveredNode(row.node.id)}
                onMouseLeave={() => setHoveredNode(null)}
                onClick={() => handleNodeClick(row.node)}
                style={{ cursor: "pointer" }}
              >
                {/* Node circle */}
                <circle
                  cx={x}
                  cy={y}
                  r={isHovered ? r + 2 : r}
                  fill={isHead ? color : "var(--color-surface)"}
                  stroke={color}
                  strokeWidth={isHead ? 3 : 2}
                />

                {/* HEAD indicator ring */}
                {isHead && (
                  <circle
                    cx={x}
                    cy={y}
                    r={r + 4}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                    opacity={0.6}
                  />
                )}

                {/* Remote tip indicator */}
                {row.node.is_remote_tip && (
                  <g>
                    <rect
                      x={x + r + 3}
                      y={y - 7}
                      width={38}
                      height={14}
                      rx={3}
                      fill="var(--color-surface)"
                      stroke="var(--color-border)"
                      strokeWidth={0.5}
                    />
                    <text
                      x={x + r + 7}
                      y={y + 1}
                      dominantBaseline="middle"
                      className="text-[7px]"
                      fill="var(--color-text-secondary)"
                      fontWeight={500}
                    >
                      origin
                    </text>
                  </g>
                )}

                {/* Commit message */}
                <text
                  x={graphWidth + TEXT_LEFT_OFFSET}
                  y={y + 1}
                  dominantBaseline="middle"
                  className="text-[11px]"
                  fill={isHead ? "var(--color-text)" : "var(--color-text-secondary)"}
                  fontWeight={isHead ? 600 : 400}
                >
                  {row.node.message.length > 50
                    ? row.node.message.substring(0, 50) + "…"
                    : row.node.message}
                </text>

                {/* Timestamp */}
                <text
                  x={graphWidth + TEXT_LEFT_OFFSET + 340}
                  y={y + 1}
                  dominantBaseline="middle"
                  className="text-[9px]"
                  fill="var(--color-text-secondary)"
                  opacity={0.6}
                >
                  {formatTimestamp(row.node.timestamp)}
                </text>

                {/* Branch tip badge */}
                {row.node.is_branch_tip && (
                  <g>
                    <rect
                      x={graphWidth + TEXT_LEFT_OFFSET - 2}
                      y={y - ROW_H / 2 + 2}
                      width={row.branchLabel ? row.branchLabel.length * 5.5 + 12 : 30}
                      height={BADGE_H}
                      rx={4}
                      fill={color}
                      opacity={0.15}
                    />
                    <text
                      x={graphWidth + TEXT_LEFT_OFFSET + 4}
                      y={y - ROW_H / 2 + 2 + BADGE_H / 2}
                      dominantBaseline="middle"
                      className="text-[8px]"
                      fill={color}
                      fontWeight={600}
                    >
                      {row.branchLabel ?? row.node.timeline}
                    </text>
                  </g>
                )}

                {/* Short hash */}
                <text
                  x={x}
                  y={y + r + 11}
                  textAnchor="middle"
                  className="text-[7px]"
                  fill="var(--color-text-secondary)"
                  opacity={isHovered ? 0.8 : 0}
                >
                  {row.node.id.substring(0, 7)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/* ── DAG Layout Engine ─────────────────────────────────────────────── */

interface LayoutRow {
  node: GraphNode;
  lane: number;
  colorIndex: number;
  branchLabel?: string;
}

interface LayoutEdge {
  d: string;
  color: string;
}

function computeDAGLayout(
  nodes: GraphNode[],
  timelineMap: Map<string, TimelineInfo>,
): { rows: LayoutRow[]; lanes: number; edges: LayoutEdge[]; branchLabels: string[] } {
  if (nodes.length === 0) {
    return { rows: [], lanes: 0, edges: [], branchLabels: [] };
  }

  // Nodes come sorted newest-first from the backend
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // Assign lanes based on timeline
  const timelineLanes = new Map<string, number>();
  let nextLane = 0;

  // Active timeline gets lane 0
  const activeTimeline = [...timelineMap.values()].find((t) => t.is_active);
  if (activeTimeline) {
    timelineLanes.set(activeTimeline.name, 0);
    nextLane = 1;
  }

  // Sort remaining timelines by name (main first if not active)
  const otherTimelines = [...timelineMap.values()]
    .filter((t) => !t.is_active)
    .sort((a, b) => {
      if (a.name === "main") return -1;
      if (b.name === "main") return 1;
      return a.name.localeCompare(b.name);
    });

  for (const t of otherTimelines) {
    if (!timelineLanes.has(t.name)) {
      timelineLanes.set(t.name, nextLane++);
    }
  }

  // Build rows
  const rows: LayoutRow[] = [];
  const nodeIndex = new Map<string, number>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const timeline = node.timeline || "main";
    let lane = timelineLanes.get(timeline);
    if (lane === undefined) {
      lane = nextLane++;
      timelineLanes.set(timeline, lane);
    }

    const tInfo = timelineMap.get(timeline);
    const colorIndex = tInfo?.color_index ?? lane;
    const branchLabel = node.is_branch_tip ? (tInfo?.label ?? timeline) : undefined;

    rows.push({ node, lane, colorIndex, branchLabel });
    nodeIndex.set(node.id, i);
  }

  // Build edges (parent connections)
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const y1 = i * ROW_H + ROW_H / 2;
    const x1 = GRAPH_LEFT_PAD + row.lane * LANE_W;

    for (const parentId of row.node.parents) {
      const parentIdx = nodeIndex.get(parentId);
      if (parentIdx === undefined) continue;

      const parentRow = rows[parentIdx];
      const y2 = parentIdx * ROW_H + ROW_H / 2;
      const x2 = GRAPH_LEFT_PAD + parentRow.lane * LANE_W;

      const color = lc(row.colorIndex);

      if (x1 === x2) {
        // Same lane — straight line
        edges.push({ d: `M ${x1} ${y1} L ${x2} ${y2}`, color });
      } else {
        // Different lane — curved line (merge or fork)
        const midY = (y1 + y2) / 2;
        edges.push({
          d: `M ${x1} ${y1} C ${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`,
          color,
        });
      }
    }
  }

  const branchLabels = [...timelineLanes.keys()];

  return {
    rows,
    lanes: nextLane > 0 ? nextLane - 1 : 0,
    edges,
    branchLabels,
  };
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return ts;
  }
}
