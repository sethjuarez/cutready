/** TypeScript types for Sketches and Storyboards. */

import type { ContractData } from "./contract";
// Import model files directly, not the generated index: type-only imports keep
// generated runtime code out of the bundle and the program small.
import type { DocumentMetadata as DocumentMetadataContract } from "../contracts/generated/model/document-metadata";
import type { MotionPlan as MotionPlanContract, MotionPlanKind } from "../contracts/generated/model/motion-plan";
import type { MotionPlanEasing, MotionPlanKeyframe as MotionPlanKeyframeContract } from "../contracts/generated/model/motion-plan-keyframe";
import type { MotionPoint as MotionPointContract } from "../contracts/generated/model/motion-point";
import type { NarrationAsset as NarrationAssetContract } from "../contracts/generated/model/narration-asset";
import type { NarrationBeat as NarrationBeatContract } from "../contracts/generated/model/narration-beat";
import type { NarrationPlan as NarrationPlanContract } from "../contracts/generated/model/narration-plan";
import type { PlanningCellLocks as PlanningCellLocksContract } from "../contracts/generated/model/planning-cell-locks";
import type { PlanningRow as PlanningRowContract } from "../contracts/generated/model/planning-row";
import type { Sketch as SketchContract, SketchState } from "../contracts/generated/model/sketch";
import type { TypingSpot as TypingSpotContract } from "../contracts/generated/model/typing-spot";

// `.sk` document types come from contracts/sketch.tsp. Interfaces below only
// narrow contract fields the frontend constrains further.

export type { MotionPlanEasing, MotionPlanKind, SketchState };

/** Recorded or generated narration audio attached to a row. */
export type NarrationAsset = ContractData<NarrationAssetContract>;

export type NarrationEmphasis = "reduced" | "moderate" | "strong";

export interface NarrationBeat extends ContractData<NarrationBeatContract> {
  emphasis?: NarrationEmphasis | null;
}

/** Durable creative direction and compiled SSML for generated narration. */
export interface NarrationPlan extends ContractData<NarrationPlanContract> {
  beats?: NarrationBeat[] | null;
}

export interface MotionPoint extends ContractData<MotionPointContract> {
  rank: 1 | 2 | 3;
}

/** A normalized text region rendered as a typewriter overlay during video export. */
export interface TypingSpot extends ContractData<TypingSpotContract> {
  font_family?: "sans" | "serif" | "mono" | null;
}

export type MotionPlanKeyframe = ContractData<MotionPlanKeyframeContract>;

/** Agent-generated camera motion plan. Empty `keyframes` are omitted on save. */
export type MotionPlan = ContractData<MotionPlanContract>;

export type PlanningCellLocks = ContractData<PlanningCellLocksContract>;

/** A lockable planning-table cell. */
export type PlanningCellField = keyof PlanningCellLocks;

/** A row in the sketch planning table. */
export interface PlanningRow extends ContractData<PlanningRowContract> {
  /** Project-relative path to an Elucim visual file (e.g., ".cutready/visuals/abc123.json"). */
  visual?: string | null;
  motion_points?: MotionPoint[] | null;
  typing_spots?: TypingSpot[] | null;
  narration_plan?: NarrationPlan | null;
}

/** User-defined key/value metadata stored with portable project documents. */
export type DocumentMetadata = ContractData<DocumentMetadataContract>;

/** A sketch — a focused scene in a demo storyboard. */
export interface Sketch extends ContractData<SketchContract> {
  rows: PlanningRow[];
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
  reachable_from_local_variation?: boolean;
  reachable_from_remote_variation?: boolean;
  reachable_from_support_ref?: boolean;
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

/** Hybrid projects: how the current branch compares with the base branch (e.g. `main`). */
export interface BaseStatus extends SyncStatus {
  /** Base branch name. */
  base: string;
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
  turn_count?: number;
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
  /** Frontend-only: CutReady display metadata retained while a chat is open. */
  cutready?: ChatMessageMetadata;
}

export interface ChatMessageMetadata {
  workingNotes?: ChatWorkingNotes;
  runDetails?: ChatRunDetails;
}

export interface ChatRunUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatRunDetails {
  provider: string;
  model: string;
  execution_engine: string;
  agent_id: string;
  run_id?: string;
  elapsed_ms?: number;
  reasoning_effort?: string | null;
  tool_calls?: number;
  usage?: ChatRunUsage;
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
