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

  /** `details.row_index` is outside the planning table. */
  rowNotFound: "row_not_found",

  /** `order` is not a permutation of the current row indices. */
  invalidReorder: "invalid_reorder",

  /** Two rows share `details.row_id`; `details.row_index` is the second. Decode and save reject it. */
  duplicateRowId: "duplicate_row_id",

  /** Codes from newer runtimes load and save unchanged. */
  string,
}

/** Structured context for a CmdError. Each code documents the fields it sets. */
model CmdErrorDetails {
  /** Zero-based row position, for row-scoped errors. */
  row_index?: uint32;

  /** The locked cell, for `locked_cell`. */
  field?: PlanningCellField;

  /** The repeated row id, for `duplicate_row_id`. */
  row_id?: string;

  /** Detail fields from newer runtimes survive load and save. */
  ...Record<unknown>;
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
