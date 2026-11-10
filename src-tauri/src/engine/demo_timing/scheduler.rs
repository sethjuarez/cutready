//! Scheduler: a target output time for every step.
//!
//! Cued steps target their cue instant (rounded to the nearest frame). Steps
//! without a cue follow the previous step by its required duration. Each step
//! needs `max(min_gap_us, min_duration_us)` (rounded up to whole frames)
//! before the next step's action may appear. When a cue comes too early for
//! that, the schedule records an [`InsertSilence`] constraint at the best
//! pause point between the previous cue's phrase and this cue's phrase:
//! the latest sentence boundary, else the latest clause boundary, else the
//! start of the narration (when no earlier cue exists), else just before the
//! cue phrase. [`schedule_to_fixpoint`] applies constraints with
//! [`apply_silence`] and reschedules until none remain.

use super::cues::{resolve_cues, Cue, CueMatch, CueResolutionError};
use super::text::BoundaryClass;
use super::units::{Fps, FrameIndex, Micros};
use super::words::{
    apply_silence, boundary_after, merge_insertions, total_silence, InsertSilence, WordTiming,
};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleConfig {
    /// Minimum output time between consecutive actions.
    pub min_gap_us: Micros,
    /// Earliest output time for the first step.
    pub lead_in_us: Micros,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        ScheduleConfig {
            min_gap_us: Micros::from_millis(250),
            lead_in_us: Micros::ZERO,
        }
    }
}

/// One step to schedule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepSpec {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cue: Option<Cue>,
    /// Output time this step's footage needs before the next action
    /// (from the take: its busy window plus the next step's pre-roll).
    #[serde(default)]
    pub min_duration_us: Micros,
}

/// Everything the scheduler reads. Narration words are on the audio clock.
#[derive(Debug, Clone, Copy)]
pub struct ScheduleInput<'a> {
    pub words: &'a [WordTiming],
    /// Plain narration text that `WordTiming::text_offset` indexes.
    pub narration: &'a str,
    /// Length of the narration audio, including trailing silence.
    pub narration_duration_us: Micros,
    pub steps: &'a [StepSpec],
    pub fps: Fps,
    pub config: &'a ScheduleConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledStep {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cue: Option<CueMatch>,
    /// Exact target instant on the output clock.
    pub target_us: Micros,
    /// Output frame the action must land on.
    pub target_frame: FrameIndex,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub steps: Vec<ScheduledStep>,
    /// Empty when the schedule is feasible.
    pub constraints: Vec<InsertSilence>,
    /// Narration length, or the end of the last step's footage if later.
    pub output_duration_us: Micros,
}

fn need_frames(step: &StepSpec, fps: Fps, min_gap: Micros) -> FrameIndex {
    let need = if step.min_duration_us > min_gap {
        step.min_duration_us
    } else {
        min_gap
    };
    fps.frame_ceil(need).max(1)
}

/// Picks where to insert silence so the cue starting at `cue_first_word`
/// moves later without moving the previous cue (whose phrase ends at
/// `previous_last_word`).
fn silence_point(
    narration: &[char],
    words: &[WordTiming],
    previous_last_word: Option<usize>,
    cue_first_word: usize,
) -> Option<usize> {
    let hi = cue_first_word.checked_sub(1)?;
    let lo = previous_last_word.unwrap_or(0);
    for class in [BoundaryClass::Sentence, BoundaryClass::Clause] {
        if let Some(w) = (lo..=hi)
            .rev()
            .find(|&w| boundary_after(narration, words, w) == class)
        {
            return Some(w);
        }
    }
    if previous_last_word.is_none() {
        None
    } else {
        Some(hi)
    }
}

/// Schedules every step once. Constraints describe the silence needed.
pub fn schedule(input: &ScheduleInput<'_>) -> Result<Schedule, CueResolutionError> {
    let cues: Vec<Option<&Cue>> = input.steps.iter().map(|s| s.cue.as_ref()).collect();
    let matches = resolve_cues(input.words, &cues)?;
    let narration: Vec<char> = input.narration.chars().collect();
    let fps = input.fps;
    let min_gap = input.config.min_gap_us;

    let mut steps = Vec::with_capacity(input.steps.len());
    let mut constraints = Vec::new();
    let mut previous: Option<(FrameIndex, FrameIndex)> = None;
    let mut previous_cue_last_word: Option<usize> = None;

    for (spec, cue) in input.steps.iter().zip(matches) {
        let earliest = match previous {
            None => fps.frame_ceil(input.config.lead_in_us),
            Some((frame, need)) => frame + need,
        };
        let (target_us, target_frame) = match &cue {
            Some(found) => {
                let frame = fps.frame_round(found.target_us);
                if frame < earliest {
                    constraints.push(InsertSilence {
                        after_word_index: silence_point(
                            &narration,
                            input.words,
                            previous_cue_last_word,
                            found.first_word,
                        ),
                        required_us: fps.frames_to_micros(earliest - frame),
                    });
                }
                previous_cue_last_word = Some(found.last_word);
                (found.target_us, frame)
            }
            None => (fps.frame_start(earliest), earliest),
        };
        previous = Some((target_frame, need_frames(spec, fps, min_gap)));
        steps.push(ScheduledStep {
            id: spec.id.clone(),
            cue,
            target_us,
            target_frame,
        });
    }

    let footage_end = match (input.steps.last(), steps.last()) {
        (Some(spec), Some(last)) => {
            fps.frame_start(last.target_frame + fps.frame_ceil(spec.min_duration_us).max(1))
        }
        _ => Micros::ZERO,
    };
    let output_duration_us = if footage_end > input.narration_duration_us {
        footage_end
    } else {
        input.narration_duration_us
    };

    Ok(Schedule {
        steps,
        constraints,
        output_duration_us,
    })
}

/// Silence that moves step `step_index`'s cue `required_us` later, for
/// infeasibilities found after scheduling (by the retime planner). `None`
/// when the step has no cue: its timing follows the previous step, so only
/// a larger `min_duration_us` can move it.
pub fn silence_for_step(
    input: &ScheduleInput<'_>,
    schedule: &Schedule,
    step_index: usize,
    required_us: Micros,
) -> Option<InsertSilence> {
    let cue = schedule.steps.get(step_index)?.cue?;
    let previous_last_word = schedule.steps[..step_index]
        .iter()
        .rev()
        .find_map(|s| s.cue.map(|c| c.last_word));
    let narration: Vec<char> = input.narration.chars().collect();
    Some(InsertSilence {
        after_word_index: silence_point(
            &narration,
            input.words,
            previous_last_word,
            cue.first_word,
        ),
        required_us,
    })
}

/// A feasible schedule and the narration it needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixpointResult {
    pub schedule: Schedule,
    /// Narration words after every insertion.
    pub words: Vec<WordTiming>,
    /// Cumulative insertions against the original words (merged).
    pub insertions: Vec<InsertSilence>,
    pub narration_duration_us: Micros,
    pub iterations: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ScheduleError {
    Cues(CueResolutionError),
    NotConverged {
        iterations: u32,
        remaining: Vec<InsertSilence>,
    },
}

impl fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ScheduleError::Cues(error) => error.fmt(f),
            ScheduleError::NotConverged {
                iterations,
                remaining,
            } => write!(
                f,
                "schedule still needs {} silence insertion(s) after {iterations} iterations",
                remaining.len()
            ),
        }
    }
}

impl std::error::Error for ScheduleError {}

impl From<CueResolutionError> for ScheduleError {
    fn from(error: CueResolutionError) -> Self {
        ScheduleError::Cues(error)
    }
}

/// Inserts silence and reschedules until no constraint remains, at most
/// `max_iterations` times. `initial` insertions (for example from the retime
/// planner) are applied first. Insertions always refer to the original
/// words, so iterating never compounds rounding.
pub fn schedule_to_fixpoint(
    input: &ScheduleInput<'_>,
    initial: &[InsertSilence],
    max_iterations: u32,
) -> Result<FixpointResult, ScheduleError> {
    let mut insertions = merge_insertions(initial);
    let mut remaining = Vec::new();
    for iteration in 1..=max_iterations.max(1) {
        let words = apply_silence(input.words, &insertions);
        let narration_duration_us = input.narration_duration_us + total_silence(&insertions);
        let shifted = ScheduleInput {
            words: &words,
            narration_duration_us,
            ..*input
        };
        let schedule = schedule(&shifted)?;
        if schedule.constraints.is_empty() {
            return Ok(FixpointResult {
                schedule,
                words,
                insertions,
                narration_duration_us,
                iterations: iteration,
            });
        }
        remaining.clone_from(&schedule.constraints);
        insertions.extend(schedule.constraints);
        insertions = merge_insertions(&insertions);
    }
    Err(ScheduleError::NotConverged {
        iterations: max_iterations.max(1),
        remaining,
    })
}
