//! Action anchoring: which host instant a logged action "happens" at.
//!
//! The anchor is `visible_at` (the first visibly changed frame, mapped to the
//! host clock) when the analyzer found one, else `dispatched_at` plus a
//! per-kind default latency from a [`LatencyTable`]. `input_effect_at` and
//! `postcondition_at` never set the anchor (the spike measured them up to
//! ~190 ms late for typing); they only bound how long the action stays busy,
//! which keeps the retime planner from cutting an action's own footage.

use super::epoch::EpochFit;
use super::units::{Fps, FrameIndex, Micros};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

/// Outcome of a logged action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ActionStatus {
    Ok,
    Failed { message: String },
}

/// One action as the recorder logged it. All instants are host micros
/// relative to the take epoch `t0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionLog {
    /// Free-form kind used to look up default latency (`click`, `type`, ...).
    pub kind: String,
    pub dispatched_at: Micros,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_effect_at: Option<Micros>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postcondition_at: Option<Micros>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_at: Option<Micros>,
    pub status: ActionStatus,
}

/// Default dispatch → visible latency per action kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyTable {
    pub default_us: Micros,
    #[serde(default)]
    pub by_kind: BTreeMap<String, Micros>,
}

impl Default for LatencyTable {
    /// Rounded-up local-page medians from the calibration spike.
    fn default() -> Self {
        let by_kind = [
            ("navigate", 40),
            ("click", 60),
            ("type", 40),
            ("scroll", 40),
        ]
        .into_iter()
        .map(|(kind, ms)| (kind.to_string(), Micros::from_millis(ms)))
        .collect();
        LatencyTable {
            default_us: Micros::from_millis(60),
            by_kind,
        }
    }
}

impl LatencyTable {
    pub fn latency(&self, kind: &str) -> Micros {
        self.by_kind.get(kind).copied().unwrap_or(self.default_us)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnchorSource {
    /// From the first visibly changed frame.
    Visible,
    /// `dispatched_at` plus the kind's default latency.
    Estimated,
}

/// The instant an action is shown, and how long it stays busy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionAnchor {
    pub host_us: Micros,
    pub source: AnchorSource,
    /// Latest of the anchor, input effect and postcondition.
    pub busy_until_us: Micros,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AnchorError {
    ActionFailed { step_index: usize, message: String },
}

impl fmt::Display for AnchorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AnchorError::ActionFailed {
                step_index,
                message,
            } => write!(f, "step {step_index} failed during the take: {message}"),
        }
    }
}

impl std::error::Error for AnchorError {}

/// Anchors one logged action. Failed actions cannot be anchored.
pub fn anchor_action(
    step_index: usize,
    log: &ActionLog,
    latencies: &LatencyTable,
) -> Result<ActionAnchor, AnchorError> {
    if let ActionStatus::Failed { message } = &log.status {
        return Err(AnchorError::ActionFailed {
            step_index,
            message: message.clone(),
        });
    }
    let (host_us, source) = match log.visible_at {
        Some(visible) => (visible, AnchorSource::Visible),
        None => (
            log.dispatched_at + latencies.latency(&log.kind),
            AnchorSource::Estimated,
        ),
    };
    let busy_until_us = [log.input_effect_at, log.postcondition_at]
        .into_iter()
        .flatten()
        .fold(host_us, Micros::max);
    Ok(ActionAnchor {
        host_us,
        source,
        busy_until_us,
    })
}

/// An anchor placed on the take's source frame grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAnchor {
    pub source_frame: FrameIndex,
    /// Frames from the anchor frame (inclusive) that must play: at least 1.
    pub hold_frames: FrameIndex,
}

/// Maps an anchor to source frames through the epoch fit.
///
/// A visible anchor already names a frame, so it rounds to the nearest frame;
/// an estimated one names an instant, so it takes the first frame at or
/// after it. The busy window ends at the first frame at or after
/// `busy_until_us`.
pub fn source_anchor(anchor: &ActionAnchor, epoch: &EpochFit, fps: Fps) -> SourceAnchor {
    let pts = epoch.host_to_pts(anchor.host_us);
    let source_frame = match anchor.source {
        AnchorSource::Visible => fps.frame_round(pts),
        AnchorSource::Estimated => fps.frame_ceil(pts),
    };
    let busy_end = fps.frame_ceil(epoch.host_to_pts(anchor.busy_until_us));
    SourceAnchor {
        source_frame,
        hold_frames: (busy_end - source_frame).max(1),
    }
}
