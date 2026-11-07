//! EDL validation, independent of how the EDL was built.

use super::edl::{Edl, EdlAnchor, SegmentKind};
use super::units::FrameIndex;
use serde::{Deserialize, Serialize};

/// A broken EDL invariant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EdlViolation {
    /// Segment output ranges must tile `[0, output_frame_count)` in order.
    OutputGap {
        segment_index: usize,
        expected_start: FrameIndex,
        actual_start: FrameIndex,
    },
    OutputLength {
        expected: FrameIndex,
        actual: FrameIndex,
    },
    /// Play/Drop source ranges must continue where the previous one ended.
    SourceDiscontinuity {
        segment_index: usize,
        expected_start: FrameIndex,
        actual_start: FrameIndex,
    },
    /// Play: equal non-empty source and output lengths. Freeze: one source
    /// frame, non-empty output. Drop: non-empty source, empty output.
    BadShape {
        segment_index: usize,
    },
    SourceOutOfRange {
        segment_index: usize,
    },
    /// A freeze must hold the last frame shown before it.
    FreezeNotLastShown {
        segment_index: usize,
    },
    AnchorNotPlayed {
        anchor_index: usize,
    },
    AnchorMisplaced {
        anchor_index: usize,
        target_frame: FrameIndex,
        output_frame: FrameIndex,
    },
}

/// Where an anchor's source frame actually plays in the output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorPlacement {
    pub anchor_index: usize,
    pub step_index: usize,
    pub source_frame: FrameIndex,
    pub target_frame: FrameIndex,
    pub output_frame: FrameIndex,
}

/// Checks continuity, segment shapes, source monotonicity and that every
/// anchor's frame plays exactly on its target frame.
pub fn validate_edl(
    edl: &Edl,
    anchors: &[EdlAnchor],
) -> Result<Vec<AnchorPlacement>, Vec<EdlViolation>> {
    let mut violations = Vec::new();
    let mut output = 0;
    let mut source: Option<FrameIndex> = None;
    let mut last_shown: Option<FrameIndex> = None;

    for (segment_index, segment) in edl.segments.iter().enumerate() {
        if segment.output_start_frame != output {
            violations.push(EdlViolation::OutputGap {
                segment_index,
                expected_start: output,
                actual_start: segment.output_start_frame,
            });
        }
        output = segment.output_end_frame;

        let shape_ok = match segment.kind {
            SegmentKind::Play => {
                segment.source_len() > 0 && segment.source_len() == segment.output_len()
            }
            SegmentKind::Freeze => segment.source_len() == 1 && segment.output_len() > 0,
            SegmentKind::Drop => segment.source_len() > 0 && segment.output_len() == 0,
        };
        if !shape_ok {
            violations.push(EdlViolation::BadShape { segment_index });
        }
        if segment.source_start_frame < 0 || segment.source_end_frame > edl.source_frame_count {
            violations.push(EdlViolation::SourceOutOfRange { segment_index });
        }

        match segment.kind {
            SegmentKind::Play | SegmentKind::Drop => {
                if let Some(expected) = source {
                    if segment.source_start_frame != expected {
                        violations.push(EdlViolation::SourceDiscontinuity {
                            segment_index,
                            expected_start: expected,
                            actual_start: segment.source_start_frame,
                        });
                    }
                }
                source = Some(segment.source_end_frame);
                if segment.kind == SegmentKind::Play {
                    last_shown = Some(segment.source_end_frame - 1);
                }
            }
            SegmentKind::Freeze => {
                if last_shown != Some(segment.source_start_frame) {
                    violations.push(EdlViolation::FreezeNotLastShown { segment_index });
                }
            }
        }
    }
    if output != edl.output_frame_count {
        violations.push(EdlViolation::OutputLength {
            expected: edl.output_frame_count,
            actual: output,
        });
    }

    let mut placements = Vec::with_capacity(anchors.len());
    for (anchor_index, anchor) in anchors.iter().enumerate() {
        let played = edl.segments.iter().find(|s| {
            s.kind == SegmentKind::Play
                && s.source_start_frame <= anchor.source_frame
                && anchor.source_frame < s.source_end_frame
        });
        match played {
            None => violations.push(EdlViolation::AnchorNotPlayed { anchor_index }),
            Some(segment) => {
                let output_frame =
                    segment.output_start_frame + (anchor.source_frame - segment.source_start_frame);
                if output_frame != anchor.target_frame {
                    violations.push(EdlViolation::AnchorMisplaced {
                        anchor_index,
                        target_frame: anchor.target_frame,
                        output_frame,
                    });
                }
                placements.push(AnchorPlacement {
                    anchor_index,
                    step_index: anchor.step_index,
                    source_frame: anchor.source_frame,
                    target_frame: anchor.target_frame,
                    output_frame,
                });
            }
        }
    }

    if violations.is_empty() {
        Ok(placements)
    } else {
        Err(violations)
    }
}
