//! Retime planner: an edit decision list (EDL) that lands each action on its
//! target output frame.
//!
//! The source take is CFR on the same frame grid as the output. Between two
//! consecutive anchors the planner either:
//!
//! * plays all source frames and **freezes** the frame just before the next
//!   action for the remaining output frames (the action is early), or
//! * **drops** idle source frames (the action is late). Dropped frames come
//!   from the idle stretch between the previous action's busy window
//!   (`hold_frames`) and the next action's pre-roll, and never include an
//!   anchor frame. Before the first anchor, frames are dropped from the start
//!   of the take instead.
//!
//! When dropping cannot recover enough frames, the planner returns an
//! [`Infeasibility`] so the scheduler can push the target later. After the
//! last anchor the tail is played and then frozen or trimmed to the output
//! length, never cutting the last action's busy window.

use super::units::FrameIndex;
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SegmentKind {
    /// Source frames play 1:1.
    Play,
    /// One source frame repeats; `source_end_frame == source_start_frame + 1`.
    Freeze,
    /// Source frames are skipped; output range is empty.
    Drop,
}

/// One edit. Frame ranges are half-open `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub kind: SegmentKind,
    pub source_start_frame: FrameIndex,
    pub source_end_frame: FrameIndex,
    pub output_start_frame: FrameIndex,
    pub output_end_frame: FrameIndex,
}

impl Segment {
    pub fn output_len(&self) -> FrameIndex {
        self.output_end_frame - self.output_start_frame
    }

    pub fn source_len(&self) -> FrameIndex {
        self.source_end_frame - self.source_start_frame
    }
}

/// An action on the source grid with its target output frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdlAnchor {
    pub step_index: usize,
    pub source_frame: FrameIndex,
    /// Frames from the anchor (inclusive) that must play uncut; at least 1.
    pub hold_frames: FrameIndex,
    pub target_frame: FrameIndex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EdlConfig {
    /// Frames right before each action that must play uncut.
    pub pre_roll_frames: FrameIndex,
}

impl Default for EdlConfig {
    fn default() -> Self {
        EdlConfig { pre_roll_frames: 2 }
    }
}

/// Frames from anchor `index` (inclusive) that must play uncut: its own
/// hold, extended while any earlier action is still busy (overlapping
/// actions). At least 1.
pub fn effective_hold_frames(anchors: &[EdlAnchor], index: usize) -> FrameIndex {
    let Some(anchor) = anchors.get(index) else {
        return 0;
    };
    let busy_end = anchors[..=index]
        .iter()
        .map(|a| a.source_frame + a.hold_frames.max(1))
        .max()
        .unwrap_or(anchor.source_frame + 1);
    (busy_end - anchor.source_frame).max(1)
}

/// Footage the planner must keep between anchor `index - 1` (or the start of
/// the take) and anchor `index`, in frames. The scheduler's
/// `min_duration_us` for the previous step must cover this.
pub fn must_play_frames(anchors: &[EdlAnchor], index: usize, config: &EdlConfig) -> FrameIndex {
    let Some(anchor) = anchors.get(index) else {
        return 0;
    };
    let (start, hold) = match index.checked_sub(1).and_then(|i| anchors.get(i)) {
        Some(prev) => (prev.source_frame, effective_hold_frames(anchors, index - 1)),
        None => (0, 0),
    };
    let span = (anchor.source_frame - start).max(0);
    let hold = hold.min(span);
    hold + config.pre_roll_frames.max(0).min(span - hold)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InfeasibilityKind {
    /// The action needs `shortfall_frames` more output frames before it.
    Late { shortfall_frames: FrameIndex },
    /// The output ends `shortfall_frames` frames inside the last action's busy window.
    TailTooShort { shortfall_frames: FrameIndex },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Infeasibility {
    pub anchor_index: usize,
    pub step_index: usize,
    #[serde(flatten)]
    pub kind: InfeasibilityKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EdlError {
    EmptySource,
    EmptyOutput,
    /// Anchors must have strictly increasing source frames inside the take.
    SourceOutOfOrder {
        anchor_index: usize,
    },
    SourceOutOfRange {
        anchor_index: usize,
        source_frame: FrameIndex,
    },
    NegativeTarget {
        anchor_index: usize,
    },
    /// The first action is visible in the first frame, so there is no
    /// pre-action frame to freeze.
    NoPreActionFrame {
        anchor_index: usize,
    },
    /// The take stops before the last action's busy window ends (for
    /// example its postcondition), so that footage does not exist.
    BusyPastEndOfTake {
        anchor_index: usize,
        missing_frames: FrameIndex,
    },
    Infeasible {
        infeasibilities: Vec<Infeasibility>,
    },
}

impl fmt::Display for EdlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EdlError::EmptySource => write!(f, "source take has no frames"),
            EdlError::EmptyOutput => write!(f, "output has no frames"),
            EdlError::SourceOutOfOrder { anchor_index } => {
                write!(
                    f,
                    "anchor {anchor_index} is not after the previous anchor in the take"
                )
            }
            EdlError::SourceOutOfRange {
                anchor_index,
                source_frame,
            } => write!(
                f,
                "anchor {anchor_index} source frame {source_frame} is outside the take"
            ),
            EdlError::NegativeTarget { anchor_index } => {
                write!(f, "anchor {anchor_index} targets a negative frame")
            }
            EdlError::NoPreActionFrame { anchor_index } => {
                write!(f, "anchor {anchor_index} is visible in the first frame")
            }
            EdlError::BusyPastEndOfTake {
                anchor_index,
                missing_frames,
            } => write!(
                f,
                "the take ends {missing_frames} frame(s) before anchor {anchor_index} finishes"
            ),
            EdlError::Infeasible { infeasibilities } => {
                write!(
                    f,
                    "{} anchor(s) cannot reach their target",
                    infeasibilities.len()
                )
            }
        }
    }
}

impl std::error::Error for EdlError {}

/// The full edit: segments cover `[0, output_frame_count)` in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edl {
    pub source_frame_count: FrameIndex,
    pub output_frame_count: FrameIndex,
    pub segments: Vec<Segment>,
}

struct Builder {
    segments: Vec<Segment>,
    output: FrameIndex,
}

impl Builder {
    fn push(
        &mut self,
        kind: SegmentKind,
        source_start: FrameIndex,
        source_end: FrameIndex,
        out_len: FrameIndex,
    ) {
        let empty = match kind {
            SegmentKind::Play | SegmentKind::Drop => source_end <= source_start,
            SegmentKind::Freeze => out_len <= 0,
        };
        if empty {
            return;
        }
        let output_end = self.output + out_len;
        if let Some(last) = self.segments.last_mut() {
            let contiguous =
                last.source_end_frame == source_start && last.output_end_frame == self.output;
            if last.kind == kind && kind != SegmentKind::Freeze && contiguous {
                last.source_end_frame = source_end;
                last.output_end_frame = output_end;
                self.output = output_end;
                return;
            }
        }
        self.segments.push(Segment {
            kind,
            source_start_frame: source_start,
            source_end_frame: source_end,
            output_start_frame: self.output,
            output_end_frame: output_end,
        });
        self.output = output_end;
    }

    fn play(&mut self, start: FrameIndex, end: FrameIndex) {
        self.push(SegmentKind::Play, start, end, end - start);
    }

    fn drop_frames(&mut self, start: FrameIndex, end: FrameIndex) {
        self.push(SegmentKind::Drop, start, end, 0);
    }

    fn freeze(&mut self, frame: FrameIndex, count: FrameIndex) {
        self.push(SegmentKind::Freeze, frame, frame + 1, count);
    }
}

/// Builds the EDL. Anchors are in step order.
pub fn plan_edl(
    anchors: &[EdlAnchor],
    source_frame_count: FrameIndex,
    output_frame_count: FrameIndex,
    config: &EdlConfig,
) -> Result<Edl, EdlError> {
    if source_frame_count <= 0 {
        return Err(EdlError::EmptySource);
    }
    if output_frame_count <= 0 {
        return Err(EdlError::EmptyOutput);
    }
    for (index, anchor) in anchors.iter().enumerate() {
        if anchor.source_frame < 0 || anchor.source_frame >= source_frame_count {
            return Err(EdlError::SourceOutOfRange {
                anchor_index: index,
                source_frame: anchor.source_frame,
            });
        }
        if index > 0 && anchor.source_frame <= anchors[index - 1].source_frame {
            return Err(EdlError::SourceOutOfOrder {
                anchor_index: index,
            });
        }
        if anchor.target_frame < 0 {
            return Err(EdlError::NegativeTarget {
                anchor_index: index,
            });
        }
    }
    if let Some(last) = anchors.len().checked_sub(1) {
        let busy_end = anchors[last].source_frame + effective_hold_frames(anchors, last);
        if busy_end > source_frame_count {
            return Err(EdlError::BusyPastEndOfTake {
                anchor_index: last,
                missing_frames: busy_end - source_frame_count,
            });
        }
    }

    let mut infeasibilities = Vec::new();
    let mut builder = Builder {
        segments: Vec::new(),
        output: 0,
    };

    let mut source_cursor = 0;
    let mut output_cursor = 0;
    for (index, anchor) in anchors.iter().enumerate() {
        let span = anchor.source_frame - source_cursor;
        let available = anchor.target_frame - output_cursor;
        let must = must_play_frames(anchors, index, config);
        let hold = if index == 0 {
            0
        } else {
            effective_hold_frames(anchors, index - 1).min(span)
        };
        let tail_keep = must - hold;

        if available >= span {
            if span == 0 && available > 0 {
                return Err(EdlError::NoPreActionFrame {
                    anchor_index: index,
                });
            }
            builder.play(source_cursor, anchor.source_frame);
            builder.freeze(anchor.source_frame - 1, available - span);
        } else {
            let drop = span - available;
            let droppable = span - must;
            if drop > droppable {
                infeasibilities.push(Infeasibility {
                    anchor_index: index,
                    step_index: anchor.step_index,
                    kind: InfeasibilityKind::Late {
                        shortfall_frames: drop - droppable,
                    },
                });
            } else if index == 0 {
                builder.drop_frames(0, drop);
                builder.play(drop, anchor.source_frame);
            } else {
                let drop_end = anchor.source_frame - tail_keep;
                builder.play(source_cursor, drop_end - drop);
                builder.drop_frames(drop_end - drop, drop_end);
                builder.play(drop_end, anchor.source_frame);
            }
        }
        source_cursor = anchor.source_frame;
        output_cursor = anchor.target_frame;
    }

    let span = source_frame_count - source_cursor;
    let available = output_frame_count - output_cursor;
    let hold = anchors
        .len()
        .checked_sub(1)
        .map_or(0, |last| effective_hold_frames(anchors, last));
    if available < hold {
        infeasibilities.push(Infeasibility {
            anchor_index: anchors.len().saturating_sub(1),
            step_index: anchors.last().map_or(0, |a| a.step_index),
            kind: InfeasibilityKind::TailTooShort {
                shortfall_frames: hold - available,
            },
        });
    } else if available > 0 {
        let played = span.min(available);
        builder.play(source_cursor, source_cursor + played);
        builder.freeze(source_cursor + played - 1, available - played);
    }

    if !infeasibilities.is_empty() {
        return Err(EdlError::Infeasible { infeasibilities });
    }
    Ok(Edl {
        source_frame_count,
        output_frame_count,
        segments: builder.segments,
    })
}
