//! Demo intent on a planning row: normalized walkthrough steps and editorial
//! framing beats. Re-exported from [super::sketch].

use serde::{Deserialize, Serialize};

/// High-level walkthrough intent derived from row action prose or a recorded demo.
///
/// This sits between `demo_actions` prose and low-level replay `Action` values:
/// prose remains user-authored, demo steps capture normalized intent, and replay
/// actions bind that intent to concrete browser/native selectors.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DemoStep {
    Navigate {
        target: String,
    },
    Click {
        target: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_bounds: Option<InteractionBounds>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        capture: Option<InteractionCapturePolicy>,
    },
    Type {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_bounds: Option<InteractionBounds>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clear_first: Option<bool>,
    },
    Select {
        target: String,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_bounds: Option<InteractionBounds>,
    },
    WaitFor {
        condition: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        edit_policy: Option<WaitEditPolicy>,
    },
    Highlight {
        target: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target_bounds: Option<InteractionBounds>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionCapturePolicy {
    BeforeAfter,
    BeforeAfterAndMotion,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WaitEditPolicy {
    KeepNatural,
    CompressWait,
    ShowStartAndEnd,
    CutToCompletion,
    KeepVisible,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FramingRect {
    /// Normalized left edge, relative to the row screenshot or visual.
    pub x: f32,
    /// Normalized top edge, relative to the row screenshot or visual.
    pub y: f32,
    /// Normalized width, relative to the row screenshot or visual.
    pub width: f32,
    /// Normalized height, relative to the row screenshot or visual.
    pub height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InteractionBounds {
    /// Left edge in source screenshot pixels.
    pub x: f32,
    /// Top edge in source screenshot pixels.
    pub y: f32,
    /// Width in source screenshot pixels.
    pub width: f32,
    /// Height in source screenshot pixels.
    pub height: f32,
}

/// Editorial camera intent for a sketch row, separate from interaction replay.
///
/// `at_ms` values are relative to the start of this planning row. These beats
/// express authoring intent; `motion_plan` is the compiled export-era camera
/// plan derived from or superseded by this higher-level intent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FramingBeat {
    FullScreen {
        #[serde(default)]
        at_ms: u32,
    },
    ZoomTo {
        #[serde(default)]
        at_ms: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rect: Option<FramingRect>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        easing: Option<FramingEasing>,
    },
    Hold {
        #[serde(default)]
        at_ms: u32,
        duration_ms: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FramingEasing {
    Linear,
    EaseInOut,
    EaseOut,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::sketch::PlanningRow;

    #[test]
    fn planning_row_intent_roundtrips_with_snake_case_schema_names() {
        let row = PlanningRow {
            demo_steps: vec![
                DemoStep::Navigate {
                    target: "/signup".into(),
                },
                DemoStep::Click {
                    target: "CTA".into(),
                    target_bounds: None,
                    capture: Some(InteractionCapturePolicy::BeforeAfterAndMotion),
                },
                DemoStep::WaitFor {
                    condition: "rows appear".into(),
                    timeout_ms: Some(30_000),
                    edit_policy: Some(WaitEditPolicy::ShowStartAndEnd),
                },
            ],
            framing_beats: vec![
                FramingBeat::FullScreen { at_ms: 0 },
                FramingBeat::ZoomTo {
                    at_ms: 500,
                    target: Some("generated outline".into()),
                    rect: Some(FramingRect {
                        x: 0.55,
                        y: 0.35,
                        width: 0.25,
                        height: 0.2,
                    }),
                    duration_ms: Some(800),
                    easing: Some(FramingEasing::EaseInOut),
                },
                FramingBeat::Hold {
                    at_ms: 1_600,
                    duration_ms: 400,
                },
            ],
            ..PlanningRow::new()
        };

        let value = serde_json::to_value(&row).unwrap();
        assert_eq!(value["demo_steps"][2]["kind"], "wait_for");
        assert_eq!(value["demo_steps"][2]["edit_policy"], "show_start_and_end");
        assert_eq!(value["framing_beats"][1]["kind"], "zoom_to");
        assert_eq!(value["framing_beats"][1]["easing"], "ease_in_out");

        let parsed: PlanningRow = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.demo_steps, row.demo_steps);
        assert_eq!(parsed.framing_beats, row.framing_beats);
    }

    #[test]
    fn planning_row_without_intent_omits_intent_keys() {
        let value = serde_json::to_value(PlanningRow::new()).unwrap();
        assert!(value.get("demo_steps").is_none());
        assert!(value.get("framing_beats").is_none());
    }
}
