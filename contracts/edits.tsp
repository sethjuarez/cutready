import "@typra/emitter";
import "./sketch.tsp";
import "./vectors.tsp";

namespace CutReady.Contracts;

/**
 * Text cells to replace on one planning row. Omitted cells are left untouched.
 * A `time` that differs from the current value also sets `duration_seconds` to
 * `PlanningTiming.parseDurationSeconds(time)`, omitting it when that is null.
 * An unchanged `time` keeps the current `duration_seconds`.
 */
model RowTextUpdate {
  /** Zero-based row index. */
  row_index: uint32;

  time?: string;
  narrative?: string;
  demo_actions?: string;
}

/**
 * Edit rejection codes. Lock checks compare each position's cells before and
 * after the edit, so unchanged values on locked content are accepted.
 */
union SketchEditErrorCode {
  /** The whole sketch is locked; every edit is rejected. */
  lockedDocument: "locked_document",

  /** A locked row's content would change, including fields a runtime doesn't model. */
  lockedRow: "locked_row",

  /** A locked cell's value would change. Screenshot and visual locks guard both cells. */
  lockedCell: "locked_cell",

  /** `row_index` is outside the planning table. */
  rowNotFound: "row_not_found",

  /** `order` is not a permutation of the current row indices. */
  invalidReorder: "invalid_reorder",
}

/** The error payload every runtime reports when it rejects an edit. */
model SketchEditError {
  code: SketchEditErrorCode;

  /** Zero-based row position, for row-scoped errors. */
  row_index?: uint32;

  /** The locked cell, for `locked_cell`. */
  field?: PlanningCellField;
}

/**
 * Behavioral contract for `.sk` documents. Each runtime binds these operations
 * to its production decode, edit, and save code through a thin vector adapter.
 * Inputs and outputs are raw `.sk` JSON, so the vectors also prove that fields
 * a runtime does not model survive the round trip.
 * Successful edits set `updated_at` to `now` (RFC 3339, at most microsecond
 * precision); rejected edits report a SketchEditError.
 */
interface SketchDocument {
  /** Decode a `.sk` document and save it again without changes. */
  @sync
  @vector(RoundTripVectors)
  roundTrip(sketch: Sketch): Sketch;

  /** Replace text cells on one row. */
  @sync
  @vector(UpdateRowTextVectors)
  updateRowText(sketch: Sketch, update: RowTextUpdate, now: string): Sketch;

  /**
   * Reorder rows. `order[i]` is the current zero-based index of the row that
   * moves to position `i`.
   */
  @sync
  @vector(ReorderRowsVectors)
  reorderRows(sketch: Sketch, order: uint32[], now: string): Sketch;
}

/** How a planning row's `time` label becomes `duration_seconds`. */
interface PlanningTiming {
  /**
   * Parse a time label into whole seconds. Trim whitespace, lowercase with the
   * full Unicode mapping (the Kelvin sign U+212A becomes `k`), and drop one
   * leading `~`, then accept the first form that matches:
   *
   * 1. A clock, `M:SS` or `H:MM:SS`; parts after the first are one or two
   *    digits below 60.
   * 2. The sum of every `<number> <unit>` pair, where the number is decimal
   *    digits with an optional fraction, the space is optional, and the unit is
   *    one of h, hr, hrs, hour, hours, m, min, mins, minute, minutes, s, sec,
   *    secs, second, seconds, not followed by an ASCII letter, ASCII digit, or
   *    underscore (JavaScript `\w`). Text around the pairs is ignored.
   * 3. A bare decimal number of seconds.
   *
   * Fractions round half up. Returns null when nothing matches or the result
   * does not fit in `uint32`. Digits are ASCII; whitespace is JavaScript's `\s`.
   */
  @sync
  @vector(ParseDurationSecondsVectors)
  parseDurationSeconds(time: string): uint32 | null;
}
