import "@typra/emitter";
import "./sketch.tsp";
import "./vectors.tsp";

namespace CutReady.Contracts;

/**
 * Text cells to replace on one planning row. Omitted cells are left untouched.
 * Desktop's time-cell UI also recomputes `duration_seconds`; this edit does not
 * (see contracts/README.md, "Open policy questions").
 */
model RowTextUpdate {
  /** Zero-based, non-negative row index. */
  row_index: int32;

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
  row_index?: int32;

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
  reorderRows(sketch: Sketch, order: int32[], now: string): Sketch;
}
