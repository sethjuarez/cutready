use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Lifecycle state of a sketch document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentState {
    Sketch,
    RecordingEnriched,
    Refined,
    Final,
}

/// A section within a sketch document containing planning table rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSection {
    pub id: Uuid,
    pub title: String,
    pub description: String,
    pub rows: Vec<PlanningRow>,
}

impl DocumentSection {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            title: title.into(),
            description: String::new(),
            rows: Vec::new(),
        }
    }
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

/// A sketch document — the primary authoring artifact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: Uuid,
    pub title: String,
    pub description: String,
    pub sections: Vec<DocumentSection>,
    /// Lexical editor state JSON — opaque to the backend.
    pub content: serde_json::Value,
    pub state: DocumentState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Document {
    pub fn new(title: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            title: title.into(),
            description: String::new(),
            sections: Vec::new(),
            content: serde_json::Value::Null,
            state: DocumentState::Sketch,
            created_at: now,
            updated_at: now,
        }
    }
}

/// Lightweight summary for listing documents without loading full content.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSummary {
    pub id: Uuid,
    pub title: String,
    pub state: DocumentState,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<&Document> for DocumentSummary {
    fn from(doc: &Document) -> Self {
        Self {
            id: doc.id,
            title: doc.title.clone(),
            state: doc.state.clone(),
            created_at: doc.created_at,
            updated_at: doc.updated_at,
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
    fn document_new_defaults() {
        let doc = Document::new("Getting Started Guide");
        assert_eq!(doc.title, "Getting Started Guide");
        assert!(doc.description.is_empty());
        assert!(doc.sections.is_empty());
        assert_eq!(doc.content, serde_json::Value::Null);
        assert_eq!(doc.state, DocumentState::Sketch);
    }

    #[test]
    fn document_roundtrip() {
        let mut doc = Document::new("Test Doc");
        doc.description = "A test document".into();
        doc.sections.push(DocumentSection::new("Section 1"));
        doc.content = serde_json::json!({"root": {"children": []}});

        let json = serde_json::to_string_pretty(&doc).unwrap();
        let parsed: Document = serde_json::from_str(&json).unwrap();
        assert_eq!(doc.id, parsed.id);
        assert_eq!(doc.title, parsed.title);
        assert_eq!(doc.description, parsed.description);
        assert_eq!(doc.sections.len(), 1);
        assert_eq!(parsed.content, serde_json::json!({"root": {"children": []}}));
    }

    #[test]
    fn document_state_serde_values() {
        assert_eq!(serde_json::to_string(&DocumentState::Sketch).unwrap(), "\"sketch\"");
        assert_eq!(serde_json::to_string(&DocumentState::RecordingEnriched).unwrap(), "\"recording_enriched\"");
        assert_eq!(serde_json::to_string(&DocumentState::Refined).unwrap(), "\"refined\"");
        assert_eq!(serde_json::to_string(&DocumentState::Final).unwrap(), "\"final\"");
    }

    #[test]
    fn document_section_new() {
        let section = DocumentSection::new("Introduction");
        assert_eq!(section.title, "Introduction");
        assert!(section.description.is_empty());
        assert!(section.rows.is_empty());
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
    fn document_summary_from_document() {
        let doc = Document::new("Summary Test");
        let summary = DocumentSummary::from(&doc);
        assert_eq!(summary.id, doc.id);
        assert_eq!(summary.title, doc.title);
        assert_eq!(summary.state, DocumentState::Sketch);
        assert_eq!(summary.created_at, doc.created_at);
    }

    #[test]
    fn document_summary_roundtrip() {
        let doc = Document::new("Roundtrip");
        let summary = DocumentSummary::from(&doc);
        let json = serde_json::to_string(&summary).unwrap();
        let parsed: DocumentSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, summary.id);
        assert_eq!(parsed.title, summary.title);
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
    fn document_with_sections_and_rows_roundtrip() {
        let mut doc = Document::new("Full Document");
        let mut section = DocumentSection::new("Setup");
        section.rows.push(PlanningRow {
            id: Uuid::new_v4(),
            time: "1:00".into(),
            narrative: "Open the app and log in".into(),
            demo_actions: "Navigate to app, enter credentials".into(),
            screenshot: None,
        });
        section.rows.push(PlanningRow::new());
        doc.sections.push(section);

        let json = serde_json::to_string_pretty(&doc).unwrap();
        let parsed: Document = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.sections.len(), 1);
        assert_eq!(parsed.sections[0].rows.len(), 2);
        assert_eq!(parsed.sections[0].rows[0].time, "1:00");
    }

    #[test]
    fn document_state_all_variants_roundtrip() {
        for state in [
            DocumentState::Sketch,
            DocumentState::RecordingEnriched,
            DocumentState::Refined,
            DocumentState::Final,
        ] {
            let json = serde_json::to_string(&state).unwrap();
            let parsed: DocumentState = serde_json::from_str(&json).unwrap();
            assert_eq!(state, parsed);
        }
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
}
