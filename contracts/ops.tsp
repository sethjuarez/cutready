import "@typra/emitter";
import "./sketch.tsp";
import "./storyboard.tsp";
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
  touch: "touch",
  replaceSketch: "replace_sketch",
  replaceStoryboard: "replace_storyboard",
  replaceNote: "replace_note",
  writeNote: "write_note",
  insertStoryboardItem: "insert_storyboard_item",
  removeStoryboardItem: "remove_storyboard_item",
  setStoryboardItems: "set_storyboard_items",
}

/** What a project file holds. Hosts pick it from the extension: `.sk`, `.sb`, `.md`. */
union DocumentKind {
  sketch: "sketch",
  storyboard: "storyboard",
  note: "note",
}

/**
 * One typed edit. Row ops address rows by stable id. Lock rules match
 * `SketchDocument`: content edits are rejected on a locked document, locked
 * rows, and changed locked cells; `set_lock` is always allowed. An op that
 * doesn't apply to the document's kind is `invalid_op`.
 *
 * Sketches take the title, description, metadata, row, `set_lock`, `touch`
 * and `replace_sketch` ops. Storyboards take `set_title`,
 * `set_description` (a string; null clears it), `set_metadata`, `set_lock`
 * without a row, `touch`, the storyboard item ops and `replace_storyboard`.
 * Notes take `write_note`, `replace_note` and `set_lock` without a row.
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

/** Mark the document edited without changing anything else. On a storyboard it
 * follows the lock policy; on a sketch it doesn't, so a touch always succeeds. */
model TouchOp extends EditOp {
  kind: "touch";
}

/**
 * Replace the whole document, for create and import only. A replacement
 * ignores the lock policy and keeps the given `updated_at`; rows without an id
 * get one as in decode.
 */
model ReplaceSketchOp extends EditOp {
  kind: "replace_sketch";
  sketch: Sketch;
}

/** `replace_sketch` for a storyboard, in the canonical shape. Hosts upgrade older files on read. */
model ReplaceStoryboardOp extends EditOp {
  kind: "replace_storyboard";
  storyboard: Storyboard;
}

/** `replace_sketch` for a note: the new markdown, ignoring the note's lock. */
model ReplaceNoteOp extends EditOp {
  kind: "replace_note";
  content: string;
}

/** The note's new markdown. Rejected while the note is locked. */
model WriteNoteOp extends EditOp {
  kind: "write_note";
  content: string;
}

/** Insert `item` at `index`; null or past the end appends. */
model InsertStoryboardItemOp extends EditOp {
  kind: "insert_storyboard_item";
  index: uint32 | null;
  item: StoryboardItem;
}

/** Remove the item at `index`; an index past the end is `invalid_op`. */
model RemoveStoryboardItemOp extends EditOp {
  kind: "remove_storyboard_item";
  index: uint32;
}

/** Replace the storyboard's items, for reorders and bulk rewrites. */
model SetStoryboardItemsOp extends EditOp {
  kind: "set_storyboard_items";
  items: StoryboardItem[];
}

/**
 * The one way every host edits a document. Ops apply in order and atomically:
 * the first rejected op fails the batch with `details.op_index` and the
 * document is unchanged. A successful batch sets `updated_at` to `now` once,
 * unless every op is a replacement. Notes have no `updated_at`.
 */
interface EditService {
  /** Apply ops to a `.sk` document. */
  @sync
  @vector(ApplySketchOpsVectors)
  applySketchOps(sketch: Sketch, ops: EditOp[], now: string): Sketch;

  /** Apply ops to a `.sb` document. */
  @sync
  @vector(ApplyStoryboardOpsVectors)
  applyStoryboardOps(storyboard: Storyboard, ops: EditOp[], now: string): Storyboard;

  /**
   * The version an edit was computed against: `sha256:` plus the lowercase
   * hex SHA-256 of the document's bytes on disk. A write whose expected
   * version differs fails with `stale_document`.
   */
  @sync
  @vector(DocumentVersionVectors)
  documentVersion(content: string): string;

  /**
   * The host write path for every project document. A version mismatch fails
   * with `stale_document` (with `details.current_version` when the file
   * exists). A missing file must start with its kind's replacement op,
   * otherwise the batch is `invalid_op`. A batch that starts with the
   * replacement op doesn't read the old bytes, so it can overwrite a file that
   * no longer parses. The result is the canonical bytes to
   * write and their version. An empty batch returns `content` unchanged.
   */
  @sync
  @vector(EditDocumentVectors)
  editDocument(request: DocumentEditRequest): DocumentEdit;

  /**
   * Review Undo: reverts a run's writes to one document on top of whatever is
   * there now. Each write is inverted newest first, entity by entity: rows by
   * id (content and locks separately), row order, other top-level fields, a
   * note's content. An entity already at its before value is skipped; one at
   * its after value is restored; anything else is an `undo_conflict` listing
   * every such entity, and nothing is written. Locks are judged on the result:
   * the undo may revert locks the run set, but content still locked afterwards
   * can't change (`locked_document`, `locked_row_count`, `locked_row`,
   * `locked_cell`). A null `content` result deletes the file.
   */
  @sync
  @vector(UndoDocumentVectors)
  undoDocument(request: DocumentUndoRequest): DocumentUndo;
}

/** One logged write: the document's bytes before and after (null when absent). */
model UndoWrite {
  before: string | null;
  after: string | null;
}

/** Undo a run's writes to one document. */
model DocumentUndoRequest {
  kind: DocumentKind;

  /** The file on disk, or null when it doesn't exist. */
  content: string | null;

  /** The run's writes to this document, oldest first. */
  writes: UndoWrite[];

  /** The note's lock from the host's lock store; ignored for other kinds. */
  note_locked?: boolean = false;

  /** RFC 3339 time stamped as `updated_at` on a merged sketch or storyboard. */
  now: string;
}

/** The bytes to write (null to delete the file) and their version. */
model DocumentUndo {
  content: string | null;
  version: string | null;
}

/**
 * A run with changes nobody has kept or undone yet. App edits run as an
 * auto-kept `user` run, so they never appear here.
 */
@serializable model RunReview {
  run_id: string;
  actor: string;
  started_at: string;
  documents: DocumentReview[];
}

/**
 * One document a run changed. Keep and Undo pass `through_seq` back; if the
 * run wrote to the document again since, they fail with `stale_review`.
 */
model DocumentReview {
  /** Project-relative path. */
  doc: string;

  /** The newest op-log entry this review covers. */
  through_seq: uint64;

  /** How many writes the review covers. */
  writes: uint32;

  /** The run created the document. */
  created: boolean;

  /** When the run last wrote it (RFC 3339). */
  last_at: string;
}

/** One write to one project file. */
model DocumentEditRequest {
  kind: DocumentKind;

  /** The file on disk, or null when it doesn't exist. */
  content: string | null;

  /** The version the ops were computed against, or null to expect no file. */
  expected_version: string | null;

  ops: EditOp[];
  now: string;

  /** The note's lock from the host's lock store; ignored for other kinds. */
  note_locked?: boolean = false;
}

/**
 * Bytes to write and their `EditService.documentVersion`. For notes,
 * `note_locked` is the lock to keep and `note_lock_changed` says whether the
 * host must save it; a note batch either edits content or locks, never both.
 */
model DocumentEdit {
  content: string;
  version: string;
  note_locked?: boolean;
  note_lock_changed?: boolean;
}
