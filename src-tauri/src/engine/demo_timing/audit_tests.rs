use super::audit::{audit, AuditCue, AuditOutcome, MissingLandmark, ObservedAction, ObservedWord};
use super::cues::CueAnchor;
use super::units::{Fps, Micros};

fn cue(step_index: usize, word: usize) -> AuditCue {
    AuditCue {
        step_index,
        anchor_word_index: word,
        anchor: CueAnchor::WordStart,
        offset_us: Micros::ZERO,
    }
}

fn word(word_index: usize, start_ms: i64, end_ms: i64) -> ObservedWord {
    ObservedWord {
        word_index,
        start_us: Micros::from_millis(start_ms),
        end_us: Micros::from_millis(end_ms),
    }
}

fn action(step_index: usize, output_frame: i64) -> ObservedAction {
    ObservedAction {
        step_index,
        output_frame,
    }
}

#[test]
fn drift_within_one_frame_passes_and_beyond_fails() {
    let fps = Fps::FPS_25;
    // (observed frame, word start ms, expected outcome, drift ms)
    let table = [
        (10, 400, AuditOutcome::Pass, 0),
        (11, 400, AuditOutcome::Pass, 40),
        (9, 400, AuditOutcome::Pass, -40),
        (12, 400, AuditOutcome::Fail, 80),
        (8, 400, AuditOutcome::Fail, -80),
        (10, 410, AuditOutcome::Pass, -10),
    ];
    for (frame, start, outcome, drift) in table {
        let report = audit(
            fps,
            &[cue(0, 3)],
            &[word(3, start, start + 300)],
            &[action(0, frame)],
            None,
        );
        assert_eq!(report.tolerance_us, Micros::from_millis(40));
        assert_eq!(
            report.cues[0].outcome, outcome,
            "frame {frame} start {start}"
        );
        assert_eq!(report.cues[0].drift_us, Some(Micros::from_millis(drift)));
        assert_eq!(report.max_abs_drift_us, Micros::from_millis(drift.abs()));
        assert_eq!(report.passed, outcome == AuditOutcome::Pass);
    }
}

#[test]
fn word_end_anchor_and_offset_set_the_expected_instant() {
    let fps = Fps::FPS_25;
    let cue = AuditCue {
        anchor: CueAnchor::WordEnd,
        offset_us: Micros::from_millis(100),
        ..cue(0, 1)
    };
    let report = audit(fps, &[cue], &[word(1, 400, 700)], &[action(0, 20)], None);
    assert_eq!(report.cues[0].expected_us, Some(Micros::from_millis(800)));
    assert_eq!(report.cues[0].observed_us, Some(Micros::from_millis(800)));
    assert!(report.passed);
}

#[test]
fn missing_landmarks_fail_the_report() {
    let fps = Fps::FPS_25;
    let report = audit(
        fps,
        &[cue(0, 0), cue(1, 5), cue(2, 0)],
        &[word(0, 0, 300)],
        &[action(0, 0), action(1, 30)],
        None,
    );
    assert_eq!(report.cues[0].outcome, AuditOutcome::Pass);
    assert_eq!(
        report.cues[1].outcome,
        AuditOutcome::Missing {
            landmark: MissingLandmark::Word
        }
    );
    assert_eq!(
        report.cues[2].outcome,
        AuditOutcome::Missing {
            landmark: MissingLandmark::Action
        }
    );
    assert_eq!(report.cues[1].drift_us, None);
    assert!(!report.passed);
}

#[test]
fn custom_tolerance_and_max_drift_across_cues() {
    let fps = Fps::FPS_25;
    let cues = [cue(0, 0), cue(1, 1)];
    let words = [word(0, 0, 300), word(1, 1_000, 1_300)];
    let actions = [action(0, 2), action(1, 26)];
    let strict = audit(fps, &cues, &words, &actions, Some(Micros::from_millis(50)));
    assert_eq!(strict.max_abs_drift_us, Micros::from_millis(80));
    assert_eq!(strict.cues[0].outcome, AuditOutcome::Fail);
    assert_eq!(strict.cues[1].outcome, AuditOutcome::Pass);
    assert!(!strict.passed);
    let loose = audit(fps, &cues, &words, &actions, Some(Micros::from_millis(100)));
    assert!(loose.passed);
    assert!(audit(fps, &[], &[], &[], None).passed);
}

#[test]
fn report_serializes_with_tagged_outcomes() {
    let report = audit(Fps::FPS_25, &[cue(0, 9)], &[], &[action(0, 0)], None);
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["cues"][0]["outcome"]["result"], "missing");
    assert_eq!(json["cues"][0]["outcome"]["landmark"], "word");
    assert!(json["cues"][0].get("driftUs").is_none());
    assert_eq!(json["toleranceUs"], 40_000);
}
