/** TypeScript types for Sketches and Storyboards. */

/** Lifecycle state of a sketch. */
export type SketchState =
  | "draft"
  | "recording_enriched"
  | "refined"
  | "final";

/** A row in the sketch planning table. */
export interface NarrationAsset {
  /** Project-relative path to recorded or generated narration audio. */
  path: string;
  /** Narrative text used when this audio was recorded/generated. */
  source_text: string;
  /** SHA-256 of the source text. */
  source_text_hash: string;
  mime_type: string;
  duration_ms?: number | null;
  /** Detected silence before speech begins, stored non-destructively for future trim/alignment. */
  leading_silence_ms?: number | null;
  /** Detected silence after speech ends, stored non-destructively for future trim/alignment. */
  trailing_silence_ms?: number | null;
  /** Decibel threshold used for leading/trailing silence detection. */
  silence_threshold_db?: number | null;
  byte_size: number;
  recorded_at: string;
}

export interface PlanningRow {
  /** Whether the entire row is protected from edits. */
  locked?: boolean;
  /** Per-cell lock state for targeted AI-safe editing. */
  locks?: Partial<Record<PlanningCellField, boolean>>;
  time: string;
  /** Concrete duration in seconds. Legacy rows may only have `time`; totals derive from either field. */
  duration_seconds?: number | null;
  narrative: string;
  demo_actions: string;
  screenshot: string | null;
  /** Path to an elucim visual file (e.g., ".cutready/visuals/abc123.json"). */
  visual?: string | null;
  /** English-language design brief for the visual (created by Designer agent Pass 1). */
  design_plan?: string | null;
  /** Recorded or generated narration audio attached to this row. */
  narration?: NarrationAsset | null;
}

export type PlanningCellField = "time" | "narrative" | "demo_actions" | "screenshot" | "visual" | "design_plan";

/** User-defined key/value metadata stored with portable project documents. */
export interface DocumentMetadata {
  fields?: Record<string, string>;
}

/** A sketch — a focused scene in a demo storyboard. */
export interface Sketch {
  title: string;
  /** Whether the whole sketch is protected from edits. */
  locked?: boolean;
  /** Rich-text description — Lexical editor state JSON. */
  description: unknown;
  /** Planning table rows. */
  rows: PlanningRow[];
  metadata?: DocumentMetadata;
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
  metadata?: DocumentMetadata;
  items: StoryboardItem[];
  created_at: string;
  updated_at: string;
}

/** An item in a storyboard's sequence. */
export type StoryboardItem =
  | { type: "sketch_ref"; path: string }
  | { type: "section"; title: string; description?: string; sketches: string[] };

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
  remote_labels?: string[];
  /** Author name (for collaborator info). */
  author?: string;
}

/** Remote git info. */
export interface RemoteInfo {
  name: string;
  url: string;
}

/** A branch that exists on a remote but has not necessarily been adopted locally. */
export interface RemoteBranchInfo {
  id: string;
  name: string;
  remote: string;
  head_message?: string;
  head_author?: string;
  head_timestamp?: string;
}

/** Sync status: how many commits ahead/behind the remote. */
export interface SyncStatus {
  ahead: number;
  behind: number;
}

/** A remote snapshot available to bring into the workspace. */
export interface IncomingCommit {
  id: string;
  message: string;
  author: string;
  timestamp: string;
  changed_files: DiffEntry[];
  projects: string[];
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
  /** Frontend-only: CutReady display metadata preserved in chat session files. */
  cutready?: ChatMessageMetadata;
}

export interface ChatMessageMetadata {
  workingNotes?: ChatWorkingNotes;
}

export interface ChatWorkingNotes {
  /** Assistant prose that streamed before a tool-round reset. */
  drafts?: string[];
  /** Provider reasoning/thinking text streamed during the run. */
  thinking?: string;
}

export interface ChatToolActivity {
  id: string;
  name: string;
  arguments: string;
  result?: string;
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
  author_name?: string | null;
  author_email?: string | null;
}

/** A persisted chat session. */
export interface ChatSession {
  title: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
  author_name?: string | null;
  author_email?: string | null;
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

export type ConflictSide = "ours" | "theirs";

export interface ConflictChoices {
  text_choices: Record<number, ConflictSide>;
  field_choices: Record<string, ConflictSide>;
}
