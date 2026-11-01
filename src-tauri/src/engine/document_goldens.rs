//! Golden byte-compare tests for every document edit and save.
//!
//! Each case copies fixtures from `crates/cutready-core/tests/golden/inputs`
//! into a temp project, applies one edit the way its command does, and
//! compares the whole project tree byte for byte with
//! `crates/cutready-core/tests/golden/expected/<case>/`.
//!
//! Regenerate after an intended format change with `UPDATE_GOLDENS=1`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tempfile::TempDir;

use crate::engine::agent::execution::{FunctionCall, ToolCall, ToolExecutionStatus};
use crate::engine::agent::tools::execute_tool;
use crate::engine::{project, sketch_edits};
use crate::models::sketch::{DocumentMetadata, PlanningRow, Sketch, Storyboard, StoryboardItem};

fn golden_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/cutready-core/tests/golden")
}

fn fixed_now() -> DateTime<Utc> {
    "2026-01-02T03:04:05Z".parse().unwrap()
}

struct Project {
    dir: TempDir,
}

impl Project {
    fn new() -> Self {
        Self {
            dir: TempDir::new().unwrap(),
        }
    }

    fn with(inputs: &[(&str, &str)]) -> Self {
        let project = Self::new();
        for (rel, input) in inputs {
            project.put(rel, input);
        }
        project
    }

    fn put(&self, rel: &str, input: &str) {
        let target = self.path(rel);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(golden_root().join("inputs").join(input), target).unwrap();
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root().join(rel)
    }

    fn sketch(&self, rel: &str) -> Sketch {
        project::read_sketch(&self.path(rel)).unwrap()
    }

    fn save_sketch(&self, rel: &str, sketch: &Sketch) {
        project::write_sketch(sketch, &self.path(rel), self.root()).unwrap();
    }

    fn storyboard(&self, rel: &str) -> Storyboard {
        project::read_storyboard(&self.path(rel)).unwrap()
    }

    fn save_storyboard(&self, rel: &str, storyboard: &Storyboard) {
        project::write_storyboard(storyboard, &self.path(rel), self.root()).unwrap();
    }

    fn edit_sketch(&self, rel: &str, edit: impl FnOnce(&mut Sketch)) {
        let mut sketch = self.sketch(rel);
        edit(&mut sketch);
        self.save_sketch(rel, &sketch);
    }

    fn edit_storyboard(&self, rel: &str, edit: impl FnOnce(&mut Storyboard)) {
        let mut storyboard = self.storyboard(rel);
        project::ensure_storyboard_unlocked(&storyboard).unwrap();
        edit(&mut storyboard);
        storyboard.updated_at = fixed_now();
        self.save_storyboard(rel, &storyboard);
    }

    fn tool(&self, name: &str, args: Value) {
        let call = ToolCall {
            id: "call-golden".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: name.into(),
                arguments: args.to_string(),
            },
        };
        let output = execute_tool(&call, self.root(), self.root(), false, false, true);
        assert_eq!(
            output.status(),
            Some(ToolExecutionStatus::Success),
            "{name} failed: {}",
            output.text()
        );
    }

    fn files(&self) -> BTreeMap<String, Vec<u8>> {
        tree(self.root())
    }
}

fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path.strip_prefix(root).unwrap();
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.insert(rel, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    if root.exists() {
        walk(root, root, &mut out);
    }
    out
}

/// Agent tools stamp `Utc::now()`; blank those values so the rest compares exactly.
fn mask_timestamps(bytes: Vec<u8>, keys: &[&str]) -> Vec<u8> {
    let Ok(text) = String::from_utf8(bytes.clone()) else {
        return bytes;
    };
    text.split_inclusive('\n')
        .map(|line| {
            let trimmed = line.trim_start();
            for key in keys {
                let key = format!("\"{key}\": \"");
                if let Some(rest) = trimmed.strip_prefix(key.as_str()) {
                    if let Some(end) = rest.find('"') {
                        let indent = &line[..line.len() - trimmed.len()];
                        return format!("{indent}{key}<now>{}", &rest[end..]);
                    }
                }
            }
            line.to_string()
        })
        .collect::<String>()
        .into_bytes()
}

fn assert_golden_files(case: &str, actual: BTreeMap<String, Vec<u8>>) {
    let expected_dir = golden_root().join("expected").join(case);
    if std::env::var_os("UPDATE_GOLDENS").is_some() {
        let _ = std::fs::remove_dir_all(&expected_dir);
        for (rel, bytes) in &actual {
            let path = expected_dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        return;
    }
    let expected = tree(&expected_dir);
    assert!(
        !expected.is_empty(),
        "missing golden {case}; run with UPDATE_GOLDENS=1"
    );
    let names = |files: &BTreeMap<String, Vec<u8>>| files.keys().cloned().collect::<Vec<_>>();
    assert_eq!(
        names(&actual),
        names(&expected),
        "{case}: project files differ"
    );
    for (rel, bytes) in &actual {
        if bytes != &expected[rel] {
            panic!(
                "{case}: {rel} differs from golden\n--- expected\n{}\n--- actual\n{}",
                String::from_utf8_lossy(&expected[rel]),
                String::from_utf8_lossy(bytes)
            );
        }
    }
}

fn assert_golden(case: &str, project: &Project) {
    assert_golden_files(case, project.files());
}

fn assert_golden_masked(case: &str, project: &Project, keys: &[&str]) {
    let files = project
        .files()
        .into_iter()
        .map(|(rel, bytes)| (rel, mask_timestamps(bytes, keys)))
        .collect();
    assert_golden_files(case, files);
}

const SKETCH: &str = "intro.sk";
const BOARD: &str = "demo.sb";

fn rich_sketch() -> Project {
    Project::with(&[(SKETCH, "sketch.sk")])
}

fn rich_storyboard() -> Project {
    Project::with(&[(BOARD, "storyboard.sb")])
}

// --- Sketch saves -----------------------------------------------------------

#[test]
fn sketch_save_roundtrip() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |_| {});
    assert_golden("sketch_save_roundtrip", &p);
}

#[test]
fn sketch_save_nulls_roundtrip() {
    let p = Project::with(&[(SKETCH, "sketch-nulls.sk")]);
    p.edit_sketch(SKETCH, |_| {});
    assert_golden("sketch_save_nulls_roundtrip", &p);
}

#[test]
fn sketch_create() {
    let p = Project::new();
    let mut sketch = Sketch::new("New sketch");
    sketch.created_at = fixed_now();
    sketch.updated_at = fixed_now();
    p.save_sketch("flows/new.sk", &sketch);
    assert_golden("sketch_create", &p);
}

#[test]
fn sketch_read_migrates_inline_visual() {
    let p = Project::with(&[(SKETCH, "sketch-inline-visual.sk")]);
    project::read_sketch_with_migration(&p.path(SKETCH), p.root()).unwrap();
    assert_golden("sketch_read_migrates_inline_visual", &p);
}

// --- Sketch edits (commands/sketch.rs) --------------------------------------

#[test]
fn sketch_update_description() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        project::ensure_sketch_unlocked(s).unwrap();
        s.description = json!({ "type": "doc", "content": [] });
        s.updated_at = fixed_now();
    });
    assert_golden("sketch_update_description", &p);
}

#[test]
fn sketch_update_rows() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        // The editor sends rows without lock state; positions keep their locks.
        let mut rows: Vec<PlanningRow> = s.rows.clone();
        rows[0].narrative = "Welcome back to **Contoso**.".into();
        rows[1].demo_actions = "Click the **Orders** tab".into();
        for row in &mut rows {
            row.locked = false;
            row.locks = Default::default();
        }
        sketch_edits::replace_rows(s, rows, fixed_now()).unwrap();
        s.updated_at = fixed_now();
    });
    assert_golden("sketch_update_rows", &p);
}

#[test]
fn sketch_update_metadata() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        project::ensure_sketch_unlocked(s).unwrap();
        s.metadata = DocumentMetadata {
            fields: [("audience".to_string(), "customers".to_string())].into(),
        };
        s.updated_at = fixed_now();
    });
    assert_golden("sketch_update_metadata", &p);
}

#[test]
fn sketch_update_title() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        project::ensure_sketch_unlocked(s).unwrap();
        s.title = "Intro — revised".into();
        s.updated_at = fixed_now();
    });
    assert_golden("sketch_update_title", &p);
}

#[test]
fn sketch_lock() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        s.set_locked_recursive(true);
        s.updated_at = fixed_now();
    });
    assert_golden("sketch_lock", &p);
}

#[test]
fn sketch_unlock() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        s.set_locked_recursive(false);
        s.updated_at = fixed_now();
    });
    assert_golden("sketch_unlock", &p);
}

#[test]
fn sketch_row_lock() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        s.rows[0].set_locked_recursive(true);
        s.rows[2].set_locked_recursive(false);
        s.updated_at = fixed_now();
    });
    assert_golden("sketch_row_lock", &p);
}

#[test]
fn sketch_cell_lock() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        let mut locks = s.rows[0].locks.clone();
        assert!(locks.set("demo_actions", true));
        s.rows[0].locks = locks;
        let mut locks = s.rows[1].locks.clone();
        assert!(locks.set("narrative", false));
        s.rows[1].locks = locks;
        s.updated_at = fixed_now();
    });
    assert_golden("sketch_cell_lock", &p);
}

#[test]
fn sketch_update_row_text() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        let update = sketch_edits::RowTextUpdate {
            row_index: 0,
            time: Some("1:05".into()),
            narrative: Some("Welcome, partners.".into()),
            demo_actions: None,
        };
        sketch_edits::update_row_text(s, &update, fixed_now()).unwrap();
        let unchanged_time = sketch_edits::RowTextUpdate {
            row_index: 1,
            time: Some("~30s".into()),
            narrative: None,
            demo_actions: Some("Click **Orders** twice".into()),
        };
        sketch_edits::update_row_text(s, &unchanged_time, fixed_now()).unwrap();
    });
    assert_golden("sketch_update_row_text", &p);
}

#[test]
fn sketch_reorder_rows() {
    let p = rich_sketch();
    p.edit_sketch(SKETCH, |s| {
        s.set_locked_recursive(false);
        sketch_edits::reorder_rows(s, &[2, 0, 1], fixed_now()).unwrap();
    });
    assert_golden("sketch_reorder_rows", &p);
}

// --- Storyboards (commands/storyboard.rs) -----------------------------------

#[test]
fn storyboard_save_roundtrip() {
    let p = rich_storyboard();
    let storyboard = p.storyboard(BOARD);
    p.save_storyboard(BOARD, &storyboard);
    assert_golden("storyboard_save_roundtrip", &p);
}

#[test]
fn storyboard_read_upgrades_legacy() {
    let p = Project::with(&[(BOARD, "storyboard-legacy.sb")]);
    p.storyboard(BOARD);
    assert_golden("storyboard_read_upgrades_legacy", &p);
}

#[test]
fn storyboard_create() {
    let p = Project::new();
    let mut storyboard = Storyboard::new("New board");
    storyboard.created_at = fixed_now();
    storyboard.updated_at = fixed_now();
    p.save_storyboard("boards/new.sb", &storyboard);
    assert_golden("storyboard_create", &p);
}

#[test]
fn storyboard_update() {
    let p = rich_storyboard();
    p.edit_storyboard(BOARD, |sb| {
        sb.title = "Contoso demo — final".into();
        sb.description = "Customer walkthrough".into();
        sb.metadata = DocumentMetadata::default();
    });
    assert_golden("storyboard_update", &p);
}

#[test]
fn storyboard_lock_cascades_to_sketches() {
    let p = Project::with(&[
        (BOARD, "storyboard.sb"),
        ("intro.sk", "sketch.sk"),
        ("orders/list.sk", "sketch-nulls.sk"),
    ]);
    // Mirrors set_storyboard_lock: missing references are skipped.
    let mut sb = p.storyboard(BOARD);
    sb.locked = true;
    sb.updated_at = fixed_now();
    for rel in sb.sketch_paths() {
        if p.path(&rel).exists() {
            p.edit_sketch(&rel, |s| {
                s.set_locked_recursive(true);
                s.updated_at = fixed_now();
            });
        }
    }
    p.save_storyboard(BOARD, &sb);
    assert_golden("storyboard_lock_cascades_to_sketches", &p);
}

#[test]
fn storyboard_add_sketch_at_position() {
    let p = rich_storyboard();
    p.edit_storyboard(BOARD, |sb| {
        sb.items.insert(
            1,
            StoryboardItem::SketchRef {
                path: "setup.sk".into(),
            },
        );
    });
    assert_golden("storyboard_add_sketch_at_position", &p);
}

#[test]
fn storyboard_add_sketch_append() {
    let p = rich_storyboard();
    p.edit_storyboard(BOARD, |sb| {
        sb.items.push(StoryboardItem::SketchRef {
            path: "appendix.sk".into(),
        });
    });
    assert_golden("storyboard_add_sketch_append", &p);
}

#[test]
fn storyboard_remove_sketch() {
    let p = rich_storyboard();
    p.edit_storyboard(BOARD, |sb| {
        sb.items.remove(0);
    });
    assert_golden("storyboard_remove_sketch", &p);
}

#[test]
fn storyboard_add_section() {
    let p = rich_storyboard();
    p.edit_storyboard(BOARD, |sb| {
        sb.items.insert(
            0,
            StoryboardItem::Section {
                title: "Opening".into(),
                description: String::new(),
                sketches: Vec::new(),
            },
        );
        sb.items.push(StoryboardItem::Section {
            title: "Appendix".into(),
            description: "Extra material".into(),
            sketches: Vec::new(),
        });
    });
    assert_golden("storyboard_add_section", &p);
}

#[test]
fn storyboard_reorder_items() {
    let p = rich_storyboard();
    p.edit_storyboard(BOARD, |sb| {
        sb.items.reverse();
    });
    assert_golden("storyboard_reorder_items", &p);
}

// --- Notes (commands/note.rs) -----------------------------------------------

fn note_content() -> String {
    std::fs::read_to_string(golden_root().join("inputs/note.md")).unwrap()
}

#[test]
fn note_save() {
    let p = Project::new();
    project::write_note(&p.path("notes/plan.md"), &note_content()).unwrap();
    assert_golden("note_save", &p);
}

#[test]
fn note_lock() {
    let p = Project::with(&[("notes/plan.md", "note.md")]);
    project::set_note_lock(p.root(), "notes\\plan.md", true).unwrap();
    project::set_note_lock(p.root(), "other.md", true).unwrap();
    assert_golden("note_lock", &p);
}

#[test]
fn note_unlock() {
    let p = Project::with(&[("notes/plan.md", "note.md")]);
    project::set_note_lock(p.root(), "notes/plan.md", true).unwrap();
    project::set_note_lock(p.root(), "notes/plan.md", false).unwrap();
    assert_golden("note_unlock", &p);
}

// --- Agent tools (engine/agent/tools.rs) ------------------------------------

#[test]
fn agent_write_sketch_restructure() {
    let p = rich_sketch();
    p.tool(
        "write_sketch",
        json!({
            "path": SKETCH,
            "description": "Agent description",
            "rows": [
                { "source_row": 1, "narrative": "Welcome back." },
                { "source_row": 2, "demo_actions": "Open **Orders**" },
                { "source_row": 3 },
            ],
        }),
    );
    assert_golden_masked("agent_write_sketch_restructure", &p, &["updated_at"]);
}

#[test]
fn agent_write_sketch_create() {
    let p = Project::new();
    p.tool(
        "write_sketch",
        json!({
            "path": "flows/fresh-start.sk",
            "rows": [
                { "time": "10s", "narrative": "First", "demo_actions": "Open app" },
                { "time": "~1 min", "narrative": "Second", "duration_seconds": 75 },
            ],
        }),
    );
    assert_golden_masked(
        "agent_write_sketch_create",
        &p,
        &["created_at", "updated_at"],
    );
}

#[test]
fn agent_update_planning_row() {
    let p = rich_sketch();
    p.tool(
        "update_planning_row",
        json!({ "path": SKETCH, "row_number": 1, "time": "45s", "demo_actions": "Scroll down" }),
    );
    assert_golden_masked("agent_update_planning_row", &p, &["updated_at"]);
}

#[test]
fn agent_write_storyboard() {
    let p = rich_storyboard();
    p.tool(
        "write_storyboard",
        json!({
            "path": BOARD,
            "title": "Agent board",
            "items": [
                { "type": "section", "title": "All", "sketches": ["intro.sk", "outro.sk"] },
                { "type": "sketch_ref", "path": "bonus.sk" },
            ],
        }),
    );
    assert_golden_masked("agent_write_storyboard", &p, &["updated_at"]);
}

#[test]
fn agent_write_note() {
    let p = Project::new();
    p.tool(
        "write_note",
        json!({ "path": "notes/agent", "content": note_content() }),
    );
    assert_golden_masked("agent_write_note", &p, &["updated_at"]);
}
