import { useState } from "react";
import type { GraphNode } from "../types/sketch";

/* ── Layout constants ─────────────────────────────────────────────── */
const LANE_W = 24;       // px between lane centres
const ROW_H = 44;        // px per commit row
const DIRTY_H = 30;      // px for dirty-indicator row
const GHOST_H = 30;      // px for ghost-branch row
const PAD_L = 18;        // left edge → lane-0 centre
const PAD_T = 8;         // top padding
const PAD_B = 8;         // bottom padding
const NODE_R = 4;        // regular dot radius
const HEAD_R = 5.5;      // HEAD dot radius
const LABEL_GAP = 14;    // last lane centre → text start

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

function lc(i: number) { return LANE_COLORS[i % LANE_COLORS.length]; }

/* ── Types ────────────────────────────────────────────────────────── */
interface TimelineInfo { label: string; colorIndex: number }

interface VisualRow {
  kind: "dirty" | "node" | "ghost";
  nodeIdx?: number;
  cx: number;     // circle centre X
  cy: number;     // circle centre Y
  h: number;      // row height
  top: number;    // row top Y
}

interface Edge {
  d: string;
  color: string;
  dashed?: boolean;
  opacity: number;
}

/* ── Props ────────────────────────────────────────────────────────── */
interface Props {
  nodes: GraphNode[];
  isDirty: boolean;
  isRewound: boolean;
  timelineMap: Map<string, TimelineInfo>;
  hasMultipleTimelines: boolean;
  onNodeClick: (commitId: string, isHead: boolean) => void;
}

/* ── Component ────────────────────────────────────────────────────── */
export function SnapshotGraph({
  nodes, isDirty, isRewound, timelineMap, hasMultipleTimelines, onNodeClick,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  /* ── empty state ─────────────────────────────── */
  if (nodes.length === 0 && !isDirty) {
    return (
      <div className="px-3 py-8 text-center">
        <div className="text-[var(--color-text-secondary)] text-xs">No snapshots yet</div>
        <div className="text-[var(--color-text-secondary)]/60 text-[10px] mt-1">
          Save a snapshot of the entire project
        </div>
      </div>
    );
  }

  /* ── lane metrics ────────────────────────────── */
  const maxNodeLane = nodes.length > 0 ? Math.max(...nodes.map(n => n.lane)) : 0;
  const headIdx     = nodes.findIndex(n => n.is_head);
  const showGhost   = isDirty && isRewound && headIdx >= 0;
  const ghostLane   = showGhost ? nodes[headIdx].lane + 1 : 0;
  const maxLane     = Math.max(maxNodeLane, showGhost ? ghostLane : 0);
  const graphColW   = PAD_L + maxLane * LANE_W + LABEL_GAP;

  /* ── build visual rows (dirty / node / ghost) ── */
  const rows: VisualRow[] = [];
  let y = PAD_T;

  // non-rewound dirty indicator at top
  if (isDirty && !isRewound && nodes.length > 0) {
    const lane = headIdx >= 0 ? nodes[headIdx].lane : nodes[0].lane;
    rows.push({ kind: "dirty", cx: PAD_L + lane * LANE_W, cy: y + DIRTY_H / 2, h: DIRTY_H, top: y });
    y += DIRTY_H;
  }

  for (let i = 0; i < nodes.length; i++) {
    // ghost row goes ABOVE HEAD (new direction points forward/up in time)
    if (nodes[i].is_head && showGhost) {
      rows.push({ kind: "ghost", cx: PAD_L + ghostLane * LANE_W, cy: y + GHOST_H / 2, h: GHOST_H, top: y });
      y += GHOST_H;
    }
    rows.push({ kind: "node", nodeIdx: i, cx: PAD_L + nodes[i].lane * LANE_W, cy: y + ROW_H / 2, h: ROW_H, top: y });
    y += ROW_H;
  }

  const totalH = y + PAD_B;

  /* ── node-row lookup ─────────────────────────── */
  const nodeRow = new Map<number, VisualRow>();
  for (const r of rows) if (r.kind === "node" && r.nodeIdx !== undefined) nodeRow.set(r.nodeIdx, r);

  /* ── edges ───────────────────────────────────── */
  const idIdx = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: Edge[] = [];

  // parent–child edges
  for (let i = 0; i < nodes.length; i++) {
    const cr = nodeRow.get(i);
    if (!cr) continue;
    for (const pid of nodes[i].parents) {
      const pi = idIdx.get(pid);
      if (pi === undefined) continue;
      const pr = nodeRow.get(pi);
      if (!pr) continue;

      const childR = nodes[i].is_head ? HEAD_R : NODE_R;
      const parR   = nodes[pi].is_head ? HEAD_R : NODE_R;
      let d: string;
      if (Math.abs(cr.cx - pr.cx) < 1) {
        // same lane → straight
        d = `M ${cr.cx} ${cr.cy + childR} L ${pr.cx} ${pr.cy - parR}`;
      } else {
        // cross-lane → cubic bezier (S-curve)
        const dy  = pr.cy - cr.cy;
        const cp1 = cr.cy + dy * 0.4;
        const cp2 = pr.cy - dy * 0.4;
        d = `M ${cr.cx} ${cr.cy + childR} C ${cr.cx} ${cp1}, ${pr.cx} ${cp2}, ${pr.cx} ${pr.cy - parR}`;
      }
      edges.push({ d, color: lc(nodes[i].lane), opacity: 0.3 });
    }
  }

  // dirty → first-node dashed connector
  const dirtyRow = rows.find(r => r.kind === "dirty");
  const firstNR  = nodeRow.get(0);
  if (dirtyRow && firstNR) {
    edges.push({
      d: `M ${dirtyRow.cx} ${dirtyRow.cy + 4} L ${firstNR.cx} ${firstNR.cy - NODE_R}`,
      color: "var(--color-text-secondary)", dashed: true, opacity: 0.25,
    });
  }

  // HEAD → ghost branch-off curve (ghost is ABOVE head, branching upward)
  // Stored separately so it renders on top of nodes (above box-shadow)
  const ghostR = rows.find(r => r.kind === "ghost");
  const headR  = headIdx >= 0 ? nodeRow.get(headIdx) : undefined;
  let ghostEdge: Edge | null = null;
  if (ghostR && headR) {
    const dx = ghostR.cx - headR.cx;
    const dy = ghostR.cy - headR.cy;  // negative (ghost is above)
    ghostEdge = {
      d: `M ${headR.cx + HEAD_R} ${headR.cy} C ${headR.cx + dx * 0.5} ${headR.cy}, ${ghostR.cx} ${ghostR.cy - dy * 0.5}, ${ghostR.cx} ${ghostR.cy + 4}`,
      color: lc(nodes[headIdx].lane), dashed: true, opacity: 0.35,
    };
  }

  /* ── render ──────────────────────────────────── */
  return (
    <div className="relative" style={{ minHeight: totalH, paddingTop: PAD_T, paddingBottom: PAD_B }}>
      {/* SVG edge layer (behind everything) */}
      <svg
        className="absolute top-0 left-0"
        width={graphColW + 4}
        height={totalH}
        style={{ pointerEvents: "none", zIndex: 0 }}
      >
        {edges.map((e, i) => (
          <path
            key={i}
            d={e.d}
            stroke={e.color}
            strokeWidth={1.5}
            strokeOpacity={e.opacity}
            fill="none"
            strokeDasharray={e.dashed ? "4 3" : undefined}
            strokeLinecap="round"
          />
        ))}
      </svg>

      {/* Visual rows */}
      {rows.map((row) => {
        /* ── dirty indicator ─────────────────── */
        if (row.kind === "dirty") {
          return (
            <div key="dirty" className="flex items-center" style={{ height: row.h }}>
              <div className="shrink-0 relative flex items-center" style={{ width: graphColW }}>
                <div
                  className="absolute rounded-full border-[1.5px] border-dashed"
                  style={{
                    left: row.cx - 4, top: "50%", transform: "translateY(-50%)",
                    width: 8, height: 8,
                    borderColor: "var(--color-text-secondary)", opacity: 0.6,
                    backgroundColor: "var(--color-surface)",
                    boxShadow: "0 0 0 2px var(--color-surface)",
                    zIndex: 1,
                  }}
                />
              </div>
              <div className="flex-1 min-w-0 pr-3">
                <span className="text-[11px] italic text-[var(--color-text-secondary)]">
                  Unsaved changes
                </span>
              </div>
            </div>
          );
        }

        /* ── ghost branch node ───────────────── */
        if (row.kind === "ghost") {
          const headColor = lc(nodes[headIdx]?.lane ?? 0);
          return (
            <div key="ghost" className="flex items-center" style={{ height: row.h }}>
              <div className="shrink-0 relative flex items-center" style={{ width: graphColW }}>
                <div
                  className="absolute rounded-full border-[1.5px] border-dashed"
                  style={{
                    left: row.cx - 3.5, top: "50%", transform: "translateY(-50%)",
                    width: 7, height: 7,
                    borderColor: headColor, opacity: 0.5,
                    backgroundColor: "var(--color-surface)", zIndex: 1,
                  }}
                />
              </div>
              <div className="flex-1 min-w-0 pr-3 flex items-center gap-1.5">
                <span className="text-[11px] italic text-[var(--color-text-secondary)]">
                  New direction
                </span>
                <span className="text-[9px] px-1 py-px rounded-sm bg-amber-500/10 text-amber-500">
                  branching
                </span>
              </div>
            </div>
          );
        }

        /* ── commit node ─────────────────────── */
        const node  = nodes[row.nodeIdx!];
        const color = lc(node.lane);
        const r     = node.is_head ? HEAD_R : NODE_R;
        const isHov = hovered === node.id;
        const tlInfo = timelineMap.get(node.timeline);
        const tlLabel = tlInfo?.label ?? node.timeline;

        return (
          <div
            key={node.id}
            className="flex items-center group"
            style={{ height: row.h }}
            onMouseEnter={() => !node.is_head && setHovered(node.id)}
            onMouseLeave={() => setHovered(null)}
          >
            {/* graph column */}
            <div className="shrink-0 relative flex items-center" style={{ width: graphColW }}>
              {/* HEAD glow ring */}
              {node.is_head && (
                <div
                  className="absolute rounded-full"
                  style={{
                    left: row.cx - r - 3, top: "50%", transform: "translateY(-50%)",
                    width: (r + 3) * 2, height: (r + 3) * 2,
                    border: `1px solid ${color}`, opacity: 0.25, zIndex: 1,
                  }}
                />
              )}
              {/* node dot */}
              <button
                className="absolute rounded-full transition-colors"
                style={{
                  left: row.cx - r, top: "50%", transform: "translateY(-50%)",
                  width: r * 2, height: r * 2,
                  backgroundColor: node.is_head || isHov ? color : "var(--color-surface)",
                  border: `2px solid ${color}`,
                  boxShadow: "0 0 0 2px var(--color-surface)",
                  cursor: node.is_head ? "default" : "pointer",
                  zIndex: 2, padding: 0,
                }}
                onClick={() => onNodeClick(node.id, node.is_head)}
                title={node.is_head ? "Current snapshot (HEAD)" : `Navigate to: ${node.message}`}
              />
            </div>

            {/* label */}
            <div
              className={`flex-1 min-w-0 pr-3 flex flex-col justify-center ${!node.is_head ? "cursor-pointer" : ""}`}
              onClick={() => !node.is_head && onNodeClick(node.id, node.is_head)}
            >
              <div className={`text-xs truncate transition-colors ${
                node.is_head
                  ? "font-medium text-[var(--color-text)]"
                  : isHov ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}>
                {node.message}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] text-[var(--color-text-secondary)]/70">
                  {fmtDate(node.timestamp)}
                </span>
                {hasMultipleTimelines && (
                  <span
                    className="text-[9px] px-1 py-px rounded-sm"
                    style={{ color, backgroundColor: `${color}15` }}
                  >
                    {tlLabel}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Ghost branch edge — rendered ON TOP of nodes so it's not hidden by box-shadow */}
      {ghostEdge && (
        <svg
          className="absolute top-0 left-0"
          width={graphColW + 4}
          height={totalH}
          style={{ pointerEvents: "none", zIndex: 3 }}
        >
          <path
            d={ghostEdge.d}
            stroke={ghostEdge.color}
            strokeWidth={1.5}
            strokeOpacity={ghostEdge.opacity}
            fill="none"
            strokeDasharray="4 3"
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  );
}

/* ── helpers ───────────────────────────────────────────────────────── */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24);
  if (dd < 7) return `${dd}d ago`;
  return d.toLocaleDateString();
}
