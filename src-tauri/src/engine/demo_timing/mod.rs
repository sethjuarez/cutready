//! Pure timing core for the live video recorder.
//!
//! This module turns a narration (with word timings) and one recorded take
//! (an action log plus calibration markers) into a [`DemoTimingPlan`]: a
//! target output frame per step and a frame-exact edit decision list that
//! lands every action on its cue word. It has no IO and depends only on
//! `std` and `serde`, so it can move to `scenecast-core` unchanged; callers
//! adapt their own action and selector types at the boundary.
//!
//! # Contract
//!
//! * **Units.** Host instants and word times are integer [`Micros`] relative
//!   to the take epoch `t0`. Edit decisions are integer frame indices on a
//!   rational [`Fps`] grid (25/1 for Playwright `recordVideo`). No float
//!   times appear in any serialized type.
//! * **Epoch.** `video_pts = offset + host · (1 + drift)`, fitted per take by
//!   [`fit_epoch`] (see [`epoch`] for exclusion and failure rules).
//! * **Anchors.** An action happens at its first visibly changed frame, else
//!   at dispatch plus a per-kind default latency ([`anchor_action`]).
//!   Input-effect and postcondition instants are audit-only for anchoring;
//!   they only bound the action's busy window.
//! * **Cues.** A step's [`Cue`] names a phrase, an occurrence counted after
//!   the previous cued step's match, a word edge and an offset
//!   ([`resolve_cues`]).
//! * **Schedule.** [`schedule`] gives each step a target frame and, when a
//!   step cannot fit before the next cue, [`InsertSilence`] constraints.
//!   [`schedule_to_fixpoint`] applies them with [`apply_silence`].
//! * **Retime.** [`plan_edl`] freezes or drops idle source frames so every
//!   anchor frame plays exactly on `round(target · fps)`; [`validate_edl`]
//!   checks the result independently.
//! * **Audit.** [`audit`] compares observed landmarks in the final media
//!   against the cues, with a one-frame default tolerance.
//! * **Version.** [`DemoTimingPlan::schema`] is [`DEMO_TIMING_SCHEMA_V1`];
//!   serialized names are camelCase.
//!
//! The output clock starts at output frame 0 together with the narration
//! audio (after silence splicing); add leading silence for an audio lead.

// Not wired into the recorder yet; the public API is the contract.
#![allow(dead_code, unused_imports)]

pub mod actions;
pub mod audit;
pub mod cues;
pub mod edl;
pub mod edl_validate;
pub mod epoch;
pub mod plan;
pub mod scheduler;
pub mod text;
pub mod units;
pub mod words;

pub use actions::{
    anchor_action, source_anchor, ActionAnchor, ActionLog, ActionStatus, AnchorError, AnchorSource,
    LatencyTable, SourceAnchor,
};
pub use audit::{
    audit, AuditCue, AuditOutcome, AuditReport, CueAudit, MissingLandmark, ObservedAction,
    ObservedWord,
};
pub use cues::{
    resolve_cues, CandidateKind, Cue, CueAnchor, CueCandidate, CueError, CueMatch,
    CueResolutionError,
};
pub use edl::{
    effective_hold_frames, must_play_frames, plan_edl, Edl, EdlAnchor, EdlConfig, EdlError,
    Infeasibility, InfeasibilityKind, Segment, SegmentKind,
};
pub use edl_validate::{validate_edl, AnchorPlacement, EdlViolation};
pub use epoch::{
    fit_epoch, EpochConfig, EpochError, EpochFit, ExcludedMarker, ExclusionReason, FitMethod,
    MarkerPair,
};
pub use plan::{
    plan_demo_timing, DemoTimingPlan, PlanConfig, PlanError, PlanInput, PlanStepInput, PlannedStep,
    DEMO_TIMING_SCHEMA_V1,
};
pub use scheduler::{
    schedule, schedule_to_fixpoint, silence_for_step, FixpointResult, Schedule, ScheduleConfig,
    ScheduleError, ScheduleInput, ScheduledStep, StepSpec,
};
pub use text::normalize_token;
pub use units::{Fps, FrameIndex, Micros};
pub use words::{
    apply_silence, merge_insertions, silence_splices, total_silence, InsertSilence, SilenceSplice,
    WordSource, WordTiming,
};

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod audit_tests;
#[cfg(test)]
mod cues_tests;
#[cfg(test)]
mod edl_tests;
#[cfg(test)]
mod epoch_tests;
#[cfg(test)]
mod plan_tests;
#[cfg(test)]
mod scheduler_tests;
#[cfg(test)]
mod text_tests;
#[cfg(test)]
mod units_tests;
