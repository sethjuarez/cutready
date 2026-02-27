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
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<TestApp />);
