use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::action::Action;
use super::animation::Animation;
use super::document::Document;
use super::recording::Recording;

/// Quality setting for screen recording.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingQuality {
    Low,
    Medium,
    High,
    Lossless,
}

/// Per-project configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSettings {
    pub output_directory: Option<PathBuf>,
    pub recording_quality: RecordingQuality,
    pub frame_rate: u32,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            output_directory: None,
            recording_quality: RecordingQuality::High,
            frame_rate: 30,
        }
    }
}

/// The top-level project, serialized as a `.cutready` JSON file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub settings: ProjectSettings,
    pub script: Script,
    #[serde(default)]
    pub documents: Vec<Document>,
    pub recordings: Vec<Recording>,
    pub animations: Vec<Animation>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Project {
    /// Create a new empty project with the given name.
    pub fn new(name: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            settings: ProjectSettings::default(),
            script: Script::default(),
            documents: Vec::new(),
            recordings: Vec::new(),
            animations: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }
}

/// The script — an ordered list of rows that describe the demo.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Script {
    pub rows: Vec<ScriptRow>,
}

/// A single row in the script table: one logical segment of the demo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptRow {
    pub id: Uuid,
    /// Segment duration in milliseconds.
    pub time_ms: u64,
    /// Voiceover / narration text (Markdown).
    pub narrative: String,
    /// Ordered demo steps for this segment.
    pub actions: Vec<Action>,
    /// Representative screenshot for this segment.
    pub screenshot: Option<PathBuf>,
    /// Metadata about how this row was created.
    pub metadata: RowMetadata,
}

impl ScriptRow {
    /// Create a new empty script row.
    pub fn new() -> Self {
        Self {
            id: Uuid::new_v4(),
            time_ms: 0,
            narrative: String::new(),
            actions: Vec::new(),
            screenshot: None,
            metadata: RowMetadata::default(),
        }
    }
}

impl Default for ScriptRow {
    fn default() -> Self {
        Self::new()
    }
}

/// How a script row was created and its refinement state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowMetadata {
    pub source: RowSource,
    pub refined: bool,
}

impl Default for RowMetadata {
    fn default() -> Self {
        Self {
            source: RowSource::Manual,
            refined: false,
        }
    }
}

/// Origin of a script row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RowSource {
    Recorded,
    Manual,
    Agent,
}

/// Summary info for listing projects (without loading the full project).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&Project> for ProjectSummary {
    fn from(p: &Project) -> Self {
        Self {
            id: p.id,
            name: p.name.clone(),
            created_at: p.created_at,
            updated_at: p.updated_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_new_has_defaults() {
        let project = Project::new("My Demo");
        assert_eq!(project.name, "My Demo");
        assert!(project.script.rows.is_empty());
        assert!(project.recordings.is_empty());
        assert!(project.animations.is_empty());
        assert_eq!(project.settings.frame_rate, 30);
        assert_eq!(project.settings.recording_quality, RecordingQuality::High);
    }

    #[test]
    fn project_roundtrip() {
        let project = Project::new("Test Project");
        let json = serde_json::to_string_pretty(&project).unwrap();
        let parsed: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(project.id, parsed.id);
        assert_eq!(project.name, parsed.name);
    }

    #[test]
    fn script_row_roundtrip() {
        let row = ScriptRow {
            id: Uuid::new_v4(),
            time_ms: 5000,
            narrative: "Click the submit button to confirm.".into(),
            actions: vec![],
            screenshot: Some("screenshots/step1.png".into()),
            metadata: RowMetadata {
                source: RowSource::Recorded,
                refined: true,
            },
        };
        let json = serde_json::to_string(&row).unwrap();
        let parsed: ScriptRow = serde_json::from_str(&json).unwrap();
        assert_eq!(row.id, parsed.id);
        assert_eq!(row.time_ms, parsed.time_ms);
        assert_eq!(row.narrative, parsed.narrative);
    }

    #[test]
    fn project_summary_from_project() {
        let project = Project::new("Demo");
        let summary = ProjectSummary::from(&project);
        assert_eq!(summary.id, project.id);
        assert_eq!(summary.name, project.name);
        assert_eq!(summary.created_at, project.created_at);
        assert_eq!(summary.updated_at, project.updated_at);
    }

    #[test]
    fn script_row_new_defaults() {
        let row = ScriptRow::new();
        assert_eq!(row.time_ms, 0);
        assert!(row.narrative.is_empty());
        assert!(row.actions.is_empty());
        assert!(row.screenshot.is_none());
        assert_eq!(row.metadata.source, RowSource::Manual);
        assert!(!row.metadata.refined);
    }

    #[test]
    fn script_row_default_matches_new() {
        let from_new = ScriptRow::new();
        let from_default = ScriptRow::default();
        // Both should produce equivalent structures (different UUIDs though)
        assert_eq!(from_new.time_ms, from_default.time_ms);
        assert_eq!(from_new.narrative, from_default.narrative);
        assert_eq!(from_new.metadata.source, from_default.metadata.source);
    }

    #[test]
    fn project_settings_default() {
        let settings = ProjectSettings::default();
        assert!(settings.output_directory.is_none());
        assert_eq!(settings.recording_quality, RecordingQuality::High);
        assert_eq!(settings.frame_rate, 30);
    }

    #[test]
    fn project_settings_roundtrip() {
        let settings = ProjectSettings {
            output_directory: Some("output/demos".into()),
            recording_quality: RecordingQuality::Lossless,
            frame_rate: 60,
        };
        let json = serde_json::to_string(&settings).unwrap();
        let parsed: ProjectSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(settings.recording_quality, parsed.recording_quality);
        assert_eq!(settings.frame_rate, parsed.frame_rate);
    }

    #[test]
    fn row_metadata_default() {
        let meta = RowMetadata::default();
        assert_eq!(meta.source, RowSource::Manual);
        assert!(!meta.refined);
    }

    #[test]
    fn row_source_serde_values() {
        // Verify snake_case serialization
        let json = serde_json::to_string(&RowSource::Recorded).unwrap();
        assert_eq!(json, "\"recorded\"");
        let json = serde_json::to_string(&RowSource::Manual).unwrap();
        assert_eq!(json, "\"manual\"");
        let json = serde_json::to_string(&RowSource::Agent).unwrap();
        assert_eq!(json, "\"agent\"");
    }

    #[test]
    fn recording_quality_serde_values() {
        let json = serde_json::to_string(&RecordingQuality::Low).unwrap();
        assert_eq!(json, "\"low\"");
        let json = serde_json::to_string(&RecordingQuality::Medium).unwrap();
        assert_eq!(json, "\"medium\"");
        let json = serde_json::to_string(&RecordingQuality::Lossless).unwrap();
        assert_eq!(json, "\"lossless\"");
    }

    #[test]
    fn script_with_multiple_rows_roundtrip() {
        let script = Script {
            rows: vec![ScriptRow::new(), ScriptRow::new(), ScriptRow::new()],
        };
        let json = serde_json::to_string(&script).unwrap();
        let parsed: Script = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.rows.len(), 3);
        // Each row should have a unique ID
        let ids: Vec<_> = parsed.rows.iter().map(|r| r.id).collect();
        assert_ne!(ids[0], ids[1]);
        assert_ne!(ids[1], ids[2]);
    }

    #[test]
    fn script_row_with_actions_roundtrip() {
        use crate::models::action::{Action, SelectorStrategy};

        let row = ScriptRow {
            id: Uuid::new_v4(),
            time_ms: 3000,
            narrative: "Navigate to the settings page and enable dark mode.".into(),
            actions: vec![
                Action::BrowserNavigate {
                    url: "https://app.example.com/settings".into(),
                },
                Action::BrowserClick {
                    selectors: vec![SelectorStrategy::DataTestId("dark-mode-toggle".into())],
                },
            ],
            screenshot: None,
            metadata: RowMetadata {
                source: RowSource::Agent,
                refined: true,
            },
        };
        let json = serde_json::to_string(&row).unwrap();
        let parsed: ScriptRow = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.actions.len(), 2);
        assert_eq!(parsed.metadata.source, RowSource::Agent);
        assert!(parsed.metadata.refined);
    }

    #[test]
    fn project_with_nested_data_roundtrip() {
        let mut project = Project::new("Full Test");
        project.script.rows.push(ScriptRow::new());
        project.settings.recording_quality = RecordingQuality::Lossless;
        project.settings.frame_rate = 60;
        project.settings.output_directory = Some("output".into());

        let json = serde_json::to_string_pretty(&project).unwrap();
        let parsed: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, project.id);
        assert_eq!(parsed.script.rows.len(), 1);
        assert_eq!(
            parsed.settings.recording_quality,
            RecordingQuality::Lossless
        );
        assert_eq!(parsed.settings.frame_rate, 60);
    }

    #[test]
    fn project_summary_roundtrip() {
        let project = Project::new("Summary Test");
        let summary = ProjectSummary::from(&project);
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: ProjectSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, summary.id);
        assert_eq!(parsed.name, summary.name);
    }

    #[test]
    fn project_created_at_equals_updated_at_on_new() {
        let project = Project::new("Timestamp Test");
        assert_eq!(project.created_at, project.updated_at);
    }
}
