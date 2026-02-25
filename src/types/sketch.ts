/** TypeScript types for Sketches and Storyboards. */

/** Lifecycle state of a sketch. */
export type SketchState =
  | "draft"
  | "recording_enriched"
  | "refined"
  | "final";

/** A row in the sketch planning table (4 columns). */
export interface PlanningRow {
  id: string;
  time: string;
  narrative: string;
  demo_actions: string;
  screenshot: string | null;
}

/** A sketch — a focused scene in a demo storyboard. */
export interface Sketch {
  id: string;
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
  id: string;
  title: string;
  state: SketchState;
  row_count: number;
  created_at: string;
  updated_at: string;
}

/** A storyboard — an ordered sequence of sketches with optional sections. */
export interface Storyboard {
  id: string;
  title: string;
  description: string;
  items: StoryboardItem[];
  created_at: string;
  updated_at: string;
}

/** An item in a storyboard's sequence. */
export type StoryboardItem =
  | { type: "sketch_ref"; sketch_id: string }
  | { type: "section"; id: string; title: string; sketch_ids: string[] };

/** Lightweight summary for listing storyboards. */
export interface StoryboardSummary {
  id: string;
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
