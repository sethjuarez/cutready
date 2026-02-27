import { useState, useMemo } from "react";
import type { GraphNode } from "../types/sketch";

/* ── Layout constants ─────────────────────────────────────────────── */
const ROW_H = 40;         // px per commit row
const DIRTY_ROW_H = 28;   // px for dirty/ghost/alias indicator rows
const LANE_W = 16;        // px between lane centers
const GRAPH_PAD = 14;     // left padding to first lane center
const NODE_R = 5;         // regular dot radius
const HEAD_R = 6.5;       // HEAD dot radius
const STROKE_W = 2;       // rail line width

const LANE_COLORS = [
  "var(--color-accent)",      // purple — main / active
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

type RowKind = "node" | "dirty" | "ghost";
interface DisplayRow {
  kind: RowKind;
  node?: GraphNode;           // for "node" rows
  laneIdx: number;            // which lane this row's dot is on
  h: number;                  // row height
}

/* ── Compute per-node display lanes ────────────────────────────── */
// Trunk = HEAD's full ancestry + nodes ahead of HEAD on its branch.
// Shared ancestors below the fork point belong on the trunk (lane 0),
// matching `git log --graph` where the active branch is the leftmost rail.
function computeDisplayLanes(
  nodes: GraphNode[],
  headNode: GraphNode | undefined,
): { displayLane: Map<string, number>; numLanes: number } {
  const displayLane = new Map<string, number>();
  if (!headNode || nodes.length === 0) {
    for (const n of nodes) displayLane.set(n.id, 0);
    return { displayLane, numLanes: 1 };
  }

  const byId = new Map<string, GraphNode>();
  for (const n of nodes) byId.set(n.id, n);

  // Walk HEAD's ancestry
  const trunkIds = new Set<string>();
  const queue = [headNode.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (trunkIds.has(id)) continue;
    trunkIds.add(id);
    const node = byId.get(id);
    if (node) for (const pid of node.parents) if (byId.has(pid)) queue.push(pid);
  }
  // Also include nodes ahead of HEAD on the same backend lane
  for (const n of nodes) if (n.lane === headNode.lane) trunkIds.add(n.id);

  // Trunk → display lane 0
  for (const id of trunkIds) displayLane.set(id, 0);

  // Non-trunk grouped by backend lane → display lanes 1, 2, …
  const branchLaneMap = new Map<number, number>();
  let nextLane = 1;
  for (const n of nodes) {
    if (trunkIds.has(n.id)) continue;
    if (!branchLaneMap.has(n.lane)) branchLaneMap.set(n.lane, nextLane++);
    displayLane.set(n.id, branchLaneMap.get(n.lane)!);
  }

  return { displayLane, numLanes: Math.max(nextLane, 1) };
}

/* ── Sort nodes for display (trunk first, branches at fork points) ── */
function sortForDisplay(nodes: GraphNode[], displayLane: Map<string, number>): GraphNode[] {
  if (nodes.length === 0) return [];

  // Trunk = display lane 0
  const trunk = nodes
    .filter(n => displayLane.get(n.id) === 0)
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));

  // Branches = non-trunk, grouped by display lane
  const branches = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const dl = displayLane.get(n.id) ?? 0;
    if (dl === 0) continue;
    if (!branches.has(dl)) branches.set(dl, []);
    branches.get(dl)!.push(n);
  }
  for (const arr of branches.values())
    arr.sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));

  // Determine fork points: where each branch's oldest node connects to the trunk
  const trunkIds = new Set(trunk.map(n => n.id));
  const branchAtFork = new Map<string, GraphNode[][]>();
  for (const [, arr] of branches) {
    const oldest = arr[arr.length - 1];
    const forkId = oldest.parents.find(p => trunkIds.has(p));
    if (forkId) {
      if (!branchAtFork.has(forkId)) branchAtFork.set(forkId, []);
      branchAtFork.get(forkId)!.push(arr);
    }
  }

  // Build: trunk nodes with branches inserted at fork points
  const result: GraphNode[] = [];
  const placed = new Set<string>();
  for (const tn of trunk) {
    const brs = branchAtFork.get(tn.id);
    if (brs) {
      for (const br of brs)
        for (const n of br)
          if (!placed.has(n.id)) { result.push(n); placed.add(n.id); }
    }
    if (!placed.has(tn.id)) { result.push(tn); placed.add(tn.id); }
  }
  for (const n of nodes) if (!placed.has(n.id)) result.push(n);
  return result;
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
  nodes: rawNodes, isDirty, isRewound, timelineMap, hasMultipleTimelines, onNodeClick,
}: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  /* ── Separate primary nodes from alias nodes ──── */
  const { primaryNodes, aliases } = useMemo(() => {
    const seen = new Set<string>();
    const primary: GraphNode[] = [];
    const aliasMap = new Map<string, { timeline: string; lane: number }[]>();
    for (const n of rawNodes) {
      if (seen.has(n.id)) {
        if (!aliasMap.has(n.id)) aliasMap.set(n.id, []);
        aliasMap.get(n.id)!.push({ timeline: n.timeline, lane: n.lane });
      } else {
        seen.add(n.id);
        primary.push(n);
      }
    }
    return { primaryNodes: primary, aliases: aliasMap };
  }, [rawNodes]);

  const headNode = primaryNodes.find(n => n.is_head);

  const { displayLane, numLanes } = useMemo(
    () => computeDisplayLanes(primaryNodes, headNode),
    [primaryNodes, headNode],
  );
  const sorted = useMemo(() => sortForDisplay(primaryNodes, displayLane), [primaryNodes, displayLane]);

  /* ── Build display rows ─────────────────────────── */
  const rows: DisplayRow[] = useMemo(() => {
    const result: DisplayRow[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      const dl = displayLane.get(n.id) ?? 0;

      // Ghost row above HEAD (rewound + dirty)
      if (n.is_head && isDirty && isRewound) {
        result.push({ kind: "ghost", laneIdx: dl + 1, h: DIRTY_ROW_H });
      }
      // Dirty row above HEAD (not rewound)
      if (n.is_head && isDirty && !isRewound) {
        result.push({ kind: "dirty", laneIdx: dl, h: DIRTY_ROW_H });
      }

      result.push({ kind: "node", node: n, laneIdx: dl, h: ROW_H });
    }
    return result;
  }, [sorted, displayLane, numLanes, isDirty, isRewound, aliases]);

  const graphW = GRAPH_PAD + (numLanes || 1) * LANE_W + 4;

  /* ── empty state ─────────────────────────────── */
  if (sorted.length === 0 && !isDirty) {
    return (
      <div className="px-3 py-8 text-center">
        <div className="text-[var(--color-text-secondary)] text-xs">No snapshots yet</div>
        <div className="text-[var(--color-text-secondary)]/60 text-[10px] mt-1">
          Save a snapshot of the entire project
        </div>
      </div>
    );
  }

  /* ── Compute y midpoints for each row ──────── */
  let totalH = 0;
  const rowTops: number[] = [];
  for (const r of rows) {
    rowTops.push(totalH);
    totalH += r.h;
  }
  function rowCy(i: number) { return rowTops[i] + rows[i].h / 2; }
  function laneX(l: number) { return GRAPH_PAD + l * LANE_W; }

  /* ── Build SVG paths: rails + connectors ──────── */
  // For each node row, we need:
  // 1. A vertical rail from this node to its parent node (if on same lane)
  // 2. A curved connector if parent is on a different lane
  const nodeRowIdx = new Map<string, number>(); // node.id → row index
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === "node" && rows[i].node) {
      nodeRowIdx.set(rows[i].node!.id, i);
    }
  }

  type SvgPath = { d: string; color: string; opacity: number; dashed?: boolean };
  const paths: SvgPath[] = [];

  // Draw vertical rail segments + branch connectors
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind !== "node" || !row.node) continue;

    for (const pid of row.node.parents) {
      const pi = nodeRowIdx.get(pid);
      if (pi === undefined) continue;

      const parentRow = rows[pi];
      const childLane = row.laneIdx;
      const parentLane = parentRow.laneIdx;
      const cx = laneX(childLane);
      const px = laneX(parentLane);
      const cy = rowCy(i);
      const py = rowCy(pi);
      const color = lc(childLane);

      if (childLane === parentLane) {
        // Same lane: straight vertical line
        paths.push({
          d: `M ${cx} ${cy + NODE_R} L ${px} ${py - NODE_R}`,
          color, opacity: 0.7,
        });
      } else {
        // Different lanes: smooth S-curve bezier (like git log --graph)
        paths.push({
          d: `M ${cx} ${cy + NODE_R} C ${cx} ${(cy + py) / 2}, ${px} ${(cy + py) / 2}, ${px} ${py - NODE_R}`,
          color, opacity: 0.6,
        });
      }
    }
  }

  // Dirty → HEAD connector
  const dirtyRowIdx = rows.findIndex(r => r.kind === "dirty");
  const headRowIdx = rows.findIndex(r => r.kind === "node" && r.node?.is_head);
  if (dirtyRowIdx >= 0 && headRowIdx >= 0) {
    const dx = laneX(rows[dirtyRowIdx].laneIdx);
    paths.push({
      d: `M ${dx} ${rowCy(dirtyRowIdx) + 4} L ${dx} ${rowCy(headRowIdx) - HEAD_R}`,
      color: "var(--color-text-secondary)", opacity: 0.4, dashed: true,
    });
  }

  // Ghost → HEAD connector (curved, branching off)
  const ghostRowIdx = rows.findIndex(r => r.kind === "ghost");
  if (ghostRowIdx >= 0 && headRowIdx >= 0) {
    const gx = laneX(rows[ghostRowIdx].laneIdx);
    const hx = laneX(rows[headRowIdx].laneIdx);
    const gy = rowCy(ghostRowIdx);
    const hy = rowCy(headRowIdx);
    paths.push({
      d: `M ${hx + HEAD_R} ${hy} Q ${gx} ${hy}, ${gx} ${gy + 4}`,
      color: lc(rows[headRowIdx].laneIdx), opacity: 0.5, dashed: true,
    });
  }

  /* ── Render ──────────────────────────────────── */
  return (
    <div className="relative" style={{ minHeight: totalH }}>
      {/* SVG graph layer */}
      <svg
        className="absolute top-0 left-0"
        width={graphW}
        height={totalH}
        style={{ pointerEvents: "none", zIndex: 1 }}
      >
        {paths.map((p, i) => (
          <path key={i} d={p.d} stroke={p.color} strokeWidth={STROKE_W}
            strokeOpacity={p.opacity} fill="none"
            strokeDasharray={p.dashed ? "3 2" : undefined}
            strokeLinecap="round" />
        ))}
      </svg>

      {/* Row content */}
      {rows.map((row) => {
        if (row.kind === "dirty") {
          const x = laneX(row.laneIdx);
          return (
            <div key="dirty" className="flex items-center overflow-hidden" style={{ height: row.h }}>
              <div className="shrink-0 relative" style={{ width: graphW, height: row.h }}>
                <div className="absolute rounded-full border-[1.5px] border-dashed"
                  style={{
                    left: x - 4, top: "50%", transform: "translateY(-50%)",
                    width: 8, height: 8, borderColor: "var(--color-text-secondary)", opacity: 0.5,
                    backgroundColor: "var(--color-surface)", zIndex: 2,
                  }} />
              </div>
              <div className="flex-1 min-w-0 pr-2">
                <span className="text-[10px] italic text-[var(--color-text-secondary)]/70">Unsaved changes</span>
              </div>
            </div>
          );
        }

        if (row.kind === "ghost") {
          const x = laneX(row.laneIdx);
          const headColor = lc(0); // trunk is always lane 0
          return (
            <div key="ghost" className="flex items-center overflow-hidden" style={{ height: row.h }}>
              <div className="shrink-0 relative" style={{ width: graphW, height: row.h }}>
                <div className="absolute rounded-full border-[1.5px] border-dashed"
                  style={{
                    left: x - 3.5, top: "50%", transform: "translateY(-50%)",
                    width: 7, height: 7, borderColor: headColor, opacity: 0.5,
                    backgroundColor: "var(--color-surface)", zIndex: 2,
                  }} />
              </div>
              <div className="flex-1 min-w-0 pr-2 flex items-center gap-1">
                <span className="text-[10px] italic text-[var(--color-text-secondary)]/70">New direction</span>
                <span className="text-[9px] px-1 py-px rounded-sm bg-amber-500/10 text-amber-500">branching</span>
              </div>
            </div>
          );
        }

        // ── Node row ──
        const node = row.node!;
        const dl = row.laneIdx;
        const x = laneX(dl);
        const color = lc(dl);
        const r = node.is_head ? HEAD_R : NODE_R;
        const isHov = hovered === node.id;
        const tlInfo = timelineMap.get(node.timeline);
        const tlLabel = tlInfo?.label ?? node.timeline;
        const nodeAliases = aliases.get(node.id);

        return (
          <div key={node.id}
            className="flex items-center group overflow-hidden"
            style={{ height: row.h }}
            onMouseEnter={() => !node.is_head && setHovered(node.id)}
            onMouseLeave={() => setHovered(null)}
          >
            {/* Graph column: dot */}
            <div className="shrink-0 relative" style={{ width: graphW, height: row.h }}>
              {/* HEAD ring */}
              {node.is_head && (
                <div className="absolute rounded-full"
                  style={{
                    left: x - r - 3, top: "50%", transform: "translateY(-50%)",
                    width: (r + 3) * 2, height: (r + 3) * 2,
                    border: `1px solid ${color}`, opacity: 0.3, zIndex: 2,
                  }} />
              )}
              {/* Dot */}
              <button className="absolute rounded-full transition-colors"
                style={{
                  left: x - r, top: "50%", transform: "translateY(-50%)",
                  width: r * 2, height: r * 2,
                  backgroundColor: node.is_head || isHov ? color : "var(--color-surface)",
                  border: `2px solid ${color}`,
                  boxShadow: "0 0 0 2px var(--color-surface)",
                  cursor: node.is_head ? "default" : "pointer",
                  zIndex: 3, padding: 0,
                }}
                onClick={() => onNodeClick(node.id, node.is_head)}
                title={node.is_head ? "Current snapshot (HEAD)" : `Navigate to: ${node.message}`}
              />
            </div>
            {/* Label column */}
            <div
              className={`flex-1 min-w-0 pr-2 flex flex-col justify-center ${!node.is_head ? "cursor-pointer" : ""}`}
              onClick={() => !node.is_head && onNodeClick(node.id, node.is_head)}
            >
              <div className={`text-xs truncate leading-tight transition-colors ${
                node.is_head ? "font-medium text-[var(--color-text)]"
                  : isHov ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)]"
              }`}>{node.message}</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-[var(--color-text-secondary)]/50">{fmtDate(node.timestamp)}</span>
                {hasMultipleTimelines && (
                  <span className="text-[9px] px-1 py-px rounded-sm leading-tight"
                    style={{ color, backgroundColor: `${color}15` }}>{tlLabel}</span>
                )}
                {nodeAliases && nodeAliases.map(a => {
                  const aInfo = timelineMap.get(a.timeline);
                  const aLabel = aInfo?.label ?? a.timeline;
                  return (
                    <span key={a.timeline} className="text-[9px] px-1 py-px rounded-sm leading-tight text-[var(--color-text-secondary)]/50"
                      style={{ backgroundColor: "var(--color-surface-alt)" }}>+{aLabel}</span>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
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
