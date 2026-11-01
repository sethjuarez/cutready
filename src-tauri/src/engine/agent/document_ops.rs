//! Agent tool writes, expressed as typed edit ops through the document writer.
//!
//! Tools build the document they want (and check locks with the agent's own
//! wording first); this module turns the change into the ops that describe it
//! so the writer, and later the run log, see the edit's intent rather than a
//! whole-file replacement. The tool dispatcher holds `workspace_write_lock`.

use std::path::Path;

use cutready_core::models::sketch::{Sketch, Storyboard};
use serde_json::{json, Value};

use crate::engine::document_writer::{self, Expected, WriteError};

/// Save `after` over the sketch at `path` under `root`. `before` is what the
/// tool read, or `None` when the tool creates the sketch (or overwrites an
/// unreadable one).
pub fn save_sketch(
    root: &Path,
    path: &Path,
    before: Option<&Sketch>,
    after: &Sketch,
) -> Result<(), WriteError> {
    match before.and_then(|before| sketch_ops(before, after)) {
        Some(ops) => document_writer::edit_file(root, path, Expected::Unchecked, &ops).map(drop),
        None => document_writer::replace_sketch(root, path, after).map(drop),
    }
}

/// Save `after` over the storyboard at `path`, like [`save_sketch`].
pub fn save_storyboard(
    root: &Path,
    path: &Path,
    before: Option<&Storyboard>,
    after: &Storyboard,
) -> Result<(), WriteError> {
    match before.and_then(|before| storyboard_ops(before, after)) {
        Some(ops) => document_writer::edit_file(root, path, Expected::Unchecked, &ops).map(drop),
        None => document_writer::replace_storyboard(root, path, after).map(drop),
    }
}

/// Write a note's markdown. An existing note gets a lock-gated `write_note`; a
/// new note is created with `replace_note`.
pub fn save_note(root: &Path, rel: &str, abs: &Path, content: &str) -> Result<(), WriteError> {
    let kind = if abs.exists() {
        "write_note"
    } else {
        "replace_note"
    };
    let op = json!({ "kind": kind, "content": content });
    document_writer::edit(root, rel, Expected::Unchecked, &[op]).map(drop)
}

/// The ops that turn `before` into `after`, or `None` when something other
/// than the title, description, metadata or rows changed.
fn sketch_ops(before: &Sketch, after: &Sketch) -> Option<Vec<Value>> {
    let mut rest = before.clone();
    rest.title = after.title.clone();
    rest.description = after.description.clone();
    rest.metadata = after.metadata.clone();
    rest.rows = after.rows.clone();
    rest.updated_at = after.updated_at;
    if to_json(&rest) != to_json(after) {
        return None;
    }

    let mut ops = vec![json!({ "kind": "touch" })];
    if before.title != after.title {
        ops.push(json!({ "kind": "set_title", "title": after.title }));
    }
    if before.description != after.description {
        ops.push(json!({ "kind": "set_description", "description": after.description }));
    }
    if to_json(&before.metadata) != to_json(&after.metadata) {
        ops.push(json!({ "kind": "set_metadata", "metadata": after.metadata }));
    }
    if to_json(&before.rows) != to_json(&after.rows) {
        ops.push(json!({ "kind": "replace_rows", "rows": after.rows }));
    }
    Some(ops)
}

/// The ops that turn `before` into `after`, or `None` when something other
/// than the title, description, metadata or items changed.
fn storyboard_ops(before: &Storyboard, after: &Storyboard) -> Option<Vec<Value>> {
    let mut rest = before.clone();
    rest.title = after.title.clone();
    rest.description = after.description.clone();
    rest.metadata = after.metadata.clone();
    rest.items = after.items.clone();
    rest.updated_at = after.updated_at;
    if to_json(&rest) != to_json(after) {
        return None;
    }

    let mut ops = vec![json!({ "kind": "touch" })];
    if before.title != after.title {
        ops.push(json!({ "kind": "set_title", "title": after.title }));
    }
    if before.description != after.description {
        ops.push(json!({ "kind": "set_description", "description": after.description }));
    }
    if to_json(&before.metadata) != to_json(&after.metadata) {
        ops.push(json!({ "kind": "set_metadata", "metadata": after.metadata }));
    }
    if to_json(&before.items) != to_json(&after.items) {
        ops.push(json!({ "kind": "set_storyboard_items", "items": after.items }));
    }
    Some(ops)
}

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cutready_core::models::sketch::{PlanningRow, StoryboardItem};

    fn sketch() -> Sketch {
        let mut sketch = Sketch::new("Intro", chrono::Utc::now());
        sketch.rows = vec![PlanningRow::new()];
        sketch.rows[0].id = "row-1".into();
        sketch
    }

    fn kinds(ops: &[Value]) -> Vec<&str> {
        ops.iter().map(|op| op["kind"].as_str().unwrap()).collect()
    }

    #[test]
    fn sketch_changes_become_typed_ops() {
        let before = sketch();
        let mut after = before.clone();
        after.title = "Welcome".into();
        after.rows[0].narrative = "Hello".into();

        let ops = sketch_ops(&before, &after).unwrap();
        assert_eq!(kinds(&ops), ["touch", "set_title", "replace_rows"]);
    }

    #[test]
    fn an_unchanged_sketch_is_only_touched() {
        let before = sketch();
        let mut after = before.clone();
        after.updated_at = chrono::Utc::now();

        assert_eq!(kinds(&sketch_ops(&before, &after).unwrap()), ["touch"]);
    }

    #[test]
    fn other_sketch_changes_replace_the_document() {
        let before = sketch();
        let mut after = before.clone();
        after.locked = true;

        assert!(sketch_ops(&before, &after).is_none());
    }

    #[test]
    fn storyboard_changes_become_typed_ops() {
        let before = Storyboard::new("Demo", chrono::Utc::now());
        let mut after = before.clone();
        after.description = "Walkthrough".into();
        after.items = vec![StoryboardItem::SketchRef {
            path: "intro.sk".into(),
        }];

        let ops = storyboard_ops(&before, &after).unwrap();
        assert_eq!(
            kinds(&ops),
            ["touch", "set_description", "set_storyboard_items"]
        );
    }

    #[test]
    fn saved_sketch_matches_the_tool_result() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("intro.sk");
        let before = sketch();
        save_sketch(temp.path(), &path, None, &before).unwrap();
        let before = crate::engine::project::read_sketch(&path).unwrap();
        let mut after = before.clone();
        after.title = "Welcome".into();
        after.description = Value::String("Opening".into());
        after.rows[0].demo_actions = "Click start".into();

        save_sketch(temp.path(), &path, Some(&before), &after).unwrap();

        let saved = crate::engine::project::read_sketch(&path).unwrap();
        after.updated_at = saved.updated_at;
        assert_eq!(to_json(&saved), to_json(&after));
    }

    #[test]
    fn notes_are_created_then_written_under_the_lock() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let abs = root.join("plan.md");

        save_note(root, "plan.md", &abs, "first").unwrap();
        save_note(root, "plan.md", &abs, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "second");

        crate::engine::project::set_note_lock(root, "plan.md", true).unwrap();
        assert!(save_note(root, "plan.md", &abs, "third").is_err());
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "second");
    }
}
