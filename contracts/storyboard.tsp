import "@typra/emitter";
import "./sketch.tsp";
import "./vectors.tsp";

namespace CutReady.Contracts;

/**
 * A `.sb` file: an ordered sequence of sketches, optionally grouped into sections.
 * Sketches are referenced by project-relative path.
 * Legacy files list paths in a top-level `sketches` array instead of `items`;
 * runtimes read it as sketch references and never write it back.
 * Unknown top-level fields must survive every runtime's decode -> save.
 */
@serializable
model Storyboard {
  @sample(#{ title: "Launch demo" })
  title: string;

  /** Plain-text description. Saved as `""` when unset. */
  description?: string;

  /** Whether the whole storyboard is protected from edits. Saved as `false` when unset. */
  locked?: boolean;

  metadata?: DocumentMetadata;
  items: StoryboardItem[];

  /** RFC 3339 UTC timestamp. Runtimes never rewrite a timestamp they did not change. */
  @sample(#{ created_at: "2026-06-28T20:00:00Z" })
  created_at: string;

  /** RFC 3339 UTC timestamp, set by every successful edit. */
  @sample(#{ updated_at: "2026-06-28T20:20:00Z" })
  updated_at: string;

  /** Fields written by newer desktop or iOS builds, preserved verbatim. */
  ...Record<unknown>;
}

/** Kinds of storyboard entries. */
union StoryboardItemType {
  sketchRef: "sketch_ref",
  section: "section",
}

/** One entry in a storyboard sequence. */
@discriminator("type")
model StoryboardItem {
  type: StoryboardItemType;
}

/** A single sketch in the sequence. */
model StoryboardSketchRef extends StoryboardItem {
  type: "sketch_ref";

  @sample(#{ path: "intro.sk" })
  path: string;
}

/** A named group of sketches. */
model StoryboardSection extends StoryboardItem {
  type: "section";

  @sample(#{ title: "Setup" })
  title: string;

  /** Omitted when empty. */
  description?: string;

  /** Project-relative sketch paths, in order. */
  sketches: string[];
}

/**
 * Behavioral contract for `.sb` documents. Each runtime binds these operations
 * to its production decode and save code through a thin vector adapter.
 * Inputs and outputs are raw `.sb` JSON.
 */
interface StoryboardDocument {
  /** Decode a `.sb` document and save it again without changes. */
  @sync
  @vector(StoryboardRoundTripVectors)
  roundTrip(storyboard: Storyboard): Storyboard;

  /**
   * Convert an older `.sb` shape to the canonical one. Runs on raw JSON before
   * decode, and is idempotent. Desktop saves the result back to disk.
   *
   * - `items` missing or null: built from legacy `sketches` (else `[]`).
   *   `sketches` is always dropped.
   * - Item type `sketch` becomes `sketch_ref`.
   * - Section: null or empty `description` is dropped; missing `sketches` is `[]`.
   * - Null or missing `description` is `""`; `locked` is `false`.
   *   Null `metadata` is dropped.
   */
  @sync
  @vector(StoryboardUpgradeVectors)
  upgrade(storyboard: unknown): Storyboard;
}
