//! Typed edit ops: the desktop binding for the `EditService` contract in
//! `contracts/ops.tsp`.
//!
//! Every host applies document edits as a batch of [`EditOp`]s addressed by
//! stable row id. Each op maps onto the [`sketch_edits`] lock policy, so ops
//! enforce exactly the rules the positional commands do. A batch is atomic:
//! the first rejected op fails it with its index and the document is left
//! unchanged.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::contracts::{
    CmdError, CmdErrorCode, CmdErrorDetails, EditOp, EditOpKind, LoadContext, SaveContext,
};
use crate::document::{self, DocumentError};
use crate::models::sketch::{
    assign_row_ids, DocumentMetadata, DuplicateRowId, PlanningCellLocks, PlanningRow, Sketch,
};
use crate::sketch_edits::{self, contract_index, RowTextUpdate, SketchEditError};

/// Why one op was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpRejection {
    #[error(transparent)]
    Edit(#[from] SketchEditError),
    #[error(transparent)]
    DuplicateRowId(#[from] DuplicateRowId),
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

/// `EditService.applySketchOps` on wire ops: each op is parsed just before it
/// applies, so the first rejected op wins whether it is malformed or refused.
pub fn apply_sketch_op_values(
    sketch: &mut Sketch,
    ops: &[Value],
    now: DateTime<Utc>,
) -> Result<(), EditOpError> {
    if ops.is_empty() {
        return Ok(());
    }
    let mut next = sketch.clone();
    for (op_index, value) in ops.iter().enumerate() {
        let op = parse_op(op_index, value)?;
        apply_one(&mut next, &op, now).map_err(|rejection| EditOpError {
            op_index,
            rejection,
        })?;
    }
    next.updated_at = now;
    *sketch = next;
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

/// A successful whole-file edit: the canonical bytes to write and their version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentEdit {
    pub content: String,
    pub version: String,
}

/// The host write path for a `.sk` file: check `expected_version` against the
/// current bytes, apply the ops, save canonically and return the new version.
/// Hosts only read and write the bytes.
pub fn edit_sketch_content(
    current: &str,
    expected_version: &str,
    ops: &[Value],
    now: DateTime<Utc>,
) -> Result<ContentEdit, ContentEditError> {
    let current_version = ensure_expected_version(current.as_bytes(), expected_version)?;
    let mut sketch = document::sketch_from_json(current)?;
    if ops.is_empty() {
        return Ok(ContentEdit {
            content: current.to_string(),
            version: current_version,
        });
    }
    apply_sketch_op_values(&mut sketch, ops, now)?;
    let content = document::sketch_to_json(&sketch)?;
    let version = document_version(content.as_bytes());
    Ok(ContentEdit { content, version })
}

/// `EditService.applySketchOps`. Applies `ops` in order; on success the
/// sketch's `updated_at` is `now` (an empty batch changes nothing).
pub fn apply_sketch_ops(
    sketch: &mut Sketch,
    ops: &[EditOp],
    now: DateTime<Utc>,
) -> Result<(), EditOpError> {
    if ops.is_empty() {
        return Ok(());
    }
    let mut next = sketch.clone();
    for (op_index, op) in ops.iter().enumerate() {
        apply_one(&mut next, op, now).map_err(|rejection| EditOpError {
            op_index,
            rejection,
        })?;
    }
    next.updated_at = now;
    *sketch = next;
    Ok(())
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

/// The document changed since the caller read it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("This document changed since the edit was made. Reload it and try again.")]
pub struct StaleDocument {
    pub current_version: String,
}

impl From<&StaleDocument> for CmdError {
    fn from(err: &StaleDocument) -> Self {
        CmdError {
            code: CmdErrorCode::StaleDocument,
            message: err.to_string(),
            details: Some(CmdErrorDetails {
                current_version: Some(err.current_version.clone()),
                ..Default::default()
            }),
        }
    }
}

/// `EditService.ensureVersion`: checks a write's expected version against the
/// bytes on disk and returns the version when it matches.
pub fn ensure_expected_version(current: &[u8], expected: &str) -> Result<String, StaleDocument> {
    let current_version = document_version(current);
    if current_version == expected {
        Ok(current_version)
    } else {
        Err(StaleDocument { current_version })
    }
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
            ensure_expected_version(b"{}", &version),
            Ok(version.clone())
        );
        let err = ensure_expected_version(b"{ }", &version).unwrap_err();
        assert_eq!(err.current_version, document_version(b"{ }"));
        let cmd = CmdError::from(&err);
        assert_eq!(cmd.code, CmdErrorCode::StaleDocument);
        assert_eq!(
            cmd.details.unwrap().current_version,
            Some(document_version(b"{ }"))
        );
    }

    #[test]
    fn content_edit_checks_the_version_then_saves_canonically() {
        let current = document::sketch_to_json(&sketch(&[("a", false)])).unwrap();
        let version = document_version(current.as_bytes());
        let edit = edit_sketch_content(
            &current,
            &version,
            &[json!({ "kind": "set_title", "title": "Renamed" })],
            test_now(),
        )
        .unwrap();
        assert_eq!(edit.version, document_version(edit.content.as_bytes()));
        assert_eq!(
            document::sketch_from_json(&edit.content).unwrap().title,
            "Renamed"
        );

        let stale = edit_sketch_content(&edit.content, &version, &[], test_now()).unwrap_err();
        assert!(matches!(stale, ContentEditError::Stale(s) if s.current_version == edit.version));
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
