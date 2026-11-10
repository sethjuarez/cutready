use super::*;
use crate::engine::live_take::audit::visual::{GridEvidence, SsimEvidence, Window};

fn vis(p1: Option<usize>, p2: Option<usize>, net_cells: usize) -> VisualEvidence {
    VisualEvidence {
        window: Window {
            lo: 50,
            hi: 150,
            expected: 100,
        },
        grid: GridEvidence {
            cols: 32,
            rows: 18,
            net_cells,
            net_box: None,
            onset: p1,
        },
        ssim: SsimEvidence {
            noise: 0.001,
            final_dissimilarity: 0.2,
            threshold: 0.02,
            abstained: p2.is_none(),
            onset: p2,
        },
        locality: Locality::AtTarget,
        in_progress_at_start: false,
    }
}

/// Expected at 4000 ms = frame 100 at 40 ms frames; mid-phrase u = 25 ms.
fn ev(v: &VisualEvidence) -> CueEvidence<'_> {
    CueEvidence {
        expected: Ok((4000.0, 25.0)),
        visual: Some(v),
        window_valid: true,
        witness: WitnessStatus::Agrees,
        frame_ms: 40.0,
    }
}

fn cfg() -> VerdictConfig {
    VerdictConfig::default()
}

#[test]
fn on_time_action_with_agreement_passes() {
    let v = vis(Some(100), Some(100), 12);
    let out = decide(&ev(&v), &cfg());
    assert_eq!(out.verdict, Verdict::Pass, "{:?}", out.reasons);
    assert_eq!(out.drift_d1_ms, Some(0.0));
}

#[test]
fn drift_sign_is_onset_minus_expected() {
    let v = vis(Some(101), Some(101), 12);
    assert_eq!(decide(&ev(&v), &cfg()).drift_d1_ms, Some(40.0));
    let v = vis(Some(99), Some(99), 12);
    assert_eq!(decide(&ev(&v), &cfg()).drift_d1_ms, Some(-40.0));
}

#[test]
fn offset_shifts_the_expected_time() {
    // A cue with +200 ms offset: expected 4200 ms → frame 105 is on time.
    let v = vis(Some(105), Some(105), 12);
    let mut e = ev(&v);
    e.expected = Ok((4200.0, 25.0));
    assert_eq!(decide(&e, &cfg()).verdict, Verdict::Pass);
}

#[test]
fn three_frames_off_fails_when_both_detectors_agree() {
    let v = vis(Some(97), Some(97), 3);
    let out = decide(&ev(&v), &cfg());
    assert_eq!(out.verdict, Verdict::Fail);
    assert_eq!(out.reasons, vec!["actionEarly"]);
    let v = vis(Some(103), None, 3);
    let out = decide(&ev(&v), &cfg());
    assert_eq!(
        out.verdict,
        Verdict::Fail,
        "D2 abstaining can't rescue a late D1"
    );
    assert_eq!(out.reasons, vec!["actionLate"]);
}

#[test]
fn a_witness_conflict_does_not_block_a_pixel_fail() {
    let v = vis(Some(106), Some(106), 3);
    let mut e = ev(&v);
    e.witness = WitnessStatus::Conflicts;
    assert_eq!(decide(&e, &cfg()).verdict, Verdict::Fail);
}

#[test]
fn boundaries_are_inclusive() {
    // |d| − u ≥ 80 fails: d = 105 ms is exactly on the fail boundary.
    let v = vis(Some(100), Some(100), 12);
    let mut e = ev(&v);
    e.expected = Ok((4000.0 - 105.0, 25.0));
    assert_eq!(decide(&e, &cfg()).verdict, Verdict::Fail);
    // |d| + u ≤ 80 passes: d = 55 ms is exactly on the pass boundary.
    e.expected = Ok((4000.0 - 55.0, 25.0));
    assert_eq!(decide(&e, &cfg()).verdict, Verdict::Pass);
    // Between the two it is uncertain.
    e.expected = Ok((4000.0 - 80.0, 25.0));
    let out = decide(&e, &cfg());
    assert_eq!(out.verdict, Verdict::Uncertain);
    assert_eq!(out.reasons, vec!["driftWithinUncertainty"]);
}

#[test]
fn detectors_disagreeing_on_a_late_onset_is_uncertain() {
    let v = vis(Some(106), Some(100), 12);
    let out = decide(&ev(&v), &cfg());
    assert_eq!(out.verdict, Verdict::Uncertain);
    assert_eq!(out.reasons, vec!["actionLate", "detectorsDisagree"]);
}

#[test]
fn in_time_but_detectors_split_is_uncertain() {
    let v = vis(Some(100), Some(102), 12);
    let out = decide(&ev(&v), &cfg());
    assert_eq!(out.verdict, Verdict::Uncertain);
    assert_eq!(out.reasons, vec!["detectorsDisagree"]);
}

#[test]
fn witness_problems_block_a_pass() {
    let v = vis(Some(100), Some(100), 12);
    for (w, why) in [
        (WitnessStatus::Conflicts, "witnessConflicts"),
        (WitnessStatus::Loose, "witnessClockLoose"),
        (WitnessStatus::Absent, "witnessAbsent"),
        (WitnessStatus::NoEffect, "witnessNoEffect"),
    ] {
        let mut e = ev(&v);
        e.witness = w;
        let out = decide(&e, &cfg());
        assert_eq!(out.verdict, Verdict::Uncertain);
        assert_eq!(out.reasons, vec![why]);
    }
}

#[test]
fn missing_word_and_missing_change() {
    let v = vis(None, None, 0);
    let mut e = ev(&v);
    assert_eq!(decide(&e, &cfg()).verdict, Verdict::Fail);
    e.expected = Err("sttSkipped".into());
    let out = decide(&e, &cfg());
    assert_eq!(out.verdict, Verdict::Uncertain);
    assert_eq!(out.reasons, vec!["sttSkipped"]);
}

#[test]
fn change_elsewhere_never_passes_or_fails() {
    let mut v = vis(Some(100), Some(100), 12);
    v.locality = Locality::Elsewhere;
    assert_eq!(decide(&ev(&v), &cfg()).verdict, Verdict::Uncertain);
    let mut v = vis(Some(110), Some(110), 12);
    v.locality = Locality::Elsewhere;
    assert_eq!(decide(&ev(&v), &cfg()).verdict, Verdict::Uncertain);
}

#[test]
fn short_window_and_in_progress_are_uncertain() {
    let v = vis(Some(100), Some(100), 12);
    let mut e = ev(&v);
    e.window_valid = false;
    assert_eq!(decide(&e, &cfg()).reasons, vec!["windowTooShort"]);
    let mut v = vis(Some(51), Some(51), 12);
    v.in_progress_at_start = true;
    assert_eq!(
        decide(&ev(&v), &cfg()).reasons,
        vec!["changeInProgressAtWindowStart"]
    );
}

#[test]
fn overall_verdict() {
    use Verdict::*;
    assert_eq!(overall([Pass, Pass]), Pass);
    assert_eq!(overall([Pass, Uncertain]), Uncertain);
    assert_eq!(overall([Uncertain, Fail, Pass]), Fail);
    assert_eq!(overall([]), Uncertain);
}

#[test]
fn an_on_time_d1_with_d2_abstaining_is_not_a_pass() {
    let v = vis(Some(100), None, 3);
    let out = decide(&ev(&v), &cfg());
    assert_eq!(out.verdict, Verdict::Uncertain);
    assert_eq!(out.reasons, vec!["secondDetectorAbstained"]);
}
