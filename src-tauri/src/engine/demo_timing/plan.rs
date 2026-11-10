//! End-to-end planner and the versioned plan contract.

use super::actions::{
    anchor_action, source_anchor, ActionAnchor, ActionLog, AnchorError, LatencyTable,
};
use super::audit::AuditCue;
use super::cues::{Cue, CueMatch};
use super::edl::{
    effective_hold_frames, must_play_frames, plan_edl, Edl, EdlAnchor, EdlConfig, EdlError,
    InfeasibilityKind, Segment,
};
use super::edl_validate::{validate_edl, EdlViolation};
use super::epoch::{fit_epoch, EpochConfig, EpochError, EpochFit, MarkerPair};
use super::scheduler::{
    schedule_to_fixpoint, silence_for_step, ScheduleConfig, ScheduleError, ScheduleInput, StepSpec,
};
use super::units::{Fps, FrameIndex, Micros};
use super::words::{silence_splices, InsertSilence, SilenceSplice, WordTiming};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Schema tag of [`DemoTimingPlan`]. Bump on any breaking contract change.
pub const DEMO_TIMING_SCHEMA_V1: &str = "cutready.demo-timing.v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanConfig {
    pub schedule: ScheduleConfig,
    pub edl: EdlConfig,
    pub epoch: EpochConfig,
    pub latency: LatencyTable,
    /// Bound on scheduler and planner iterations.
    pub max_iterations: u32,
}

impl Default for PlanConfig {
    fn default() -> Self {
        PlanConfig {
            schedule: ScheduleConfig::default(),
            edl: EdlConfig::default(),
            epoch: EpochConfig::default(),
            latency: LatencyTable::default(),
            max_iterations: 8,
        }
    }
}

/// One recorded step: its cue (if any) and what the recorder logged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepInput {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cue: Option<Cue>,
    pub action: ActionLog,
}

/// Everything the planner needs from one narration and one take.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    /// Plain narration text that word `textOffset`s index.
    pub narration: String,
    pub words: Vec<WordTiming>,
    pub narration_duration_us: Micros,
    pub steps: Vec<PlanStepInput>,
    pub markers: Vec<MarkerPair>,
    pub source_frame_count: FrameIndex,
    pub fps: Fps,
    #[serde(default)]
    pub config: PlanConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedStep {
    pub id: String,
    pub anchor: ActionAnchor,
    pub source_frame: FrameIndex,
    pub hold_frames: FrameIndex,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cue: Option<CueMatch>,
    /// Exact target on the output clock (after inserted silence).
    pub target_us: Micros,
    pub target_frame: FrameIndex,
    /// Output frame where the anchor frame plays (equals `target_frame`).
    pub output_frame: FrameIndex,
    /// `frame_start(output_frame) − target_us`; within ±½ frame.
    pub quantization_error_us: Micros,
}

/// The versioned timing contract for one rendered demo.
///
/// The output clock starts at output frame 0 with the (silence-spliced)
/// narration audio, so `words` and step targets share one clock.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoTimingPlan {
    pub schema: String,
    pub fps: Fps,
    pub epoch: EpochFit,
    /// Narration words on the output clock, after inserted silence.
    pub words: Vec<WordTiming>,
    /// Silence to splice into the original narration audio.
    pub silences: Vec<SilenceSplice>,
    pub narration_duration_us: Micros,
    pub steps: Vec<PlannedStep>,
    pub source_frame_count: FrameIndex,
    pub output_frame_count: FrameIndex,
    pub segments: Vec<Segment>,
}

impl DemoTimingPlan {
    pub fn is_supported_schema(&self) -> bool {
        self.schema == DEMO_TIMING_SCHEMA_V1
    }

    pub fn edl(&self) -> Edl {
        Edl {
            source_frame_count: self.source_frame_count,
            output_frame_count: self.output_frame_count,
            segments: self.segments.clone(),
        }
    }

    /// Cues to hand to [`super::audit::audit`] with observed landmarks.
    pub fn audit_cues(&self, inputs: &[PlanStepInput]) -> Vec<AuditCue> {
        self.steps
            .iter()
            .zip(inputs)
            .enumerate()
            .filter_map(|(step_index, (planned, input))| {
                let found = planned.cue?;
                let cue = input.cue.as_ref()?;
                Some(AuditCue {
                    step_index,
                    anchor_word_index: found.anchor_word,
                    anchor: cue.anchor,
                    offset_us: cue.offset_us,
                })
            })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "detail",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PlanError {
    Epoch(EpochError),
    Anchor(AnchorError),
    Schedule(ScheduleError),
    Edl(EdlError),
    /// A step without a cue cannot be moved by silence.
    UncuedStepLate {
        step_index: usize,
        shortfall_frames: FrameIndex,
    },
    /// The planner produced an EDL that breaks an invariant (a bug).
    InvalidEdl(Vec<EdlViolation>),
    NotConverged {
        iterations: u32,
    },
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlanError::Epoch(e) => e.fmt(f),
            PlanError::Anchor(e) => e.fmt(f),
            PlanError::Schedule(e) => e.fmt(f),
            PlanError::Edl(e) => e.fmt(f),
            PlanError::UncuedStepLate {
                step_index,
                shortfall_frames,
            } => write!(
                f,
                "step {step_index} has no cue and needs {shortfall_frames} more frame(s)"
            ),
            PlanError::InvalidEdl(v) => write!(f, "planned EDL breaks {} invariant(s)", v.len()),
            PlanError::NotConverged { iterations } => {
                write!(f, "plan did not converge after {iterations} iterations")
            }
        }
    }
}

impl std::error::Error for PlanError {}

/// Calibrates the take, anchors actions, schedules against the narration
/// (inserting silence as needed) and builds a validated EDL.
pub fn plan_demo_timing(input: &PlanInput) -> Result<DemoTimingPlan, PlanError> {
    let fps = input.fps;
    let config = &input.config;
    let epoch = fit_epoch(&input.markers, fps, &config.epoch).map_err(PlanError::Epoch)?;

    let mut anchors = Vec::with_capacity(input.steps.len());
    let mut edl_anchors = Vec::with_capacity(input.steps.len());
    for (step_index, step) in input.steps.iter().enumerate() {
        let anchor =
            anchor_action(step_index, &step.action, &config.latency).map_err(PlanError::Anchor)?;
        let source = source_anchor(&anchor, &epoch, fps);
        anchors.push(anchor);
        edl_anchors.push(EdlAnchor {
            step_index,
            source_frame: source.source_frame,
            hold_frames: source.hold_frames,
            target_frame: 0,
        });
    }

    let specs: Vec<StepSpec> = input
        .steps
        .iter()
        .enumerate()
        .map(|(i, step)| {
            let frames = if i + 1 < edl_anchors.len() {
                must_play_frames(&edl_anchors, i + 1, &config.edl)
            } else {
                effective_hold_frames(&edl_anchors, i)
            };
            StepSpec {
                id: step.id.clone(),
                cue: step.cue.clone(),
                min_duration_us: fps.frames_to_micros(frames),
            }
        })
        .collect();
    let head = fps.frames_to_micros(must_play_frames(&edl_anchors, 0, &config.edl));
    let schedule_config = ScheduleConfig {
        lead_in_us: if head > config.schedule.lead_in_us {
            head
        } else {
            config.schedule.lead_in_us
        },
        ..config.schedule
    };
    let schedule_input = ScheduleInput {
        words: &input.words,
        narration: &input.narration,
        narration_duration_us: input.narration_duration_us,
        steps: &specs,
        fps,
        config: &schedule_config,
    };

    let mut extra: Vec<InsertSilence> = Vec::new();
    let iterations = config.max_iterations.max(1);
    for _ in 0..iterations {
        let fixed = schedule_to_fixpoint(&schedule_input, &extra, iterations)
            .map_err(PlanError::Schedule)?;
        let output_frame_count = fps.frame_ceil(fixed.schedule.output_duration_us).max(1);
        for (edl_anchor, step) in edl_anchors.iter_mut().zip(&fixed.schedule.steps) {
            edl_anchor.target_frame = step.target_frame;
        }

        let edl = match plan_edl(
            &edl_anchors,
            input.source_frame_count,
            output_frame_count,
            &config.edl,
        ) {
            Ok(edl) => edl,
            Err(EdlError::Infeasible { infeasibilities }) => {
                // Silence moves a late cue; it cannot lengthen the tail
                // (target and output end move together), and the schedule
                // already sizes the output to the last step's footage.
                let mut late = Vec::with_capacity(infeasibilities.len());
                for infeasible in &infeasibilities {
                    match infeasible.kind {
                        InfeasibilityKind::Late { shortfall_frames } => {
                            late.push((infeasible.step_index, shortfall_frames))
                        }
                        InfeasibilityKind::TailTooShort { .. } => {
                            return Err(PlanError::Edl(EdlError::Infeasible {
                                infeasibilities: infeasibilities.clone(),
                            }))
                        }
                    }
                }
                extra = fixed.insertions;
                for (step_index, shortfall_frames) in late {
                    let insertion = silence_for_step(
                        &schedule_input,
                        &fixed.schedule,
                        step_index,
                        fps.frames_to_micros(shortfall_frames),
                    )
                    .ok_or(PlanError::UncuedStepLate {
                        step_index,
                        shortfall_frames,
                    })?;
                    extra.push(insertion);
                }
                continue;
            }
            Err(error) => return Err(PlanError::Edl(error)),
        };
        let placements = validate_edl(&edl, &edl_anchors).map_err(PlanError::InvalidEdl)?;

        let steps = fixed
            .schedule
            .steps
            .iter()
            .zip(&anchors)
            .zip(&edl_anchors)
            .zip(&placements)
            .map(
                |(((scheduled, anchor), edl_anchor), placement)| PlannedStep {
                    id: scheduled.id.clone(),
                    anchor: *anchor,
                    source_frame: edl_anchor.source_frame,
                    hold_frames: edl_anchor.hold_frames,
                    cue: scheduled.cue,
                    target_us: scheduled.target_us,
                    target_frame: scheduled.target_frame,
                    output_frame: placement.output_frame,
                    quantization_error_us: fps.frame_start(placement.output_frame)
                        - scheduled.target_us,
                },
            )
            .collect();

        return Ok(DemoTimingPlan {
            schema: DEMO_TIMING_SCHEMA_V1.to_string(),
            fps,
            epoch,
            silences: silence_splices(&input.words, &fixed.insertions),
            words: fixed.words,
            narration_duration_us: fixed.narration_duration_us,
            steps,
            source_frame_count: input.source_frame_count,
            output_frame_count,
            segments: edl.segments,
        });
    }
    Err(PlanError::NotConverged { iterations })
}
