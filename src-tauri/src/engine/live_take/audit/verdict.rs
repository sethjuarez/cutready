//! Per-cue verdicts from independent evidence. Every input here was
//! produced by something other than the planner: the cue word's time comes
//! from a transcript of the final audio, the action's onset from detectors
//! that run on the final video, and the witness from page-side timestamps.
//!
//! `drift = observed onset − expected time`, where the expected time is the
//! corrected transcript time of the cue word plus the cue's offset.
//! Negative drift means the action showed up before its word.

use super::visual::{Locality, VisualEvidence};
use super::witness::WitnessStatus;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Pass,
    Fail,
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictConfig {
    /// Allowed |drift| including the word-time uncertainty, ms.
    pub tolerance_ms: f64,
    /// Max |D1 − D2| onset difference for the detectors to agree, frames.
    pub detector_agree_frames: i64,
}

impl Default for VerdictConfig {
    fn default() -> Self {
        Self {
            tolerance_ms: 80.0,
            detector_agree_frames: 1,
        }
    }
}

/// The inputs a verdict is made from (all times in ms on the final media).
#[derive(Debug, Clone, PartialEq)]
pub struct CueEvidence<'a> {
    /// Expected onset time (corrected word time + offset), with its
    /// uncertainty, or the reason it's unavailable.
    pub expected: Result<(f64, f64), String>,
    pub visual: Option<&'a VisualEvidence>,
    pub window_valid: bool,
    pub witness: WitnessStatus,
    pub frame_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueVerdict {
    pub verdict: Verdict,
    /// Machine-readable reasons, most decisive first.
    pub reasons: Vec<String>,
    pub drift_d1_ms: Option<f64>,
    pub drift_d2_ms: Option<f64>,
}

fn verdict(v: Verdict, reasons: &[&str], d1: Option<f64>, d2: Option<f64>) -> CueVerdict {
    CueVerdict {
        verdict: v,
        reasons: reasons.iter().map(|r| r.to_string()).collect(),
        drift_d1_ms: d1,
        drift_d2_ms: d2,
    }
}

pub fn decide(ev: &CueEvidence, cfg: &VerdictConfig) -> CueVerdict {
    let (expected_ms, u) = match &ev.expected {
        Ok(e) => *e,
        Err(why) => return verdict(Verdict::Uncertain, &[why.as_str()], None, None),
    };
    let Some(vis) = ev.visual else {
        return verdict(Verdict::Uncertain, &["noVideoWindow"], None, None);
    };
    if !ev.window_valid {
        return verdict(Verdict::Uncertain, &["windowTooShort"], None, None);
    }
    if vis.grid.net_cells == 0 {
        return verdict(Verdict::Fail, &["noVisibleChange"], None, None);
    }
    let drift = |f: Option<usize>| f.map(|f| f as f64 * ev.frame_ms - expected_ms);
    let d1 = drift(vis.grid.onset);
    let d2 = if vis.ssim.abstained {
        None
    } else {
        drift(vis.ssim.onset)
    };
    if vis.in_progress_at_start {
        return verdict(
            Verdict::Uncertain,
            &["changeInProgressAtWindowStart"],
            d1,
            d2,
        );
    }
    let Some(d1v) = d1 else {
        return verdict(Verdict::Uncertain, &["noPersistentOnset"], d1, d2);
    };
    let t = cfg.tolerance_ms;
    let beyond = |d: f64| d.abs() - u >= t;
    if beyond(d1v) {
        let reason = if d1v > 0.0 {
            "actionLate"
        } else {
            "actionEarly"
        };
        if vis.locality == Locality::Elsewhere {
            return verdict(
                Verdict::Uncertain,
                &[reason, "changeAwayFromTarget"],
                d1,
                d2,
            );
        }
        return match d2 {
            Some(d2v) if !beyond(d2v) => {
                verdict(Verdict::Uncertain, &[reason, "detectorsDisagree"], d1, d2)
            }
            _ => verdict(Verdict::Fail, &[reason], d1, d2),
        };
    }

    let mut doubts: Vec<&str> = Vec::new();
    if d1v.abs() + u > t {
        doubts.push("driftWithinUncertainty");
    }
    match (vis.grid.onset, vis.ssim.onset, vis.ssim.abstained) {
        (Some(p1), Some(p2), false) => {
            if (p1 as i64 - p2 as i64).abs() > cfg.detector_agree_frames {
                doubts.push("detectorsDisagree");
            }
        }
        // A pass needs both detectors.
        _ => doubts.push("secondDetectorAbstained"),
    }
    match ev.witness {
        WitnessStatus::Agrees | WitnessStatus::NotApplicable => {}
        WitnessStatus::Conflicts => doubts.push("witnessConflicts"),
        WitnessStatus::Loose => doubts.push("witnessClockLoose"),
        WitnessStatus::Absent => doubts.push("witnessAbsent"),
        WitnessStatus::NoEffect => doubts.push("witnessNoEffect"),
    }
    match vis.locality {
        Locality::AtTarget | Locality::Global => {}
        Locality::Elsewhere => doubts.push("changeAwayFromTarget"),
        Locality::Unknown => doubts.push("targetUnknown"),
    }
    if doubts.is_empty() {
        verdict(Verdict::Pass, &[], d1, d2)
    } else {
        verdict(Verdict::Uncertain, &doubts, d1, d2)
    }
}

/// Take verdict: any fail fails; otherwise any uncertain is uncertain. No
/// cues at all is uncertain: nothing was shown to land on its word.
pub fn overall(cues: impl IntoIterator<Item = Verdict>) -> Verdict {
    let mut out = Verdict::Uncertain;
    for (i, v) in cues.into_iter().enumerate() {
        if i == 0 {
            out = Verdict::Pass;
        }
        match v {
            Verdict::Fail => return Verdict::Fail,
            Verdict::Uncertain => out = Verdict::Uncertain,
            Verdict::Pass => {}
        }
    }
    out
}

#[cfg(test)]
#[path = "verdict_tests.rs"]
mod tests;
