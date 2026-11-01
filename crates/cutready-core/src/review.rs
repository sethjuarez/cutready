//! Review Undo: the desktop binding for `EditService.undoDocument` in
//! `contracts/ops.tsp`.
//!
//! An undo reverts one run's writes to one document on top of whatever is
//! there now. When nothing else touched the document since, the result is the
//! bytes the run started from. Otherwise each write is inverted newest first,
//! entity by entity, so edits made by others in between survive. Locks are
//! judged on the result: the undo may revert locks the run set, but content
//! that is still locked afterwards can't change.

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use crate::contracts::{
    CmdError, CmdErrorCode, CmdErrorDetails, DocumentKind, UndoConflict, UndoWrite,
};
use crate::document::{self, DocumentError};
use crate::edit_ops::{document_version, STORYBOARD_LOCKED_MESSAGE};
use crate::models::sketch::{PlanningRow, Sketch, Storyboard};
use crate::notes::NOTE_LOCKED_MESSAGE;
use crate::sketch_edits::{field_matches, row_content_matches, SketchEditError, LOCKABLE_FIELDS};

/// What an undo writes: the new bytes (None deletes the file) and their version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentUndo {
    pub content: Option<String>,
    pub version: Option<String>,
}

impl DocumentUndo {
    /// Whether the result differs from `current` and needs writing.
    pub fn changes(&self, current: Option<&str>) -> bool {
        self.content.as_deref() != current
    }
}

/// Why an undo can't be applied. Nothing is written.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum UndoError {
    #[error("Changes made since this run would be lost; undo them first.")]
    Conflicts(Vec<UndoConflict>),
    #[error(transparent)]
    Locked(#[from] SketchEditError),
    #[error("{}", STORYBOARD_LOCKED_MESSAGE)]
    LockedStoryboard,
    #[error("{}", NOTE_LOCKED_MESSAGE)]
    LockedNote,
    #[error(transparent)]
    Document(#[from] DocumentError),
}

/// The contract's CmdError. Unreadable documents have no contract code; they
/// surface as their message.
impl TryFrom<&UndoError> for CmdError {
    type Error = String;

    fn try_from(err: &UndoError) -> Result<Self, String> {
        let plain = |code| CmdError {
            code,
            message: err.to_string(),
            details: None,
        };
        match err {
            UndoError::Conflicts(conflicts) => Ok(CmdError {
                code: CmdErrorCode::UndoConflict,
                message: err.to_string(),
                details: Some(CmdErrorDetails {
                    conflicts: Some(conflicts.clone()),
                    ..Default::default()
                }),
            }),
            UndoError::Locked(edit) => Ok(CmdError::from(edit)),
            UndoError::LockedStoryboard | UndoError::LockedNote => {
                Ok(plain(CmdErrorCode::LockedDocument))
            }
            UndoError::Document(DocumentError::DuplicateRowId(dup)) => Ok(CmdError::from(dup)),
            UndoError::Document(other) => Err(other.to_string()),
        }
    }
}

/// `EditService.undoDocument`. `current` is the file on disk (None when
/// absent), `writes` the run's writes to it oldest first, and `note_locked`
/// the note's lock from the host's store.
pub fn undo_document(
    kind: DocumentKind,
    current: Option<&str>,
    writes: &[UndoWrite],
    note_locked: bool,
    now: DateTime<Utc>,
) -> Result<DocumentUndo, UndoError> {
    let Some(last) = writes.last() else {
        return Ok(result(current.map(str::to_owned)));
    };
    let chained = writes
        .windows(2)
        .all(|pair| pair[1].before == pair[0].after);
    let content = if chained && current == last.after.as_deref() {
        writes[0].before.clone()
    } else {
        merge(kind, current, writes, now)?
    };
    guard_locks(kind, current, content.as_deref(), note_locked)?;
    Ok(result(content))
}

fn result(content: Option<String>) -> DocumentUndo {
    let version = content.as_deref().map(|c| document_version(c.as_bytes()));
    DocumentUndo { content, version }
}

/// Inverts each write newest first onto the current document.
fn merge(
    kind: DocumentKind,
    current: Option<&str>,
    writes: &[UndoWrite],
    now: DateTime<Utc>,
) -> Result<Option<String>, UndoError> {
    let original = current.map(|c| normalize(kind, c)).transpose()?;
    let mut doc = original.clone();
    let mut conflicts = Vec::new();
    for write in writes.iter().rev() {
        let before = write
            .before
            .as_deref()
            .map(|c| normalize(kind, c))
            .transpose()?;
        let after = write
            .after
            .as_deref()
            .map(|c| normalize(kind, c))
            .transpose()?;
        invert(
            kind,
            &mut doc,
            before,
            after,
            write.after.as_deref(),
            current,
            &mut conflicts,
        );
    }
    if !conflicts.is_empty() {
        return Err(UndoError::Conflicts(conflicts));
    }
    let unchanged = match (&doc, &original) {
        (Some(doc), Some(original)) => same_doc(doc, original),
        (None, None) => true,
        _ => false,
    };
    if unchanged {
        return Ok(current.map(str::to_owned));
    }
    doc.map(|value| serialize(kind, value, now)).transpose()
}

/// A document as a JSON value with canonical shape: sketches and storyboards
/// round-trip through their models (legacy rows gain ids, older storyboards
/// upgrade), notes are their text.
fn normalize(kind: DocumentKind, content: &str) -> Result<Value, UndoError> {
    let to_value = |result: Result<Value, serde_json::Error>| {
        result.map_err(|e| UndoError::Document(DocumentError::Serialize(e.to_string())))
    };
    match kind {
        DocumentKind::Sketch => {
            to_value(serde_json::to_value(document::sketch_from_json(content)?))
        }
        DocumentKind::Storyboard => to_value(serde_json::to_value(
            document::storyboard_from_json(content)?.0,
        )),
        DocumentKind::Note => Ok(Value::String(content.to_owned())),
    }
}

fn serialize(
    kind: DocumentKind,
    mut value: Value,
    now: DateTime<Utc>,
) -> Result<String, UndoError> {
    let parse = |e: serde_json::Error| UndoError::Document(DocumentError::Parse(e.to_string()));
    if let Some(fields) = value.as_object_mut() {
        fields.insert(
            "updated_at".into(),
            serde_json::to_value(now).map_err(parse)?,
        );
    }
    match kind {
        DocumentKind::Sketch => {
            let sketch: Sketch = serde_json::from_value(value).map_err(parse)?;
            Ok(document::sketch_to_json(&sketch)?)
        }
        DocumentKind::Storyboard => {
            let storyboard: Storyboard = serde_json::from_value(value).map_err(parse)?;
            Ok(document::storyboard_to_json(&storyboard)?)
        }
        DocumentKind::Note => Ok(value.as_str().unwrap_or_default().to_owned()),
    }
}

/// Equal apart from `updated_at`, which every edit stamps.
fn same_doc(a: &Value, b: &Value) -> bool {
    match (a.as_object(), b.as_object()) {
        (Some(a), Some(b)) => without(a, &["updated_at"]) == without(b, &["updated_at"]),
        _ => a == b,
    }
}

fn without(fields: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    let mut fields = fields.clone();
    for key in keys {
        fields.remove(*key);
    }
    fields
}

/// Inverts one write. `after_text` and `current_text` are the raw bytes the
/// whole-document conflict reports versions of.
fn invert(
    kind: DocumentKind,
    doc: &mut Option<Value>,
    before: Option<Value>,
    after: Option<Value>,
    after_text: Option<&str>,
    current_text: Option<&str>,
    conflicts: &mut Vec<UndoConflict>,
) {
    let whole_conflict = |conflicts: &mut Vec<UndoConflict>| {
        conflicts.push(UndoConflict {
            path: String::new(),
            expected_version: after_text.map(|t| document_version(t.as_bytes())),
            current_version: current_text.map(|t| document_version(t.as_bytes())),
        })
    };
    match (before, after, doc.as_mut()) {
        (None, None, _) => {}
        // Created by the run: delete it unless it changed since.
        (None, Some(_), None) => {}
        (None, Some(after), Some(now)) => {
            if same_doc(now, &after) {
                *doc = None;
            } else {
                whole_conflict(conflicts);
            }
        }
        // Deleted by the run: restore it unless something took its place.
        (Some(before), None, None) => *doc = Some(before),
        (Some(before), None, Some(now)) => {
            if !same_doc(now, &before) {
                whole_conflict(conflicts);
            }
        }
        (Some(_), Some(_), None) => whole_conflict(conflicts),
        (Some(before), Some(after), Some(now)) => match kind {
            DocumentKind::Note => {
                if *now == after {
                    *now = before;
                } else if *now != before {
                    whole_conflict(conflicts);
                }
            }
            DocumentKind::Storyboard => {
                invert_fields(now, &before, &after, &["updated_at"], conflicts)
            }
            DocumentKind::Sketch => {
                invert_fields(now, &before, &after, &["updated_at", "rows"], conflicts);
                invert_rows(now, &before, &after, conflicts);
            }
        },
    }
}

/// Top-level fields, each its own entity.
fn invert_fields(
    now: &mut Value,
    before: &Value,
    after: &Value,
    skip: &[&str],
    conflicts: &mut Vec<UndoConflict>,
) {
    let (Some(now), Some(before), Some(after)) =
        (now.as_object_mut(), before.as_object(), after.as_object())
    else {
        return;
    };
    let keys: Vec<String> = before
        .keys()
        .chain(after.keys())
        .filter(|key| !skip.contains(&key.as_str()))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for key in keys {
        let path = format!("/{key}");
        restore(
            now.get(&key).cloned(),
            before.get(&key),
            after.get(&key),
            &path,
            conflicts,
            |value| match value {
                Some(value) => {
                    now.insert(key.clone(), value);
                }
                None => {
                    now.remove(&key);
                }
            },
        );
    }
}

/// The entity rule: unchanged by the write or already at its before value,
/// leave it; at its after value, restore the before value; else conflict.
fn restore(
    current: Option<Value>,
    before: Option<&Value>,
    after: Option<&Value>,
    path: &str,
    conflicts: &mut Vec<UndoConflict>,
    set: impl FnOnce(Option<Value>),
) {
    if before == after || current.as_ref() == before {
        return;
    }
    if current.as_ref() == after {
        set(before.cloned());
        return;
    }
    conflicts.push(UndoConflict {
        path: path.to_owned(),
        expected_version: after.map(entity_version),
        current_version: current.as_ref().map(entity_version),
    });
}

/// `documentVersion` of an entity's compact JSON with keys sorted, so every
/// runtime hashes the same bytes.
fn entity_version(value: &Value) -> String {
    let mut text = String::new();
    canonical_json(value, &mut text);
    document_version(text.as_bytes())
}

fn canonical_json(value: &Value, out: &mut String) {
    match value {
        Value::Object(fields) => {
            let sorted: BTreeMap<&String, &Value> = fields.iter().collect();
            out.push('{');
            for (i, (key, value)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                canonical_json(value, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_json(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

const LOCK_KEYS: [&str; 2] = ["locked", "locks"];

fn row_id(row: &Value) -> Option<&str> {
    row.get("id").and_then(Value::as_str)
}

fn rows_of(doc: &Value) -> Vec<Value> {
    doc.get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn by_id(rows: &[Value]) -> BTreeMap<String, Value> {
    rows.iter()
        .filter_map(|row| Some((row_id(row)?.to_owned(), row.clone())))
        .collect()
}

/// A row's content: everything but its lock state.
fn content(row: &Value) -> Value {
    match row.as_object() {
        Some(fields) => Value::Object(without(fields, &LOCK_KEYS)),
        None => row.clone(),
    }
}

/// Rows by id: removals of inserted rows, then per-row content and lock
/// restores, then the run's reorder, then re-inserts of deleted rows.
fn invert_rows(now: &mut Value, before: &Value, after: &Value, conflicts: &mut Vec<UndoConflict>) {
    let before_rows = rows_of(before);
    let after_rows = rows_of(after);
    let mut rows = rows_of(now);
    let before_ids = by_id(&before_rows);
    let after_ids = by_id(&after_rows);

    // Rows the run inserted.
    rows.retain(|row| {
        let Some(id) = row_id(row) else { return true };
        if before_ids.contains_key(id) {
            return true;
        }
        let Some(inserted) = after_ids.get(id) else {
            return true;
        };
        if row == inserted {
            return false;
        }
        conflicts.push(UndoConflict {
            path: format!("/rows/{id}"),
            expected_version: Some(entity_version(inserted)),
            current_version: Some(entity_version(row)),
        });
        true
    });

    // Rows in both images: content, `locked` and `locks` are separate entities.
    for row in rows.iter_mut() {
        let Some(id) = row_id(row).map(str::to_owned) else {
            continue;
        };
        let (Some(b), Some(a)) = (before_ids.get(&id), after_ids.get(&id)) else {
            continue;
        };
        let mut next = row.clone();
        restore(
            Some(content(row)),
            Some(&content(b)),
            Some(&content(a)),
            &format!("/rows/{id}"),
            conflicts,
            |value| {
                let mut fields = value
                    .and_then(|v| v.as_object().cloned())
                    .unwrap_or_default();
                for key in LOCK_KEYS {
                    if let Some(lock) = row.get(key) {
                        fields.insert(key.into(), lock.clone());
                    }
                }
                next = Value::Object(fields);
            },
        );
        for key in LOCK_KEYS {
            restore(
                row.get(key).cloned(),
                b.get(key),
                a.get(key),
                &format!("/rows/{id}/{key}"),
                conflicts,
                |value| {
                    if let (Some(fields), Some(value)) = (next.as_object_mut(), value) {
                        fields.insert(key.into(), value);
                    }
                },
            );
        }
        *row = next;
    }

    // The run's reorder of rows that were there before and after it.
    let order = |source: &[Value], present: &HashSet<String>| -> Vec<String> {
        source
            .iter()
            .filter_map(row_id)
            .filter(|id| {
                present.contains(*id) && before_ids.contains_key(*id) && after_ids.contains_key(*id)
            })
            .map(str::to_owned)
            .collect()
    };
    let present: HashSet<String> = rows.iter().filter_map(row_id).map(str::to_owned).collect();
    let now_order = order(&rows, &present);
    let before_order = order(&before_rows, &present);
    let after_order = order(&after_rows, &present);
    if before_order != after_order && now_order != before_order {
        if now_order == after_order {
            let moved: Vec<Value> = before_order
                .iter()
                .filter_map(|id| {
                    rows.iter()
                        .find(|row| row_id(row) == Some(id.as_str()))
                        .cloned()
                })
                .collect();
            let slots: HashSet<&str> = before_order.iter().map(String::as_str).collect();
            let mut moved = moved.into_iter();
            for row in rows.iter_mut() {
                if row_id(row).is_some_and(|id| slots.contains(id)) {
                    if let Some(next) = moved.next() {
                        *row = next;
                    }
                }
            }
        } else {
            conflicts.push(UndoConflict {
                path: "/rows".into(),
                expected_version: Some(entity_version(&Value::from(after_order))),
                current_version: Some(entity_version(&Value::from(now_order))),
            });
        }
    }

    // Rows the run deleted, back after the nearest earlier row still present.
    for (index, row) in before_rows.iter().enumerate() {
        let Some(id) = row_id(row) else { continue };
        if after_ids.contains_key(id) {
            continue;
        }
        if let Some(existing) = rows.iter().find(|r| row_id(r) == Some(id)) {
            if existing != row {
                conflicts.push(UndoConflict {
                    path: format!("/rows/{id}"),
                    expected_version: None,
                    current_version: Some(entity_version(existing)),
                });
            }
            continue;
        }
        let anchor = before_rows[..index]
            .iter()
            .rev()
            .filter_map(row_id)
            .find_map(|prev| rows.iter().position(|r| row_id(r) == Some(prev)));
        rows.insert(anchor.map_or(0, |at| at + 1), row.clone());
    }

    if let Some(fields) = now.as_object_mut() {
        fields.insert("rows".into(), Value::Array(rows));
    }
}

/// Locks are judged on the result against what is there now.
fn guard_locks(
    kind: DocumentKind,
    current: Option<&str>,
    result: Option<&str>,
    note_locked: bool,
) -> Result<(), UndoError> {
    if current == result {
        return Ok(());
    }
    match kind {
        DocumentKind::Note => {
            if note_locked {
                return Err(UndoError::LockedNote);
            }
        }
        DocumentKind::Storyboard => {
            let Some(current) = current else {
                return Ok(());
            };
            let now = document::storyboard_from_json(current)?.0;
            match result {
                None if now.locked => return Err(UndoError::LockedStoryboard),
                None => {}
                Some(result) => {
                    let next = document::storyboard_from_json(result)?.0;
                    if next.locked && !same_storyboard_content(&now, &next) {
                        return Err(UndoError::LockedStoryboard);
                    }
                }
            }
        }
        DocumentKind::Sketch => {
            let Some(current) = current else {
                return Ok(());
            };
            let now = document::sketch_from_json(current)?;
            match result {
                None if now.locked => return Err(SketchEditError::LockedDocument.into()),
                None => {}
                Some(result) => guard_sketch(&now, &document::sketch_from_json(result)?)?,
            }
        }
    }
    Ok(())
}

fn same_storyboard_content(a: &Storyboard, b: &Storyboard) -> bool {
    let strip = |s: &Storyboard| {
        serde_json::to_value(s)
            .ok()
            .and_then(|v| v.as_object().map(|f| without(f, &["locked", "updated_at"])))
    };
    strip(a) == strip(b)
}

fn guard_sketch(now: &Sketch, next: &Sketch) -> Result<(), SketchEditError> {
    if next.locked {
        let strip = |s: &Sketch| {
            serde_json::to_value(s)
                .ok()
                .and_then(|v| v.as_object().map(|f| without(f, &["locked", "updated_at"])))
        };
        if strip(now) != strip(next) {
            return Err(SketchEditError::LockedDocument);
        }
    }
    let current: BTreeMap<&str, &PlanningRow> =
        now.rows.iter().map(|row| (row.id.as_str(), row)).collect();
    let held = next
        .rows
        .iter()
        .any(|row| current.contains_key(row.id.as_str()) && (row.locked || row.locks.any()));
    if held && now.rows.len() != next.rows.len() {
        return Err(SketchEditError::LockedRowCount);
    }
    for (row_index, row) in next.rows.iter().enumerate() {
        let Some(old) = current.get(row.id.as_str()) else {
            continue;
        };
        if row.locked && !row_content_matches(old, row) {
            return Err(SketchEditError::LockedRow { row_index });
        }
        for field in LOCKABLE_FIELDS {
            if row.locks.is_locked(field) && !field_matches(old, row, field) {
                return Err(SketchEditError::LockedCell { row_index, field });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::test_now;
    use serde_json::json;

    fn row(id: &str, narrative: &str) -> Value {
        json!({ "id": id, "time": "0:10", "narrative": narrative, "demo_actions": "" })
    }

    fn sketch(rows: Value, extra: Value) -> String {
        let mut doc = json!({
            "title": "T",
            "rows": rows,
            "state": "draft",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        });
        for (key, value) in extra.as_object().cloned().unwrap_or_default() {
            doc[key] = value;
        }
        document::sketch_to_json(&document::sketch_from_json(&doc.to_string()).unwrap()).unwrap()
    }

    fn write(before: &str, after: &str) -> UndoWrite {
        UndoWrite {
            before: Some(before.into()),
            after: Some(after.into()),
        }
    }

    fn undo(current: &str, writes: &[UndoWrite]) -> Result<Sketch, UndoError> {
        let result = undo_document(
            DocumentKind::Sketch,
            Some(current),
            writes,
            false,
            test_now(),
        )?;
        Ok(document::sketch_from_json(&result.content.expect("a document")).unwrap())
    }

    fn narratives(sketch: &Sketch) -> Vec<(&str, &str)> {
        sketch
            .rows
            .iter()
            .map(|row| (row.id.as_str(), row.narrative.as_str()))
            .collect()
    }

    #[test]
    fn edits_made_by_others_survive_the_undo() {
        let base = sketch(json!([row("a", "A"), row("b", "B")]), json!({}));
        let ran = sketch(json!([row("a", "run"), row("b", "B")]), json!({}));
        let now = sketch(json!([row("a", "run"), row("b", "theirs")]), json!({}));
        let result = undo(&now, &[write(&base, &ran)]).unwrap();
        assert_eq!(narratives(&result), [("a", "A"), ("b", "theirs")]);
        assert_eq!(result.updated_at, test_now());
    }

    #[test]
    fn a_run_write_after_someone_elses_is_undone_too() {
        let base = sketch(json!([row("a", "A"), row("b", "B")]), json!({}));
        let first = sketch(json!([row("a", "run"), row("b", "B")]), json!({}));
        let theirs = sketch(json!([row("a", "run"), row("b", "theirs")]), json!({}));
        let second = sketch(
            json!([row("a", "run"), row("b", "theirs")]),
            json!({ "title": "Run" }),
        );
        let result = undo(&second, &[write(&base, &first), write(&theirs, &second)]).unwrap();
        assert_eq!(result.title, "T");
        assert_eq!(narratives(&result), [("a", "A"), ("b", "theirs")]);
    }

    #[test]
    fn inserted_rows_go_and_deleted_rows_return_in_place() {
        let base = sketch(
            json!([row("a", "A"), row("b", "B"), row("c", "C")]),
            json!({}),
        );
        let ran = sketch(
            json!([row("a", "A"), row("c", "C"), row("new", "N")]),
            json!({}),
        );
        let now = sketch(
            json!([row("a", "A"), row("c", "theirs"), row("new", "N")]),
            json!({}),
        );
        let result = undo(&now, &[write(&base, &ran)]).unwrap();
        assert_eq!(
            narratives(&result),
            [("a", "A"), ("b", "B"), ("c", "theirs")]
        );
    }

    #[test]
    fn a_reorder_is_reverted_around_other_edits() {
        let base = sketch(
            json!([row("a", "A"), row("b", "B"), row("c", "C")]),
            json!({}),
        );
        let ran = sketch(
            json!([row("c", "C"), row("a", "A"), row("b", "B")]),
            json!({}),
        );
        let now = sketch(
            json!([
                row("c", "C"),
                row("theirs", "T"),
                row("a", "edited"),
                row("b", "B")
            ]),
            json!({}),
        );
        let result = undo(&now, &[write(&base, &ran)]).unwrap();
        assert_eq!(
            narratives(&result),
            [("a", "edited"), ("theirs", "T"), ("b", "B"), ("c", "C")]
        );
    }

    #[test]
    fn unknown_fields_survive() {
        let base = sketch(json!([row("a", "A")]), json!({}));
        let ran = sketch(json!([row("a", "run")]), json!({}));
        let mut theirs_row = row("a", "run");
        theirs_row["future_row_field"] = json!({ "keep": true });
        let now = sketch(json!([theirs_row]), json!({ "future_document_field": [1] }));
        let result = undo(&now, &[write(&base, &ran)]).unwrap_err();
        // The row's content includes its unknown fields, so a row someone
        // else extended since is theirs now.
        assert!(matches!(result, UndoError::Conflicts(ref c) if c[0].path == "/rows/a"));

        let now = sketch(
            json!([row("a", "run")]),
            json!({ "future_document_field": [1] }),
        );
        let result = undo(&now, &[write(&base, &ran)]).unwrap();
        assert_eq!(result.unknown_fields["future_document_field"], json!([1]));
        assert_eq!(narratives(&result), [("a", "A")]);
    }

    #[test]
    fn the_runs_own_lock_is_undone() {
        let base = sketch(json!([row("a", "A"), row("b", "B")]), json!({}));
        let mut locked = row("a", "A");
        locked["locked"] = json!(true);
        let ran = sketch(json!([locked.clone(), row("b", "B")]), json!({}));
        let now = sketch(json!([locked, row("b", "theirs")]), json!({}));
        let result = undo(&now, &[write(&base, &ran)]).unwrap();
        assert!(!result.rows[0].locked);
        assert_eq!(narratives(&result), [("a", "A"), ("b", "theirs")]);
    }

    #[test]
    fn a_lock_elsewhere_does_not_block_restoring_unlocked_content() {
        let base = sketch(json!([row("a", "A"), row("b", "B")]), json!({}));
        let ran = sketch(json!([row("a", "run"), row("b", "B")]), json!({}));
        let mut locked = row("b", "B");
        locked["locks"] = json!({ "narrative": true });
        let now = sketch(json!([row("a", "run"), locked]), json!({}));
        let result = undo(&now, &[write(&base, &ran)]).unwrap();
        assert_eq!(narratives(&result), [("a", "A"), ("b", "B")]);
        assert!(result.rows[1].locks.narrative);
    }

    #[test]
    fn rows_cannot_be_removed_while_another_row_is_locked() {
        let base = sketch(json!([row("a", "A")]), json!({}));
        let ran = sketch(json!([row("a", "A"), row("new", "N")]), json!({}));
        let mut locked = row("a", "A");
        locked["locked"] = json!(true);
        let now = sketch(json!([locked, row("new", "N")]), json!({}));
        let err = undo(&now, &[write(&base, &ran)]).unwrap_err();
        assert_eq!(err, UndoError::Locked(SketchEditError::LockedRowCount));
    }

    #[test]
    fn a_fully_reverted_document_keeps_its_bytes() {
        let base = sketch(json!([row("a", "A")]), json!({}));
        let ran = sketch(json!([row("a", "run")]), json!({ "title": "Run" }));
        let mut now = document::sketch_from_json(&base).unwrap();
        now.updated_at = test_now();
        let now = document::sketch_to_json(&now).unwrap();
        let result = undo_document(
            DocumentKind::Sketch,
            Some(&now),
            &[write(&base, &ran)],
            false,
            test_now(),
        )
        .unwrap();
        assert_eq!(result.content.as_deref(), Some(now.as_str()));
        assert!(!result.changes(Some(&now)));
    }

    #[test]
    fn every_conflict_is_reported() {
        let base = sketch(json!([row("a", "A"), row("b", "B")]), json!({}));
        let ran = sketch(
            json!([row("a", "run"), row("b", "run")]),
            json!({ "title": "Run" }),
        );
        let now = sketch(
            json!([row("a", "x"), row("b", "y")]),
            json!({ "title": "Theirs" }),
        );
        let Err(UndoError::Conflicts(conflicts)) = undo(&now, &[write(&base, &ran)]) else {
            panic!("expected conflicts");
        };
        let paths: Vec<&str> = conflicts.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["/title", "/rows/a", "/rows/b"]);
    }

    #[test]
    fn a_locked_sketch_cannot_be_deleted() {
        let created = sketch(json!([]), json!({}));
        let locked = sketch(json!([]), json!({ "locked": true }));
        let err = undo_document(
            DocumentKind::Sketch,
            Some(&locked),
            &[
                UndoWrite {
                    before: None,
                    after: Some(created.clone()),
                },
                write(&created, &locked),
            ],
            false,
            test_now(),
        )
        .unwrap_err();
        assert_eq!(err, UndoError::Locked(SketchEditError::LockedDocument));
    }
}
