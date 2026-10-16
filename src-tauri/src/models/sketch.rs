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
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "BTreeMap::is_empty"
    )]
    pub fields: BTreeMap<String, String>,
}

impl DocumentMetadata {
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty()
    }
}

/// Treats explicit null like an absent optional field without accepting other invalid values.
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// Lock state for editable planning row cells.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PlanningCellLocks {
    #[serde(default, deserialize_with = "null_as_default")]
    pub time: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub narrative: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub demo_actions: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub screenshot: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub visual: bool,
    #[serde(default, deserialize_with = "null_as_default")]
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

/// A deliberate delivery beat that may anchor narration and camera motion.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NarrationBeat {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_degree: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emphasis: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_after_ms: Option<u32>,
}

/// Durable creative direction and compiled Azure Speech SSML for generated narration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NarrationPlan {
    pub source_text: String,
    pub voice: String,
    pub locale: String,
    pub ssml: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_style: Option<String>,
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
    pub pronunciation_overrides: std::collections::BTreeMap<String, String>,
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub beats: Vec<NarrationBeat>,
    pub generated_at: DateTime<Utc>,
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

/// A normalized text box rendered as a typewriter overlay during video export.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TypingSpot {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_offset_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub characters_per_second: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_cursor: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_scale: Option<f32>,
}

/// Agent-generated camera motion plan for screenshot rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MotionPlan {
    pub kind: MotionPlanKind,
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "Vec::is_empty"
    )]
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
    #[serde(default, deserialize_with = "null_as_default")]
    pub locked: bool,
    /// Per-cell lock state for targeted protection.
    #[serde(default, deserialize_with = "null_as_default")]
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
        deserialize_with = "null_as_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub motion_points: Vec<MotionPoint>,
    /// Positioned text overlays that are rendered in source coordinates before camera motion.
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub typing_spots: Vec<TypingSpot>,
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
    /// Durable SSML and creative direction for generated narration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narration_plan: Option<NarrationPlan>,
    /// Fields this version does not model (written by newer desktop or iOS builds).
    /// Preserved verbatim so a save never drops them.
    #[serde(flatten)]
    pub unknown_fields: serde_json::Map<String, serde_json::Value>,
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
            typing_spots: Vec::new(),
            motion_plan: None,
            design_plan: None,
            narration: None,
            narration_plan: None,
            unknown_fields: serde_json::Map::new(),
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
    #[serde(default, deserialize_with = "null_as_default")]
    pub locked: bool,
    /// Rich-text description — stored as JSON value. Null if empty.
    #[serde(default)]
    pub description: serde_json::Value,
    /// Planning table rows.
    #[serde(default)]
    pub rows: Vec<PlanningRow>,
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "DocumentMetadata::is_empty"
    )]
    pub metadata: DocumentMetadata,
    pub state: SketchState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Fields this version does not model (written by newer desktop or iOS builds).
    /// Preserved verbatim so a save never drops them.
    #[serde(flatten)]
    pub unknown_fields: serde_json::Map<String, serde_json::Value>,
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
            unknown_fields: serde_json::Map::new(),
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
///
/// Decoding is strict: read files through [`Storyboard::from_json_upgraded`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Storyboard {
    pub title: String,
    pub description: String,
    /// Whether the whole storyboard is protected from edits.
    pub locked: bool,
    #[serde(default, skip_serializing_if = "DocumentMetadata::is_empty")]
    pub metadata: DocumentMetadata,
    /// Ordered items: loose sketch refs and/or named sections.
    pub items: Vec<StoryboardItem>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Fields this version does not model (written by newer desktop or iOS builds).
    /// Preserved verbatim so a save never drops them.
    #[serde(flatten)]
    pub unknown_fields: serde_json::Map<String, serde_json::Value>,
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
            unknown_fields: serde_json::Map::new(),
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
            .any(|item| item.sketch_paths().contains(&sketch_path))
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

impl Storyboard {
    /// Parse `.sb` JSON, upgrading older shapes first.
    /// Returns whether the upgrade changed anything, so callers can save the canonical form.
    pub fn from_json_upgraded(text: &str) -> Result<(Self, bool), serde_json::Error> {
        Self::from_json_bytes_upgraded(text.as_bytes())
    }

    /// Parse bytes directly so invalid UTF-8 is reported instead of replaced.
    pub fn from_json_bytes_upgraded(bytes: &[u8]) -> Result<(Self, bool), serde_json::Error> {
        let mut value: serde_json::Value = serde_json::from_slice(bytes)?;
        let upgraded = upgrade_storyboard_json(&mut value);
        Ok((serde_json::from_value(value)?, upgraded))
    }
}

/// Convert an older `.sb` shape to the canonical one (`StoryboardDocument.upgrade`
/// in contracts/storyboard.tsp). Returns whether anything changed.
pub fn upgrade_storyboard_json(value: &mut serde_json::Value) -> bool {
    use serde_json::{json, Value};

    let Some(doc) = value.as_object_mut() else {
        return false;
    };
    let before = doc.clone();

    let legacy = doc.remove("sketches");
    if doc.get("items").map_or(true, Value::is_null) {
        let items = legacy
            .as_ref()
            .and_then(Value::as_array)
            .map(|paths| {
                paths
                    .iter()
                    .map(|path| json!({ "type": "sketch_ref", "path": path }))
                    .collect()
            })
            .unwrap_or_default();
        doc.insert("items".into(), Value::Array(items));
    }
    if let Some(items) = doc.get_mut("items").and_then(Value::as_array_mut) {
        for item in items.iter_mut().filter_map(Value::as_object_mut) {
            match item.get("type").and_then(Value::as_str) {
                Some("sketch") => {
                    item.insert("type".into(), json!("sketch_ref"));
                }
                Some("section") => {
                    if item
                        .get("description")
                        .is_some_and(|d| d.is_null() || d.as_str() == Some(""))
                    {
                        item.remove("description");
                    }
                    if item.get("sketches").map_or(true, Value::is_null) {
                        item.insert("sketches".into(), json!([]));
                    }
                }
                _ => {}
            }
        }
    }
    if doc.get("description").map_or(true, Value::is_null) {
        doc.insert("description".into(), json!(""));
    }
    if doc.get("locked").map_or(true, Value::is_null) {
        doc.insert("locked".into(), json!(false));
    }
    if doc.get("metadata").is_some_and(Value::is_null) {
        doc.remove("metadata");
    }

    *doc != before
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
#[allow(dead_code)]
pub struct VersionEntry {
    pub id: String,
    pub message: String,
    pub timestamp: DateTime<Utc>,
    pub summary: String,
}

/// A timeline (git branch) in the project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
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
#[allow(dead_code)]
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
            typing_spots: Vec::new(),
            motion_plan: None,
            design_plan: None,
            narration: None,
            narration_plan: None,
            unknown_fields: Default::default(),
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
        assert!(row.narration_plan.is_none());
    }

    #[test]
    fn planning_cell_locks_treat_null_as_absent() {
        let locks: PlanningCellLocks = serde_json::from_value(serde_json::json!({
            "time": null,
            "narrative": null,
            "demo_actions": null,
            "screenshot": null,
            "visual": null,
            "design_plan": null
        }))
        .unwrap();

        assert_eq!(locks, PlanningCellLocks::default());
    }

    #[test]
    fn optional_null_defaults_do_not_accept_malformed_values() {
        let valid = serde_json::json!({
            "title": "Strict optional fields",
            "locked": true,
            "rows": [{
                "time": "0:05",
                "narrative": "Keep valid values.",
                "demo_actions": "Wait.",
                "locked": true,
                "locks": {
                    "time": true, "narrative": false, "demo_actions": false,
                    "screenshot": false, "visual": false, "design_plan": false
                },
                "motion_points": [],
                "typing_spots": [],
                "motion_plan": { "kind": "subtle_push", "keyframes": [] },
                "narration_plan": {
                    "source_text": "Keep valid values.",
                    "voice": "en-US-AvaMultilingualNeural",
                    "locale": "en-US",
                    "ssml": "<speak>Keep valid values.</speak>",
                    "pronunciation_overrides": { "CutReady": "cut ready" },
                    "beats": [],
                    "generated_at": "2026-06-28T20:00:00Z"
                }
            }],
            "metadata": { "fields": { "owner": "Demo team" } },
            "state": "draft",
            "created_at": "2026-06-28T20:00:00Z",
            "updated_at": "2026-06-28T20:00:00Z"
        });
        let sketch: Sketch = serde_json::from_value(valid.clone()).unwrap();
        assert!(sketch.locked);
        assert!(sketch.rows[0].locked);
        assert!(sketch.rows[0].locks.time);
        assert!(!sketch.rows[0].locks.narrative);
        assert_eq!(sketch.metadata.fields["owner"], "Demo team");
        assert_eq!(
            sketch.rows[0]
                .narration_plan
                .as_ref()
                .unwrap()
                .pronunciation_overrides["CutReady"],
            "cut ready"
        );

        for pointer in [
            "/locked",
            "/metadata",
            "/metadata/fields",
            "/rows/0/locked",
            "/rows/0/locks",
            "/rows/0/locks/time",
            "/rows/0/locks/narrative",
            "/rows/0/locks/demo_actions",
            "/rows/0/locks/screenshot",
            "/rows/0/locks/visual",
            "/rows/0/locks/design_plan",
            "/rows/0/motion_points",
            "/rows/0/typing_spots",
            "/rows/0/motion_plan/keyframes",
            "/rows/0/narration_plan/pronunciation_overrides",
            "/rows/0/narration_plan/beats",
        ] {
            let mut malformed = valid.clone();
            *malformed.pointer_mut(pointer).unwrap() = serde_json::json!("invalid");
            assert!(
                serde_json::from_value::<Sketch>(malformed).is_err(),
                "must reject an invalid value at {pointer}"
            );
        }

        for (pointer, value) in [
            ("/metadata/fields", serde_json::json!({ "owner": null })),
            (
                "/rows/0/narration_plan/pronunciation_overrides",
                serde_json::json!({ "CutReady": null }),
            ),
            ("/rows/0/narration_plan/beats", serde_json::json!([null])),
            ("/rows/0/motion_plan/keyframes", serde_json::json!([null])),
            ("/rows/0/motion_points", serde_json::json!([null])),
            ("/rows/0/typing_spots", serde_json::json!([null])),
        ] {
            let mut malformed = valid.clone();
            *malformed.pointer_mut(pointer).unwrap() = value;
            assert!(
                serde_json::from_value::<Sketch>(malformed).is_err(),
                "null entries must not be discarded at {pointer}"
            );
        }
    }

    #[test]
    fn planning_row_roundtrips_narration_plan() {
        let mut row = PlanningRow::new();
        row.narration_plan = Some(NarrationPlan {
            source_text: "CutReady keeps the story moving.".into(),
            voice: "en-US-AvaMultilingualNeural".into(),
            locale: "en-US".into(),
            ssml: "<speak><voice name=\"en-US-AvaMultilingualNeural\">CutReady keeps the story moving.</voice></speak>".into(),
            baseline_style: Some("narration-professional".into()),
            pronunciation_overrides: [("CutReady".into(), "cut ready".into())].into_iter().collect(),
            beats: vec![NarrationBeat {
                text: "story moving".into(),
                purpose: Some("payoff".into()),
                style: Some("excited".into()),
                style_degree: Some(1.1),
                emphasis: Some("moderate".into()),
                pause_after_ms: Some(250),
            }],
            generated_at: Utc::now(),
        });

        let serialized = serde_json::to_value(&row).unwrap();
        let parsed: PlanningRow = serde_json::from_value(serialized).unwrap();
        let plan = parsed.narration_plan.unwrap();
        assert_eq!(
            plan.baseline_style.as_deref(),
            Some("narration-professional")
        );
        assert_eq!(
            plan.pronunciation_overrides
                .get("CutReady")
                .map(String::as_str),
            Some("cut ready")
        );
        assert_eq!(plan.beats[0].pause_after_ms, Some(250));
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
            typing_spots: vec![TypingSpot {
                x: 0.2,
                y: 0.3,
                width: 0.4,
                height: 0.1,
                text: "Create a workspace".into(),
                start_offset_ms: Some(200),
                duration_ms: Some(1_500),
                characters_per_second: Some(18.0),
                show_cursor: Some(true),
                text_color: Some("#ffffff".into()),
                font_family: Some("sans".into()),
                font_scale: Some(1.0),
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
            narration_plan: None,
            unknown_fields: Default::default(),
        };
        let json = serde_json::to_string(&row).unwrap();
        let parsed: PlanningRow = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.time, "~30s");
        assert_eq!(parsed.duration_seconds, Some(30));
        assert_eq!(parsed.screenshot, Some("screenshots/step1.png".into()));
        assert_eq!(parsed.motion_points.len(), 1);
        assert_eq!(parsed.typing_spots.len(), 1);
        assert_eq!(parsed.typing_spots[0].text, "Create a workspace");
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
            unknown_fields: Default::default(),
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

        let (storyboard, upgraded) = Storyboard::from_json_upgraded(json).unwrap();

        assert!(upgraded);
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
            unknown_fields: Default::default(),
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
