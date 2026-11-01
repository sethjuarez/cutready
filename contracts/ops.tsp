import "@typra/emitter";
import "./sketch.tsp";
import "./errors.tsp";
import "./vectors.tsp";

namespace CutReady.Contracts;

/** Every edit kind. A kind this runtime doesn't know is rejected, never skipped. */
union EditOpKind {
  setTitle: "set_title",
  setDescription: "set_description",
  setMetadata: "set_metadata",
  setRowText: "set_row_text",
  setScreenshot: "set_screenshot",
  setVisual: "set_visual",
  insertRow: "insert_row",
  deleteRow: "delete_row",
  reorderRows: "reorder_rows",
  updateRow: "update_row",
  replaceRows: "replace_rows",
  setLock: "set_lock",
}

/**
 * One typed edit, addressed by stable row id. Lock rules match
 * `SketchDocument`: content edits are rejected on a locked sketch, locked rows,
 * and changed locked cells; `set_lock` is always allowed.
 */
@discriminator("kind")
model EditOp {
  kind: EditOpKind;
}

model SetTitleOp extends EditOp {
  kind: "set_title";
  title: string;
}

/** Rich-text description; null clears it. */
model SetDescriptionOp extends EditOp {
  kind: "set_description";
  description: unknown | null;
}

model SetMetadataOp extends EditOp {
  kind: "set_metadata";
  metadata: DocumentMetadata;
}

/**
 * Text cells to replace on one row; omitted cells are left untouched. A changed
 * `time` recomputes `duration_seconds` as in `RowTextUpdate`.
 */
model SetRowTextOp extends EditOp {
  kind: "set_row_text";
  row_id: string;
  time?: string;
  narrative?: string;
  demo_actions?: string;
}

/** Project-relative screenshot path; null clears it. */
model SetScreenshotOp extends EditOp {
  kind: "set_screenshot";
  row_id: string;
  screenshot: string | null;
}

/** Visual reference (`.cutready/visuals/<hash>.json`); null clears it. */
model SetVisualOp extends EditOp {
  kind: "set_visual";
  row_id: string;
  visual: string | null;
}

/**
 * Insert `row` after `after_row_id`, or first when it is null. The new row's
 * lock state is ignored: inserted rows start unlocked. A row without an id
 * gets one as in decode.
 */
model InsertRowOp extends EditOp {
  kind: "insert_row";
  after_row_id: string | null;
  row: PlanningRow;
}

model DeleteRowOp extends EditOp {
  kind: "delete_row";
  row_id: string;
}

/** The new order; `row_ids` lists every current row id exactly once. */
model ReorderRowsOp extends EditOp {
  kind: "reorder_rows";
  row_ids: string[];
}

/**
 * Replace the row whose id is `row.id` with `row`, including fields this
 * runtime doesn't model. The row keeps its current lock state.
 */
model UpdateRowOp extends EditOp {
  kind: "update_row";
  row: PlanningRow;
}

/**
 * Replace the whole planning table. Lock state stays with each position, as in
 * `SketchDocument`. Prefer the targeted ops; this one is for bulk rewrites.
 */
model ReplaceRowsOp extends EditOp {
  kind: "replace_rows";
  rows: PlanningRow[];
}

/**
 * Lock or unlock the sketch (no `row_id`), a whole row (`row_id`), or one cell
 * (`row_id` and `field`). Sketch and row locks apply to everything inside them.
 */
model SetLockOp extends EditOp {
  kind: "set_lock";
  row_id?: string;
  field?: PlanningCellField;
  locked: boolean;
}

/**
 * The one way every host edits a document. Ops apply in order and atomically:
 * the first rejected op fails the batch with `details.op_index` and the
 * document is unchanged. A successful batch sets `updated_at` to `now` once.
 */
interface EditService {
  /** Apply ops to a `.sk` document. */
  @sync
  @vector(ApplySketchOpsVectors)
  applySketchOps(sketch: Sketch, ops: EditOp[], now: string): Sketch;

  /**
   * The version an edit was computed against: `sha256:` plus the lowercase
   * hex SHA-256 of the document's bytes on disk. A write whose expected
   * version differs fails with `stale_document`.
   */
  @sync
  @vector(DocumentVersionVectors)
  documentVersion(content: string): string;

  /**
   * The host write path for a `.sk` file. `content` is the file on disk and
   * `expected_version` the version the ops were computed against; a mismatch
   * fails with `stale_document` and `details.current_version`. Otherwise the
   * ops apply and the result is the canonical bytes to write and their
   * version. An empty batch returns `content` unchanged.
   */
  @sync
  @vector(EditSketchContentVectors)
  editSketchContent(content: string, expected_version: string, ops: EditOp[], now: string): ContentEdit;
}

/** Bytes to write and their `EditService.documentVersion`. */
model ContentEdit {
  content: string;
  version: string;
}
