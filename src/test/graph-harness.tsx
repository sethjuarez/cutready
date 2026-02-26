import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SnapshotGraph } from "../components/SnapshotGraph";
import type { GraphNode } from "../types/sketch";
import "../index.css";

/**
 * Standalone test harness for SnapshotGraph.
 * Run: npm run dev, then navigate to http://localhost:1420/test-graph.html
 */

// ── quipy-demo data ───────────────────────────────────────────
const quipyNodes: GraphNode[] = [
  { id: "1a23d36", message: "other 1",                   timestamp: "2026-02-26T23:27:44Z", timeline: "fork-232744",  parents: ["9617d7b"], lane: 2, is_head: true,  is_branch_tip: true },
  { id: "9e5245f", message: "take 2",                    timestamp: "2026-02-26T23:26:17Z", timeline: "main",         parents: ["977ffee"], lane: 0, is_head: false, is_branch_tip: true },
  { id: "977ffee", message: "take 1",                    timestamp: "2026-02-26T23:25:00Z", timeline: "main",         parents: ["9617d7b"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "9617d7b", message: "Initial getting started",   timestamp: "2026-02-26T23:24:00Z", timeline: "main",         parents: ["e906234"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "e906234", message: "Initialize project",        timestamp: "2026-02-26T23:23:00Z", timeline: "main",         parents: [],          lane: 0, is_head: false, is_branch_tip: false },
  // Alias: fork-232617 also points at 9e5245f
  { id: "9e5245f", message: "take 2",                    timestamp: "2026-02-26T23:26:17Z", timeline: "fork-232617",  parents: ["977ffee"], lane: 1, is_head: false, is_branch_tip: true },
];

const quipyTimelines = new Map([
  ["main", { label: "Main", colorIndex: 0 }],
  ["fork-232617", { label: "fork-232617", colorIndex: 1 }],
  ["fork-232744", { label: "Other direction", colorIndex: 2 }],
]);

// ── voice-demo data ───────────────────────────────────────────
const voiceNodes: GraphNode[] = [
  { id: "e3b75fb", message: "part 1",                    timestamp: "2026-02-26T22:10:00Z", timeline: "fork-investigation", parents: ["cf906af"], lane: 2, is_head: false, is_branch_tip: true },
  { id: "cf906af", message: "my new thing",              timestamp: "2026-02-26T22:09:00Z", timeline: "fork-investigation", parents: ["86102fb"], lane: 2, is_head: false, is_branch_tip: false },
  { id: "86102fb", message: "part 1",                    timestamp: "2026-02-26T22:08:00Z", timeline: "fork-investigation", parents: ["7f415c7"], lane: 2, is_head: false, is_branch_tip: false },
  { id: "d8999e1", message: "three",                     timestamp: "2026-02-26T22:07:00Z", timeline: "main",               parents: ["dbf94b6"], lane: 0, is_head: false, is_branch_tip: true },
  { id: "dbf94b6", message: "two",                       timestamp: "2026-02-26T22:06:00Z", timeline: "main",               parents: ["7f415c7"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "7f415c7", message: "one",                       timestamp: "2026-02-26T22:05:00Z", timeline: "main",               parents: ["de141e4"], lane: 0, is_head: true,  is_branch_tip: false },
  { id: "de141e4", message: "start",                     timestamp: "2026-02-26T22:04:00Z", timeline: "main",               parents: ["e085e3d"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "e085e3d", message: "Initialize project",        timestamp: "2026-02-26T22:03:00Z", timeline: "main",               parents: [],          lane: 0, is_head: false, is_branch_tip: false },
  // Alias: fork-223120 also points at de141e4
  { id: "de141e4", message: "start",                     timestamp: "2026-02-26T22:04:00Z", timeline: "fork-223120",        parents: ["e085e3d"], lane: 1, is_head: false, is_branch_tip: true },
];

const voiceTimelines = new Map([
  ["main", { label: "Main", colorIndex: 0 }],
  ["fork-223120", { label: "fork-223120", colorIndex: 1 }],
  ["fork-investigation", { label: "Investigation", colorIndex: 2 }],
]);

// ── Simple linear (no branches) ──────────────────────────────
const simpleNodes: GraphNode[] = [
  { id: "aaa", message: "Latest snapshot",    timestamp: "2026-02-26T23:30:00Z", timeline: "main", parents: ["bbb"], lane: 0, is_head: true,  is_branch_tip: true },
  { id: "bbb", message: "Added intro scene",  timestamp: "2026-02-26T23:20:00Z", timeline: "main", parents: ["ccc"], lane: 0, is_head: false, is_branch_tip: false },
  { id: "ccc", message: "Initial setup",      timestamp: "2026-02-26T23:10:00Z", timeline: "main", parents: [],      lane: 0, is_head: false, is_branch_tip: false },
];

const simpleTimelines = new Map([
  ["main", { label: "Main", colorIndex: 0 }],
]);

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

      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        {/* Simple linear */}
        <div style={{ width: 280, border: "1px solid #45475a", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #45475a", fontSize: 13, fontWeight: 600 }}>
            Simple (no branches)
          </div>
          <SnapshotGraph
            nodes={simpleNodes}
            isDirty={false}
            isRewound={false}
            timelineMap={simpleTimelines}
            hasMultipleTimelines={false}
            onNodeClick={(id) => setClicked(id)}
          />
        </div>

        {/* quipy-demo */}
        <div style={{ width: 280, border: "1px solid #45475a", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #45475a", fontSize: 13, fontWeight: 600 }}>
            quipy-demo (3 branches, duplicate tip)
          </div>
          <SnapshotGraph
            nodes={quipyNodes}
            isDirty={false}
            isRewound={false}
            timelineMap={quipyTimelines}
            hasMultipleTimelines={true}
            onNodeClick={(id) => setClicked(id)}
          />
        </div>

        {/* voice-demo */}
        <div style={{ width: 280, border: "1px solid #45475a", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #45475a", fontSize: 13, fontWeight: 600 }}>
            voice-demo (3 branches, shared ancestor)
          </div>
          <SnapshotGraph
            nodes={voiceNodes}
            isDirty={false}
            isRewound={false}
            timelineMap={voiceTimelines}
            hasMultipleTimelines={true}
            onNodeClick={(id) => setClicked(id)}
          />
        </div>

        {/* voice-demo with dirty + rewound */}
        <div style={{ width: 280, border: "1px solid #45475a", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #45475a", fontSize: 13, fontWeight: 600 }}>
            voice-demo (dirty + rewound)
          </div>
          <SnapshotGraph
            nodes={voiceNodes}
            isDirty={true}
            isRewound={true}
            timelineMap={voiceTimelines}
            hasMultipleTimelines={true}
            onNodeClick={(id) => setClicked(id)}
          />
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<TestApp />);
