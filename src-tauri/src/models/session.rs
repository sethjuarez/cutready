use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::action::{Action, ActionMetadata};

/// Raw output from the interaction recorder — unprocessed captured events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedSession {
    pub id: Uuid,
    pub mode: RecordingMode,
    /// Optional link to a sketch this recording is associated with (relative path).
    #[serde(default, alias = "document_id", alias = "sketch_id")]
    pub sketch_path: Option<String>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub actions: Vec<CapturedAction>,
}

impl RecordedSession {
    /// Create a new empty session.
    pub fn new(mode: RecordingMode) -> Self {
        Self {
            id: Uuid::new_v4(),
            mode,
            sketch_path: None,
            started_at: Utc::now(),
            ended_at: None,
            actions: Vec::new(),
        }
    }
}

/// Whether the session is free-form (continuous) or step-by-step.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingMode {
    FreeForm,
    StepByStep,
}

/// A single captured interaction with full context.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapturedAction {
    pub action: Action,
    pub metadata: ActionMetadata,
    /// Low-level event data for debugging.
    pub raw_event: Option<RawEvent>,
}

/// Raw event data from the capture source (CDP, Win32 hooks, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawEvent {
    /// Source of the event.
    pub source: EventSource,
    /// JSON-encoded raw event data.
    pub data: String,
}

/// Where a raw event came from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Cdp,
    DomObserver,
    WinEventHook,
    InputHook,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::action::SelectorStrategy;

    #[test]
    fn recorded_session_roundtrip() {
        let mut session = RecordedSession::new(RecordingMode::FreeForm);
        session.actions.push(CapturedAction {
            action: Action::BrowserClick {
                selectors: vec![SelectorStrategy::CssSelector("#btn".into())],
            },
            metadata: ActionMetadata {
                captured_screenshot: Some("screenshots/step_0.png".into()),
                selector_strategies: vec![SelectorStrategy::CssSelector("#btn".into())],
                timestamp_ms: 1500,
                confidence: 0.92,
                context_snapshot: None,
            },
            raw_event: Some(RawEvent {
                source: EventSource::Cdp,
                data: r#"{"type":"click","x":100,"y":200}"#.into(),
            }),
        });
        session.ended_at = Some(Utc::now());

        let json = serde_json::to_string_pretty(&session).unwrap();
        let parsed: RecordedSession = serde_json::from_str(&json).unwrap();
        assert_eq!(session.id, parsed.id);
        assert_eq!(session.mode, parsed.mode);
        assert_eq!(session.actions.len(), parsed.actions.len());
    }

    #[test]
    fn session_new_defaults() {
        let session = RecordedSession::new(RecordingMode::StepByStep);
        assert_eq!(session.mode, RecordingMode::StepByStep);
        assert!(session.actions.is_empty());
        assert!(session.ended_at.is_none());
    }

    #[test]
    fn recording_mode_serde_values() {
        let json = serde_json::to_string(&RecordingMode::FreeForm).unwrap();
        assert_eq!(json, "\"free_form\"");
        let json = serde_json::to_string(&RecordingMode::StepByStep).unwrap();
        assert_eq!(json, "\"step_by_step\"");
    }

    #[test]
    fn event_source_all_variants_roundtrip() {
        for source in [
            EventSource::Cdp,
            EventSource::DomObserver,
            EventSource::WinEventHook,
            EventSource::InputHook,
        ] {
            let json = serde_json::to_string(&source).unwrap();
            let parsed: EventSource = serde_json::from_str(&json).unwrap();
            assert_eq!(source, parsed);
        }
    }

    #[test]
    fn event_source_serde_values() {
        let json = serde_json::to_string(&EventSource::Cdp).unwrap();
        assert_eq!(json, "\"cdp\"");
        let json = serde_json::to_string(&EventSource::DomObserver).unwrap();
        assert_eq!(json, "\"dom_observer\"");
        let json = serde_json::to_string(&EventSource::WinEventHook).unwrap();
        assert_eq!(json, "\"win_event_hook\"");
        let json = serde_json::to_string(&EventSource::InputHook).unwrap();
        assert_eq!(json, "\"input_hook\"");
    }

    #[test]
    fn raw_event_roundtrip() {
        let event = RawEvent {
            source: EventSource::DomObserver,
            data: r#"{"tagName":"BUTTON","id":"submit"}"#.into(),
        };
        let json = serde_json::to_string(&event).unwrap();
        let parsed: RawEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.source, EventSource::DomObserver);
        assert!(parsed.data.contains("BUTTON"));
    }

    #[test]
    fn captured_action_without_raw_event_roundtrip() {
        let captured = CapturedAction {
            action: Action::BrowserNavigate {
                url: "https://example.com".into(),
            },
            metadata: ActionMetadata {
                captured_screenshot: None,
                selector_strategies: vec![],
                timestamp_ms: 0,
                confidence: 1.0,
                context_snapshot: None,
            },
            raw_event: None,
        };
        let json = serde_json::to_string(&captured).unwrap();
        let parsed: CapturedAction = serde_json::from_str(&json).unwrap();
        assert!(parsed.raw_event.is_none());
    }

    #[test]
    fn session_with_multiple_actions_roundtrip() {
        let mut session = RecordedSession::new(RecordingMode::FreeForm);
        for i in 0..5 {
            session.actions.push(CapturedAction {
                action: Action::Wait { duration_ms: i * 100 },
                metadata: ActionMetadata {
                    captured_screenshot: None,
                    selector_strategies: vec![],
                    timestamp_ms: i * 100,
                    confidence: 1.0,
                    context_snapshot: None,
                },
                raw_event: None,
            });
        }
        let json = serde_json::to_string(&session).unwrap();
        let parsed: RecordedSession = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.actions.len(), 5);
    }
}
