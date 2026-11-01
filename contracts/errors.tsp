import "@typra/emitter";
import "./sketch.tsp";

namespace CutReady.Contracts;

/**
 * Stable error codes. Clients branch on `code`, never on `message`. Lock
 * checks compare each position's cells before and after the edit, so
 * unchanged values on locked content are accepted.
 */
union CmdErrorCode {
  /** The whole sketch is locked; every edit is rejected. */
  lockedDocument: "locked_document",

  /** Rows would be added or removed while a row or cell is locked. */
  lockedRowCount: "locked_row_count",

  /** A locked row's content would change, including fields a runtime doesn't model. */
  lockedRow: "locked_row",

  /** A locked cell's value would change. Screenshot and visual locks guard both cells. */
  lockedCell: "locked_cell",

  /** `details.row_index` is outside the planning table, or no row has `details.row_id`. */
  rowNotFound: "row_not_found",

  /** `order` (or `row_ids`) is not a permutation of the current rows. */
  invalidReorder: "invalid_reorder",

  /** Two rows share `details.row_id`; `details.row_index` is the second. Decode and save reject it. */
  duplicateRowId: "duplicate_row_id",

  /** An op is malformed, for example a cell lock without a row. */
  invalidOp: "invalid_op",

  /** The document changed since the edit was computed; `details.current_version` is its version now. */
  staleDocument: "stale_document",

  /**
   * Undo would overwrite changes made since the run: `details.conflicts` lists
   * each entity whose current value matches neither the run's before nor its
   * after value. Nothing is written.
   */
  undoConflict: "undo_conflict",

  /** The run wrote to the document again since it was reviewed; review it again. */
  staleReview: "stale_review",

  /** Codes from newer runtimes load and save unchanged. */
  string,
}

/** Structured context for a CmdError. Each code documents the fields it sets. */
model CmdErrorDetails {
  /** Zero-based row position, for row-scoped errors. */
  row_index?: uint32;

  /** The locked cell, for `locked_cell`. */
  field?: PlanningCellField;

  /** The repeated row id for `duplicate_row_id`; the missing one for `row_not_found`. */
  row_id?: string;

  /** Zero-based position of the rejected op in an `EditService` batch. */
  op_index?: uint32;

  /** The document version on disk, for `stale_document`. */
  current_version?: string;

  /** The entities that block an undo, for `undo_conflict`. */
  conflicts?: UndoConflict[];

  /** Detail fields from newer runtimes survive load and save. */
  ...Record<unknown>;
}

/**
 * One entity an undo can't revert. `path` addresses it: `""` for the whole
 * document (a note is only ever whole), `/<key>` for a top-level field,
 * `/rows/<id>` for a row's content, `/rows/<id>/locked` and
 * `/rows/<id>/locks` for its locks, and `/rows` for the order of row ids.
 * Versions are `documentVersion` of the file's bytes for `""` and of the
 * entity's compact JSON with keys sorted otherwise; absent entities omit them.
 */
model UndoConflict {
  path: string;

  /** The value the undo expected (the run's after value). */
  expected_version?: string;

  /** The value there now. */
  current_version?: string;
}

/**
 * The error envelope every runtime reports when it rejects a command, in
 * Draftline's `TauriCommandError` shape. `message` is human-readable text each
 * runtime words for itself; vectors pin `code` and `details` only.
 */
@serializable
model CmdError {
  code: CmdErrorCode;
  message: string;
  details?: CmdErrorDetails;
}
