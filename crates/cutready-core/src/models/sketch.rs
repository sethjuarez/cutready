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

pub use super::demo_intent::{
    DemoStep, FramingBeat, FramingEasing, FramingRect, InteractionBounds, InteractionCapturePolicy,
    WaitEditPolicy,
};

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
    /// Spoken text used when this audio was recorded/generated.
    pub source_text: String,
    /// SHA-256 of `source_text`.
    pub source_text_hash: String,
    /// Row narrative text at the moment this asset was recorded/generated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrative_text: Option<String>,
    /// SHA-256 of `narrative_text` for non-lossy staleness checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrative_text_hash: Option<String>,
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
    /// Stable identity, unique within the sketch. Empty until the codec
    /// assigns one (see [`assign_row_ids`]); always written on save.
    #[serde(default, deserialize_with = "null_as_default")]
    pub id: String,
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
    /// Normalized walkthrough steps compiled from prose actions or rough recordings.
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub demo_steps: Vec<DemoStep>,
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
    /// Editorial camera/framing beats for zoom, pan, crop, and hold intent.
    #[serde(
        default,
        deserialize_with = "null_as_default",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub framing_beats: Vec<FramingBeat>,
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
            id: String::new(),
            locked: false,
            locks: PlanningCellLocks::default(),
            time: String::new(),
            duration_seconds: None,
            narrative: String::new(),
            demo_actions: String::new(),
            demo_steps: Vec::new(),
            screenshot: None,
            visual: None,
            motion_points: Vec::new(),
            typing_spots: Vec::new(),
            motion_plan: None,
            framing_beats: Vec::new(),
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

/// Two rows in one sketch share an id.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Planning row {} repeats the row id `{row_id}`.", .row_index + 1)]
pub struct DuplicateRowId {
    /// Zero-based position of the second row with the id.
    pub row_index: usize,
    pub row_id: String,
}

/// Gives every row a stable id. Ids already present are kept and must be
/// unique. A row without one (legacy files, or rows built in code) gets
/// `row-{position}`, one-based, with `-2`, `-3`, ... appended while that
/// id is taken, so every runtime migrates the same file to the same ids.
pub fn assign_row_ids(rows: &mut [PlanningRow]) -> Result<(), DuplicateRowId> {
    let mut taken = std::collections::HashSet::new();
    for (row_index, row) in rows.iter().enumerate() {
        if !row.id.is_empty() && !taken.insert(row.id.clone()) {
            return Err(DuplicateRowId {
                row_index,
                row_id: row.id.clone(),
            });
        }
    }
    for (index, row) in rows.iter_mut().enumerate() {
        if !row.id.is_empty() {
            continue;
        }
        let base = format!("row-{}", index + 1);
        let mut candidate = base.clone();
        let mut suffix = 2;
        while taken.contains(&candidate) {
            candidate = format!("{base}-{suffix}");
            suffix += 1;
        }
        taken.insert(candidate.clone());
        row.id = candidate;
    }
    Ok(())
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
    pub fn new(title: impl Into<String>, now: DateTime<Utc>) -> Self {
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
    pub fn new(title: impl Into<String>, now: DateTime<Utc>) -> Self {
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
    if doc.get("items").is_none_or(Value::is_null) {
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
                    if item.get("sketches").is_none_or(Value::is_null) {
                        item.insert("sketches".into(), json!([]));
                    }
                }
                _ => {}
            }
        }
    }
    if doc.get("description").is_none_or(Value::is_null) {
        doc.insert("description".into(), json!(""));
    }
    if doc.get("locked").is_none_or(Value::is_null) {
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
    /// Number of turns for chat documents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_count: Option<usize>,
}

#[cfg(test)]
#[path = "sketch_tests.rs"]
mod tests;
