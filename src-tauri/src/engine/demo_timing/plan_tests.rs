use super::actions::{ActionLog, ActionStatus, AnchorError};
use super::audit::{audit, ObservedAction, ObservedWord};
use super::cues::Cue;
use super::edl::{EdlError, SegmentKind};
use super::edl_validate::validate_edl;
use super::epoch::{EpochError, FitMethod, MarkerPair};
use super::plan::{
    plan_demo_timing, DemoTimingPlan, PlanConfig, PlanError, PlanInput, PlanStepInput,
    DEMO_TIMING_SCHEMA_V1,
};
use super::scheduler::ScheduleError;
use super::test_support::words_from;
use super::units::{Fps, Micros};
use super::words::SilenceSplice;

const NARRATION: &str = "Open the settings. Click save.";

fn ms(v: i64) -> Micros {
    Micros::from_millis(v)
}

fn visible(at_ms: i64, postcondition_ms: Option<i64>) -> ActionLog {
    ActionLog {
        kind: "click".to_string(),
        dispatched_at: ms(at_ms - 50),
        input_effect_at: None,
        postcondition_at: postcondition_ms.map(ms),
        visible_at: Some(ms(at_ms)),
        status: ActionStatus::Ok,
    }
}

fn step(id: &str, cue: Option<&str>, action: ActionLog) -> PlanStepInput {
    PlanStepInput {
        id: id.to_string(),
        cue: cue.map(Cue::new),
        action,
    }
}

/// Video lags host by 300 ms; the first marker is clamped at PTS 0.
fn markers() -> Vec<MarkerPair> {
    let mut markers = vec![MarkerPair {
        host_us: ms(100),
        pts_us: Micros::ZERO,
    }];
    markers.extend((1..=5).map(|s| MarkerPair {
        host_us: ms(s * 1_000),
        pts_us: ms(s * 1_000 - 300),
    }));
    markers
}

fn base_input(steps: Vec<PlanStepInput>) -> PlanInput {
    PlanInput {
        narration: NARRATION.to_string(),
        words: words_from(NARRATION, 300, 100),
        narration_duration_us: ms(2_000),
        steps,
        markers: markers(),
        source_frame_count: 200,
        fps: Fps::FPS_25,
        config: PlanConfig::default(),
    }
}

fn two_steps(postcondition_ms: i64) -> PlanInput {
    base_input(vec![
        step("open", Some("open"), visible(2_020, Some(postcondition_ms))),
        step("click", Some("click"), visible(6_020, None)),
    ])
}

type Seg = (SegmentKind, i64, i64, i64, i64);

fn segments(plan: &DemoTimingPlan) -> Vec<Seg> {
    plan.segments
        .iter()
        .map(|s| {
            (
                s.kind,
                s.source_start_frame,
                s.source_end_frame,
                s.output_start_frame,
                s.output_end_frame,
            )
        })
        .collect()
}

#[test]
fn end_to_end_plan_lands_actions_on_their_words() {
    let plan = plan_demo_timing(&two_steps(2_500)).unwrap();
    assert!(plan.is_supported_schema());
    assert_eq!(plan.epoch.method, FitMethod::MedianOffset);
    assert_eq!(plan.epoch.offset_us, ms(-300));

    // Head pre-roll (2 frames) needs 80 ms of leading silence.
    assert_eq!(
        plan.silences,
        vec![SilenceSplice {
            after_word_index: None,
            at_us: Micros::ZERO,
            duration_us: ms(80),
        }]
    );
    assert_eq!(plan.narration_duration_us, ms(2_080));
    assert_eq!(plan.output_frame_count, 52);

    let placed: Vec<(i64, i64, i64, i64)> = plan
        .steps
        .iter()
        .map(|s| {
            (
                s.source_frame,
                s.hold_frames,
                s.target_frame,
                s.output_frame,
            )
        })
        .collect();
    assert_eq!(placed, vec![(43, 12, 2, 2), (143, 1, 32, 32)]);
    assert!(plan
        .steps
        .iter()
        .all(|s| s.quantization_error_us == Micros::ZERO));

    use SegmentKind::*;
    assert_eq!(
        segments(&plan),
        vec![
            (Drop, 0, 41, 0, 0),
            (Play, 41, 71, 0, 30),
            (Drop, 71, 141, 30, 30),
            (Play, 141, 163, 30, 52),
        ]
    );
    let anchors: Vec<_> = plan
        .steps
        .iter()
        .enumerate()
        .map(|(step_index, s)| super::edl::EdlAnchor {
            step_index,
            source_frame: s.source_frame,
            hold_frames: s.hold_frames,
            target_frame: s.target_frame,
        })
        .collect();
    assert!(validate_edl(&plan.edl(), &anchors).is_ok());
}

#[test]
fn long_busy_window_inserts_silence_before_the_next_cue() {
    // Postcondition at 4.0 s keeps step 0 busy until source frame 93.
    let plan = plan_demo_timing(&two_steps(4_000)).unwrap();
    assert_eq!(plan.steps[0].hold_frames, 50);
    assert_eq!(
        plan.silences,
        vec![
            SilenceSplice {
                after_word_index: None,
                at_us: Micros::ZERO,
                duration_us: ms(80),
            },
            SilenceSplice {
                after_word_index: Some(2),
                at_us: ms(1_150),
                duration_us: ms(880),
            },
        ]
    );
    assert_eq!(plan.steps[1].target_frame, 54);
    assert_eq!(plan.steps[1].output_frame, 54);
    assert_eq!(plan.words[3].start_us, ms(2_160));
    assert_eq!(plan.output_frame_count, 74);
}

#[test]
fn audit_cues_round_trip_through_observed_media() {
    let input = two_steps(2_500);
    let plan = plan_demo_timing(&input).unwrap();
    let cues = plan.audit_cues(&input.steps);
    assert_eq!(cues.len(), 2);
    let words: Vec<ObservedWord> = plan
        .words
        .iter()
        .enumerate()
        .map(|(word_index, w)| ObservedWord {
            word_index,
            start_us: w.start_us,
            end_us: w.end_us(),
        })
        .collect();
    let on_time: Vec<ObservedAction> = plan
        .steps
        .iter()
        .enumerate()
        .map(|(step_index, s)| ObservedAction {
            step_index,
            output_frame: s.output_frame,
        })
        .collect();
    assert!(audit(plan.fps, &cues, &words, &on_time, None).passed);

    let mut late = on_time.clone();
    late[1].output_frame += 3;
    let report = audit(plan.fps, &cues, &words, &late, None);
    assert!(!report.passed);
    assert_eq!(report.cues[1].drift_us, Some(ms(120)));
}

#[test]
fn uncued_steps_are_skipped_by_audit_cues() {
    let input = base_input(vec![
        step("open", Some("open"), visible(2_020, None)),
        step("wait", None, visible(3_020, None)),
    ]);
    let plan = plan_demo_timing(&input).unwrap();
    let cues = plan.audit_cues(&input.steps);
    assert_eq!(cues.len(), 1);
    assert_eq!(cues[0].step_index, 0);
    // The uncued step follows by the 250 ms min gap (7 frames).
    assert_eq!(plan.steps[1].target_frame - plan.steps[0].target_frame, 7);
}

#[test]
fn estimated_anchor_uses_kind_latency() {
    let mut action = visible(2_020, None);
    action.visible_at = None;
    action.dispatched_at = ms(2_000);
    let input = base_input(vec![step("open", Some("open"), action)]);
    let plan = plan_demo_timing(&input).unwrap();
    // 2.0 s + 60 ms click latency − 300 ms = 1.76 s → frame 44.
    assert_eq!(plan.steps[0].source_frame, 44);
}

#[test]
fn failures_are_typed() {
    let mut failed = two_steps(2_500);
    failed.steps[1].action.status = ActionStatus::Failed {
        message: "selector not found".to_string(),
    };
    assert!(matches!(
        plan_demo_timing(&failed),
        Err(PlanError::Anchor(AnchorError::ActionFailed {
            step_index: 1,
            ..
        }))
    ));

    let out_of_order = base_input(vec![
        step("open", Some("open"), visible(6_020, None)),
        step("click", Some("click"), visible(2_020, None)),
    ]);
    assert_eq!(
        plan_demo_timing(&out_of_order),
        Err(PlanError::Edl(EdlError::SourceOutOfOrder {
            anchor_index: 1
        }))
    );

    let mut missing = two_steps(2_500);
    missing.steps[1].cue = Some(Cue::new("cancel"));
    assert!(matches!(
        plan_demo_timing(&missing),
        Err(PlanError::Schedule(ScheduleError::Cues(_)))
    ));

    let mut no_markers = two_steps(2_500);
    no_markers.markers.truncate(1);
    assert!(matches!(
        plan_demo_timing(&no_markers),
        Err(PlanError::Epoch(EpochError::NotEnoughMarkers { .. }))
    ));
}

#[test]
fn plan_contract_serializes_camel_case_with_schema() {
    let plan = plan_demo_timing(&two_steps(2_500)).unwrap();
    let json = serde_json::to_value(&plan).unwrap();
    assert_eq!(json["schema"], DEMO_TIMING_SCHEMA_V1);
    assert_eq!(json["fps"], serde_json::json!({"num": 25, "den": 1}));
    assert_eq!(json["outputFrameCount"], 52);
    assert_eq!(json["segments"][0]["kind"], "drop");
    assert_eq!(json["steps"][0]["targetFrame"], 2);
    assert_eq!(json["silences"][0]["durationUs"], 80_000);
    let back: DemoTimingPlan = serde_json::from_value(json).unwrap();
    assert_eq!(back, plan);

    let mut other = plan;
    other.schema = "cutready.demo-timing.v2".to_string();
    assert!(!other.is_supported_schema());
}

#[test]
fn plan_input_accepts_json_with_default_config() {
    let input = two_steps(2_500);
    let mut json = serde_json::to_value(&input).unwrap();
    json.as_object_mut().unwrap().remove("config");
    let parsed: PlanInput = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.config, PlanConfig::default());
    assert_eq!(parsed, input);
    assert_eq!(plan_demo_timing(&parsed), plan_demo_timing(&input));
}
