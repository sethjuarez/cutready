import "@typra/emitter";

/**
 * Portable CutReady document contracts. Wire names are snake_case because
 * `.sk`/`.sb` files are snake_case on disk; Typra derives idiomatic native
 * names (e.g. Swift `demoActions`) from them.
 *
 * The @vector cases in vectors.tsp pin the canonical save form and edit
 * policy; contracts/README.md documents both.
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

  /** Rich-text description (Lexical JSON or Markdown string). Opaque. Save writes `null` when unset. */
  description: unknown | null = null;

  rows: PlanningRow[];
  metadata?: DocumentMetadata;
  state: SketchState;

  /** RFC 3339 UTC timestamp. Runtimes never rewrite a timestamp they did not change. */
  @sample(#{ created_at: "2026-06-28T20:00:00Z" })
  created_at: string;

  /** RFC 3339 UTC timestamp, set by every successful edit. */
  @sample(#{ updated_at: "2026-06-28T20:20:00Z" })
  updated_at: string;

  /** Fields written by newer desktop or iOS builds, preserved verbatim. */
  ...Record<unknown>;
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
  /**
   * Stable identity, unique within the sketch. Decode gives a row without one
   * (legacy files) `row-{position}`, one-based, appending `-2`, `-3`, ... while
   * that id is taken; save always writes it. Duplicate ids are rejected with
   * `duplicate_row_id`. Hosts may mint any other unique string for new rows.
   */
  id?: string;

  /** Whether the entire row is protected from edits. Saved as `false` when unset. */
  locked?: boolean;

  /** Saved with all six fields, even when nothing is locked. */
  locks?: PlanningCellLocks;

  /** Human duration such as `~30s`, `0:20`, or `2m`. */
  @sample(#{ time: "0:20" })
  time: string;

  /** Concrete duration in seconds. */
  duration_seconds?: uint32;

  @sample(#{ narrative: "Welcome to CutReady." })
  narrative: string;

  @sample(#{ demo_actions: "Open the workspace." })
  demo_actions: string;

  /** Normalized walkthrough steps compiled from prose actions or rough recordings. Omitted when empty. */
  demo_steps?: DemoStep[];

  /** Project-relative screenshot path. Legacy files may omit it; save writes `null` when unset. */
  screenshot: string | null = null;

  /** Project-relative Elucim visual path (legacy files may inline the document). Opaque. */
  visual?: unknown;

  motion_points?: MotionPoint[];
  typing_spots?: TypingSpot[];
  motion_plan?: MotionPlan;

  /** Editorial camera/framing beats; t_ms is row-relative. Omitted when empty. */
  framing_beats?: FramingBeat[];

  /** Designer brief for the visual. */
  design_plan?: string;

  narration?: NarrationAsset;
  narration_plan?: NarrationPlan;

  /** Fields written by newer desktop or iOS builds, preserved verbatim. */
  ...Record<unknown>;
}

/** Recorded or generated narration audio attached to a row. */
model NarrationAsset {
  @sample(#{ path: ".cutready/narration/row-1.wav" })
  path: string;

  /** Spoken text used when the audio was recorded or generated. */
  source_text: string;

  /** SHA-256 of `source_text`. */
  source_text_hash: string;

  /** Row narrative text at the moment the audio was recorded or generated. */
  narrative_text?: string;

  /** SHA-256 of `narrative_text`, for non-lossy staleness checks. */
  narrative_text_hash?: string;

  mime_type: string;

  /** Legacy files may omit it; save writes `null` when unknown. */
  duration_ms: uint32 | null = null;

  leading_silence_ms?: uint32;
  trailing_silence_ms?: uint32;
  silence_threshold_db?: float32;
  byte_size: uint64;

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
  pause_after_ms?: uint32;
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
  rank: uint8;

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
  start_offset_ms?: uint32;
  duration_ms?: uint32;
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
  time_ms: uint32;
  scale: float32;
  x: float32;
  y: float32;
  easing?: MotionPlanEasing;
}

union MotionPlanKind {
  subtlePush: "subtle_push",
  wideHoldThenPush: "wide_hold_then_push",
  pushThenDrift: "push_then_drift",
}

/** Agent-generated camera motion plan for screenshot rows. */
model MotionPlan {
  kind: MotionPlanKind;
  keyframes?: MotionPlanKeyframe[];
  rationale?: string;
}

/** How a click step captures its interaction for export. */
union InteractionCapturePolicy {
  beforeAfter: "before_after",
  beforeAfterAndMotion: "before_after_and_motion",
}

/** How the edit treats time spent waiting for a condition. */
union WaitEditPolicy {
  keepNatural: "keep_natural",
  compressWait: "compress_wait",
  showStartAndEnd: "show_start_and_end",
  cutToCompletion: "cut_to_completion",
  keepVisible: "keep_visible",
}

/** A target region in source screenshot pixels. */
model InteractionBounds {
  x: float32;
  y: float32;
  width: float32;
  height: float32;
}

/** Kinds of walkthrough steps. */
union DemoStepKind {
  navigate: "navigate",
  click: "click",
  type: "type",
  select: "select",
  waitFor: "wait_for",
  highlight: "highlight",
}

/**
 * Normalized walkthrough intent between `demo_actions` prose and replay actions.
 */
@discriminator("kind")
model DemoStep {
  kind: DemoStepKind;
}

model DemoStepNavigate extends DemoStep {
  kind: "navigate";
  target: string;
}

model DemoStepClick extends DemoStep {
  kind: "click";
  target: string;
  target_bounds?: InteractionBounds;
  capture?: InteractionCapturePolicy;
}

model DemoStepType extends DemoStep {
  kind: "type";
  text: string;
  target?: string;
  target_bounds?: InteractionBounds;
  clear_first?: boolean;
}

model DemoStepSelect extends DemoStep {
  kind: "select";
  target: string;
  value: string;
  target_bounds?: InteractionBounds;
}

model DemoStepWaitFor extends DemoStep {
  kind: "wait_for";
  condition: string;
  timeout_ms?: uint32;
  edit_policy?: WaitEditPolicy;
}

model DemoStepHighlight extends DemoStep {
  kind: "highlight";
  target: string;
  target_bounds?: InteractionBounds;
}

/** A region normalized to the row screenshot or visual (0..1). */
model FramingRect {
  x: float32;
  y: float32;
  width: float32;
  height: float32;
}

union FramingEasing {
  linear: "linear",
  easeInOut: "ease_in_out",
  easeOut: "ease_out",
}

/** Kinds of framing beats. */
union FramingBeatKind {
  fullScreen: "full_screen",
  zoomTo: "zoom_to",
  hold: "hold",
}

/**
 * Editorial camera intent for a row, separate from interaction replay.
 * `at_ms` is relative to the start of the row; save always writes it.
 */
@discriminator("kind")
model FramingBeat {
  kind: FramingBeatKind;
}

model FramingBeatFullScreen extends FramingBeat {
  kind: "full_screen";
  at_ms?: uint32;
}

model FramingBeatZoomTo extends FramingBeat {
  kind: "zoom_to";
  at_ms?: uint32;
  target?: string;
  rect?: FramingRect;
  duration_ms?: uint32;
  easing?: FramingEasing;
}

model FramingBeatHold extends FramingBeat {
  kind: "hold";
  at_ms?: uint32;
  duration_ms: uint32;
}