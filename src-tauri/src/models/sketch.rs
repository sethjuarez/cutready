//! Core data models for Sketches and Storyboards.
//!
//! A **Sketch** is a focused scene: title + description + planning table.
//! Sketches are stored as `.sk` files; their file path is their identity.
//!
//! A **Storyboard** sequences multiple Sketches with optional named sections.
//! Storyboards are stored as `.sb` files; they reference sketches by relative path.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Lifecycle state of a sketch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SketchState {
    /// Initial authoring state (serialized as "draft"; also accepts legacy "sketch").
    #[serde(alias = "sketch")]
    Draft,
    RecordingEnriched,
    Refined,
    Final,
}

/// A row in the sketch planning table (4 columns).
///
/// Row identity is its array index — no UUID needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningRow {
    /// Approximate duration (e.g., "~30s", "1:00", "2m").
    pub time: String,
    /// Narrative bullet points for this step.
    pub narrative: String,
    /// Demo action bullet points for this step.
    pub demo_actions: String,
    /// Path to a captured screenshot (relative to project dir).
    pub screenshot: Option<String>,
}

impl PlanningRow {
    pub fn new() -> Self {
        Self {
            time: String::new(),
            narrative: String::new(),
            demo_actions: String::new(),
            screenshot: None,
        }
    }
}

impl Default for PlanningRow {
    fn default() -> Self {
        Self::new()
    }
}

/// A sketch — a focused scene in a demo storyboard.
///
/// Stored as a `.sk` file. The file path is the identity (no internal ID).
/// Contains a title, description (JSON value), and a planning table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sketch {
    pub title: String,
    /// Rich-text description — stored as JSON value. Null if empty.
    #[serde(default)]
    pub description: serde_json::Value,
    /// Planning table rows.
    #[serde(default)]
    pub rows: Vec<PlanningRow>,
    pub state: SketchState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Sketch {
    pub fn new(title: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            title: title.into(),
            description: serde_json::Value::Null,
            rows: Vec::new(),
            state: SketchState::Draft,
            created_at: now,
            updated_at: now,
        }
    }
}

/// Lightweight summary for listing sketches without loading full content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SketchSummary {
    /// Relative path from project root (e.g., "intro.sk" or "flows/login.sk").
    pub path: String,
    pub title: String,
    pub state: SketchState,
    pub row_count: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl SketchSummary {
    /// Create a summary from a sketch and its relative path.
    pub fn from_sketch(sketch: &Sketch, path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            title: sketch.title.clone(),
            state: sketch.state.clone(),
            row_count: sketch.rows.len(),
            created_at: sketch.created_at,
            updated_at: sketch.updated_at,
        }
    }
}

/// A storyboard — an ordered sequence of sketches with optional sections.
///
/// Stored as a `.sb` file. The file path is the identity (no internal ID).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Storyboard {
    pub title: String,
    pub description: String,
    /// Ordered items: loose sketch refs and/or named sections.
    pub items: Vec<StoryboardItem>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Storyboard {
    pub fn new(title: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            title: title.into(),
            description: String::new(),
            items: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }
}

/// An item in a storyboard's sequence.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StoryboardItem {
    /// A reference to a sketch by relative path (e.g., "intro.sk").
    SketchRef { path: String },
    /// A named section grouping multiple sketch paths.
    Section {
        title: String,
        sketches: Vec<String>,
    },
}

/// Lightweight summary for listing storyboards.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryboardSummary {
    /// Relative path from project root (e.g., "full-demo.sb").
    pub path: String,
    pub title: String,
    pub sketch_count: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl StoryboardSummary {
    /// Create a summary from a storyboard and its relative path.
    pub fn from_storyboard(sb: &Storyboard, path: impl Into<String>) -> Self {
        let sketch_count = sb
            .items
            .iter()
            .map(|item| match item {
                StoryboardItem::SketchRef { .. } => 1,
                StoryboardItem::Section { sketches, .. } => sketches.len(),
            })
            .sum();
        Self {
            path: path.into(),
            title: sb.title.clone(),
            sketch_count,
            created_at: sb.created_at,
            updated_at: sb.updated_at,
        }
    }
}

/// An entry in the project's version history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry {
    pub id: String,
    pub message: String,
    pub timestamp: DateTime<Utc>,
    pub summary: String,
}

/// A timeline (git branch) in the project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimelineInfo {
    /// Branch name (slug).
    pub name: String,
    /// Display label chosen by user.
    pub label: String,
    /// Whether this is the currently active timeline.
    pub is_active: bool,
    /// Number of snapshots on this timeline.
    pub snapshot_count: usize,
    /// Index used for assigning lane color (0-based).
    pub color_index: usize,
}

/// A node in the timeline graph (commit with parent + lane info).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub message: String,
    pub timestamp: DateTime<Utc>,
    /// The timeline (branch) this node belongs to.
    pub timeline: String,
    /// Parent commit IDs.
    pub parents: Vec<String>,
    /// Lane index for rendering.
    pub lane: usize,
    /// Whether this commit is the current HEAD.
    pub is_head: bool,
    /// Whether this is a branch tip (for showing branch markers on shared commits).
    #[serde(default)]
    pub is_branch_tip: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sketch_new_defaults() {
        let sketch = Sketch::new("Getting Started Guide");
        assert_eq!(sketch.title, "Getting Started Guide");
        assert_eq!(sketch.description, serde_json::Value::Null);
        assert!(sketch.rows.is_empty());
        assert_eq!(sketch.state, SketchState::Draft);
    }

    #[test]
    fn sketch_roundtrip() {
        let mut sketch = Sketch::new("Test Sketch");
        sketch.rows.push(PlanningRow {
            time: "~30s".into(),
            narrative: "Click the button".into(),
            demo_actions: "Navigate, click CTA".into(),
            screenshot: Some("screenshots/step1.png".into()),
        });
        sketch.description = serde_json::json!({"root": {"children": []}});

        let json = serde_json::to_string_pretty(&sketch).unwrap();
        let parsed: Sketch = serde_json::from_str(&json).unwrap();
        assert_eq!(sketch.title, parsed.title);
        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].time, "~30s");
        assert_eq!(
            parsed.description,
            serde_json::json!({"root": {"children": []}})
        );
    }

    #[test]
    fn sketch_state_serde_values() {
        assert_eq!(
            serde_json::to_string(&SketchState::Draft).unwrap(),
            "\"draft\""
        );
        assert_eq!(
            serde_json::to_string(&SketchState::RecordingEnriched).unwrap(),
            "\"recording_enriched\""
        );
        assert_eq!(
            serde_json::to_string(&SketchState::Refined).unwrap(),
            "\"refined\""
        );
        assert_eq!(
            serde_json::to_string(&SketchState::Final).unwrap(),
            "\"final\""
        );
    }

    #[test]
    fn sketch_state_legacy_alias() {
        let parsed: SketchState = serde_json::from_str("\"sketch\"").unwrap();
        assert_eq!(parsed, SketchState::Draft);
    }

    #[test]
    fn sketch_state_all_variants_roundtrip() {
        for state in [
            SketchState::Draft,
            SketchState::RecordingEnriched,
            SketchState::Refined,
            SketchState::Final,
        ] {
            let json = serde_json::to_string(&state).unwrap();
            let parsed: SketchState = serde_json::from_str(&json).unwrap();
            assert_eq!(state, parsed);
        }
    }

    #[test]
    fn planning_row_new_defaults() {
        let row = PlanningRow::new();
        assert!(row.time.is_empty());
        assert!(row.narrative.is_empty());
        assert!(row.demo_actions.is_empty());
        assert!(row.screenshot.is_none());
    }

    #[test]
    fn planning_row_roundtrip() {
        let row = PlanningRow {
            time: "~30s".into(),
            narrative: "Click the sign-up button".into(),
            demo_actions: "Navigate to /signup, click CTA".into(),
            screenshot: Some("screenshots/step1.png".into()),
        };
        let json = serde_json::to_string(&row).unwrap();
        let parsed: PlanningRow = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.time, "~30s");
        assert_eq!(parsed.screenshot, Some("screenshots/step1.png".into()));
    }

    #[test]
    fn planning_row_default_matches_new() {
        let from_new = PlanningRow::new();
        let from_default = PlanningRow::default();
        assert_eq!(from_new.time, from_default.time);
        assert_eq!(from_new.narrative, from_default.narrative);
        assert_eq!(from_new.demo_actions, from_default.demo_actions);
        assert_eq!(from_new.screenshot, from_default.screenshot);
    }

    #[test]
    fn sketch_summary_from_sketch() {
        let mut sketch = Sketch::new("Summary Test");
        sketch.rows.push(PlanningRow::new());
        sketch.rows.push(PlanningRow::new());
        let summary = SketchSummary::from_sketch(&sketch, "test.sk");
        assert_eq!(summary.path, "test.sk");
        assert_eq!(summary.title, sketch.title);
        assert_eq!(summary.state, SketchState::Draft);
        assert_eq!(summary.row_count, 2);
    }

    #[test]
    fn sketch_summary_roundtrip() {
        let sketch = Sketch::new("Roundtrip");
        let summary = SketchSummary::from_sketch(&sketch, "roundtrip.sk");
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: SketchSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.path, "roundtrip.sk");
        assert_eq!(parsed.title, summary.title);
    }

    #[test]
    fn storyboard_new_defaults() {
        let sb = Storyboard::new("Product Demo");
        assert_eq!(sb.title, "Product Demo");
        assert!(sb.description.is_empty());
        assert!(sb.items.is_empty());
    }

    #[test]
    fn storyboard_with_items_roundtrip() {
        let sb = Storyboard {
            title: "Full Demo".into(),
            description: "End-to-end product demo".into(),
            items: vec![
                StoryboardItem::SketchRef {
                    path: "intro.sk".into(),
                },
                StoryboardItem::Section {
                    title: "Getting Started".into(),
                    sketches: vec!["setup.sk".into(), "first-run.sk".into()],
                },
            ],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let json = serde_json::to_string_pretty(&sb).unwrap();
        let parsed: Storyboard = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.title, "Full Demo");
        assert_eq!(parsed.items.len(), 2);

        match &parsed.items[0] {
            StoryboardItem::SketchRef { path } => assert_eq!(path, "intro.sk"),
            _ => panic!("Expected SketchRef"),
        }
        match &parsed.items[1] {
            StoryboardItem::Section { title, sketches } => {
                assert_eq!(title, "Getting Started");
                assert_eq!(sketches.len(), 2);
                assert_eq!(sketches[0], "setup.sk");
            }
            _ => panic!("Expected Section"),
        }
    }

    #[test]
    fn storyboard_item_tagged_serde() {
        let item = StoryboardItem::SketchRef {
            path: "test.sk".into(),
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"type\":\"sketch_ref\""));
        assert!(json.contains("\"path\":\"test.sk\""));

        let item = StoryboardItem::Section {
            title: "Intro".into(),
            sketches: vec![],
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"type\":\"section\""));
    }

    #[test]
    fn storyboard_summary_from_storyboard() {
        let mut sb = Storyboard::new("Test");
        sb.items.push(StoryboardItem::SketchRef {
            path: "a.sk".into(),
        });
        sb.items.push(StoryboardItem::Section {
            title: "Core".into(),
            sketches: vec!["b.sk".into(), "c.sk".into()],
        });

        let summary = StoryboardSummary::from_storyboard(&sb, "test.sb");
        assert_eq!(summary.path, "test.sb");
        assert_eq!(summary.title, "Test");
        assert_eq!(summary.sketch_count, 3);
    }

    #[test]
    fn storyboard_summary_roundtrip() {
        let sb = Storyboard::new("Roundtrip");
        let summary = StoryboardSummary::from_storyboard(&sb, "roundtrip.sb");
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: StoryboardSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.path, "roundtrip.sb");
        assert_eq!(parsed.sketch_count, 0);
    }

    #[test]
    fn version_entry_roundtrip() {
        let entry = VersionEntry {
            id: "abc123".into(),
            message: "Add introduction section".into(),
            timestamp: Utc::now(),
            summary: "1 section added".into(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        let parsed: VersionEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "abc123");
        assert_eq!(parsed.message, "Add introduction section");
    }

    #[test]
    fn sketch_backward_compat_missing_fields() {
        // Sketch JSON with missing rows/description should deserialize
        let json = r#"{
            "title": "Legacy Doc",
            "state": "sketch",
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        }"#;
        let sketch: Sketch = serde_json::from_str(json).unwrap();
        assert_eq!(sketch.title, "Legacy Doc");
        assert_eq!(sketch.state, SketchState::Draft);
        assert!(sketch.rows.is_empty());
        assert_eq!(sketch.description, serde_json::Value::Null);
    }
}
