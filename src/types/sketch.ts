/** TypeScript types for Sketches and Storyboards. */

/** Lifecycle state of a sketch. */
export type SketchState =
  | "draft"
  | "recording_enriched"
  | "refined"
  | "final";

/** A row in the sketch planning table (4 columns). */
export interface PlanningRow {
  time: string;
  narrative: string;
  demo_actions: string;
  screenshot: string | null;
}

/** A sketch — a focused scene in a demo storyboard. */
export interface Sketch {
  title: string;
  /** Rich-text description — Lexical editor state JSON. */
  description: unknown;
  /** Planning table rows. */
  rows: PlanningRow[];
  state: SketchState;
  created_at: string;
  updated_at: string;
}

/** Lightweight summary for listing sketches. */
export interface SketchSummary {
  path: string;
  title: string;
  state: SketchState;
  row_count: number;
  created_at: string;
  updated_at: string;
}

/** A storyboard — an ordered sequence of sketches with optional sections. */
export interface Storyboard {
  title: string;
  description: string;
  items: StoryboardItem[];
  created_at: string;
  updated_at: string;
}

/** An item in a storyboard's sequence. */
export type StoryboardItem =
  | { type: "sketch_ref"; path: string }
  | { type: "section"; title: string; sketches: string[] };

/** Lightweight summary for listing storyboards. */
export interface StoryboardSummary {
  path: string;
  title: string;
  sketch_count: number;
  created_at: string;
  updated_at: string;
}

/** An entry in the project's version history. */
export interface VersionEntry {
  id: string;
  message: string;
  timestamp: string;
  summary: string;
}
