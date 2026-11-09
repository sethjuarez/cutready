//! Planning for rasterized frame sequences produced by Elucim export.
//!
//! Elucim emits a manifest of frame entries with a path, duration, and explicit
//! terminal marker. CutReady owns dwell: the gesture plays at its authored pace,
//! then the terminal frame holds for the rest of the row.

use std::path::PathBuf;

/// One entry of an Elucim frame manifest.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameManifestEntry {
    pub path: PathBuf,
    /// Milliseconds until the next frame. The terminal entry carries `0`.
    pub duration_ms: i64,
    /// Set on the final frame of the gesture, and only there.
    pub terminal: bool,
}

/// A frame that survived planning, with the duration it should actually be shown for.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedFrame {
    pub path: PathBuf,
    pub duration_seconds: f64,
}

/// How the authored gesture related to the row it had to fit inside.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FrameSequenceFit {
    /// The gesture exactly filled the row.
    Exact,
    /// The gesture finished early and the final frame held for the remainder.
    Held { hold_seconds: f64 },
    /// The row was shorter than the gesture; trailing frames never appear.
    Truncated {
        dropped_frames: usize,
        lost_seconds: f64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrameSequencePlan {
    pub frames: Vec<PlannedFrame>,
    /// Always equal to the requested row duration.
    pub total_seconds: f64,
    pub fit: FrameSequenceFit,
}

fn minimum_frame_seconds(fps: u32) -> f64 {
    if fps == 0 {
        return 0.0;
    }
    1.0 / f64::from(fps)
}

/// Merge gesture entries shorter than one output frame into their neighbours
/// so every shown frame lasts at least `minimum` seconds while the gesture
/// keeps its authored total. A merged group shows its latest frame, so a
/// zero-duration entry is superseded rather than stretched.
fn coalesce_gesture(entries: &[FrameManifestEntry], minimum: f64) -> Vec<PlannedFrame> {
    let mut steps: Vec<PlannedFrame> = Vec::new();
    for entry in entries {
        let seconds = entry.duration_ms.max(0) as f64 / 1000.0;
        match steps.last_mut() {
            Some(last) if last.duration_seconds < minimum => {
                last.path = entry.path.clone();
                last.duration_seconds += seconds;
            }
            _ => steps.push(PlannedFrame {
                path: entry.path.clone(),
                duration_seconds: seconds,
            }),
        }
    }
    steps.retain(|step| step.duration_seconds > 0.0);
    steps
}

/// Fit an Elucim frame manifest into a row of `row_duration_seconds`.
///
/// The terminal entry's authored duration is ignored because it is a delta to a
/// frame that does not exist. The terminal frame absorbs remaining row dwell.
pub fn plan_frame_sequence(
    manifest: &[FrameManifestEntry],
    row_duration_seconds: f64,
    fps: u32,
) -> anyhow::Result<FrameSequencePlan> {
    if manifest.is_empty() {
        anyhow::bail!("Frame manifest is empty");
    }
    if !row_duration_seconds.is_finite() || row_duration_seconds <= 0.0 {
        anyhow::bail!(
            "Row duration must be a positive number of seconds, got {row_duration_seconds}"
        );
    }

    let last_index = manifest.len() - 1;
    let marked: Vec<usize> = manifest
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.terminal)
        .map(|(index, _)| index)
        .collect();
    match marked.as_slice() {
        [] => anyhow::bail!(
            "Frame manifest has no entry marked terminal, so it may be truncated ({} frames)",
            manifest.len()
        ),
        [index] if *index != last_index => anyhow::bail!(
            "Frame manifest marks entry {index} terminal but has {} entries; frames after the terminal frame are unreachable",
            manifest.len()
        ),
        [_] => {}
        _ => anyhow::bail!(
            "Frame manifest marks {} entries terminal; exactly one is allowed",
            marked.len()
        ),
    }

    let steps = coalesce_gesture(&manifest[..last_index], minimum_frame_seconds(fps));
    let gesture_seconds: f64 = steps.iter().map(|step| step.duration_seconds).sum();

    if gesture_seconds > row_duration_seconds {
        let mut frames = Vec::new();
        let mut spent = 0.0;
        for step in &steps {
            if spent >= row_duration_seconds {
                break;
            }
            let shown = step.duration_seconds.min(row_duration_seconds - spent);
            frames.push(PlannedFrame {
                path: step.path.clone(),
                duration_seconds: shown,
            });
            spent += shown;
        }

        let dropped_frames = steps.len() + 1 - frames.len();
        return Ok(FrameSequencePlan {
            frames,
            total_seconds: row_duration_seconds,
            fit: FrameSequenceFit::Truncated {
                dropped_frames,
                lost_seconds: gesture_seconds - row_duration_seconds,
            },
        });
    }

    let hold_seconds = row_duration_seconds - gesture_seconds;
    let mut frames = steps;
    frames.push(PlannedFrame {
        path: manifest[last_index].path.clone(),
        duration_seconds: hold_seconds,
    });

    Ok(FrameSequencePlan {
        frames,
        total_seconds: row_duration_seconds,
        fit: if hold_seconds <= f64::EPSILON {
            FrameSequenceFit::Exact
        } else {
            FrameSequenceFit::Held { hold_seconds }
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(durations: &[i64]) -> Vec<FrameManifestEntry> {
        let last = durations.len().saturating_sub(1);
        durations
            .iter()
            .enumerate()
            .map(|(index, duration_ms)| FrameManifestEntry {
                path: PathBuf::from(format!("frame-{index:03}.png")),
                duration_ms: *duration_ms,
                terminal: index == last,
            })
            .collect()
    }

    #[test]
    fn missing_terminal_marker_is_rejected_as_truncated() {
        let mut truncated = manifest(&[500, 500, 0]);
        truncated.pop();
        for entry in &mut truncated {
            entry.terminal = false;
        }

        assert!(plan_frame_sequence(&truncated, 3.0, 60)
            .unwrap_err()
            .to_string()
            .contains("truncated"));
    }

    #[test]
    fn frames_after_terminal_frame_are_rejected() {
        let mut manifest = manifest(&[500, 500, 0]);
        manifest[0].terminal = true;
        manifest[2].terminal = false;

        assert!(plan_frame_sequence(&manifest, 3.0, 60)
            .unwrap_err()
            .to_string()
            .contains("unreachable"));
    }

    #[test]
    fn more_than_one_terminal_marker_is_rejected() {
        let mut manifest = manifest(&[500, 500, 0]);
        manifest[1].terminal = true;

        assert!(plan_frame_sequence(&manifest, 3.0, 60)
            .unwrap_err()
            .to_string()
            .contains("exactly one"));
    }

    #[test]
    fn terminal_zero_duration_entry_absorbs_the_rest_of_the_row() {
        let plan = plan_frame_sequence(&manifest(&[500, 500, 0]), 3.0, 60).unwrap();

        assert_eq!(plan.frames.len(), 3);
        assert_eq!(plan.frames[0].duration_seconds, 0.5);
        assert_eq!(plan.frames[1].duration_seconds, 0.5);
        assert_eq!(plan.frames[2].duration_seconds, 2.0);
        assert_eq!(plan.fit, FrameSequenceFit::Held { hold_seconds: 2.0 });
        assert_eq!(plan.total_seconds, 3.0);
    }

    #[test]
    fn plan_always_fills_exactly_the_row_it_was_given() {
        for row_seconds in [0.25, 1.0, 3.0, 11.5] {
            let plan = plan_frame_sequence(&manifest(&[500, 500, 0]), row_seconds, 60).unwrap();
            let summed: f64 = plan.frames.iter().map(|frame| frame.duration_seconds).sum();
            assert!(
                (summed - row_seconds).abs() < 1e-9,
                "row {row_seconds}s got {summed}s of frames"
            );
            assert_eq!(plan.total_seconds, row_seconds);
        }
    }

    #[test]
    fn gesture_keeps_authored_pace_when_row_grows() {
        let short = plan_frame_sequence(&manifest(&[500, 500, 0]), 2.0, 60).unwrap();
        let long = plan_frame_sequence(&manifest(&[500, 500, 0]), 20.0, 60).unwrap();

        assert_eq!(
            short.frames[0].duration_seconds,
            long.frames[0].duration_seconds
        );
        assert_eq!(
            short.frames[1].duration_seconds,
            long.frames[1].duration_seconds
        );
        assert_ne!(
            short.frames[2].duration_seconds,
            long.frames[2].duration_seconds
        );
    }

    #[test]
    fn exactly_fitting_gesture_keeps_terminal_endpoint() {
        let plan = plan_frame_sequence(&manifest(&[500, 500, 0]), 1.0, 60).unwrap();

        assert_eq!(plan.frames.len(), 3);
        assert_eq!(plan.frames[2].duration_seconds, 0.0);
        assert_eq!(plan.fit, FrameSequenceFit::Exact);
    }

    #[test]
    fn row_shorter_than_gesture_truncates_loudly_instead_of_rescaling() {
        let plan = plan_frame_sequence(&manifest(&[500, 500, 0]), 0.7, 60).unwrap();

        assert_eq!(plan.frames.len(), 2);
        assert_eq!(plan.frames[0].duration_seconds, 0.5);
        assert!((plan.frames[1].duration_seconds - 0.2).abs() < 1e-9);
        assert_eq!(
            plan.fit,
            FrameSequenceFit::Truncated {
                dropped_frames: 1,
                lost_seconds: 0.30000000000000004
            }
        );
    }

    #[test]
    fn interior_zero_duration_frame_is_superseded_without_adding_time() {
        let plan = plan_frame_sequence(&manifest(&[500, 0, 500, 0]), 3.0, 60).unwrap();

        assert_eq!(plan.frames.len(), 3);
        assert_eq!(plan.frames[1].path, PathBuf::from("frame-002.png"));
        assert_eq!(plan.frames[1].duration_seconds, 0.5);
        assert_eq!(plan.fit, FrameSequenceFit::Held { hold_seconds: 2.0 });
    }

    #[test]
    fn sub_frame_samples_coalesce_instead_of_stretching_the_gesture() {
        // 120fps authored gesture (8ms steps) played into a 30fps export.
        let mut durations = vec![8; 120];
        durations.push(0);
        let plan = plan_frame_sequence(&manifest(&durations), 2.0, 30).unwrap();

        let gesture: f64 = plan.frames[..plan.frames.len() - 1]
            .iter()
            .map(|frame| frame.duration_seconds)
            .sum();
        assert!((gesture - 0.96).abs() < 1e-9, "gesture took {gesture}s");
        assert!(plan.frames[..plan.frames.len() - 1]
            .iter()
            .all(|frame| frame.duration_seconds >= 1.0 / 30.0 - 1e-9));
        assert_eq!(plan.frames.len(), 25);
        assert!(matches!(plan.fit, FrameSequenceFit::Held { hold_seconds } if (hold_seconds - 1.04).abs() < 1e-9));
    }

    #[test]
    fn single_frame_manifest_behaves_like_a_still() {
        let plan = plan_frame_sequence(&manifest(&[0]), 4.0, 60).unwrap();

        assert_eq!(plan.frames.len(), 1);
        assert_eq!(plan.frames[0].duration_seconds, 4.0);
        assert_eq!(plan.fit, FrameSequenceFit::Held { hold_seconds: 4.0 });
    }

    #[test]
    fn negative_durations_are_treated_as_zero() {
        let plan = plan_frame_sequence(&manifest(&[-500, 500, 0]), 3.0, 60).unwrap();
        assert!(plan.frames.iter().all(|frame| frame.duration_seconds > 0.0));
        let summed: f64 = plan.frames.iter().map(|frame| frame.duration_seconds).sum();
        assert!((summed - 3.0).abs() < 1e-9);
    }

    #[test]
    fn empty_manifest_is_rejected() {
        assert!(plan_frame_sequence(&[], 3.0, 60).is_err());
    }

    #[test]
    fn nonpositive_row_duration_is_rejected() {
        assert!(plan_frame_sequence(&manifest(&[500, 0]), 0.0, 60).is_err());
        assert!(plan_frame_sequence(&manifest(&[500, 0]), -1.0, 60).is_err());
        assert!(plan_frame_sequence(&manifest(&[500, 0]), f64::NAN, 60).is_err());
    }
}
