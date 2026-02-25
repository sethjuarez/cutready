use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::action::Action;

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

/// A lightweight view of an open project folder.
///
/// Projects are folders on disk — there is no central registry.
/// Sketches (`.sk`) and storyboards (`.sb`) are discovered by scanning the folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectView {
    /// Absolute path to the project folder.
    pub root: PathBuf,
    /// Display name (derived from folder name).
    pub name: String,
}

impl ProjectView {
    pub fn new(root: PathBuf) -> Self {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".into());
        Self { root, name }
    }
}

/// Entry in the recent projects list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentProject {
    /// Absolute path to the project folder.
    pub path: String,
    /// When the project was last opened.
    pub last_opened: DateTime<Utc>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_view_from_path() {
        let view = ProjectView::new(PathBuf::from("/home/user/My Demo"));
        assert_eq!(view.name, "My Demo");
        assert_eq!(view.root, PathBuf::from("/home/user/My Demo"));
    }

    #[test]
    fn project_view_roundtrip() {
        let view = ProjectView::new(PathBuf::from("/projects/demo"));
        let json = serde_json::to_string(&view).unwrap();
        let parsed: ProjectView = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "demo");
    }

    #[test]
    fn recent_project_roundtrip() {
        let rp = RecentProject {
            path: "/home/user/demo".into(),
            last_opened: Utc::now(),
        };
        let json = serde_json::to_string(&rp).unwrap();
        let parsed: RecentProject = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.path, rp.path);
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
}
