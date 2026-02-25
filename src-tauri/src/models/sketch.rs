//! Core data models for Sketches and Storyboards.
//!
//! A **Sketch** is a focused scene: title + description + planning table.
//! A **Storyboard** sequences multiple Sketches with optional named sections.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningRow {
    pub id: Uuid,
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
            id: Uuid::new_v4(),
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
/// Contains a title, rich-text description (Lexical JSON), and a planning table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sketch {
    pub id: Uuid,
    pub title: String,
    /// Rich-text description — Lexical editor state JSON. Null if empty.
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
            id: Uuid::new_v4(),
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
    pub id: Uuid,
    pub title: String,
    pub state: SketchState,
    pub row_count: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&Sketch> for SketchSummary {
    fn from(s: &Sketch) -> Self {
        Self {
            id: s.id,
            title: s.title.clone(),
            state: s.state.clone(),
            row_count: s.rows.len(),
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }
}

/// A storyboard — an ordered sequence of sketches with optional sections.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Storyboard {
    pub id: Uuid,
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
            id: Uuid::new_v4(),
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
    /// A reference to a sketch (by ID).
    SketchRef { sketch_id: Uuid },
    /// A named section grouping multiple sketches.
    Section {
        id: Uuid,
        title: String,
        sketch_ids: Vec<Uuid>,
    },
}

/// Lightweight summary for listing storyboards.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryboardSummary {
    pub id: Uuid,
    pub title: String,
    pub sketch_count: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&Storyboard> for StoryboardSummary {
    fn from(s: &Storyboard) -> Self {
        let sketch_count = s.items.iter().map(|item| match item {
            StoryboardItem::SketchRef { .. } => 1,
            StoryboardItem::Section { sketch_ids, .. } => sketch_ids.len(),
        }).sum();
        Self {
            id: s.id,
            title: s.title.clone(),
            sketch_count,
            created_at: s.created_at,
            updated_at: s.updated_at,
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
            id: Uuid::new_v4(),
            time: "~30s".into(),
            narrative: "Click the button".into(),
            demo_actions: "Navigate, click CTA".into(),
            screenshot: Some("screenshots/step1.png".into()),
        });
        sketch.description = serde_json::json!({"root": {"children": []}});

        let json = serde_json::to_string_pretty(&sketch).unwrap();
        let parsed: Sketch = serde_json::from_str(&json).unwrap();
        assert_eq!(sketch.id, parsed.id);
        assert_eq!(sketch.title, parsed.title);
        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].time, "~30s");
        assert_eq!(parsed.description, serde_json::json!({"root": {"children": []}}));
    }

    #[test]
    fn sketch_state_serde_values() {
        assert_eq!(serde_json::to_string(&SketchState::Draft).unwrap(), "\"draft\"");
        assert_eq!(serde_json::to_string(&SketchState::RecordingEnriched).unwrap(), "\"recording_enriched\"");
        assert_eq!(serde_json::to_string(&SketchState::Refined).unwrap(), "\"refined\"");
        assert_eq!(serde_json::to_string(&SketchState::Final).unwrap(), "\"final\"");
    }

    #[test]
    fn sketch_state_legacy_alias() {
        // Old "sketch" value should deserialize to Draft
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
            id: Uuid::new_v4(),
            time: "~30s".into(),
            narrative: "Click the sign-up button".into(),
            demo_actions: "Navigate to /signup, click CTA".into(),
            screenshot: Some("screenshots/step1.png".into()),
        };
        let json = serde_json::to_string(&row).unwrap();
        let parsed: PlanningRow = serde_json::from_str(&json).unwrap();
        assert_eq!(row.id, parsed.id);
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
        let summary = SketchSummary::from(&sketch);
        assert_eq!(summary.id, sketch.id);
        assert_eq!(summary.title, sketch.title);
        assert_eq!(summary.state, SketchState::Draft);
        assert_eq!(summary.row_count, 2);
    }

    #[test]
    fn sketch_summary_roundtrip() {
        let sketch = Sketch::new("Roundtrip");
        let summary = SketchSummary::from(&sketch);
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: SketchSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, summary.id);
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
        let sketch_id = Uuid::new_v4();
        let section_id = Uuid::new_v4();
        let sb = Storyboard {
            id: Uuid::new_v4(),
            title: "Full Demo".into(),
            description: "End-to-end product demo".into(),
            items: vec![
                StoryboardItem::SketchRef { sketch_id },
                StoryboardItem::Section {
                    id: section_id,
                    title: "Getting Started".into(),
                    sketch_ids: vec![Uuid::new_v4(), Uuid::new_v4()],
                },
            ],
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let json = serde_json::to_string_pretty(&sb).unwrap();
        let parsed: Storyboard = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, sb.id);
        assert_eq!(parsed.items.len(), 2);

        match &parsed.items[0] {
            StoryboardItem::SketchRef { sketch_id: sid } => assert_eq!(*sid, sketch_id),
            _ => panic!("Expected SketchRef"),
        }
        match &parsed.items[1] {
            StoryboardItem::Section { id, title, sketch_ids } => {
                assert_eq!(*id, section_id);
                assert_eq!(title, "Getting Started");
                assert_eq!(sketch_ids.len(), 2);
            }
            _ => panic!("Expected Section"),
        }
    }

    #[test]
    fn storyboard_item_tagged_serde() {
        let item = StoryboardItem::SketchRef { sketch_id: Uuid::new_v4() };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"type\":\"sketch_ref\""));

        let item = StoryboardItem::Section {
            id: Uuid::new_v4(),
            title: "Intro".into(),
            sketch_ids: vec![],
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"type\":\"section\""));
    }

    #[test]
    fn storyboard_summary_from_storyboard() {
        let mut sb = Storyboard::new("Test");
        sb.items.push(StoryboardItem::SketchRef { sketch_id: Uuid::new_v4() });
        sb.items.push(StoryboardItem::Section {
            id: Uuid::new_v4(),
            title: "Core".into(),
            sketch_ids: vec![Uuid::new_v4(), Uuid::new_v4()],
        });

        let summary = StoryboardSummary::from(&sb);
        assert_eq!(summary.id, sb.id);
        assert_eq!(summary.title, "Test");
        assert_eq!(summary.sketch_count, 3); // 1 loose + 2 in section
    }

    #[test]
    fn storyboard_summary_roundtrip() {
        let sb = Storyboard::new("Roundtrip");
        let summary = StoryboardSummary::from(&sb);
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: StoryboardSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, summary.id);
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
        // Old document JSON with missing rows/description should deserialize
        let json = r#"{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "title": "Legacy Doc",
            "state": "sketch",
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        }"#;
        let sketch: Sketch = serde_json::from_str(json).unwrap();
        assert_eq!(sketch.title, "Legacy Doc");
        assert_eq!(sketch.state, SketchState::Draft); // "sketch" → Draft via alias
        assert!(sketch.rows.is_empty());
        assert_eq!(sketch.description, serde_json::Value::Null);
    }

    #[test]
    fn sketch_ignores_old_document_fields() {
        // Old document JSON had "content" and "sections" fields — should be silently ignored
        let json = r#"{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "title": "Old Document",
            "description": "plain text desc",
            "content": {"root": {}},
            "sections": [{"id": "550e8400-e29b-41d4-a716-446655440001", "title": "S1", "description": "", "rows": []}],
            "state": "refined",
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        }"#;
        let sketch: Sketch = serde_json::from_str(json).unwrap();
        assert_eq!(sketch.title, "Old Document");
        assert_eq!(sketch.state, SketchState::Refined);
        // "description" was a plain string — deserializes as Value::String
        assert_eq!(sketch.description, serde_json::Value::String("plain text desc".into()));
    }
}
