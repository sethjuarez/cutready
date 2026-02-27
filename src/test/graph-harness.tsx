import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SnapshotGraph } from "../components/SnapshotGraph";
import type { GraphNode } from "../types/sketch";
import "../index.css";

/**
 * Test harness: each scenario mirrors a real git repo in D:\cutready\test-*
 * Verify with: cd D:\cutready\test-* && git log --oneline --graph --all --decorate
 */

const T = "2026-02-27T05:00:00Z"; // base time
const t = (m: number) => new Date(+new Date(T) - m * 60000).toISOString();

// ── 1) Linear: 3 commits on main, HEAD at tip ────────────────
// git: * Final polish (HEAD) / * Added intro / * Initial setup
const linearNodes: GraphNode[] = [
  { id: "c3", message: "Final polish",  timestamp: t(0), timeline: "main", parents: ["c2"], lane: 0, is_head: true,  is_branch_tip: true },
  { id: "c2", message: "Added intro",   timestamp: t(1), timeline: "main", parents: ["c1"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "c1", message: "Initial setup", timestamp: t(2), timeline: "main", parents: [],     lane: 0, is_head: false, is_branch_tip: false },
];

// ── 2) Linear + dirty ────────────────────────────────────────
// Same graph but isDirty=true

// ── 3) Two branches: main(3) + fork from c2, HEAD on fork ───
// git: * Main continues (main) / | * Refined approach (HEAD->fork) / | * Exploring idea / |/ / * Added intro / * Initial setup
const twoBranchNodes: GraphNode[] = [
  { id: "f2", message: "Refined approach", timestamp: t(0), timeline: "fork-explore", parents: ["f1"], lane: 1, is_head: true,  is_branch_tip: true },
  { id: "f1", message: "Exploring idea",   timestamp: t(1), timeline: "fork-explore", parents: ["c2"], lane: 1, is_head: false, is_branch_tip: false },
  { id: "m3", message: "Main continues",   timestamp: t(1), timeline: "main",         parents: ["c2"], lane: 0, is_head: false, is_branch_tip: true },
  { id: "c2", message: "Added intro",      timestamp: t(2), timeline: "main",         parents: ["c1"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "c1", message: "Initial setup",    timestamp: t(3), timeline: "main",         parents: [],     lane: 0, is_head: false, is_branch_tip: false },
];

// ── 4) Two branches + dirty ──────────────────────────────────

// ── 5) Three branches: main(3) + fork-A from c2 (2) + fork-B from c1 (1), HEAD on fork-A
// git: * Alternate (fork-alt) / | * Refined A (HEAD->fork-explore) / | * Exploring A / | | * Main continues (main) / | |/ / | * Added intro / |/ / * Initial setup
const threeBranchNodes: GraphNode[] = [
  { id: "a2", message: "Refined A",           timestamp: t(0), timeline: "fork-explore",   parents: ["a1"], lane: 1, is_head: true,  is_branch_tip: true },
  { id: "a1", message: "Exploring idea A",    timestamp: t(1), timeline: "fork-explore",   parents: ["c2"], lane: 1, is_head: false, is_branch_tip: false },
  { id: "m3", message: "Main continues",      timestamp: t(1), timeline: "main",           parents: ["c2"], lane: 0, is_head: false, is_branch_tip: true },
  { id: "b1", message: "Alternate direction",  timestamp: t(1), timeline: "fork-alternate", parents: ["c1"], lane: 2, is_head: false, is_branch_tip: true },
  { id: "c2", message: "Added intro",         timestamp: t(2), timeline: "main",           parents: ["c1"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "c1", message: "Initial setup",       timestamp: t(3), timeline: "main",           parents: [],     lane: 0, is_head: false, is_branch_tip: false },
];

// ── 7) Deep branches: main(5) + fork-explore from c3(3, HEAD) + fork-alt from c2(2)
// git log: see D:\cutready\test-deep-branches
const deepBranchNodes: GraphNode[] = [
  { id: "a3", message: "Refined exploration",  timestamp: t(0),  timeline: "fork-explore", parents: ["a2"], lane: 1, is_head: true,  is_branch_tip: true },
  { id: "a2", message: "Develop exploration",  timestamp: t(1),  timeline: "fork-explore", parents: ["a1"], lane: 1, is_head: false, is_branch_tip: false },
  { id: "a1", message: "Explore idea",         timestamp: t(2),  timeline: "fork-explore", parents: ["c3"], lane: 1, is_head: false, is_branch_tip: false },
  { id: "m5", message: "Final main",           timestamp: t(1),  timeline: "main",         parents: ["m4"], lane: 0, is_head: false, is_branch_tip: true },
  { id: "m4", message: "Polish main",          timestamp: t(2),  timeline: "main",         parents: ["c3"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "b2", message: "Refine alt",           timestamp: t(1),  timeline: "fork-alt",     parents: ["b1"], lane: 2, is_head: false, is_branch_tip: true },
  { id: "b1", message: "Alt approach",         timestamp: t(2),  timeline: "fork-alt",     parents: ["c2"], lane: 2, is_head: false, is_branch_tip: false },
  { id: "c3", message: "Core features",        timestamp: t(3),  timeline: "main",         parents: ["c2"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "c2", message: "Add structure",        timestamp: t(4),  timeline: "main",         parents: ["c1"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "c1", message: "Initial setup",        timestamp: t(5),  timeline: "main",         parents: [],     lane: 0, is_head: false, is_branch_tip: false },
];

// ── 8) Four branches, staggered forks: main(4) + explore from c2(3, HEAD) + late from c3(2) + early from c1(2)
// git log: see D:\cutready\test-four-branch
const fourBranchNodes: GraphNode[] = [
  { id: "a3", message: "Explore complete",     timestamp: t(0),  timeline: "fork-explore", parents: ["a2"], lane: 1, is_head: true,  is_branch_tip: true },
  { id: "a2", message: "Explore develop",      timestamp: t(1),  timeline: "fork-explore", parents: ["a1"], lane: 1, is_head: false, is_branch_tip: false },
  { id: "a1", message: "Explore start",        timestamp: t(2),  timeline: "fork-explore", parents: ["c2"], lane: 1, is_head: false, is_branch_tip: false },
  { id: "m4", message: "Main complete",        timestamp: t(1),  timeline: "main",         parents: ["c3"], lane: 0, is_head: false, is_branch_tip: true },
  { id: "b2", message: "Late branch polish",   timestamp: t(1),  timeline: "fork-late",    parents: ["b1"], lane: 3, is_head: false, is_branch_tip: true },
  { id: "b1", message: "Late branch start",    timestamp: t(2),  timeline: "fork-late",    parents: ["c3"], lane: 3, is_head: false, is_branch_tip: false },
  { id: "d2", message: "Early refined",        timestamp: t(1),  timeline: "fork-early",   parents: ["d1"], lane: 2, is_head: false, is_branch_tip: true },
  { id: "d1", message: "Early experiment",     timestamp: t(2),  timeline: "fork-early",   parents: ["c1"], lane: 2, is_head: false, is_branch_tip: false },
  { id: "c3", message: "Build features",       timestamp: t(3),  timeline: "main",         parents: ["c2"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "c2", message: "Add framework",        timestamp: t(4),  timeline: "main",         parents: ["c1"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "c1", message: "Initial setup",        timestamp: t(5),  timeline: "main",         parents: [],     lane: 0, is_head: false, is_branch_tip: false },
];

// ── 9) Long parallel branches from same fork point: main(3) + alpha from c1(4, HEAD) + beta from c1(3)
// git log: see D:\cutready\test-long-parallel
const longParallelNodes: GraphNode[] = [
  { id: "a4", message: "Alpha complete",  timestamp: t(0),  timeline: "fork-alpha", parents: ["a3"], lane: 1, is_head: true,  is_branch_tip: true },
  { id: "a3", message: "Alpha refine",    timestamp: t(1),  timeline: "fork-alpha", parents: ["a2"], lane: 1, is_head: false, is_branch_tip: false },
  { id: "a2", message: "Alpha develop",   timestamp: t(2),  timeline: "fork-alpha", parents: ["a1"], lane: 1, is_head: false, is_branch_tip: false },
  { id: "a1", message: "Alpha start",     timestamp: t(3),  timeline: "fork-alpha", parents: ["c1"], lane: 1, is_head: false, is_branch_tip: false },
  { id: "m3", message: "Main complete",   timestamp: t(1),  timeline: "main",       parents: ["m2"], lane: 0, is_head: false, is_branch_tip: true },
  { id: "m2", message: "Main progress",   timestamp: t(2),  timeline: "main",       parents: ["c1"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "b3", message: "Beta polish",     timestamp: t(1),  timeline: "fork-beta",  parents: ["b2"], lane: 2, is_head: false, is_branch_tip: true },
  { id: "b2", message: "Beta develop",    timestamp: t(2),  timeline: "fork-beta",  parents: ["b1"], lane: 2, is_head: false, is_branch_tip: false },
  { id: "b1", message: "Beta start",      timestamp: t(3),  timeline: "fork-beta",  parents: ["c1"], lane: 2, is_head: false, is_branch_tip: false },
  { id: "c1", message: "Initial setup",   timestamp: t(4),  timeline: "main",       parents: [],     lane: 0, is_head: false, is_branch_tip: false },
];

// ── Timeline maps ─────────────────────────────────────────────
const mainOnly = new Map([["main", { label: "Main", colorIndex: 0 }]]);
const twoTl = new Map([
  ["main", { label: "Main", colorIndex: 0 }],
  ["fork-explore", { label: "Explore", colorIndex: 1 }],
]);
const threeTl = new Map([
  ["main", { label: "Main", colorIndex: 0 }],
  ["fork-explore", { label: "Explore", colorIndex: 1 }],
  ["fork-alternate", { label: "Alternate", colorIndex: 2 }],
]);
const deepTl = new Map([
  ["main", { label: "Main", colorIndex: 0 }],
  ["fork-explore", { label: "Explore", colorIndex: 1 }],
  ["fork-alt", { label: "Alt", colorIndex: 2 }],
]);
const fourTl = new Map([
  ["main", { label: "Main", colorIndex: 0 }],
  ["fork-explore", { label: "Explore", colorIndex: 1 }],
  ["fork-early", { label: "Early", colorIndex: 2 }],
  ["fork-late", { label: "Late", colorIndex: 3 }],
]);
const parallelTl = new Map([
  ["main", { label: "Main", colorIndex: 0 }],
  ["fork-alpha", { label: "Alpha", colorIndex: 1 }],
  ["fork-beta", { label: "Beta", colorIndex: 2 }],
]);

// ── Panel helper ──────────────────────────────────────────────
function Panel({ title, gitGraph, nodes, isDirty, isRewound, timelineMap, multi, onNodeClick }: {
  title: string; gitGraph: string;
  nodes: GraphNode[]; isDirty: boolean; isRewound: boolean;
  timelineMap: Map<string, { label: string; colorIndex: number }>;
  multi: boolean; onNodeClick: (id: string) => void;
}) {
  return (
    <div style={{ width: 300, border: "1px solid #45475a", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #45475a", fontSize: 13, fontWeight: 600 }}>
        {title}
      </div>
      <SnapshotGraph nodes={nodes} isDirty={isDirty} isRewound={isRewound}
        timelineMap={timelineMap} hasMultipleTimelines={multi}
        onNodeClick={(id) => onNodeClick(id)} />
      <pre style={{ padding: "6px 12px", fontSize: 10, color: "#6c7086", borderTop: "1px solid #313244",
        whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.4 }}>
        {gitGraph}
      </pre>
    </div>
  );
}

function TestApp() {
  const [clicked, setClicked] = useState<string | null>(null);

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", background: "#1e1e2e", color: "#cdd6f4", minHeight: "100vh", padding: 24 }}>
      <style>{`
        :root {
          --color-accent: #cba6f7;
          --color-accent-hover: #b48ae0;
          --color-text: #cdd6f4;
          --color-text-secondary: #a6adc8;
          --color-surface: #1e1e2e;
          --color-surface-alt: #313244;
          --color-border: #45475a;
        }
      `}</style>

      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Snapshot Graph Test Harness</h1>
      {clicked && <p style={{ fontSize: 12, color: "#a6adc8", marginBottom: 16 }}>Last clicked: {clicked}</p>}

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Panel title="1) Linear" gitGraph={
`* Final polish (HEAD -> main)
* Added intro
* Initial setup`}
          nodes={linearNodes} isDirty={false} isRewound={false}
          timelineMap={mainOnly} multi={false} onNodeClick={setClicked} />

        <Panel title="2) Linear + dirty" gitGraph={
`* Final polish (HEAD -> main)
* Added intro
* Initial setup
(working tree dirty)`}
          nodes={linearNodes} isDirty={true} isRewound={false}
          timelineMap={mainOnly} multi={false} onNodeClick={setClicked} />

        <Panel title="3) Two branches" gitGraph={
`* Main continues (main)
| * Refined approach (HEAD -> fork)
| * Exploring idea
|/
* Added intro
* Initial setup`}
          nodes={twoBranchNodes} isDirty={false} isRewound={false}
          timelineMap={twoTl} multi={true} onNodeClick={setClicked} />

        <Panel title="4) Two branches + dirty" gitGraph={
`* Refined approach (HEAD -> fork)
* Exploring idea
| * Main continues (main)
|/
* Added intro
* Initial setup
(working tree dirty)`}
          nodes={twoBranchNodes} isDirty={true} isRewound={false}
          timelineMap={twoTl} multi={true} onNodeClick={setClicked} />

        <Panel title="5) Three branches" gitGraph={
`* Alternate (fork-alt)
| * Refined A (HEAD -> fork-explore)
| * Exploring idea A
| | * Main continues (main)
| |/
| * Added intro
|/
* Initial setup`}
          nodes={threeBranchNodes} isDirty={false} isRewound={false}
          timelineMap={threeTl} multi={true} onNodeClick={setClicked} />

        <Panel title="6) Three branches + dirty" gitGraph={
`* Alternate (fork-alt)
| * Refined A (HEAD -> fork-explore)
| * Exploring idea A
| | * Main continues (main)
| |/
| * Added intro
|/
* Initial setup
(working tree dirty)`}
          nodes={threeBranchNodes} isDirty={true} isRewound={false}
          timelineMap={threeTl} multi={true} onNodeClick={setClicked} />

        <Panel title="7) Deep branches (3×multi-commit)" gitGraph={
`* fork-alt: Refine alt
* fork-alt: Alt approach
| * HEAD→fork-explore: Refined exploration
| * fork-explore: Develop exploration
| * fork-explore: Explore idea
| | * main: Final main
| | * main: Polish main
| |/
| * Core features
|/
* Add structure
* Initial setup`}
          nodes={deepBranchNodes} isDirty={false} isRewound={false}
          timelineMap={deepTl} multi={true} onNodeClick={setClicked} />

        <Panel title="8) Four branches, staggered forks" gitGraph={
`* HEAD→fork-explore: Explore complete
* fork-explore: Explore develop
* fork-explore: Explore start
| * main: Main complete
| | * fork-early: Early refined
| | * fork-early: Early experiment
| | | * fork-late: Late branch polish
| | | * fork-late: Late branch start
| | |/
| |/|
| * | Build features
|/ /
* / Add framework
|/
* Initial setup`}
          nodes={fourBranchNodes} isDirty={false} isRewound={false}
          timelineMap={fourTl} multi={true} onNodeClick={setClicked} />

        <Panel title="9) Long parallel (3 from same point)" gitGraph={
`* HEAD→fork-alpha: Alpha complete
* fork-alpha: Alpha refine
* fork-alpha: Alpha develop
* fork-alpha: Alpha start
| * main: Main complete
| * main: Main progress
|/
| * fork-beta: Beta polish
| * fork-beta: Beta develop
| * fork-beta: Beta start
|/
* Initial setup`}
          nodes={longParallelNodes} isDirty={false} isRewound={false}
          timelineMap={parallelTl} multi={true} onNodeClick={setClicked} />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<TestApp />);
