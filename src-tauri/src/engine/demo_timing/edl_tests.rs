use super::edl::{
    effective_hold_frames, must_play_frames, plan_edl, Edl, EdlAnchor, EdlConfig, EdlError,
    InfeasibilityKind, Segment, SegmentKind,
};
use super::edl_validate::{validate_edl, EdlViolation};
use super::test_support::Rng;
use super::units::FrameIndex;

fn anchor(
    step_index: usize,
    source_frame: FrameIndex,
    hold_frames: FrameIndex,
    target_frame: FrameIndex,
) -> EdlAnchor {
    EdlAnchor {
        step_index,
        source_frame,
        hold_frames,
        target_frame,
    }
}

fn seg(kind: SegmentKind, src: (FrameIndex, FrameIndex), out: (FrameIndex, FrameIndex)) -> Segment {
    Segment {
        kind,
        source_start_frame: src.0,
        source_end_frame: src.1,
        output_start_frame: out.0,
        output_end_frame: out.1,
    }
}

use SegmentKind::{Drop, Freeze, Play};

fn plan(anchors: &[EdlAnchor], source: FrameIndex, output: FrameIndex) -> Result<Edl, EdlError> {
    plan_edl(anchors, source, output, &EdlConfig::default())
}

#[test]
fn early_action_freezes_the_frame_before_it() {
    let anchors = [anchor(0, 10, 3, 20)];
    let edl = plan(&anchors, 50, 60).unwrap();
    assert_eq!(
        edl.segments,
        vec![
            seg(Play, (0, 10), (0, 10)),
            seg(Freeze, (9, 10), (10, 20)),
            seg(Play, (10, 50), (20, 60)),
        ]
    );
    validate_edl(&edl, &anchors).unwrap();
}

#[test]
fn late_first_action_drops_from_the_start_of_the_take() {
    let anchors = [anchor(0, 30, 2, 10)];
    let edl = plan(&anchors, 40, 20).unwrap();
    assert_eq!(
        edl.segments,
        vec![seg(Drop, (0, 20), (0, 0)), seg(Play, (20, 40), (0, 20))]
    );
}

#[test]
fn late_action_drops_idle_frames_between_busy_window_and_pre_roll() {
    let anchors = [anchor(0, 5, 3, 5), anchor(1, 40, 2, 15)];
    let edl = plan(&anchors, 50, 25).unwrap();
    assert_eq!(
        edl.segments,
        vec![
            seg(Play, (0, 13), (0, 13)),
            seg(Drop, (13, 38), (13, 13)),
            seg(Play, (38, 50), (13, 25)),
        ]
    );
    let placements = validate_edl(&edl, &anchors).unwrap();
    assert_eq!(placements[1].output_frame, 15);
}

#[test]
fn late_action_that_cannot_drop_enough_is_infeasible() {
    // must play = 3 (hold) + 2 (pre-roll) = 5 frames; only 3 available.
    let anchors = [anchor(0, 5, 3, 5), anchor(4, 40, 2, 8)];
    assert_eq!(must_play_frames(&anchors, 1, &EdlConfig::default()), 5);
    match plan(&anchors, 50, 25) {
        Err(EdlError::Infeasible { infeasibilities }) => {
            assert_eq!(infeasibilities.len(), 1);
            assert_eq!(infeasibilities[0].anchor_index, 1);
            assert_eq!(infeasibilities[0].step_index, 4);
            assert_eq!(
                infeasibilities[0].kind,
                InfeasibilityKind::Late {
                    shortfall_frames: 2
                }
            );
            let json = serde_json::to_value(infeasibilities[0]).unwrap();
            assert_eq!(json["kind"], "late");
            assert_eq!(json["shortfallFrames"], 2);
            assert_eq!(json["stepIndex"], 4);
        }
        other => panic!("expected infeasible, got {other:?}"),
    }
}

#[test]
fn overlapping_busy_window_is_carried_past_the_next_anchor() {
    // A is busy until source frame 20; B (frame 15) holds 1 frame itself.
    let anchors = [
        anchor(0, 10, 10, 10),
        anchor(1, 15, 1, 15),
        anchor(2, 60, 1, 30),
    ];
    assert_eq!(effective_hold_frames(&anchors, 0), 10);
    assert_eq!(effective_hold_frames(&anchors, 1), 5);
    assert_eq!(effective_hold_frames(&anchors, 2), 1);
    // B keeps 5 busy frames + 2 pre-roll before C.
    assert_eq!(must_play_frames(&anchors, 2, &EdlConfig::default()), 7);
    let edl = plan(&anchors, 80, 40).unwrap();
    assert_eq!(
        edl.segments,
        vec![
            seg(Play, (0, 28), (0, 28)),
            seg(Drop, (28, 58), (28, 28)),
            seg(Play, (58, 70), (28, 40)),
        ]
    );
    assert!(validate_edl(&edl, &anchors).is_ok());
}

#[test]
fn busy_window_past_the_end_of_the_take_is_an_error() {
    let anchors = [anchor(0, 10, 3, 10), anchor(1, 20, 2, 20)];
    assert!(plan(&anchors, 22, 40).is_ok());
    assert_eq!(
        plan(&anchors, 21, 40),
        Err(EdlError::BusyPastEndOfTake {
            anchor_index: 1,
            missing_frames: 1
        })
    );
    // An earlier action still busy at the end counts too.
    let overlapping = [anchor(0, 10, 15, 10), anchor(1, 20, 1, 20)];
    assert_eq!(
        plan(&overlapping, 22, 40),
        Err(EdlError::BusyPastEndOfTake {
            anchor_index: 1,
            missing_frames: 3
        })
    );
}

#[test]
fn tail_is_trimmed_padded_or_rejected() {
    let anchors = [anchor(0, 10, 3, 10)];
    assert_eq!(
        plan(&anchors, 100, 20).unwrap().segments,
        vec![seg(Play, (0, 20), (0, 20))]
    );
    assert_eq!(
        plan(&anchors, 15, 30).unwrap().segments,
        vec![seg(Play, (0, 15), (0, 15)), seg(Freeze, (14, 15), (15, 30))]
    );
    match plan(&anchors, 100, 12) {
        Err(EdlError::Infeasible { infeasibilities }) => assert_eq!(
            infeasibilities[0].kind,
            InfeasibilityKind::TailTooShort {
                shortfall_frames: 1
            }
        ),
        other => panic!("expected tail error, got {other:?}"),
    }
}

#[test]
fn no_anchors_plays_and_pads() {
    assert_eq!(
        plan(&[], 10, 10).unwrap().segments,
        vec![seg(Play, (0, 10), (0, 10))]
    );
    assert_eq!(
        plan(&[], 4, 6).unwrap().segments,
        vec![seg(Play, (0, 4), (0, 4)), seg(Freeze, (3, 4), (4, 6))]
    );
}

#[test]
fn input_errors() {
    assert_eq!(plan(&[], 0, 10), Err(EdlError::EmptySource));
    assert_eq!(plan(&[], 10, 0), Err(EdlError::EmptyOutput));
    assert_eq!(
        plan(&[anchor(0, 10, 1, 10)], 10, 20),
        Err(EdlError::SourceOutOfRange {
            anchor_index: 0,
            source_frame: 10
        })
    );
    assert_eq!(
        plan(&[anchor(0, 5, 1, 5), anchor(1, 5, 1, 9)], 20, 20),
        Err(EdlError::SourceOutOfOrder { anchor_index: 1 })
    );
    assert_eq!(
        plan(&[anchor(0, 5, 1, -1)], 20, 20),
        Err(EdlError::NegativeTarget { anchor_index: 0 })
    );
    assert_eq!(
        plan(&[anchor(0, 0, 1, 5)], 20, 20),
        Err(EdlError::NoPreActionFrame { anchor_index: 0 })
    );
    assert!(plan(&[anchor(0, 0, 1, 0)], 20, 20).is_ok());
}

#[test]
fn validator_catches_broken_edls() {
    let anchors = [anchor(0, 10, 3, 20)];
    let good = plan(&anchors, 50, 60).unwrap();

    let mut gap = good.clone();
    gap.segments[1].output_start_frame += 1;
    let violations = validate_edl(&gap, &anchors).unwrap_err();
    assert_eq!(
        violations,
        vec![EdlViolation::OutputGap {
            segment_index: 1,
            expected_start: 10,
            actual_start: 11
        }]
    );

    let mut short_play = good.clone();
    short_play.segments[2].output_start_frame += 1;
    let violations = validate_edl(&short_play, &anchors).unwrap_err();
    assert!(violations.contains(&EdlViolation::BadShape { segment_index: 2 }));
    assert!(violations.contains(&EdlViolation::AnchorMisplaced {
        anchor_index: 0,
        target_frame: 20,
        output_frame: 21
    }));

    let mut stale_freeze = good.clone();
    stale_freeze.segments[1].source_start_frame = 3;
    stale_freeze.segments[1].source_end_frame = 4;
    assert!(validate_edl(&stale_freeze, &anchors)
        .unwrap_err()
        .contains(&EdlViolation::FreezeNotLastShown { segment_index: 1 }));

    let misplaced = [anchor(0, 10, 3, 19)];
    assert!(validate_edl(&good, &misplaced).unwrap_err().contains(
        &EdlViolation::AnchorMisplaced {
            anchor_index: 0,
            target_frame: 19,
            output_frame: 20
        }
    ));

    let mut skipped = good.clone();
    skipped.segments[2].source_start_frame = 11;
    assert!(validate_edl(&skipped, &anchors).unwrap_err().contains(
        &EdlViolation::SourceDiscontinuity {
            segment_index: 2,
            expected_start: 10,
            actual_start: 11
        }
    ));

    let mut short = good;
    short.output_frame_count = 61;
    assert!(validate_edl(&short, &anchors)
        .unwrap_err()
        .contains(&EdlViolation::OutputLength {
            expected: 61,
            actual: 60
        }));
}

struct Scenario {
    anchors: Vec<EdlAnchor>,
    source: FrameIndex,
    output: FrameIndex,
}

/// Random anchors with feasible targets: every gap leaves room for the
/// footage the planner must keep.
fn feasible_scenario(rng: &mut Rng, config: &EdlConfig) -> Scenario {
    let count = rng.range(0, 6) as usize;
    let mut anchors: Vec<EdlAnchor> = Vec::with_capacity(count);
    let mut source = rng.range(0, 20);
    for step_index in 0..count {
        anchors.push(anchor(step_index, source, rng.range(1, 12), 0));
        source += rng.range(1, 60);
    }
    let mut target = 0;
    for index in 0..count {
        let must = must_play_frames(&anchors, index, config);
        let slack = match rng.range(0, 2) {
            0 => 0,
            1 => rng.range(0, 5),
            _ => rng.range(0, 80),
        };
        target += must + slack;
        if index == 0 && anchors[0].source_frame == 0 {
            target = 0;
        }
        anchors[index].target_frame = target;
    }
    let tail_hold = anchors
        .len()
        .checked_sub(1)
        .map_or(0, |last| effective_hold_frames(&anchors, last));
    let last_source = anchors.last().map_or(0, |a| a.source_frame);
    let source_count = last_source + tail_hold.max(1) + rng.range(0, 80);
    let output = (target + tail_hold + rng.range(0, 60)).max(1);
    Scenario {
        anchors,
        source: source_count,
        output,
    }
}

#[test]
fn property_feasible_plans_validate_and_hit_every_target() {
    for seed in 0..2_000 {
        let mut rng = Rng::new(seed);
        let config = EdlConfig {
            pre_roll_frames: rng.range(0, 4),
        };
        let s = feasible_scenario(&mut rng, &config);
        let edl = plan_edl(&s.anchors, s.source, s.output, &config)
            .unwrap_or_else(|e| panic!("seed {seed}: {e:?} for {:?}", s.anchors));
        let placements = validate_edl(&edl, &s.anchors)
            .unwrap_or_else(|v| panic!("seed {seed}: {v:?} for {edl:?}"));
        assert_eq!(placements.len(), s.anchors.len());
        for (placement, a) in placements.iter().zip(&s.anchors) {
            assert_eq!(placement.output_frame, a.target_frame, "seed {seed}");
        }
        assert_protected_footage_plays(seed, &edl, &s.anchors, &config);
    }
}

/// Drops never cut an anchor, its busy window (even when it overlaps later
/// anchors) or its pre-roll.
fn assert_protected_footage_plays(seed: u64, edl: &Edl, anchors: &[EdlAnchor], config: &EdlConfig) {
    for (index, a) in anchors.iter().enumerate() {
        let previous = index.checked_sub(1).map_or(0, |i| anchors[i].source_frame);
        let pre_roll_start = (a.source_frame - config.pre_roll_frames).max(previous);
        let busy_end = a.source_frame + a.hold_frames.max(1);
        for drop in edl.segments.iter().filter(|s| s.kind == Drop) {
            let overlaps_busy =
                drop.source_start_frame < busy_end && a.source_frame < drop.source_end_frame;
            let overlaps_pre =
                drop.source_start_frame < a.source_frame && pre_roll_start < drop.source_end_frame;
            assert!(
                !overlaps_busy,
                "seed {seed}: drop {drop:?} cuts busy window of {a:?}"
            );
            assert!(
                !overlaps_pre,
                "seed {seed}: drop {drop:?} cuts pre-roll of {a:?}"
            );
        }
    }
}

#[test]
fn property_shortfall_matches_the_missing_frames() {
    let config = EdlConfig::default();
    let mut checked = 0;
    for seed in 0..2_000 {
        let mut rng = Rng::new(seed ^ 0xA5A5);
        let mut s = feasible_scenario(&mut rng, &config);
        if s.anchors.len() < 2 {
            continue;
        }
        let victim = rng.range(1, s.anchors.len() as i64 - 1) as usize;
        let must = must_play_frames(&s.anchors, victim, &config);
        let gap = s.anchors[victim].target_frame - s.anchors[victim - 1].target_frame;
        let cut = gap - must + rng.range(1, must.max(1));
        if cut > gap {
            continue;
        }
        for a in &mut s.anchors[victim..] {
            a.target_frame -= cut;
        }
        s.output -= cut;
        match plan_edl(&s.anchors, s.source, s.output, &config) {
            Err(EdlError::Infeasible { infeasibilities }) => {
                assert_eq!(infeasibilities.len(), 1, "seed {seed}");
                assert_eq!(infeasibilities[0].anchor_index, victim);
                assert_eq!(
                    infeasibilities[0].kind,
                    InfeasibilityKind::Late {
                        shortfall_frames: must - (gap - cut)
                    },
                    "seed {seed}"
                );
                checked += 1;
            }
            other => panic!("seed {seed}: expected infeasible, got {other:?}"),
        }
    }
    assert!(checked > 500, "only {checked} scenarios exercised");
}
