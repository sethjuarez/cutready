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
  showLabel: boolean;
}

interface LayoutEdge {
  d: string;
  color: string;
}

/* ── Constants ────────────────────────────────────────────────────── */

const ROW_GAP_V = 36;
const ROW_GAP_H = 56;
const LANE_GAP_V = 24;
const LANE_GAP_H = 48;
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
): { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number; textOffset: number } {
  if (rawNodes.length === 0)
    return { nodes: [], edges: [], width: 0, height: 0, textOffset: PAD };

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

  /* 2. Topological sort, roots first, timestamp tiebreaker (oldest → top/left) */
  // Build children map (reverse of parents)
  const childrenOf = new Map<string, string[]>();
  for (const n of deduped) {
    for (const pid of n.parents) {
      if (nodeMap.has(pid)) {
        if (!childrenOf.has(pid)) childrenOf.set(pid, []);
        childrenOf.get(pid)!.push(n.id);
      }
    }
  }
  // In-degree = number of parents within the graph
  const inDeg = new Map<string, number>();
  for (const n of deduped) {
    inDeg.set(n.id, n.parents.filter((p) => nodeMap.has(p)).length);
  }
  // Start with root nodes (no parents), sorted oldest first
  const tsOf = (n: GraphNode) => new Date(n.timestamp).getTime();
  const ready = deduped.filter((n) => inDeg.get(n.id) === 0);
  ready.sort((a, b) => tsOf(a) - tsOf(b));

  const sorted: GraphNode[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    sorted.push(n);
    for (const kid of childrenOf.get(n.id) ?? []) {
      if (!inDeg.has(kid)) continue;
      const nd = inDeg.get(kid)! - 1;
      inDeg.set(kid, nd);
      if (nd === 0) {
        ready.push(nodeMap.get(kid)!);
        ready.sort((a, b) => tsOf(a) - tsOf(b));
      }
    }
  }

  /* 3. Timeline-based lane assignment — each timeline gets a fixed lane */
  const nodeCol = new Map<string, number>();
  const tlCreation = new Map<string, number>();
  for (const node of deduped) {
    const ts = new Date(node.timestamp).getTime();
    const prev = tlCreation.get(node.timeline);
    if (prev === undefined || ts < prev) tlCreation.set(node.timeline, ts);
  }

  // Active timeline → lane 0, others sorted by creation time
  const activeTl = [...timelineMap.values()].find((t) => t.is_active)?.name;
  const tlOrder = [...tlCreation.keys()].sort((a, b) => {
    if (a === activeTl) return -1;
    if (b === activeTl) return 1;
    return (tlCreation.get(a) ?? 0) - (tlCreation.get(b) ?? 0);
  });
  const timelineLane = new Map<string, number>();
  tlOrder.forEach((tl, i) => timelineLane.set(tl, i));

  for (const node of sorted) {
    nodeCol.set(node.id, timelineLane.get(node.timeline) ?? 0);
  }

  /* 4. Coordinates — row 0 at top (vertical) / left (horizontal) */
  const rowGap = dir === "vertical" ? ROW_GAP_V : ROW_GAP_H;
  const maxCol = Math.max(0, ...Array.from(nodeCol.values()));
  const maxRow = sorted.length - 1;

  const layoutNodes: LayoutNode[] = sorted.map((node, row) => {
    const col = nodeCol.get(node.id)!;
    const tInfo = timelineMap.get(node.timeline);
    const colorIndex = tInfo?.color_index ?? col;

    const [x, y] = dir === "vertical"
      ? [PAD + col * LANE_GAP_V, PAD + row * rowGap]
      : [PAD + row * rowGap, PAD + col * LANE_GAP_H];

    return { node, col, row, x, y, colorIndex, branchLabels: tipLabels.get(node.id) ?? [], showLabel: true };
  });

  /* 4b. Label collision detection — hide labels that would overlap */
  if (dir === "horizontal") {
    // Group by lane, check horizontal distance between consecutive labels
    const byLane = new Map<number, LayoutNode[]>();
    for (const ln of layoutNodes) {
      if (!byLane.has(ln.col)) byLane.set(ln.col, []);
      byLane.get(ln.col)!.push(ln);
    }
    const MIN_H_DIST = 52; // minimum px between angled label origins
    for (const [, laneNodes] of byLane) {
      laneNodes.sort((a, b) => a.x - b.x);
      let lastShownX = -Infinity;
      for (const ln of laneNodes) {
        if (ln.x - lastShownX < MIN_H_DIST && !ln.node.is_head && ln.branchLabels.length === 0) {
          ln.showLabel = false;
        } else {
          lastShownX = ln.x;
        }
      }
    }
  } else {
    // Vertical: labels in text column — check vertical distance
    const MIN_V_DIST = 14; // minimum px between labels
    let lastShownY = -Infinity;
    const sortedByY = [...layoutNodes].sort((a, b) => a.y - b.y);
    for (const ln of sortedByY) {
      if (ln.y - lastShownY < MIN_V_DIST && !ln.node.is_head && ln.branchLabels.length === 0) {
        ln.showLabel = false;
      } else {
        lastShownY = ln.y;
      }
    }
  }

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
  const laneGap = dir === "vertical" ? LANE_GAP_V : LANE_GAP_H;
  const graphLanes = PAD + (maxCol + 1) * laneGap;
  const graphLen = PAD + maxRow * rowGap;
  const textOffset = graphLanes + 12;// x where vertical labels start

  const w = dir === "vertical" ? textOffset + 280 : graphLen + PAD * 2;
  const h = dir === "vertical" ? graphLen + PAD * 2 : graphLanes + 120;

  return { nodes: layoutNodes, edges, width: w, height: h, textOffset };
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
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
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
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] shrink-0">
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
      <div ref={containerRef} className="flex-1 overflow-hidden relative">
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
              const labelX = bl.length > 0
                ? layout.textOffset + (Math.min(bl[0].length, 12) * 4.5 + 8)
                : layout.textOffset;

              return (
                <g
                  key={node.id}
                  onMouseEnter={(e) => {
                    setHoveredNode(node.id);
                    const rect = containerRef.current?.getBoundingClientRect();
                    if (rect) setTooltipPos({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8 });
                  }}
                  onMouseMove={(e) => {
                    const rect = containerRef.current?.getBoundingClientRect();
                    if (rect) setTooltipPos({ x: e.clientX - rect.left + 12, y: e.clientY - rect.top - 8 });
                  }}
                  onMouseLeave={() => { setHoveredNode(null); setTooltipPos(null); }}
                  onClick={(e) => { e.stopPropagation(); handleNodeClick(node); }}
                  style={{ cursor: "pointer" }}
                >
                  {/* Hit area */}
                  <circle cx={x} cy={y} r={r + 6} fill="transparent" />

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

                  {/* Connector line from node to label (vertical mode) */}
                  {dir === "vertical" && ln.showLabel && (
                    <line
                      x1={x + r + 2} y1={y}
                      x2={layout.textOffset - 6} y2={y}
                      stroke={color} strokeWidth={0.5} opacity={0.25}
                    />
                  )}

                  {/* Branch name — small text near node */}
                  {bl.length > 0 && bl.map((label, bi) => {
                    const truncLabel = label.length > 12 ? label.substring(0, 12) + "…" : label;
                    if (dir === "vertical") {
                      return (
                        <text key={label} x={layout.textOffset} y={y + 3 + bi * 11}
                          fontSize={7} fill={color} opacity={0.7} fontWeight={600}
                          fontFamily="var(--font-mono, monospace)">{truncLabel}</text>
                      );
                    } else {
                      return (
                        <text key={label} x={x} y={y - r - 4 - bi * 10}
                          fontSize={7} fill={color} opacity={0.7} fontWeight={600}
                          textAnchor="middle" fontFamily="var(--font-mono, monospace)">{truncLabel}</text>
                      );
                    }
                  })}

                  {/* Commit message label */}
                  {ln.showLabel && (dir === "vertical" ? (
                    <text
                      x={labelX} y={y + 1} dominantBaseline="middle" fontSize={9}
                      fill={isHead ? "var(--color-text)" : "var(--color-text-secondary)"}
                      fontWeight={isHead ? 600 : 400} opacity={0.85}>
                      {node.message.length > 30 ? node.message.substring(0, 30) + "…" : node.message}
                    </text>
                  ) : (
                    <text
                      x={x + r + 4} y={y + r + 4}
                      fontSize={8}
                      fill={isHead ? "var(--color-text)" : "var(--color-text-secondary)"}
                      fontWeight={isHead ? 600 : 400} opacity={0.85}
                      transform={`rotate(30, ${x + r + 4}, ${y + r + 4})`}
                    >
                      {node.message.length > 20 ? node.message.substring(0, 20) + "…" : node.message}
                    </text>
                  ))}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Hover tooltip */}
        {hoveredNode && tooltipPos && (() => {
          const ln = layout.nodes.find((n) => n.node.id === hoveredNode);
          if (!ln) return null;
          const { node } = ln;
          const color = lc(ln.colorIndex);
          return (
            <div
              className="absolute pointer-events-none z-50 max-w-xs"
              style={{ left: tooltipPos.x, top: tooltipPos.y }}
            >
              <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg px-3 py-2">
                <p className="text-xs font-semibold text-[var(--color-text)] leading-tight">{node.message}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[9px] font-mono text-[var(--color-text-secondary)]">{node.id.substring(0, 7)}</span>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-[9px] text-[var(--color-text-secondary)]">{formatTimestamp(node.timestamp)}</span>
                </div>
                {node.author && (
                  <p className="text-[9px] text-[var(--color-text-secondary)] mt-0.5">{node.author}</p>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
