//! Core data models for Sketches and Storyboards.
//!
//! A **Sketch** is a focused scene: title + description + planning table.
//! Sketches are stored as `.sk` files; their file path is their identity.
//!
//! A **Storyboard** sequences multiple Sketches with optional named sections.
//! Storyboards are stored as `.sb` files; they reference sketches by relative path.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

/// User-defined key/value metadata stored with portable documents.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct DocumentMetadata {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

impl DocumentMetadata {
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }
}

fn deserialize_vec_or_default<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

/// Lock state for editable planning row cells.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PlanningCellLocks {
    #[serde(default)]
    pub time: bool,
    #[serde(default)]
    pub narrative: bool,
    #[serde(default)]
    pub demo_actions: bool,
    #[serde(default)]
    pub screenshot: bool,
    #[serde(default)]
    pub visual: bool,
    #[serde(default)]
    pub design_plan: bool,
}

impl PlanningCellLocks {
    pub fn is_locked(&self, field: &str) -> bool {
        match field {
            "time" => self.time,
            "narrative" => self.narrative,
            "demo_actions" => self.demo_actions,
            "screenshot" => self.screenshot,
            "visual" => self.visual,
            "design_plan" => self.design_plan,
            _ => false,
        }
    }

    pub fn set(&mut self, field: &str, locked: bool) -> bool {
        match field {
            "time" => self.time = locked,
            "narrative" => self.narrative = locked,
            "demo_actions" => self.demo_actions = locked,
            "screenshot" => self.screenshot = locked,
            "visual" => self.visual = locked,
            "design_plan" => self.design_plan = locked,
            _ => return false,
        }
        true
    }

    pub fn set_all(&mut self, locked: bool) {
        self.time = locked;
        self.narrative = locked;
        self.demo_actions = locked;
        self.screenshot = locked;
        self.visual = locked;
        self.design_plan = locked;
    }

    pub fn any(&self) -> bool {
        self.time
            || self.narrative
            || self.demo_actions
            || self.screenshot
            || self.visual
            || self.design_plan
    }
}

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

/// Row-level narration audio captured or generated from the narrative text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NarrationAsset {
    /// Path to the audio asset relative to the project root.
    pub path: String,
    /// The row narrative text at the moment this asset was recorded/generated.
    pub source_text: String,
    /// SHA-256 of `source_text` for future non-lossy staleness checks.
    pub source_text_hash: String,
    pub mime_type: String,
    pub duration_ms: Option<u32>,
    /// Detected silence before speech begins, stored non-destructively for future trim/alignment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leading_silence_ms: Option<u32>,
    /// Detected silence after speech ends, stored non-destructively for future trim/alignment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trailing_silence_ms: Option<u32>,
    /// Decibel threshold used for leading/trailing silence detection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_threshold_db: Option<f32>,
    pub byte_size: u64,
    pub recorded_at: DateTime<Utc>,
}

/// Ranked normalized screenshot point used by the Motion Director for camera moves.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MotionPoint {
    pub rank: u8,
    pub x: f32,
    pub y: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Agent-generated camera motion plan for screenshot rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MotionPlan {
    pub kind: MotionPlanKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keyframes: Vec<MotionPlanKeyframe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MotionPlanKind {
    SubtlePush,
    WideHoldThenPush,
    PushThenDrift,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MotionPlanKeyframe {
    pub time_ms: u32,
    pub scale: f32,
    pub x: f32,
    pub y: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub easing: Option<MotionPlanEasing>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MotionPlanEasing {
    Linear,
    EaseInOut,
    EaseOut,
}

/// A row in the sketch planning table (4 columns).
///
/// Row identity is its array index — no UUID needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanningRow {
    /// Whether the entire row is protected from edits.
    #[serde(default)]
    pub locked: bool,
    /// Per-cell lock state for targeted protection.
    #[serde(default)]
    pub locks: PlanningCellLocks,
    /// Approximate duration (e.g., "~30s", "1:00", "2m").
    pub time: String,
    /// Concrete duration in seconds for reliable total-time summaries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
    /// Narrative bullet points for this step.
    pub narrative: String,
    /// Demo action bullet points for this step.
    pub demo_actions: String,
    /// Path to a captured screenshot (relative to project dir).
    pub screenshot: Option<String>,
    /// Optional elucim DSL document for an animated framing visual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual: Option<serde_json::Value>,
    /// Ranked normalized screenshot points used by the Motion Director for camera moves.
    #[serde(
        default,
        deserialize_with = "deserialize_vec_or_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub motion_points: Vec<MotionPoint>,
    /// Agent-generated camera motion plan for screenshot rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub motion_plan: Option<MotionPlan>,
    /// English-language design brief describing layout, elements, colors, and animation intent.
    /// Created by the Designer agent's conceptual pass before generating DSL JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_plan: Option<String>,
    /// Optional narration audio for this row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narration: Option<NarrationAsset>,
}

impl PlanningRow {
    pub fn new() -> Self {
        Self {
            locked: false,
            locks: PlanningCellLocks::default(),
            time: String::new(),
            duration_seconds: None,
            narrative: String::new(),
            demo_actions: String::new(),
            screenshot: None,
            visual: None,
            motion_points: Vec::new(),
            motion_plan: None,
            design_plan: None,
            narration: None,
        }
    }

    pub fn set_locked_recursive(&mut self, locked: bool) {
        self.locked = locked;
        self.locks.set_all(locked);
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
    /// Whether the whole sketch is protected from edits.
    #[serde(default)]
    pub locked: bool,
    /// Rich-text description — stored as JSON value. Null if empty.
    #[serde(default)]
    pub description: serde_json::Value,
    /// Planning table rows.
    #[serde(default)]
    pub rows: Vec<PlanningRow>,
    #[serde(default, skip_serializing_if = "DocumentMetadata::is_empty")]
    pub metadata: DocumentMetadata,
    pub state: SketchState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Sketch {
    pub fn new(title: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            title: title.into(),
            locked: false,
            description: serde_json::Value::Null,
            rows: Vec::new(),
            metadata: DocumentMetadata::default(),
            state: SketchState::Draft,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn set_locked_recursive(&mut self, locked: bool) {
        self.locked = locked;
        for row in &mut self.rows {
            row.set_locked_recursive(locked);
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
#[derive(Debug, Clone, Serialize)]
pub struct Storyboard {
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Whether the whole storyboard is protected from edits.
    #[serde(default)]
    pub locked: bool,
    #[serde(default, skip_serializing_if = "DocumentMetadata::is_empty")]
    pub metadata: DocumentMetadata,
    /// Ordered items: loose sketch refs and/or named sections.
    #[serde(default)]
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
            locked: false,
            metadata: DocumentMetadata::default(),
            items: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }

    pub fn sketch_paths(&self) -> Vec<String> {
        self.items
            .iter()
            .flat_map(|item| item.sketch_paths())
            .map(str::to_owned)
            .collect()
    }

    pub fn sketch_count(&self) -> usize {
        self.items.iter().map(StoryboardItem::sketch_count).sum()
    }

    pub fn references_sketch(&self, sketch_path: &str) -> bool {
        self.items
            .iter()
            .any(|item| item.sketch_paths().iter().any(|path| *path == sketch_path))
    }

    pub fn remove_sketch_references(&mut self, sketch_path: &str) -> usize {
        let before = self.sketch_count();
        self.items.retain(|item| match item {
            StoryboardItem::SketchRef { path } => path != sketch_path,
            StoryboardItem::Section { .. } => true,
        });
        for item in &mut self.items {
            if let StoryboardItem::Section { sketches, .. } = item {
                sketches.retain(|path| path != sketch_path);
            }
        }
        before.saturating_sub(self.sketch_count())
    }

    pub fn replace_sketch_references(&mut self, old_path: &str, new_path: &str) -> usize {
        let mut replaced = 0;
        for item in &mut self.items {
            match item {
                StoryboardItem::SketchRef { path } => {
                    if path.replace('\\', "/") == old_path {
                        *path = new_path.to_owned();
                        replaced += 1;
                    }
                }
                StoryboardItem::Section { sketches, .. } => {
                    for path in sketches {
                        if path.replace('\\', "/") == old_path {
                            *path = new_path.to_owned();
                            replaced += 1;
                        }
                    }
                }
            }
        }
        replaced
    }
}

impl<'de> Deserialize<'de> for Storyboard {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct StoryboardShape {
            title: String,
            #[serde(default)]
            description: String,
            #[serde(default)]
            locked: bool,
            #[serde(default)]
            metadata: DocumentMetadata,
            items: Option<Vec<StoryboardItem>>,
            #[serde(default)]
            sketches: Vec<String>,
            created_at: DateTime<Utc>,
            updated_at: DateTime<Utc>,
        }

        let shape = StoryboardShape::deserialize(deserializer)?;
        let items = shape.items.unwrap_or_else(|| {
            shape
                .sketches
                .into_iter()
                .map(|path| StoryboardItem::SketchRef { path })
                .collect()
        });

        Ok(Self {
            title: shape.title,
            description: shape.description,
            locked: shape.locked,
            metadata: shape.metadata,
            items,
            created_at: shape.created_at,
            updated_at: shape.updated_at,
        })
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
        #[serde(default, skip_serializing_if = "String::is_empty")]
        description: String,
        sketches: Vec<String>,
    },
}

impl StoryboardItem {
    pub fn sketch_paths(&self) -> Vec<&str> {
        match self {
            StoryboardItem::SketchRef { path } => vec![path.as_str()],
            StoryboardItem::Section { sketches, .. } => {
                sketches.iter().map(String::as_str).collect()
            }
        }
    }

    pub fn sketch_count(&self) -> usize {
        match self {
            StoryboardItem::SketchRef { .. } => 1,
            StoryboardItem::Section { sketches, .. } => sketches.len(),
        }
    }
}

/// Lightweight summary for listing storyboards.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoryboardSummary {
    /// Relative path from project root (e.g., "full-demo.sb").
    pub path: String,
    pub title: String,
    pub locked: bool,
    pub sketch_count: usize,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl StoryboardSummary {
    /// Create a summary from a storyboard and its relative path.
    pub fn from_storyboard(sb: &Storyboard, path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            title: sb.title.clone(),
            locked: sb.locked,
            sketch_count: sb.sketch_count(),
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
    /// Whether this commit is the tip of a remote tracking branch (e.g., origin/main).
    #[serde(default)]
    pub is_remote_tip: bool,
    /// Author name of this commit.
    #[serde(default)]
    pub author: String,
}

/// Lightweight summary for listing notes (.md files) in the sidebar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSummary {
    /// Relative path from project root (e.g., "notes/ideas.md").
    pub path: String,
    /// Display title derived from filename (e.g., "ideas").
    pub title: String,
    /// File size in bytes.
    pub size: u64,
    /// Last modified timestamp.
    pub updated_at: DateTime<Utc>,
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
    fn sketch_lock_cascades_to_rows_and_cells() {
        let mut sketch = Sketch::new("Demo");
        sketch.rows.push(PlanningRow::new());

        sketch.set_locked_recursive(true);

        assert!(sketch.locked);
        assert!(sketch.rows[0].locked);
        assert!(sketch.rows[0].locks.time);
        assert!(sketch.rows[0].locks.narrative);
        assert!(sketch.rows[0].locks.demo_actions);
        assert!(sketch.rows[0].locks.screenshot);
        assert!(sketch.rows[0].locks.visual);
        assert!(sketch.rows[0].locks.design_plan);

        sketch.set_locked_recursive(false);

        assert!(!sketch.locked);
        assert!(!sketch.rows[0].locked);
        assert!(!sketch.rows[0].locks.any());
    }

    #[test]
    fn sketch_roundtrip() {
        let mut sketch = Sketch::new("Test Sketch");
        sketch.rows.push(PlanningRow {
            locked: false,
            locks: PlanningCellLocks::default(),
            time: "~30s".into(),
            duration_seconds: Some(30),
            narrative: "Click the button".into(),
            demo_actions: "Navigate, click CTA".into(),
            screenshot: Some("screenshots/step1.png".into()),
            visual: None,
            motion_points: Vec::new(),
            motion_plan: None,
            design_plan: None,
            narration: None,
        });
        sketch
            .metadata
            .fields
            .insert("owner".to_string(), "Demo team".to_string());
        sketch.description = serde_json::json!({"root": {"children": []}});

        let json = serde_json::to_string_pretty(&sketch).unwrap();
        let parsed: Sketch = serde_json::from_str(&json).unwrap();
        assert_eq!(sketch.title, parsed.title);
        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].time, "~30s");
        assert_eq!(parsed.rows[0].duration_seconds, Some(30));
        assert_eq!(
            parsed.metadata.fields.get("owner").map(String::as_str),
            Some("Demo team")
        );
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
        assert!(row.duration_seconds.is_none());
        assert!(row.narrative.is_empty());
        assert!(row.demo_actions.is_empty());
        assert!(row.screenshot.is_none());
    }

    #[test]
    fn planning_row_tolerates_null_motion_points() {
        let row: PlanningRow = serde_json::from_value(serde_json::json!({
            "time": "~30s",
            "duration_seconds": 30,
            "narrative": "Click the sign-up button",
            "demo_actions": "Navigate to /signup, click CTA",
            "screenshot": "screenshots/step1.png",
            "visual": null,
            "motion_points": null,
            "motion_plan": null
        }))
        .unwrap();

        assert!(row.motion_points.is_empty());
        assert!(row.motion_plan.is_none());
    }

    #[test]
    fn planning_row_roundtrip() {
        let row = PlanningRow {
            locked: false,
            locks: PlanningCellLocks::default(),
            time: "~30s".into(),
            duration_seconds: Some(30),
            narrative: "Click the sign-up button".into(),
            demo_actions: "Navigate to /signup, click CTA".into(),
            screenshot: Some("screenshots/step1.png".into()),
            visual: None,
            motion_points: vec![MotionPoint {
                rank: 1,
                x: 0.62,
                y: 0.41,
                label: Some("Primary CTA".into()),
            }],
            motion_plan: Some(MotionPlan {
                kind: MotionPlanKind::SubtlePush,
                keyframes: vec![
                    MotionPlanKeyframe {
                        time_ms: 0,
                        scale: 1.0,
                        x: 0.5,
                        y: 0.5,
                        easing: Some(MotionPlanEasing::EaseOut),
                    },
                    MotionPlanKeyframe {
                        time_ms: 2_000,
                        scale: 1.16,
                        x: 0.62,
                        y: 0.41,
                        easing: Some(MotionPlanEasing::EaseOut),
                    },
                ],
                rationale: Some("Push toward the primary CTA.".into()),
            }),
            design_plan: None,
            narration: None,
        };
        let json = serde_json::to_string(&row).unwrap();
        let parsed: PlanningRow = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.time, "~30s");
        assert_eq!(parsed.duration_seconds, Some(30));
        assert_eq!(parsed.screenshot, Some("screenshots/step1.png".into()));
        assert_eq!(parsed.motion_points.len(), 1);
        assert_eq!(
            parsed.motion_points[0].label.as_deref(),
            Some("Primary CTA")
        );
        assert_eq!(
            parsed.motion_plan.as_ref().map(|plan| &plan.kind),
            Some(&MotionPlanKind::SubtlePush)
        );
    }

    #[test]
    fn planning_row_default_matches_new() {
        let from_new = PlanningRow::new();
        let from_default = PlanningRow::default();
        assert_eq!(from_new.time, from_default.time);
        assert_eq!(from_new.locked, from_default.locked);
        assert_eq!(from_new.locks, from_default.locks);
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
        assert!(!sb.locked);
        assert!(sb.items.is_empty());
    }

    #[test]
    fn storyboard_with_items_roundtrip() {
        let sb = Storyboard {
            title: "Full Demo".into(),
            description: "End-to-end product demo".into(),
            locked: false,
            metadata: DocumentMetadata::default(),
            items: vec![
                StoryboardItem::SketchRef {
                    path: "intro.sk".into(),
                },
                StoryboardItem::Section {
                    title: "Getting Started".into(),
                    description: "Connect the first flow.".into(),
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
            StoryboardItem::Section {
                title,
                description,
                sketches,
            } => {
                assert_eq!(title, "Getting Started");
                assert_eq!(description, "Connect the first flow.");
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
            description: String::new(),
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
            description: String::new(),
            sketches: vec!["b.sk".into(), "c.sk".into()],
        });

        let summary = StoryboardSummary::from_storyboard(&sb, "test.sb");
        assert_eq!(summary.path, "test.sb");
        assert_eq!(summary.title, "Test");
        assert!(!summary.locked);
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
    fn storyboard_legacy_sketches_field_converts_to_items() {
        let json = r#"{
            "title": "Legacy Board",
            "description": "Old shape",
            "sketches": ["intro.sk", "demo.sk"],
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z"
        }"#;

        let storyboard: Storyboard = serde_json::from_str(json).unwrap();

        assert_eq!(storyboard.title, "Legacy Board");
        assert_eq!(storyboard.sketch_paths(), vec!["intro.sk", "demo.sk"]);
        assert_eq!(storyboard.sketch_count(), 2);
        assert!(storyboard.references_sketch("demo.sk"));
    }

    #[test]
    fn storyboard_section_description_defaults_for_existing_sections() {
        let json = r#"{
            "type": "section",
            "title": "Observe",
            "sketches": ["performance.sk"]
        }"#;

        let item: StoryboardItem = serde_json::from_str(json).unwrap();

        match item {
            StoryboardItem::Section {
                title,
                description,
                sketches,
            } => {
                assert_eq!(title, "Observe");
                assert!(description.is_empty());
                assert_eq!(sketches, vec!["performance.sk"]);
            }
            _ => panic!("Expected Section"),
        }
    }

    #[test]
    fn storyboard_removes_sketch_references_from_items_and_sections() {
        let now = Utc::now();
        let mut storyboard = Storyboard {
            title: "Demo".into(),
            description: String::new(),
            locked: false,
            metadata: DocumentMetadata::default(),
            items: vec![
                StoryboardItem::SketchRef {
                    path: "intro.sk".into(),
                },
                StoryboardItem::SketchRef {
                    path: "delete-me.sk".into(),
                },
                StoryboardItem::Section {
                    title: "Build".into(),
                    description: String::new(),
                    sketches: vec![
                        "delete-me.sk".into(),
                        "keep-me.sk".into(),
                        "delete-me.sk".into(),
                    ],
                },
            ],
            created_at: now,
            updated_at: now,
        };

        let removed = storyboard.remove_sketch_references("delete-me.sk");

        assert_eq!(removed, 3);
        assert_eq!(storyboard.sketch_paths(), vec!["intro.sk", "keep-me.sk"]);
        assert!(!storyboard.references_sketch("delete-me.sk"));
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
        assert!(!sketch.locked);
    }

    #[test]
    fn planning_row_backward_compat_missing_locks() {
        let json = r#"{
            "time": "~30s",
            "narrative": "Say hello",
            "demo_actions": "Open the app",
            "screenshot": null
        }"#;
        let row: PlanningRow = serde_json::from_str(json).unwrap();
        assert!(!row.locked);
        assert!(!row.locks.any());
    }

    #[test]
    fn planning_cell_locks_roundtrip() {
        let mut locks = PlanningCellLocks::default();
        assert!(locks.set("narrative", true));
        assert!(locks.is_locked("narrative"));
        assert!(!locks.is_locked("demo_actions"));
        assert!(!locks.set("unknown", true));

        let json = serde_json::to_string(&locks).unwrap();
        let parsed: PlanningCellLocks = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, locks);
    }
}
