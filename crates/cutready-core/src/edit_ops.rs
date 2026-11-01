//! Typed edit ops: the desktop binding for the `EditService` contract in
//! `contracts/ops.tsp`.
//!
//! Every host edits project documents as a batch of [`EditOp`]s. Sketch row
//! ops address rows by stable id and map onto the [`sketch_edits`] lock policy,
//! so they enforce exactly the rules the positional commands do. A batch is
//! atomic: the first rejected op fails it with its index and the document is
//! left unchanged. [`edit_document`] is the one write path: hosts read the
//! bytes, call it, and write what it returns.

use std::borrow::Borrow;

use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::contracts::{
    CmdError, CmdErrorCode, CmdErrorDetails, DocumentKind, EditOp, EditOpKind, LoadContext,
    SaveContext,
};
use crate::document::{self, DocumentError};
use crate::models::sketch::{
    assign_row_ids, DocumentMetadata, DuplicateRowId, PlanningCellLocks, PlanningRow, Sketch,
    Storyboard, StoryboardItem,
};
use crate::notes::NOTE_LOCKED_MESSAGE;
use crate::sketch_edits::{self, contract_index, RowTextUpdate, SketchEditError};

/// The storyboard lock message, shared with the desktop commands.
pub const STORYBOARD_LOCKED_MESSAGE: &str = "This storyboard is locked. Unlock it before editing.";

/// Why one op was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpRejection {
    #[error(transparent)]
    Edit(#[from] SketchEditError),
    #[error(transparent)]
    DuplicateRowId(#[from] DuplicateRowId),
    #[error("{}", STORYBOARD_LOCKED_MESSAGE)]
    LockedStoryboard,
    #[error("{}", NOTE_LOCKED_MESSAGE)]
    LockedNote,
}

/// A rejected batch: which op failed (zero-based) and why.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{rejection}")]
pub struct EditOpError {
    pub op_index: usize,
    pub rejection: OpRejection,
}

/// The contract's `CmdError` with `details.op_index` set.
impl From<&EditOpError> for CmdError {
    fn from(err: &EditOpError) -> Self {
        let mut cmd = match &err.rejection {
            OpRejection::Edit(edit) => CmdError::from(edit),
            OpRejection::DuplicateRowId(dup) => CmdError::from(dup),
            OpRejection::LockedStoryboard | OpRejection::LockedNote => CmdError {
                code: CmdErrorCode::LockedDocument,
                message: err.rejection.to_string(),
                details: None,
            },
        };
        cmd.details.get_or_insert_with(Default::default).op_index =
            Some(contract_index(err.op_index));
        cmd
    }
}

/// Parse wire ops. A malformed op, including one of a kind this runtime
/// doesn't know, is rejected as `invalid_op` rather than skipped.
pub fn parse_ops(values: &[Value]) -> Result<Vec<EditOp>, EditOpError> {
    values
        .iter()
        .enumerate()
        .map(|(op_index, value)| parse_op(op_index, value))
        .collect()
}

fn parse_op(op_index: usize, value: &Value) -> Result<EditOp, EditOpError> {
    EditOp::try_load_from_value(value, &LoadContext::default()).map_err(|e| {
        rejected(
            op_index,
            SketchEditError::InvalidOp {
                reason: format!("Edit {} is not a valid op: {e}", op_index + 1),
            },
        )
    })
}

/// Ops parsed one at a time, just before each applies, so the first rejected
/// op wins whether it is malformed or refused.
fn lazy_ops(values: &[Value]) -> impl Iterator<Item = Result<EditOp, EditOpError>> + '_ {
    values
        .iter()
        .enumerate()
        .map(|(op_index, value)| parse_op(op_index, value))
}

fn typed_ops(ops: &[EditOp]) -> impl Iterator<Item = Result<&EditOp, EditOpError>> {
    ops.iter().map(Ok)
}

/// Whole-document replacements keep the given `updated_at`.
fn is_replacement(op: &EditOp) -> bool {
    matches!(
        op.kind,
        EditOpKind::ReplaceSketchOp { .. }
            | EditOpKind::ReplaceStoryboardOp { .. }
            | EditOpKind::ReplaceNoteOp { .. }
    )
}

/// Apply a batch to a copy and keep it only if every op succeeds. A batch
/// with any op but a replacement stamps `now` once.
fn run_batch<D: Clone, O: Borrow<EditOp>>(
    doc: &mut D,
    ops: impl Iterator<Item = Result<O, EditOpError>>,
    now: DateTime<Utc>,
    apply: impl Fn(&mut D, &EditOp, DateTime<Utc>) -> Result<(), OpRejection>,
    stamp: impl FnOnce(&mut D, DateTime<Utc>),
) -> Result<(), EditOpError> {
    let mut next = doc.clone();
    let mut edited = false;
    let mut any = false;
    for (op_index, op) in ops.enumerate() {
        let op = op?;
        let op = op.borrow();
        apply(&mut next, op, now).map_err(|rejection| EditOpError {
            op_index,
            rejection,
        })?;
        any = true;
        edited |= !is_replacement(op);
    }
    if !any {
        return Ok(());
    }
    if edited {
        stamp(&mut next, now);
    }
    *doc = next;
    Ok(())
}

fn stamp_sketch(sketch: &mut Sketch, now: DateTime<Utc>) {
    sketch.updated_at = now;
}

fn stamp_storyboard(storyboard: &mut Storyboard, now: DateTime<Utc>) {
    storyboard.updated_at = now;
}

/// `EditService.applySketchOps` on wire ops.
pub fn apply_sketch_op_values(
    sketch: &mut Sketch,
    ops: &[Value],
    now: DateTime<Utc>,
) -> Result<(), EditOpError> {
    run_batch(sketch, lazy_ops(ops), now, apply_one, stamp_sketch)
}

/// `EditService.applySketchOps`. Applies `ops` in order; on success the
/// sketch's `updated_at` is `now` unless every op is a replacement (an empty
/// batch changes nothing).
pub fn apply_sketch_ops(
    sketch: &mut Sketch,
    ops: &[EditOp],
    now: DateTime<Utc>,
) -> Result<(), EditOpError> {
    run_batch(sketch, typed_ops(ops), now, apply_one, stamp_sketch)
}

/// `EditService.applyStoryboardOps` on wire ops.
pub fn apply_storyboard_op_values(
    storyboard: &mut Storyboard,
    ops: &[Value],
    now: DateTime<Utc>,
) -> Result<(), EditOpError> {
    run_batch(
        storyboard,
        lazy_ops(ops),
        now,
        apply_storyboard_one,
        stamp_storyboard,
    )
}

/// `EditService.applyStoryboardOps`.
pub fn apply_storyboard_ops(
    storyboard: &mut Storyboard,
    ops: &[EditOp],
    now: DateTime<Utc>,
) -> Result<(), EditOpError> {
    run_batch(
        storyboard,
        typed_ops(ops),
        now,
        apply_storyboard_one,
        stamp_storyboard,
    )
}

/// A note after a batch: its markdown and lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteState {
    pub content: String,
    pub locked: bool,
}

/// Note ops: `write_note` and `replace_note` change the markdown, `set_lock`
/// changes the lock. Hosts keep the lock in a separate store, so one batch
/// does either, never both.
fn apply_note_op_values(note: &mut NoteState, ops: &[Value]) -> Result<(), EditOpError> {
    let mut next = note.clone();
    let mut edits_content = None;
    for (op_index, op) in lazy_ops(ops).enumerate() {
        let op = op?;
        let content_op = !matches!(op.kind, EditOpKind::SetLockOp { .. });
        if *edits_content.get_or_insert(content_op) != content_op {
            return Err(rejected(
                op_index,
                SketchEditError::InvalidOp {
                    reason: "A note edit either changes the note or its lock, not both.".into(),
                },
            ));
        }
        apply_note_one(&mut next, &op).map_err(|rejection| EditOpError {
            op_index,
            rejection,
        })?;
    }
    *note = next;
    Ok(())
}

fn apply_note_one(note: &mut NoteState, op: &EditOp) -> Result<(), OpRejection> {
    match &op.kind {
        EditOpKind::WriteNoteOp { content } => {
            if note.locked {
                return Err(OpRejection::LockedNote);
            }
            note.content = content.clone();
        }
        EditOpKind::ReplaceNoteOp { content } => note.content = content.clone(),
        EditOpKind::SetLockOp {
            row_id: None,
            field: None,
            locked,
        } => note.locked = *locked,
        EditOpKind::SetLockOp { .. } => return Err(invalid("A note has no rows to lock.")),
        _ => return Err(not_for(op, "a note")),
    }
    Ok(())
}

/// Why a whole-file edit failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ContentEditError {
    #[error(transparent)]
    Stale(#[from] StaleDocument),
    #[error(transparent)]
    Document(#[from] DocumentError),
    #[error(transparent)]
    Op(#[from] EditOpError),
}

/// The contract's CmdError for a rejected write. Unreadable or unsavable
/// documents have no contract code yet; they surface as their message.
impl TryFrom<&ContentEditError> for CmdError {
    type Error = String;

    fn try_from(err: &ContentEditError) -> Result<Self, String> {
        match err {
            ContentEditError::Stale(stale) => Ok(CmdError::from(stale)),
            ContentEditError::Op(op) => Ok(CmdError::from(op)),
            ContentEditError::Document(DocumentError::DuplicateRowId(dup)) => {
                Ok(CmdError::from(dup))
            }
            ContentEditError::Document(other) => Err(other.to_string()),
        }
    }
}

/// A note's lock after a batch, and whether the host must save it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoteLock {
    pub locked: bool,
    pub changed: bool,
}

/// A successful whole-file edit: the canonical bytes to write and their
/// version, plus the note's lock for notes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentEdit {
    pub content: String,
    pub version: String,
    pub note_lock: Option<NoteLock>,
}

impl DocumentEdit {
    /// Whether the bytes differ from `current` and need writing.
    pub fn changes(&self, current: Option<&str>) -> bool {
        current != Some(self.content.as_str())
    }
}

/// `EditService.editDocument`: the host write path for every project file.
/// `current` is the file on disk (None when absent), `expected_version` the
/// version the ops were computed against (None to expect no file), and
/// `note_locked` the note's lock from the host's store.
pub fn edit_document(
    kind: DocumentKind,
    current: Option<&str>,
    expected_version: Option<&str>,
    ops: &[Value],
    now: DateTime<Utc>,
    note_locked: bool,
) -> Result<DocumentEdit, ContentEditError> {
    let current_version = ensure_expected_version(current.map(str::as_bytes), expected_version)?;
    let replaces = starts_with_replacement(kind, ops)?;
    if current.is_none() && !replaces {
        return Err(new_document_needs_replacement(kind, ops)?.into());
    }
    // A replacement batch doesn't read the old bytes, so it can overwrite a
    // file that no longer parses.
    let base = current.filter(|_| !replaces);
    let unchanged = |content: &str, version: String| DocumentEdit {
        content: content.to_string(),
        version,
        note_lock: (kind == DocumentKind::Note).then_some(NoteLock {
            locked: note_locked,
            changed: false,
        }),
    };
    if let (Some(content), Some(version), true) = (current, current_version, ops.is_empty()) {
        return Ok(unchanged(content, version));
    }
    let (content, note_lock) = match kind {
        DocumentKind::Sketch => {
            let mut sketch = match base {
                Some(content) => document::sketch_from_json(content)?,
                None => Sketch::new("", now),
            };
            apply_sketch_op_values(&mut sketch, ops, now)?;
            (document::sketch_to_json(&sketch)?, None)
        }
        DocumentKind::Storyboard => {
            let mut storyboard = match base {
                Some(content) => document::storyboard_from_json(content)?.0,
                None => Storyboard::new("", now),
            };
            apply_storyboard_op_values(&mut storyboard, ops, now)?;
            (document::storyboard_to_json(&storyboard)?, None)
        }
        DocumentKind::Note => {
            let mut note = NoteState {
                content: current.unwrap_or_default().to_string(),
                locked: note_locked,
            };
            apply_note_op_values(&mut note, ops)?;
            let lock = NoteLock {
                locked: note.locked,
                changed: note.locked != note_locked,
            };
            (note.content, Some(lock))
        }
    };
    let version = document_version(content.as_bytes());
    Ok(DocumentEdit {
        content,
        version,
        note_lock,
    })
}

/// Whether the batch opens with its kind's replacement op.
fn starts_with_replacement(kind: DocumentKind, ops: &[Value]) -> Result<bool, EditOpError> {
    let Some(value) = ops.first() else {
        return Ok(false);
    };
    let first = parse_op(0, value)?;
    Ok(matches!(
        (kind, &first.kind),
        (DocumentKind::Sketch, EditOpKind::ReplaceSketchOp { .. })
            | (
                DocumentKind::Storyboard,
                EditOpKind::ReplaceStoryboardOp { .. }
            )
            | (DocumentKind::Note, EditOpKind::ReplaceNoteOp { .. })
    ))
}

/// A file that doesn't exist yet is created by its kind's replacement op.
fn new_document_needs_replacement(
    kind: DocumentKind,
    ops: &[Value],
) -> Result<EditOpError, EditOpError> {
    let reason = match ops.first() {
        Some(value) => format!(
            "This {kind} doesn't exist yet; start with replace_{kind}, not {}.",
            parse_op(0, value)?.kind_str()
        ),
        None => "A new document needs its content.".into(),
    };
    Ok(rejected(0, SketchEditError::InvalidOp { reason }))
}

/// `EditService.documentVersion`: `sha256:` plus the lowercase hex digest of
/// the document's bytes.
pub fn document_version(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    let mut version = String::with_capacity(7 + digest.len() * 2);
    version.push_str("sha256:");
    for byte in digest {
        version.push_str(&format!("{byte:02x}"));
    }
    version
}

/// The document changed since the caller read it. `current_version` is None
/// when the file no longer exists.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("This document changed since the edit was made. Reload it and try again.")]
pub struct StaleDocument {
    pub current_version: Option<String>,
}

impl From<&StaleDocument> for CmdError {
    fn from(err: &StaleDocument) -> Self {
        CmdError {
            code: CmdErrorCode::StaleDocument,
            message: err.to_string(),
            details: err.current_version.as_ref().map(|version| CmdErrorDetails {
                current_version: Some(version.clone()),
                ..Default::default()
            }),
        }
    }
}

/// Checks a write's expected version against the bytes on disk (None when
/// absent) and returns the current version when it matches.
pub fn ensure_expected_version(
    current: Option<&[u8]>,
    expected: Option<&str>,
) -> Result<Option<String>, StaleDocument> {
    let current_version = current.map(document_version);
    if current_version.as_deref() == expected {
        Ok(current_version)
    } else {
        Err(StaleDocument { current_version })
    }
}

/// An op that doesn't apply to this kind of document.
fn not_for(op: &EditOp, what: &str) -> OpRejection {
    invalid(format!("{} doesn't apply to {what}.", op.kind_str()))
}

fn ensure_storyboard_unlocked(storyboard: &Storyboard) -> Result<(), OpRejection> {
    if storyboard.locked {
        return Err(OpRejection::LockedStoryboard);
    }
    Ok(())
}

fn apply_storyboard_one(
    storyboard: &mut Storyboard,
    op: &EditOp,
    _now: DateTime<Utc>,
) -> Result<(), OpRejection> {
    let item = |value: Value| to_core::<StoryboardItem>(value, "storyboard item");
    match &op.kind {
        EditOpKind::SetLockOp {
            row_id: None,
            field: None,
            locked,
        } => storyboard.locked = *locked,
        EditOpKind::SetLockOp { .. } => {
            return Err(invalid("A storyboard has no rows to lock."));
        }
        EditOpKind::ReplaceStoryboardOp { storyboard: next } => {
            *storyboard = to_core(next.to_value(&SaveContext::default()), "storyboard")?;
        }
        EditOpKind::SetTitleOp { title } => {
            ensure_storyboard_unlocked(storyboard)?;
            storyboard.title = title.clone();
        }
        EditOpKind::SetDescriptionOp { description } => {
            ensure_storyboard_unlocked(storyboard)?;
            storyboard.description = match description {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(text)) => text.clone(),
                Some(_) => return Err(invalid("A storyboard description is plain text.")),
            };
        }
        EditOpKind::SetMetadataOp { metadata } => {
            ensure_storyboard_unlocked(storyboard)?;
            storyboard.metadata = to_core::<DocumentMetadata>(
                metadata.to_value(&SaveContext::default()),
                "metadata",
            )?;
        }
        EditOpKind::TouchOp => ensure_storyboard_unlocked(storyboard)?,
        EditOpKind::InsertStoryboardItemOp { index, item: value } => {
            ensure_storyboard_unlocked(storyboard)?;
            let item = item(value.clone())?;
            match index.map(|i| i as usize) {
                Some(at) if at < storyboard.items.len() => storyboard.items.insert(at, item),
                _ => storyboard.items.push(item),
            }
        }
        EditOpKind::RemoveStoryboardItemOp { index } => {
            ensure_storyboard_unlocked(storyboard)?;
            let at = *index as usize;
            if at >= storyboard.items.len() {
                return Err(invalid("Position out of range"));
            }
            storyboard.items.remove(at);
        }
        EditOpKind::SetStoryboardItemsOp { items } => {
            ensure_storyboard_unlocked(storyboard)?;
            storyboard.items = items
                .iter()
                .map(|value| item(value.to_value(&SaveContext::default())))
                .collect::<Result<_, _>>()?;
        }
        _ => return Err(not_for(op, "a storyboard")),
    }
    Ok(())
}

fn rejected(op_index: usize, err: SketchEditError) -> EditOpError {
    EditOpError {
        op_index,
        rejection: OpRejection::Edit(err),
    }
}

fn invalid(reason: impl Into<String>) -> OpRejection {
    SketchEditError::InvalidOp {
        reason: reason.into(),
    }
    .into()
}

fn row_position(sketch: &Sketch, row_id: &str) -> Result<usize, SketchEditError> {
    sketch
        .rows
        .iter()
        .position(|row| row.id == row_id)
        .ok_or_else(|| SketchEditError::RowIdNotFound {
            row_id: row_id.to_string(),
        })
}

/// Contract values become the core model through their canonical JSON, which
/// keeps fields the core doesn't model.
fn to_core<T: serde::de::DeserializeOwned>(value: Value, what: &str) -> Result<T, OpRejection> {
    serde_json::from_value(value).map_err(|e| invalid(format!("Invalid {what}: {e}")))
}

fn core_row(row: &crate::contracts::PlanningRow) -> Result<PlanningRow, OpRejection> {
    to_core(row.to_value(&SaveContext::default()), "planning row")
}

/// Replace the rows under the lock policy, then give new rows ids and reject
/// repeated ones.
fn commit_rows(
    sketch: &mut Sketch,
    rows: Vec<PlanningRow>,
    now: DateTime<Utc>,
) -> Result<(), OpRejection> {
    sketch_edits::replace_rows(sketch, rows, now)?;
    assign_row_ids(&mut sketch.rows)?;
    Ok(())
}

fn set_row_asset(
    sketch: &mut Sketch,
    row_id: &str,
    now: DateTime<Utc>,
    set: impl FnOnce(&mut PlanningRow),
) -> Result<(), OpRejection> {
    sketch_edits::ensure_unlocked(sketch)?;
    let index = row_position(sketch, row_id)?;
    let mut rows = sketch.rows.clone();
    set(&mut rows[index]);
    commit_rows(sketch, rows, now)
}

fn apply_one(sketch: &mut Sketch, op: &EditOp, now: DateTime<Utc>) -> Result<(), OpRejection> {
    match &op.kind {
        EditOpKind::TouchOp => {}
        EditOpKind::ReplaceSketchOp { sketch: next } => {
            let mut next: Sketch = to_core(next.to_value(&SaveContext::default()), "sketch")?;
            assign_row_ids(&mut next.rows)?;
            *sketch = next;
        }
        EditOpKind::SetTitleOp { title } => {
            sketch_edits::ensure_unlocked(sketch)?;
            sketch.title = title.clone();
        }
        EditOpKind::SetDescriptionOp { description } => {
            sketch_edits::ensure_unlocked(sketch)?;
            sketch.description = description.clone().unwrap_or(Value::Null);
        }
        EditOpKind::SetMetadataOp { metadata } => {
            sketch_edits::ensure_unlocked(sketch)?;
            sketch.metadata = to_core::<DocumentMetadata>(
                metadata.to_value(&SaveContext::default()),
                "metadata",
            )?;
        }
        EditOpKind::SetRowTextOp {
            row_id,
            time,
            narrative,
            demo_actions,
        } => {
            sketch_edits::ensure_unlocked(sketch)?;
            let update = RowTextUpdate {
                row_index: row_position(sketch, row_id)?,
                time: time.clone(),
                narrative: narrative.clone(),
                demo_actions: demo_actions.clone(),
            };
            sketch_edits::update_row_text(sketch, &update, now)?;
        }
        EditOpKind::SetScreenshotOp { row_id, screenshot } => {
            set_row_asset(sketch, row_id, now, |row| {
                row.screenshot = screenshot.clone()
            })?;
        }
        EditOpKind::SetVisualOp { row_id, visual } => {
            set_row_asset(sketch, row_id, now, |row| {
                row.visual = visual.clone().map(Value::String)
            })?;
        }
        EditOpKind::InsertRowOp { after_row_id, row } => {
            sketch_edits::ensure_unlocked(sketch)?;
            let at = match after_row_id {
                Some(anchor) => row_position(sketch, anchor)? + 1,
                None => 0,
            };
            let mut row = core_row(row)?;
            row.locked = false;
            row.locks = PlanningCellLocks::default();
            let mut rows = sketch.rows.clone();
            rows.insert(at, row);
            commit_rows(sketch, rows, now)?;
        }
        EditOpKind::DeleteRowOp { row_id } => {
            sketch_edits::ensure_unlocked(sketch)?;
            let index = row_position(sketch, row_id)?;
            let mut rows = sketch.rows.clone();
            rows.remove(index);
            commit_rows(sketch, rows, now)?;
        }
        EditOpKind::ReorderRowsOp { row_ids } => {
            sketch_edits::ensure_unlocked(sketch)?;
            let order = row_ids
                .iter()
                .map(|id| row_position(sketch, id))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| SketchEditError::InvalidReorder)?;
            sketch_edits::reorder_rows(sketch, &order, now)?;
        }
        EditOpKind::UpdateRowOp { row } => {
            sketch_edits::ensure_unlocked(sketch)?;
            let mut row = core_row(row)?;
            if row.id.is_empty() {
                return Err(invalid("update_row needs the row's id."));
            }
            let index = row_position(sketch, &row.id)?;
            row.locked = sketch.rows[index].locked;
            row.locks = sketch.rows[index].locks.clone();
            let mut rows = sketch.rows.clone();
            rows[index] = row;
            commit_rows(sketch, rows, now)?;
        }
        EditOpKind::ReplaceRowsOp { rows } => {
            let rows = rows.iter().map(core_row).collect::<Result<Vec<_>, _>>()?;
            commit_rows(sketch, rows, now)?;
        }
        EditOpKind::SetLockOp {
            row_id,
            field,
            locked,
        } => match (row_id, field) {
            (None, None) => sketch.set_locked_recursive(*locked),
            (None, Some(_)) => return Err(invalid("A cell lock needs a row_id.")),
            (Some(row_id), None) => {
                let index = row_position(sketch, row_id)?;
                sketch.rows[index].set_locked_recursive(*locked);
            }
            (Some(row_id), Some(field)) => {
                let index = row_position(sketch, row_id)?;
                if !sketch.rows[index].locks.set(field.as_str(), *locked) {
                    return Err(invalid(format!(
                        "Unknown planning cell field: {}",
                        field.as_str()
                    )));
                }
            }
        },
        _ => return Err(not_for(op, "a sketch")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::test_now;
    use serde_json::json;

    fn sketch(rows: &[(&str, bool)]) -> Sketch {
        let mut sketch = Sketch::new("Ops", test_now());
        sketch.rows = rows
            .iter()
            .map(|(id, locked)| {
                let mut row = PlanningRow::new();
                row.id = id.to_string();
                row.narrative = format!("Row {id}.");
                row.set_locked_recursive(*locked);
                row
            })
            .collect();
        sketch
    }

    fn ops(values: Value) -> Vec<EditOp> {
        parse_ops(values.as_array().unwrap()).unwrap()
    }

    #[test]
    fn document_version_hashes_bytes() {
        assert_eq!(
            document_version(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn expected_version_must_match_the_bytes_on_disk() {
        let version = document_version(b"{}");
        assert_eq!(
            ensure_expected_version(Some(b"{}"), Some(&version)),
            Ok(Some(version.clone()))
        );
        assert_eq!(ensure_expected_version(None, None), Ok(None));
        let gone = ensure_expected_version(None, Some(&version)).unwrap_err();
        assert_eq!(gone.current_version, None);
        assert_eq!(CmdError::from(&gone).details, None);
        let err = ensure_expected_version(Some(b"{ }"), Some(&version)).unwrap_err();
        assert_eq!(err.current_version, Some(document_version(b"{ }")));
        let cmd = CmdError::from(&err);
        assert_eq!(cmd.code, CmdErrorCode::StaleDocument);
        assert_eq!(
            cmd.details.unwrap().current_version,
            Some(document_version(b"{ }"))
        );
    }

    #[test]
    fn a_replacement_overwrites_a_file_that_no_longer_parses() {
        let replacement = sketch(&[("a", false)]);
        let op = json!({ "kind": "replace_sketch", "sketch": replacement });
        let edit = edit_document(
            DocumentKind::Sketch,
            Some("{"),
            Some(&document_version(b"{")),
            &[op],
            test_now(),
            false,
        )
        .unwrap();
        assert_eq!(
            edit.content,
            document::sketch_to_json(&replacement).unwrap()
        );

        let touch = edit_document(
            DocumentKind::Sketch,
            Some("{"),
            Some(&document_version(b"{")),
            &[json!({ "kind": "touch" })],
            test_now(),
            false,
        );
        assert!(matches!(touch, Err(ContentEditError::Document(_))));
    }

    #[test]
    fn content_edit_checks_the_version_then_saves_canonically() {
        let current = document::sketch_to_json(&sketch(&[("a", false)])).unwrap();
        let version = document_version(current.as_bytes());
        let edit = edit_document(
            DocumentKind::Sketch,
            Some(&current),
            Some(&version),
            &[json!({ "kind": "set_title", "title": "Renamed" })],
            test_now(),
            false,
        )
        .unwrap();
        assert_eq!(edit.note_lock, None);
        assert_eq!(edit.version, document_version(edit.content.as_bytes()));
        assert_eq!(
            document::sketch_from_json(&edit.content).unwrap().title,
            "Renamed"
        );

        let stale = edit_document(
            DocumentKind::Sketch,
            Some(&edit.content),
            Some(&version),
            &[],
            test_now(),
            false,
        )
        .unwrap_err();
        assert!(
            matches!(stale, ContentEditError::Stale(s) if s.current_version == Some(edit.version))
        );
    }

    #[test]
    fn a_new_document_must_start_with_its_replacement() {
        let err = edit_document(
            DocumentKind::Note,
            None,
            None,
            &[json!({ "kind": "write_note", "content": "x" })],
            test_now(),
            false,
        )
        .unwrap_err();
        assert!(matches!(err, ContentEditError::Op(e) if e.op_index == 0));

        let edit = edit_document(
            DocumentKind::Note,
            None,
            None,
            &[json!({ "kind": "replace_note", "content": "# Hi" })],
            test_now(),
            true,
        )
        .unwrap();
        assert_eq!(edit.content, "# Hi");
        assert_eq!(
            edit.note_lock,
            Some(NoteLock {
                locked: true,
                changed: false
            })
        );
        assert!(edit.changes(None));
    }

    #[test]
    fn missing_sketches_and_storyboards_are_created_by_replacement() {
        let mut fresh = sketch(&[("a", false)]);
        fresh.locked = true;
        let edit = edit_document(
            DocumentKind::Sketch,
            None,
            None,
            &[json!({ "kind": "replace_sketch", "sketch": serde_json::to_value(&fresh).unwrap() })],
            test_now(),
            false,
        )
        .unwrap();
        assert_eq!(edit.content, document::sketch_to_json(&fresh).unwrap());
        assert_eq!(edit.note_lock, None);

        let board = Storyboard::new("Board", test_now());
        let edit = edit_document(
            DocumentKind::Storyboard,
            None,
            None,
            &[json!({ "kind": "replace_storyboard", "storyboard": serde_json::to_value(&board).unwrap() })],
            test_now(),
            false,
        )
        .unwrap();
        assert_eq!(edit.content, document::storyboard_to_json(&board).unwrap());
    }

    #[test]
    fn rejected_storyboard_and_note_batches_change_nothing() {
        let mut storyboard = Storyboard::new("Board", test_now());
        let before = document::storyboard_to_json(&storyboard).unwrap();
        apply_storyboard_op_values(
            &mut storyboard,
            &[
                json!({ "kind": "set_title", "title": "Renamed" }),
                json!({ "kind": "remove_storyboard_item", "index": 0 }),
            ],
            test_now(),
        )
        .unwrap_err();
        assert_eq!(document::storyboard_to_json(&storyboard).unwrap(), before);

        let mut note = NoteState {
            content: "# Plan".into(),
            locked: false,
        };
        apply_note_op_values(
            &mut note,
            &[
                json!({ "kind": "set_lock", "locked": true }),
                json!({ "kind": "write_note", "content": "# Both" }),
            ],
        )
        .unwrap_err();
        assert_eq!(
            note,
            NoteState {
                content: "# Plan".into(),
                locked: false
            }
        );
    }

    #[test]
    fn storyboard_ops_respect_the_lock_and_keep_items_in_order() {
        let mut storyboard = Storyboard::new("Board", test_now());
        let item = json!({ "type": "sketch_ref", "path": "a.sk" });
        apply_storyboard_op_values(
            &mut storyboard,
            &[
                json!({ "kind": "insert_storyboard_item", "index": null, "item": item }),
                json!({ "kind": "insert_storyboard_item", "index": 0, "item": { "type": "sketch_ref", "path": "b.sk" } }),
                json!({ "kind": "remove_storyboard_item", "index": 1 }),
            ],
            test_now(),
        )
        .unwrap();
        assert_eq!(storyboard.items.len(), 1);

        storyboard.locked = true;
        let before = storyboard.clone();
        let err =
            apply_storyboard_op_values(&mut storyboard, &[json!({ "kind": "touch" })], test_now())
                .unwrap_err();
        assert_eq!(err.rejection, OpRejection::LockedStoryboard);
        assert_eq!(storyboard.items.len(), before.items.len());
        assert_eq!(storyboard.updated_at, before.updated_at);
        assert_eq!(CmdError::from(&err).code, CmdErrorCode::LockedDocument);
    }

    #[test]
    fn wire_ops_report_the_first_rejection_in_order() {
        let mut locked = sketch(&[("a", false)]);
        locked.locked = true;
        let err = apply_sketch_op_values(
            &mut locked,
            &[
                json!({ "kind": "set_title", "title": "No" }),
                json!({ "kind": "set_mood" }),
            ],
            test_now(),
        )
        .unwrap_err();
        assert_eq!(err.op_index, 0);
        assert_eq!(
            err.rejection,
            OpRejection::Edit(SketchEditError::LockedDocument)
        );
    }

    #[test]
    fn rejected_batch_leaves_the_sketch_unchanged() {
        let original = sketch(&[("a", false), ("b", true)]);
        let mut edited = original.clone();
        let err = apply_sketch_ops(
            &mut edited,
            &ops(json!([
                { "kind": "set_title", "title": "Changed" },
                { "kind": "set_row_text", "row_id": "b", "narrative": "No." }
            ])),
            test_now(),
        )
        .unwrap_err();
        assert_eq!(err.op_index, 1);
        assert_eq!(
            err.rejection,
            OpRejection::Edit(SketchEditError::LockedRow { row_index: 1 })
        );
        assert_eq!(edited.title, original.title);
        assert_eq!(CmdError::from(&err).details.unwrap().op_index, Some(1));
    }

    #[test]
    fn unknown_op_kind_is_invalid_with_its_index() {
        let err = parse_ops(&[
            json!({ "kind": "set_title", "title": "x" }),
            json!({ "kind": "nope" }),
        ])
        .unwrap_err();
        assert_eq!(err.op_index, 1);
        assert_eq!(CmdError::from(&err).code, CmdErrorCode::InvalidOp);
    }

    #[test]
    fn lock_ops_work_on_a_locked_sketch() {
        let mut locked = sketch(&[("a", false)]);
        locked.set_locked_recursive(true);
        apply_sketch_ops(
            &mut locked,
            &ops(json!([{ "kind": "set_lock", "row_id": "a", "locked": false }])),
            test_now(),
        )
        .unwrap();
        assert!(locked.locked);
        assert!(!locked.rows[0].locked);
    }
}
