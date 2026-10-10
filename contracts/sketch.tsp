import "@typra/emitter";

/**
 * Portable CutReady document contracts. Wire names are snake_case because
 * `.sk`/`.sb` files are snake_case on disk; Typra derives idiomatic native
 * names (e.g. Swift `demoActions`) from them.
 *
 * Canonical save rules that Typra cannot express yet (explicit `null` and
 * unknown-field passthrough) are pinned by the @vector cases in vectors.tsp
 * and documented in contracts/README.md. Integer counts, ranks, and durations
 * are non-negative; Typra has no unsigned integer types yet.
 */
namespace CutReady.Contracts;

/** Lifecycle state of a sketch. Legacy files may say `sketch`. */
@parseAlias("draft", #["sketch"])
union SketchState {
  draft: "draft",
  recordingEnriched: "recording_enriched",
  refined: "refined",
  final: "final",
}

/** User-defined key/value metadata stored with portable documents. */
model DocumentMetadata {
  fields?: Record<string>;
}

/**
 * A `.sk` file: a focused scene with a planning table.
 * Unknown top-level fields must survive every runtime's decode -> save.
 */
@serializable
model Sketch {
  @sample(#{ title: "Intro" })
  title: string;

  /** Whether the whole sketch is protected from edits. Saved as `false` when unset. */
  locked?: boolean;

  /** Rich-text description (Lexical JSON, Markdown string, or null). Opaque. */
  description?: unknown;

  rows: PlanningRow[];
  metadata?: DocumentMetadata;
  state: SketchState;

  /** RFC 3339 UTC timestamp. Runtimes never rewrite a timestamp they did not change. */
  @sample(#{ created_at: "2026-06-28T20:00:00Z" })
  created_at: string;

  /** RFC 3339 UTC timestamp, set by every successful edit. */
  @sample(#{ updated_at: "2026-06-28T20:20:00Z" })
  updated_at: string;
}

/** Planning-table cells that can be locked individually. */
union PlanningCellField {
  time: "time",
  narrative: "narrative",
  demoActions: "demo_actions",
  screenshot: "screenshot",
  visual: "visual",
  designPlan: "design_plan",
}

/** Per-cell lock state. Canonical save writes all six fields. */
model PlanningCellLocks {
  time?: boolean;
  narrative?: boolean;
  demo_actions?: boolean;
  screenshot?: boolean;
  visual?: boolean;
  design_plan?: boolean;
}

/**
 * A row in the sketch planning table.
 * Unknown fields must survive every runtime's decode -> save.
 */
model PlanningRow {
  /** Whether the entire row is protected from edits. Saved as `false` when unset. */
  locked?: boolean;

  /** Saved with all six fields, even when nothing is locked. */
  locks?: PlanningCellLocks;

  /** Human duration such as `~30s`, `0:20`, or `2m`. */
  @sample(#{ time: "0:20" })
  time: string;

  /** Concrete duration in seconds. */
  duration_seconds?: int32;

  @sample(#{ narrative: "Welcome to CutReady." })
  narrative: string;

  @sample(#{ demo_actions: "Open the workspace." })
  demo_actions: string;

  /** Project-relative screenshot path. Canonical save writes `null` when absent. */
  screenshot?: string;

  /** Project-relative Elucim visual path (legacy files may inline the document). Opaque. */
  visual?: unknown;

  motion_points?: MotionPoint[];
  typing_spots?: TypingSpot[];
  motion_plan?: MotionPlan;

  /** Designer brief for the visual. */
  design_plan?: string;

  narration?: NarrationAsset;
  narration_plan?: NarrationPlan;
}

/** Recorded or generated narration audio attached to a row. */
model NarrationAsset {
  @sample(#{ path: ".cutready/narration/row-1.wav" })
  path: string;

  /** Narrative text at the moment the audio was recorded or generated. */
  source_text: string;

  /** SHA-256 of `source_text`. */
  source_text_hash: string;

  mime_type: string;

  /** Canonical save writes `null` when unknown. */
  duration_ms?: int64;

  leading_silence_ms?: int64;
  trailing_silence_ms?: int64;
  silence_threshold_db?: float32;
  byte_size: int64;

  /** RFC 3339 UTC timestamp. */
  recorded_at: string;
}

/** A deliberate delivery beat for generated narration. */
model NarrationBeat {
  text: string;
  purpose?: string;
  style?: string;
  style_degree?: float32;
  emphasis?: string;
  pause_after_ms?: int64;
}

/** Durable creative direction and compiled SSML for generated narration. */
model NarrationPlan {
  source_text: string;
  voice: string;
  locale: string;
  ssml: string;
  baseline_style?: string;
  pronunciation_overrides?: Record<string>;
  beats?: NarrationBeat[];

  /** RFC 3339 UTC timestamp. */
  generated_at: string;
}

/** Ranked normalized screenshot point used for camera moves. */
model MotionPoint {
  /** 1, 2, or 3. */
  rank: int32;

  x: float32;
  y: float32;
  label?: string;
}

/** A normalized text region rendered as a typewriter overlay. */
model TypingSpot {
  x: float32;
  y: float32;
  width: float32;
  height: float32;
  text: string;
  start_offset_ms?: int64;
  duration_ms?: int64;
  characters_per_second?: float32;
  show_cursor?: boolean;
  text_color?: string;
  font_family?: string;
  font_scale?: float32;
}

union MotionPlanEasing {
  linear: "linear",
  easeInOut: "ease_in_out",
  easeOut: "ease_out",
}

model MotionPlanKeyframe {
  time_ms: int64;
  scale: float32;
  x: float32;
  y: float32;
  easing?: MotionPlanEasing;
}

/** Agent-generated camera motion plan for screenshot rows. */
model MotionPlan {
  /**
   * `subtle_push`, `wide_hold_then_push`, or `push_then_drift`.
   * A string until Typra emits matching Rust enum variant names for
   * multi-word values in generated tests.
   */
  kind: string;
  keyframes?: MotionPlanKeyframe[];
  rationale?: string;
}
