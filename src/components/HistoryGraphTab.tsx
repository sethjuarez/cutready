import * as d3 from "d3";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { GraphNode, TimelineInfo } from "../types/sketch";

/**
 * HistoryGraphTab — Full DAG visualization using topological sort + git-style
 * rail lane assignment. d3 for zoom/pan, vertical/horizontal toggle.
 */

/* ── Types ────────────────────────────────────────────────────────── */

type LayoutDir = "vertical" | "horizontal";

interface LayoutNode {
  node: GraphNode;
  col: number;
  row: number;
  x: number;
  y: number;
  colorIndex: number;
  branchLabels: string[];
}

interface LayoutEdge {
  d: string;
  color: string;
}

/* ── Constants ────────────────────────────────────────────────────── */

const ROW_GAP = 36;
const LANE_GAP = 24;
const PAD = 32;
const NODE_R = 5;
const HEAD_R = 7;

const LANE_COLORS = [
  "var(--color-accent)", "#10b981", "#f59e0b", "#ef4444",
  "#3b82f6", "#ec4899", "#14b8a6", "#8b5cf6",
];
const lc = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

/* ── DAG Layout Engine ────────────────────────────────────────────── */

function computeLayout(
  rawNodes: GraphNode[],
  timelineMap: Map<string, TimelineInfo>,
  dir: LayoutDir,
): { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number } {
  if (rawNodes.length === 0)
    return { nodes: [], edges: [], width: 0, height: 0 };

  /* 1. Deduplicate, collect branch labels */
  const uniqueMap = new Map<string, GraphNode>();
  const tipLabels = new Map<string, string[]>();
  for (const n of rawNodes) {
    if (!uniqueMap.has(n.id)) uniqueMap.set(n.id, n);
    if (n.is_branch_tip) {
      if (!tipLabels.has(n.id)) tipLabels.set(n.id, []);
      const t = timelineMap.get(n.timeline);
      tipLabels.get(n.id)!.push(t?.label ?? n.timeline);
    }
  }
  const deduped = [...uniqueMap.values()];
  const nodeMap = new Map<string, GraphNode>();
  for (const n of deduped) nodeMap.set(n.id, n);

  /* 2. Topological sort (Kahn's) — tips first */
  const inDeg = new Map<string, number>();
  for (const n of deduped) inDeg.set(n.id, 0);
  for (const n of deduped) {
    for (const pid of n.parents) {
      if (inDeg.has(pid)) inDeg.set(pid, inDeg.get(pid)! + 1);
    }
  }

  const ready = deduped.filter((n) => inDeg.get(n.id) === 0);
  const sortPriority = (arr: GraphNode[]) =>
    arr.sort((a, b) => {
      const aa = timelineMap.get(a.timeline)?.is_active ? 0 : 1;
      const ba = timelineMap.get(b.timeline)?.is_active ? 0 : 1;
      if (aa !== ba) return aa - ba;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
  sortPriority(ready);

  const sorted: GraphNode[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    sorted.push(n);
    for (const pid of n.parents) {
      if (!inDeg.has(pid)) continue;
      const nd = inDeg.get(pid)! - 1;
      inDeg.set(pid, nd);
      if (nd === 0) {
        ready.push(nodeMap.get(pid)!);
        sortPriority(ready);
      }
    }
  }

  /* 3. Git-style rail lane assignment */
  const cols: (string | null)[] = [];
  const nodeCol = new Map<string, number>();
  const freeCol = () => {
    const i = cols.indexOf(null);
    if (i >= 0) return i;
    cols.push(null);
    return cols.length - 1;
  };

  for (const node of sorted) {
    const expecting: number[] = [];
    for (let c = 0; c < cols.length; c++) {
      if (cols[c] === node.id) expecting.push(c);
    }
    let col: number;
    if (expecting.length > 0) {
      col = expecting[0];
      for (let i = 1; i < expecting.length; i++) cols[expecting[i]] = null;
    } else {
      col = freeCol();
    }
    cols[col] = node.parents.length > 0 ? node.parents[0] : null;
    for (let p = 1; p < node.parents.length; p++) {
      const pid = node.parents[p];
      if (!cols.includes(pid)) cols[freeCol()] = pid;
    }
    nodeCol.set(node.id, col);
  }

  /* 4. Coordinates */
  const maxCol = Math.max(0, ...Array.from(nodeCol.values()));
  const maxRow = sorted.length - 1;

  const layoutNodes: LayoutNode[] = sorted.map((node, row) => {
    const col = nodeCol.get(node.id)!;
    const tInfo = timelineMap.get(node.timeline);
    const colorIndex = tInfo?.color_index ?? col;

    const [x, y] = dir === "vertical"
      ? [PAD + col * LANE_GAP, PAD + row * ROW_GAP]
      : [PAD + (maxRow - row) * ROW_GAP, PAD + col * LANE_GAP];

    return { node, col, row, x, y, colorIndex, branchLabels: tipLabels.get(node.id) ?? [] };
  });

  /* 5. Edge paths (d3 link generators) */
  const nodePos = new Map<string, { x: number; y: number; colorIndex: number }>();
  for (const ln of layoutNodes) nodePos.set(ln.node.id, { x: ln.x, y: ln.y, colorIndex: ln.colorIndex });

  type LinkDatum = { source: [number, number]; target: [number, number] };
  const linkGen = dir === "vertical"
    ? d3.linkVertical<LinkDatum, [number, number]>().x((d) => d[0]).y((d) => d[1])
    : d3.linkHorizontal<LinkDatum, [number, number]>().x((d) => d[0]).y((d) => d[1]);

  const edges: LayoutEdge[] = [];
  for (const ln of layoutNodes) {
    for (const pid of ln.node.parents) {
      const pp = nodePos.get(pid);
      if (!pp) continue;
      const d = linkGen({ source: [ln.x, ln.y], target: [pp.x, pp.y] });
      if (d) edges.push({ d, color: lc(ln.colorIndex) });
    }
  }

  /* 6. Bounds */
  const graphLanes = PAD + (maxCol + 1) * LANE_GAP;
  const graphLen = PAD + maxRow * ROW_GAP;
  const labelPad = dir === "vertical" ? 360 : 60;

  const w = dir === "vertical" ? graphLanes + labelPad : graphLen + PAD + labelPad;
  const h = dir === "vertical" ? graphLen + PAD + 20 : graphLanes + 80;

  return { nodes: layoutNodes, edges, width: w, height: h };
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

/* ── Component ────────────────────────────────────────────────────── */

export function HistoryGraphTab() {
  const graphNodes = useAppStore((s) => s.graphNodes);
  const timelines = useAppStore((s) => s.timelines);
  const loadGraphData = useAppStore((s) => s.loadGraphData);
  const loadTimelines = useAppStore((s) => s.loadTimelines);
  const navigateToSnapshot = useAppStore((s) => s.navigateToSnapshot);
  const switchTimeline = useAppStore((s) => s.switchTimeline);

  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [dir, setDir] = useState<LayoutDir>("vertical");

  useEffect(() => { loadGraphData(); loadTimelines(); }, [loadGraphData, loadTimelines]);

  const handleNodeClick = useCallback(async (node: GraphNode) => {
    try {
      await navigateToSnapshot(node.id);
      await loadGraphData();
    } catch (err) {
      console.error("Navigation failed:", err);
    }
  }, [navigateToSnapshot, loadGraphData]);

  const timelineMap = useMemo(() => {
    const m = new Map<string, TimelineInfo>();
    for (const t of timelines) m.set(t.name, t);
    return m;
  }, [timelines]);

  const layout = useMemo(
    () => computeLayout(graphNodes, timelineMap, dir),
    [graphNodes, timelineMap, dir],
  );

  // Text label x-offset (vertical mode): right of rightmost lane
  const textX = useMemo(() => {
    const maxCol = layout.nodes.reduce((m, n) => Math.max(m, n.col), 0);
    return PAD + (maxCol + 1) * LANE_GAP + 12;
  }, [layout]);

  /* d3 zoom — Ctrl+wheel to zoom, drag to pan */
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = d3.select(svgRef.current);
    const g = d3.select(gRef.current);

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 4])
      .wheelDelta((event) => -event.deltaY * 0.002)
      .filter((event) => {
        if (event.type === "wheel") return event.ctrlKey || event.metaKey;
        return true;
      })
      .on("zoom", (event) => { g.attr("transform", event.transform.toString()); });

    zoomRef.current = zoom;
    svg.call(zoom);

    // Auto-fit
    const ct = containerRef.current;
    if (ct && layout.nodes.length > 0) {
      const { width: cw, height: ch } = ct.getBoundingClientRect();
      const gw = layout.width || 100;
      const gh = layout.height || 100;
      const scale = Math.min(cw / gw, ch / gh, 1.5) * 0.9;
      const tx = (cw - gw * scale) / 2;
      const ty = Math.max(8, (ch - gh * scale) / 2);
      svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }

    return () => { svg.on(".zoom", null); };
  }, [layout]);

  const handleFit = useCallback(() => {
    if (!svgRef.current || !containerRef.current || !zoomRef.current || layout.nodes.length === 0) return;
    const svg = d3.select(svgRef.current);
    const { width: cw, height: ch } = containerRef.current.getBoundingClientRect();
    const gw = layout.width || 100;
    const gh = layout.height || 100;
    const scale = Math.min(cw / gw, ch / gh, 1.5) * 0.9;
    const tx = (cw - gw * scale) / 2;
    const ty = Math.max(8, (ch - gh * scale) / 2);
    svg.transition().duration(300).call(
      zoomRef.current.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale),
    );
  }, [layout]);

  const handleZoomIn = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 1.3);
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 0.75);
  }, []);

  const toggleDir = useCallback(() => {
    setDir((d) => (d === "vertical" ? "horizontal" : "vertical"));
  }, []);

  /* ── Empty state ──────────────────────────────────── */
  if (graphNodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-secondary)]">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-30 mb-3">
          <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="10" r="2.5" /><circle cx="6" cy="18" r="2.5" />
          <path d="M6 8.5v7" /><path d="M6 8.5c0 3 4 4.5 9.5 4" />
        </svg>
        <p className="text-xs">No snapshots yet</p>
        <p className="text-[10px] opacity-60 mt-1">Save your first snapshot to see the history graph</p>
      </div>
    );
  }

  /* ── Render ───────────────────────────────────────── */
  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="10" r="2.5" /><circle cx="6" cy="18" r="2.5" />
          <path d="M6 8.5v7" /><path d="M6 8.5c0 3 4 4.5 9.5 4" />
        </svg>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">History</h2>
        <span className="text-[10px] text-[var(--color-text-secondary)]">
          {layout.nodes.length} snapshot{layout.nodes.length !== 1 ? "s" : ""} · {timelines.length} timeline{timelines.length !== 1 ? "s" : ""}
        </span>

        <div className="flex-1" />

        {/* Direction toggle */}
        <button
          onClick={toggleDir}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] transition-colors"
          title={`Switch to ${dir === "vertical" ? "horizontal" : "vertical"} layout`}
        >
          {dir === "vertical" ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v18" /><path d="M5 12l7 7 7-7" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h18" /><path d="M12 5l7 7-7 7" />
            </svg>
          )}
          {dir === "vertical" ? "Vertical" : "Horizontal"}
        </button>

        {/* Fit button */}
        <button
          onClick={handleFit}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] transition-colors"
          title="Fit graph to view"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
          Fit
        </button>

        {/* Zoom +/− */}
        <div className="flex items-center border border-[var(--color-border)] rounded overflow-hidden">
          <button
            onClick={handleZoomOut}
            className="px-1.5 py-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] transition-colors"
            title="Zoom out"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
          <button
            onClick={handleZoomIn}
            className="px-1.5 py-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] transition-colors border-l border-[var(--color-border)]"
            title="Zoom in"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 ml-2">
          {timelines.map((t) => (
            <button
              key={t.name}
              onClick={() => switchTimeline(t.name)}
              className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
              title={`Switch to ${t.label}`}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: lc(t.color_index) }} />
              <span className={t.is_active ? "font-medium text-[var(--color-text)]" : ""}>{t.label}</span>
              {t.is_active && <span className="text-[8px] opacity-50">(active)</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Graph — d3-zoomed SVG */}
      <div ref={containerRef} className="flex-1 overflow-hidden">
        <svg ref={svgRef} width="100%" height="100%" className="select-none" style={{ cursor: "grab" }}>
          <g ref={gRef}>
            {/* Edges */}
            {layout.edges.map((edge, i) => (
              <path key={i} d={edge.d} fill="none" stroke={edge.color} strokeWidth={2} opacity={0.4} />
            ))}

            {/* Nodes */}
            {layout.nodes.map((ln) => {
              const { node, x, y, colorIndex, branchLabels: bl } = ln;
              const color = lc(colorIndex);
              const isHead = node.is_head;
              const isHov = hoveredNode === node.id;
              const r = isHead ? HEAD_R : NODE_R;

              return (
                <g
                  key={node.id}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onMouseLeave={() => setHoveredNode(null)}
                  onClick={(e) => { e.stopPropagation(); handleNodeClick(node); }}
                  style={{ cursor: "pointer" }}
                >
                  <circle
                    cx={x} cy={y} r={isHov ? r + 2 : r}
                    fill={isHead ? color : "var(--color-surface)"}
                    stroke={color} strokeWidth={isHead ? 3 : 2}
                  />

                  {isHead && (
                    <circle cx={x} cy={y} r={r + 4} fill="none" stroke={color}
                      strokeWidth={1.5} strokeDasharray="3 2" opacity={0.6} />
                  )}

                  {node.is_remote_tip && (
                    <g>
                      <rect x={x + r + 3} y={y - 7} width={38} height={14} rx={3}
                        fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={0.5} />
                      <text x={x + r + 7} y={y + 1} dominantBaseline="middle"
                        fontSize={7} fill="var(--color-text-secondary)" fontWeight={500}>origin</text>
                    </g>
                  )}

                  {/* Branch badges */}
                  {bl.map((label, bi) => {
                    const bw = label.length * 5.5 + 12;
                    if (dir === "vertical") {
                      return (
                        <g key={label}>
                          <rect x={textX - 2} y={y - ROW_GAP / 2 + 2 + bi * 16} width={bw} height={14} rx={4} fill={color} opacity={0.15} />
                          <text x={textX + 4} y={y - ROW_GAP / 2 + 11 + bi * 16} fontSize={8} fill={color} fontWeight={600}
                            fontFamily="var(--font-mono, monospace)">{label}</text>
                        </g>
                      );
                    }
                    const bx = x - bw / 2;
                    return (
                      <g key={label}>
                        <rect x={bx} y={y - r - 16 - bi * 16} width={bw} height={14} rx={4} fill={color} opacity={0.15} />
                        <text x={bx + 6} y={y - r - 6 - bi * 16} fontSize={8} fill={color} fontWeight={600}
                          fontFamily="var(--font-mono, monospace)">{label}</text>
                      </g>
                    );
                  })}

                  {/* Commit message */}
                  {dir === "vertical" ? (
                    <text x={textX} y={y + 1} dominantBaseline="middle" fontSize={10}
                      fill={isHead ? "var(--color-text)" : "var(--color-text-secondary)"}
                      fontWeight={isHead ? 600 : 400}>
                      {node.message.length > 48 ? node.message.substring(0, 48) + "…" : node.message}
                    </text>
                  ) : (
                    <text x={x} y={y + r + 14} textAnchor="middle" fontSize={8}
                      fill={isHead ? "var(--color-text)" : "var(--color-text-secondary)"}
                      fontWeight={isHead ? 600 : 400}>
                      {node.message.length > 24 ? node.message.substring(0, 24) + "…" : node.message}
                    </text>
                  )}

                  {/* Timestamp (vertical) */}
                  {dir === "vertical" && (
                    <text x={textX + 310} y={y + 1} dominantBaseline="middle" fontSize={8}
                      fill="var(--color-text-secondary)" opacity={0.5}>
                      {formatTimestamp(node.timestamp)}
                    </text>
                  )}

                  {/* Hash on hover */}
                  <text
                    x={x}
                    y={dir === "vertical" ? y + r + 10 : y - r - 3}
                    textAnchor="middle" fontSize={7}
                    fill="var(--color-text-secondary)" opacity={isHov ? 0.8 : 0}
                    fontFamily="var(--font-mono, monospace)">
                    {node.id.substring(0, 7)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
