/** TypeScript types for Sketches and Storyboards. */

/** Lifecycle state of a sketch. */
export type SketchState =
  | "draft"
  | "recording_enriched"
  | "refined"
  | "final";

/** A row in the sketch planning table. */
export interface PlanningRow {
  /** Whether the entire row is protected from edits. */
  locked?: boolean;
  /** Per-cell lock state for targeted AI-safe editing. */
  locks?: Partial<Record<PlanningCellField, boolean>>;
  time: string;
  narrative: string;
  demo_actions: string;
  screenshot: string | null;
  /** Path to an elucim visual file (e.g., ".cutready/visuals/abc123.json"). */
  visual?: string | null;
  /** English-language design brief for the visual (created by Designer agent Pass 1). */
  design_plan?: string | null;
}

export type PlanningCellField = "time" | "narrative" | "demo_actions" | "screenshot" | "visual" | "design_plan";

/** A sketch — a focused scene in a demo storyboard. */
export interface Sketch {
  title: string;
  /** Whether the whole sketch is protected from edits. */
  locked?: boolean;
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
  /** Whether the whole storyboard is protected from edits. */
  locked?: boolean;
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
  locked?: boolean;
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

/** A timeline (branch) in the project. */
export interface TimelineInfo {
  name: string;
  label: string;
  is_active: boolean;
  snapshot_count: number;
  color_index: number;
}

/** A node in the timeline graph. */
export interface GraphNode {
  id: string;
  message: string;
  timestamp: string;
  timeline: string;
  parents: string[];
  lane: number;
  is_head: boolean;
  is_branch_tip?: boolean;
  is_remote_tip?: boolean;
  /** Author name (for collaborator info). */
  author?: string;
}

/** Remote git info. */
export interface RemoteInfo {
  name: string;
  url: string;
}

/** Sync status: how many commits ahead/behind the remote. */
export interface SyncStatus {
  ahead: number;
  behind: number;
}

/** A file change between two snapshots. */
export interface DiffEntry {
  path: string;
  /** "added" | "deleted" | "modified" */
  status: string;
  additions: number;
  deletions: number;
}

/** Lightweight summary for listing notes (.md files). */
export interface NoteSummary {
  path: string;
  title: string;
  size: number;
  updated_at: string;
}

// ── Chat types ────────────────────────────────────────────────

/** A single content part in a multimodal message (matches Rust ContentPart). */
export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

/** A chat message (matches Rust ChatMessage). */
export interface ChatMessage {
  role: string;
  /** May be a plain string, null, or an array of ContentPart objects for multimodal messages. */
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Frontend-only: marks a message as queued while the agent is busy. */
  pending?: boolean;
}

export interface ToolCall {
  id: string;
  call_type: string;
  function: { name: string; arguments: string };
}

/** Summary of a saved chat session. */
export interface ChatSessionSummary {
  path: string;
  title: string;
  message_count: number;
  updated_at: string;
}

/** A persisted chat session. */
export interface ChatSession {
  title: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

// ── Merge types ──────────────────────────────────────────────

export type ConflictFileType = "sketch" | "storyboard" | "note" | "other";

export interface FieldConflict {
  field_path: string;
  ours: unknown;
  theirs: unknown;
  ancestor: unknown;
}

export interface TextConflictRegion {
  start_line: number;
  ours_lines: string[];
  theirs_lines: string[];
  ancestor_lines: string[];
}

export interface ConflictFile {
  path: string;
  file_type: ConflictFileType;
  ours: string;
  theirs: string;
  ancestor: string;
  field_conflicts: FieldConflict[];
  text_conflicts: TextConflictRegion[];
}

export type MergeResult =
  | { status: "clean"; commit_id: string }
  | { status: "conflicts"; conflicts: ConflictFile[] }
  | { status: "fast_forward"; commit_id: string }
  | { status: "nothing" };

export interface FileResolution {
  path: string;
  content: string;
}
