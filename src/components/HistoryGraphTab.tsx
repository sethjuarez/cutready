import * as d3 from "d3";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { GraphNode, TimelineInfo } from "../types/sketch";

/**
 * HistoryGraphTab — Full DAG visualization using a tangled-tree layout
 * (inspired by nitaku's "Tangled Tree Visualization II").
 *
 * Layout: level-based horizontal (or vertical), with metro-style edge bundling.
 * Features: d3 zoom/pan, vertical/horizontal toggle, auto-fit.
 */

/* ── Types ────────────────────────────────────────────────────────── */

type LayoutDir = "vertical" | "horizontal";

/** A positioned node after tangled layout. */
interface TangleNode {
  node: GraphNode;
  x: number;
  y: number;
  height: number;
  level: number;
  colorIndex: number;
  branchLabels: string[];
}

/** A bundled edge path. */
interface TangleEdge {
  d: string;
  color: string;
  /** Wider background stroke for readability? */
  bg?: boolean;
}

/* ── Constants ────────────────────────────────────────────────────── */

const LANE_COLORS = [
  "var(--color-accent)", "#10b981", "#f59e0b", "#ef4444",
  "#3b82f6", "#ec4899", "#14b8a6", "#8b5cf6",
];
const lc = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

/* ── Tangled Tree Layout Engine ───────────────────────────────────── */

/** Tuning knobs (pixel values). */
const PADDING = 32;
const NODE_HEIGHT_BASE = 36;
const NODE_WIDTH = 160;
const BUNDLE_WIDTH = 14;
const LEVEL_PAD = 24;
const METRO_D = 4;
const ARC_R = 16;
const MIN_FAMILY_H = 22;

interface TNode {
  id: string;
  gn: GraphNode;
  level: number;
  parents: TNode[];
  colorIndex: number;
  branchLabels: string[];
  bundle?: TBundle;
  bundles: TBundle[][];
  bundles_index: Record<string, TBundle[]>;
  height: number;
  x: number;
  y: number;
}

interface TBundle {
  id: string;
  parents: TNode[];
  level: number;
  i: number;
  x: number;
  y: number;
  links: TLink[];
  color: string;
}

interface TLink {
  source: TNode;
  target: TNode;
  bundle: TBundle;
  xt: number; yt: number;
  xb: number;
  xs: number; ys: number;
  c1: number; c2: number;
}

function constructTangleLayout(
  rawNodes: GraphNode[],
  timelineMap: Map<string, TimelineInfo>,
  dir: LayoutDir,
): { nodes: TangleNode[]; edges: TangleEdge[]; width: number; height: number } {
  if (rawNodes.length === 0)
    return { nodes: [], edges: [], width: 0, height: 0 };

  /* ── 1. Deduplicate, collect branch labels ──────────────────── */
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
  const gnMap = new Map<string, GraphNode>();
  for (const n of deduped) gnMap.set(n.id, n);

  /* ── 2. Compute depth levels (BFS from roots) ──────────────── */
  const childrenOf = new Map<string, string[]>();
  for (const n of deduped) {
    for (const pid of n.parents) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)!.push(n.id);
    }
  }

  // Depth = longest path from any root
  const depth = new Map<string, number>();
  const roots = deduped.filter((n) => n.parents.length === 0 || !n.parents.some((p) => gnMap.has(p)));

  // BFS/topo for longest-path depth
  const inDeg = new Map<string, number>();
  for (const n of deduped) {
    let d = 0;
    for (const pid of n.parents) { if (gnMap.has(pid)) d++; }
    inDeg.set(n.id, d);
  }
  const queue = roots.map((n) => n.id);
  for (const rid of queue) depth.set(rid, 0);

  let qi = 0;
  while (qi < queue.length) {
    const nid = queue[qi++];
    const nd = depth.get(nid)!;
    for (const cid of (childrenOf.get(nid) ?? [])) {
      const cd = depth.get(cid);
      if (cd === undefined || nd + 1 > cd) depth.set(cid, nd + 1);
      const rem = inDeg.get(cid)! - 1;
      inDeg.set(cid, rem);
      if (rem === 0) queue.push(cid);
    }
  }

  // Group by level, sort within each level by timestamp
  const maxDepth = Math.max(0, ...depth.values());
  const levels: GraphNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const n of deduped) {
    const d = depth.get(n.id) ?? 0;
    levels[d].push(n);
  }
  for (const lvl of levels) {
    lvl.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /* ── 3. Build TNode objects ────────────────────────────────── */
  const tNodes: TNode[] = [];
  const tIndex = new Map<string, TNode>();

  for (let li = 0; li < levels.length; li++) {
    for (const gn of levels[li]) {
      const tInfo = timelineMap.get(gn.timeline);
      const tn: TNode = {
        id: gn.id,
        gn,
        level: li,
        parents: [],
        colorIndex: tInfo?.color_index ?? 0,
        branchLabels: tipLabels.get(gn.id) ?? [],
        bundles: [],
        bundles_index: {},
        height: 0,
        x: 0, y: 0,
      };
      tNodes.push(tn);
      tIndex.set(gn.id, tn);
    }
  }

  // Objectify parents
  for (const tn of tNodes) {
    tn.parents = tn.gn.parents
      .map((pid) => tIndex.get(pid))
      .filter((p): p is TNode => p !== undefined);
  }

  /* ── 4. Compute bundles (nitaku algorithm) ─────────────────── */
  interface LevelBundles { bundles: TBundle[] }
  const levelBundles: LevelBundles[] = levels.map(() => ({ bundles: [] }));

  for (let li = 0; li < levels.length; li++) {
    const nodesInLevel = levels[li].map((gn) => tIndex.get(gn.id)!);
    const index: Record<string, TBundle> = {};

    for (const tn of nodesInLevel) {
      if (tn.parents.length === 0) continue;
      const bid = tn.parents.map((p) => p.id).sort().join("--");
      if (bid in index) {
        index[bid].parents = index[bid].parents.concat(tn.parents);
      } else {
        index[bid] = {
          id: bid,
          parents: tn.parents.slice(),
          level: li,
          i: 0,
          x: 0, y: 0,
          links: [],
          color: lc(tn.colorIndex),
        };
      }
      tn.bundle = index[bid];
    }
    const bundles = Object.values(index);
    bundles.forEach((b, i) => { b.i = i; });
    levelBundles[li].bundles = bundles;
  }

  const allBundles = levelBundles.flatMap((lb) => lb.bundles);

  // Build links
  const links: TLink[] = [];
  for (const tn of tNodes) {
    for (const p of tn.parents) {
      if (tn.bundle) {
        links.push({
          source: tn, target: p, bundle: tn.bundle,
          xt: 0, yt: 0, xb: 0, xs: 0, ys: 0, c1: 0, c2: 0,
        });
      }
    }
  }

  // Reverse pointers
  for (const b of allBundles) {
    for (const p of b.parents) {
      if (!(b.id in p.bundles_index)) p.bundles_index[b.id] = [];
      p.bundles_index[b.id].push(b);
    }
  }
  for (const tn of tNodes) {
    tn.bundles = Object.values(tn.bundles_index);
    tn.bundles.forEach((bg, i) => bg.forEach((b) => { b.i = i; }));
  }

  for (const l of links) {
    l.bundle.links.push(l);
  }

  /* ── 5. Layout coordinates ─────────────────────────────────── */
  for (const tn of tNodes) {
    tn.height = (Math.max(1, tn.bundles.length) - 1) * METRO_D;
  }

  let xOff = PADDING;
  let yOff = PADDING;

  for (let li = 0; li < levels.length; li++) {
    xOff += levelBundles[li].bundles.length * BUNDLE_WIDTH;
    yOff += LEVEL_PAD;
    const nodesInLevel = levels[li].map((gn) => tIndex.get(gn.id)!);
    for (const tn of nodesInLevel) {
      tn.x = tn.level * NODE_WIDTH + xOff;
      tn.y = NODE_HEIGHT_BASE + yOff + tn.height / 2;
      yOff += NODE_HEIGHT_BASE + tn.height;
    }
  }

  // Bundle positions
  let rowIdx = 0;
  for (let li = 0; li < levels.length; li++) {
    for (const b of levelBundles[li].bundles) {
      b.x = b.parents[0].x + NODE_WIDTH +
        (levelBundles[li].bundles.length - 1 - b.i) * BUNDLE_WIDTH;
      b.y = rowIdx * NODE_HEIGHT_BASE;
    }
    rowIdx += levels[li].length;
  }

  // Link coordinates
  for (const l of links) {
    l.xt = l.target.x;
    const bArr = l.target.bundles_index[l.bundle.id];
    const bIdx = bArr ? bArr.indexOf(l.bundle) : 0;
    const bCount = l.target.bundles.length;
    l.yt = l.target.y + bIdx * METRO_D - (bCount * METRO_D) / 2 + METRO_D / 2;
    l.xb = l.bundle.x;
    l.xs = l.source.x;
    l.ys = l.source.y;
  }

  // Compress vertical space
  let yNegOff = 0;
  for (let li = 0; li < levels.length; li++) {
    const bs = levelBundles[li].bundles;
    if (bs.length > 0) {
      const minGap = Math.min(
        ...bs.flatMap((b) =>
          b.links.map((lk) => (lk.ys - ARC_R) - (lk.yt + ARC_R))
        ),
      );
      yNegOff += Math.max(0, -MIN_FAMILY_H + minGap);
    }
    const nodesInLevel = levels[li].map((gn) => tIndex.get(gn.id)!);
    for (const tn of nodesInLevel) {
      tn.y -= yNegOff;
    }
  }

  // Re-compute link coords after compression
  for (const l of links) {
    const bArr = l.target.bundles_index[l.bundle.id];
    const bIdx = bArr ? bArr.indexOf(l.bundle) : 0;
    const bCount = l.target.bundles.length;
    l.yt = l.target.y + bIdx * METRO_D - (bCount * METRO_D) / 2 + METRO_D / 2;
    l.ys = l.source.y;
    l.c1 = l.source.level - l.target.level > 1 ? NODE_WIDTH + ARC_R : ARC_R;
    l.c2 = ARC_R;
  }

  /* ── 6. Build output ───────────────────────────────────────── */
  const w = Math.max(100, d3.max(tNodes, (n) => n.x)! + NODE_WIDTH + 2 * PADDING);
  const h = Math.max(100, d3.max(tNodes, (n) => n.y)! + NODE_HEIGHT_BASE / 2 + 2 * PADDING);

  // Dir transform: horizontal = default (levels left→right, nodes stacked vertically)
  //                vertical   = swap x↔y (levels top→bottom, nodes spread horizontally)
  const transform = (px: number, py: number): [number, number] =>
    dir === "horizontal" ? [px, py] : [py, px];

  const tangleNodes: TangleNode[] = tNodes.map((tn) => {
    const [fx, fy] = transform(tn.x, tn.y);
    return {
      node: tn.gn,
      x: fx,
      y: fy,
      height: tn.height,
      level: tn.level,
      colorIndex: tn.colorIndex,
      branchLabels: tn.branchLabels,
    };
  });

  // Build edge paths — metro-style bundled arcs
  const tangleEdges: TangleEdge[] = [];
  const bundlesSeen = new Set<string>();

  for (const b of allBundles) {
    if (bundlesSeen.has(b.id)) continue;
    bundlesSeen.add(b.id);

    const pathSegments = b.links.map((l) => {
      if (dir === "horizontal") {
        return `M${l.xt} ${l.yt} L${l.xb - l.c1} ${l.yt} A${l.c1} ${l.c1} 90 0 1 ${l.xb} ${l.yt + l.c1} L${l.xb} ${l.ys - l.c2} A${l.c2} ${l.c2} 90 0 0 ${l.xb + l.c2} ${l.ys} L${l.xs} ${l.ys}`;
      } else {
        // Vertical: swap axes in the path
        return `M${l.yt} ${l.xt} L${l.yt} ${l.xb - l.c1} A${l.c1} ${l.c1} 90 0 0 ${l.yt + l.c1} ${l.xb} L${l.ys - l.c2} ${l.xb} A${l.c2} ${l.c2} 90 0 1 ${l.ys} ${l.xb + l.c2} L${l.ys} ${l.xs}`;
      }
    }).join(" ");

    // Background (wider, surface color for gap effect)
    tangleEdges.push({ d: pathSegments, color: "var(--color-bg)", bg: true });
    // Foreground (thin, colored)
    tangleEdges.push({ d: pathSegments, color: b.color });
  }

  const [finalW, finalH] = dir === "horizontal" ? [w, h] : [h, w];

  return { nodes: tangleNodes, edges: tangleEdges, width: finalW, height: finalH };
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

const NODE_R = 6;
const HEAD_R = 8;

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
  const [dir, setDir] = useState<LayoutDir>("horizontal");

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
    () => constructTangleLayout(graphNodes, timelineMap, dir),
    [graphNodes, timelineMap, dir],
  );

  /* d3 zoom — applied to <svg>, transforms <g> */
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = d3.select(svgRef.current);
    const g = d3.select(gRef.current);

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .filter((event) => {
        // Allow programmatic zoom, drag/pan, and Ctrl+wheel
        if (event.type === "wheel") return event.ctrlKey || event.metaKey;
        return true;
      })
      .on("zoom", (event) => { g.attr("transform", event.transform.toString()); });

    zoomRef.current = zoom;
    svg.call(zoom);

    const ct = containerRef.current;
    if (ct && layout.nodes.length > 0) {
      const { width: cw, height: ch } = ct.getBoundingClientRect();
      const gw = layout.width || 100;
      const gh = layout.height || 100;
      const scale = Math.min(cw / gw, ch / gh, 1.5) * 0.85;
      const tx = (cw - gw * scale) / 2;
      const ty = (ch - gh * scale) / 2;
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
    const scale = Math.min(cw / gw, ch / gh, 1.5) * 0.85;
    const tx = (cw - gw * scale) / 2;
    const ty = (ch - gh * scale) / 2;
    svg.transition().duration(300).call(
      zoomRef.current.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale),
    );
  }, [layout]);

  const handleZoomIn = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 1.4);
  }, []);

  const handleZoomOut = useCallback(() => {
    if (!svgRef.current || !zoomRef.current) return;
    d3.select(svgRef.current).transition().duration(200).call(zoomRef.current.scaleBy, 0.7);
  }, []);

  const toggleDir= useCallback(() => {
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
            className="px-1.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] transition-colors"
            title="Zoom out"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
          <button
            onClick={handleZoomIn}
            className="px-1.5 py-1 text-[10px] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)] transition-colors border-l border-[var(--color-border)]"
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
            {/* Edges — background first, then colored */}
            {layout.edges.map((edge, i) => (
              <path
                key={i}
                d={edge.d}
                fill="none"
                stroke={edge.color}
                strokeWidth={edge.bg ? 5 : 2}
                opacity={edge.bg ? 1 : 0.8}
              />
            ))}

            {/* Nodes */}
            {layout.nodes.map((ln) => {
              const { node, x, y, colorIndex, branchLabels: bl } = ln;
              const color = lc(colorIndex);
              const isHead = node.is_head;
              const isHov = hoveredNode === node.id;
              const r = isHead ? HEAD_R : NODE_R;

              // Node line height for metro-style rendering (reserved for future use)
              return (
                <g
                  key={node.id}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onMouseLeave={() => setHoveredNode(null)}
                  onClick={(e) => { e.stopPropagation(); handleNodeClick(node); }}
                  style={{ cursor: "pointer" }}
                >
                  {/* Node circle */}
                  <circle
                    cx={x} cy={y}
                    r={isHov ? r + 2 : r}
                    fill={isHead ? color : "var(--color-surface)"}
                    stroke={color}
                    strokeWidth={isHead ? 3 : 2}
                  />

                  {/* HEAD dashed ring */}
                  {isHead && (
                    <circle cx={x} cy={y} r={r + 4} fill="none" stroke={color}
                      strokeWidth={1.5} strokeDasharray="3 2" opacity={0.6} />
                  )}

                  {/* Remote-tip badge */}
                  {node.is_remote_tip && (
                    <g>
                      <rect x={x + r + 3} y={y - 7} width={38} height={14} rx={3}
                        fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={0.5} />
                      <text x={x + r + 7} y={y + 1} dominantBaseline="middle"
                        fontSize={7} fill="var(--color-text-secondary)" fontWeight={500}>origin</text>
                    </g>
                  )}

                  {/* Commit message label */}
                  <text
                    x={x + r + 6} y={y - r - 4}
                    fontSize={10}
                    fill={isHead ? "var(--color-text)" : "var(--color-text-secondary)"}
                    fontWeight={isHead ? 600 : 400}
                  >
                    {node.message.length > 40 ? node.message.substring(0, 40) + "…" : node.message}
                  </text>

                  {/* Branch-tip badges */}
                  {bl.map((label, bi) => {
                    const bw = label.length * 5.5 + 12;
                    return (
                      <g key={label}>
                        <rect x={x + r + 4} y={y + r + 2 + bi * 18} width={bw} height={16} rx={4}
                          fill={color} opacity={0.15} />
                        <text x={x + r + 10} y={y + r + 13 + bi * 18} fontSize={8} fill={color}
                          fontWeight={600} fontFamily="var(--font-mono, monospace)">{label}</text>
                      </g>
                    );
                  })}

                  {/* Short hash on hover */}
                  <text
                    x={x + r + 6} y={y + 3}
                    fontSize={7}
                    fill="var(--color-text-secondary)"
                    opacity={isHov ? 0.8 : 0}
                    fontFamily="var(--font-mono, monospace)"
                  >
                    {node.id.substring(0, 7)} · {formatTimestamp(node.timestamp)}
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
