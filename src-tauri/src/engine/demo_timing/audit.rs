//! Audit: does the rendered media keep each action on its word?
//!
//! The audit reads only *observed* landmarks from the final media (the
//! output frame where each action is first visible, and word times measured
//! on the final audio), so it checks the render rather than re-checking the
//! planner's own arithmetic. For each cue the expected instant is the
//! observed anchor word edge plus the cue offset; the drift is the observed
//! action frame's start time minus that instant.

use super::cues::CueAnchor;
use super::units::{Fps, FrameIndex, Micros};
use serde::{Deserialize, Serialize};

/// What the plan promised for one cued step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditCue {
    pub step_index: usize,
    pub anchor_word_index: usize,
    pub anchor: CueAnchor,
    #[serde(default)]
    pub offset_us: Micros,
}

/// A word as measured on the final audio (output clock).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedWord {
    pub word_index: usize,
    pub start_us: Micros,
    pub end_us: Micros,
}

/// The first output frame where a step's action is visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedAction {
    pub step_index: usize,
    pub output_frame: FrameIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissingLandmark {
    Action,
    Word,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "result",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AuditOutcome {
    Pass,
    Fail,
    Missing { landmark: MissingLandmark },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueAudit {
    pub step_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_us: Option<Micros>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_us: Option<Micros>,
    /// `observed − expected`; positive means the action is late.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drift_us: Option<Micros>,
    pub outcome: AuditOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditReport {
    pub tolerance_us: Micros,
    pub cues: Vec<CueAudit>,
    pub max_abs_drift_us: Micros,
    pub passed: bool,
}

/// Audits every cue. `tolerance_us` defaults to one frame. Missing
/// landmarks fail the report.
pub fn audit(
    fps: Fps,
    cues: &[AuditCue],
    words: &[ObservedWord],
    actions: &[ObservedAction],
    tolerance_us: Option<Micros>,
) -> AuditReport {
    let tolerance_us = tolerance_us.unwrap_or_else(|| fps.frame_duration());
    let mut max_abs_drift_us = Micros::ZERO;
    let results: Vec<CueAudit> = cues
        .iter()
        .map(|cue| {
            let expected_us = words
                .iter()
                .find(|w| w.word_index == cue.anchor_word_index)
                .map(|w| {
                    let edge = match cue.anchor {
                        CueAnchor::WordStart => w.start_us,
                        CueAnchor::WordEnd => w.end_us,
                    };
                    edge + cue.offset_us
                });
            let observed_us = actions
                .iter()
                .find(|a| a.step_index == cue.step_index)
                .map(|a| fps.frame_start(a.output_frame));
            let (drift_us, outcome) = match (expected_us, observed_us) {
                (_, None) => (
                    None,
                    AuditOutcome::Missing {
                        landmark: MissingLandmark::Action,
                    },
                ),
                (None, Some(_)) => (
                    None,
                    AuditOutcome::Missing {
                        landmark: MissingLandmark::Word,
                    },
                ),
                (Some(expected), Some(observed)) => {
                    let drift = observed - expected;
                    if drift.abs() > max_abs_drift_us {
                        max_abs_drift_us = drift.abs();
                    }
                    let outcome = if drift.abs() <= tolerance_us {
                        AuditOutcome::Pass
                    } else {
                        AuditOutcome::Fail
                    };
                    (Some(drift), outcome)
                }
            };
            CueAudit {
                step_index: cue.step_index,
                expected_us,
                observed_us,
                drift_us,
                outcome,
            }
        })
        .collect();
    let passed = results.iter().all(|r| r.outcome == AuditOutcome::Pass);
    AuditReport {
        tolerance_us,
        cues: results,
        max_abs_drift_us,
        passed,
    }
}
