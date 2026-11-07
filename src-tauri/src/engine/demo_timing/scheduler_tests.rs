use super::cues::{Cue, CueError};
use super::scheduler::{
    schedule, schedule_to_fixpoint, silence_for_step, ScheduleConfig, ScheduleError, ScheduleInput,
    StepSpec,
};
use super::test_support::{words_from, Rng};
use super::units::{Fps, Micros};
use super::words::{
    apply_silence, merge_insertions, silence_splices, total_silence, InsertSilence, SilenceSplice,
    WordTiming,
};

const NARRATION: &str = "Open the settings. Click save, then close it.";
// 0 Open, 1 the, 2 settings., 3 Click, 4 save,, 5 then, 6 close, 7 it.
// Word i starts at i * 400 ms; at 25 fps that is frame i * 10.

fn step(id: &str, cue: Option<&str>, min_ms: i64) -> StepSpec {
    StepSpec {
        id: id.to_string(),
        cue: cue.map(Cue::new),
        min_duration_us: Micros::from_millis(min_ms),
    }
}

fn input<'a>(
    narration: &'a str,
    words: &'a [WordTiming],
    steps: &'a [StepSpec],
    config: &'a ScheduleConfig,
) -> ScheduleInput<'a> {
    ScheduleInput {
        words,
        narration,
        narration_duration_us: words
            .last()
            .map_or(Micros::ZERO, |w| w.end_us() + Micros::from_millis(100)),
        steps,
        fps: Fps::FPS_25,
        config,
    }
}

#[test]
fn feasible_schedule_targets_cue_frames() {
    let words = words_from(NARRATION, 300, 100);
    let steps = [
        step("a", Some("open"), 0),
        step("b", Some("click"), 0),
        step("c", Some("close"), 0),
    ];
    let config = ScheduleConfig::default();
    let s = schedule(&input(NARRATION, &words, &steps, &config)).unwrap();
    let frames: Vec<i64> = s.steps.iter().map(|s| s.target_frame).collect();
    assert_eq!(frames, vec![0, 30, 60]);
    assert_eq!(s.steps[1].target_us, Micros::from_millis(1_200));
    assert!(s.constraints.is_empty());
    assert_eq!(s.output_duration_us, Micros::from_millis(3_200));
}

#[test]
fn overrun_inserts_silence_at_the_sentence_boundary() {
    let words = words_from(NARRATION, 300, 100);
    let steps = [
        step("a", Some("settings"), 2_000),
        step("b", Some("click"), 0),
    ];
    let config = ScheduleConfig::default();
    let input = input(NARRATION, &words, &steps, &config);
    let s = schedule(&input).unwrap();
    assert_eq!(
        s.constraints,
        vec![InsertSilence {
            after_word_index: Some(2),
            required_us: Micros::from_millis(1_600),
        }]
    );

    let fixed = schedule_to_fixpoint(&input, &[], 8).unwrap();
    assert_eq!(fixed.iterations, 2);
    assert_eq!(fixed.insertions, s.constraints);
    assert_eq!(fixed.schedule.steps[0].target_frame, 20);
    assert_eq!(fixed.schedule.steps[1].target_frame, 70);
    assert_eq!(fixed.words[2].start_us, Micros::from_millis(800));
    assert_eq!(fixed.words[3].start_us, Micros::from_millis(2_800));
    assert_eq!(fixed.narration_duration_us, Micros::from_millis(4_800));
    assert!(fixed.schedule.constraints.is_empty());
}

#[test]
fn silence_prefers_clause_boundary_then_word_before_cue() {
    let words = words_from(NARRATION, 300, 100);
    let steps = [step("a", Some("click"), 2_000), step("b", Some("close"), 0)];
    let config = ScheduleConfig::default();
    let s = schedule(&input(NARRATION, &words, &steps, &config)).unwrap();
    assert_eq!(
        s.constraints,
        vec![InsertSilence {
            after_word_index: Some(4),
            required_us: Micros::from_millis(800),
        }]
    );

    let plain = "open the menu now click save";
    let words = words_from(plain, 300, 100);
    let steps = [step("a", Some("open"), 2_000), step("b", Some("click"), 0)];
    let s = schedule(&input(plain, &words, &steps, &config)).unwrap();
    assert_eq!(
        s.constraints,
        vec![InsertSilence {
            after_word_index: Some(3),
            required_us: Micros::from_millis(400),
        }]
    );
}

#[test]
fn boundary_uses_narration_text_when_words_lack_punctuation() {
    // TTS often reports bare words; the narration text still has the period.
    let mut words = words_from(NARRATION, 300, 100);
    for word in &mut words {
        word.text = word.text.trim_end_matches(['.', ',']).to_string();
    }
    let steps = [step("a", Some("open"), 2_000), step("b", Some("click"), 0)];
    let config = ScheduleConfig::default();
    let s = schedule(&input(NARRATION, &words, &steps, &config)).unwrap();
    assert_eq!(s.constraints[0].after_word_index, Some(2));
}

#[test]
fn lead_in_before_first_cue_becomes_leading_silence() {
    let words = words_from(NARRATION, 300, 100);
    let steps = [step("a", Some("open"), 0)];
    let config = ScheduleConfig {
        lead_in_us: Micros::from_millis(200),
        ..ScheduleConfig::default()
    };
    let input = input(NARRATION, &words, &steps, &config);
    let s = schedule(&input).unwrap();
    assert_eq!(
        s.constraints,
        vec![InsertSilence {
            after_word_index: None,
            required_us: Micros::from_millis(200),
        }]
    );
    let fixed = schedule_to_fixpoint(&input, &[], 4).unwrap();
    assert_eq!(fixed.words[0].start_us, Micros::from_millis(200));
    assert_eq!(fixed.schedule.steps[0].target_frame, 5);
}

#[test]
fn uncued_steps_follow_the_previous_step_by_the_min_gap() {
    let words = words_from(NARRATION, 300, 100);
    let steps = [
        step("a", Some("open"), 0),
        step("b", None, 1_000),
        step("c", Some("click"), 0),
    ];
    let config = ScheduleConfig::default();
    let s = schedule(&input(NARRATION, &words, &steps, &config)).unwrap();
    // 250 ms min gap rounds up to 7 frames.
    assert_eq!(s.steps[1].target_frame, 7);
    assert_eq!(s.steps[1].target_us, Micros::from_millis(280));
    assert!(s.steps[1].cue.is_none());
    // b needs 25 frames, so c (frame 30) must wait until frame 32.
    assert_eq!(
        s.constraints,
        vec![InsertSilence {
            after_word_index: Some(2),
            required_us: Micros::from_millis(80),
        }]
    );
}

#[test]
fn trailing_footage_extends_the_output() {
    let words = words_from(NARRATION, 300, 100);
    let steps = [step("a", Some("close"), 5_000)];
    let config = ScheduleConfig::default();
    let s = schedule(&input(NARRATION, &words, &steps, &config)).unwrap();
    assert_eq!(s.output_duration_us, Micros::from_millis(2_400 + 5_000));
}

#[test]
fn silence_for_step_targets_the_cue_and_skips_uncued_steps() {
    let words = words_from(NARRATION, 300, 100);
    let steps = [
        step("a", Some("click"), 0),
        step("b", None, 0),
        step("c", Some("close"), 0),
    ];
    let config = ScheduleConfig::default();
    let input = input(NARRATION, &words, &steps, &config);
    let s = schedule(&input).unwrap();
    assert_eq!(
        silence_for_step(&input, &s, 2, Micros(40_000)),
        Some(InsertSilence {
            after_word_index: Some(4),
            required_us: Micros(40_000),
        })
    );
    assert_eq!(silence_for_step(&input, &s, 1, Micros(40_000)), None);
    assert_eq!(silence_for_step(&input, &s, 9, Micros(40_000)), None);
}

#[test]
fn cue_errors_and_non_convergence_are_reported() {
    let words = words_from(NARRATION, 300, 100);
    let config = ScheduleConfig::default();
    let bad = [step("a", Some("missing"), 0)];
    match schedule_to_fixpoint(&input(NARRATION, &words, &bad, &config), &[], 4) {
        Err(ScheduleError::Cues(e)) => assert!(matches!(e.errors[0], CueError::NotFound { .. })),
        other => panic!("expected cue error, got {other:?}"),
    }
    let steps = [
        step("a", Some("settings"), 2_000),
        step("b", Some("click"), 0),
    ];
    match schedule_to_fixpoint(&input(NARRATION, &words, &steps, &config), &[], 1) {
        Err(ScheduleError::NotConverged {
            iterations,
            remaining,
        }) => {
            assert_eq!(iterations, 1);
            assert_eq!(remaining.len(), 1);
        }
        other => panic!("expected non-convergence, got {other:?}"),
    }
}

#[test]
fn initial_insertions_are_applied_before_scheduling() {
    let words = words_from(NARRATION, 300, 100);
    let steps = [step("a", Some("open"), 0), step("b", Some("click"), 0)];
    let config = ScheduleConfig::default();
    let extra = [InsertSilence {
        after_word_index: Some(2),
        required_us: Micros::from_millis(400),
    }];
    let fixed =
        schedule_to_fixpoint(&input(NARRATION, &words, &steps, &config), &extra, 4).unwrap();
    assert_eq!(fixed.iterations, 1);
    assert_eq!(fixed.schedule.steps[1].target_frame, 40);
    assert_eq!(fixed.insertions, extra.to_vec());
}

#[test]
fn apply_silence_shifts_only_later_words() {
    let words = words_from("a b c", 300, 100);
    let insertions = [
        InsertSilence {
            after_word_index: Some(1),
            required_us: Micros::from_millis(100),
        },
        InsertSilence {
            after_word_index: None,
            required_us: Micros::from_millis(50),
        },
        InsertSilence {
            after_word_index: Some(1),
            required_us: Micros::from_millis(25),
        },
        InsertSilence {
            after_word_index: Some(0),
            required_us: Micros::from_millis(-10),
        },
    ];
    let shifted = apply_silence(&words, &insertions);
    let starts: Vec<i64> = shifted.iter().map(|w| w.start_us.0 / 1_000).collect();
    assert_eq!(starts, vec![50, 450, 975]);
    assert!(shifted
        .iter()
        .zip(&words)
        .all(|(a, b)| a.duration_us == b.duration_us));
    assert_eq!(
        merge_insertions(&insertions),
        vec![
            InsertSilence {
                after_word_index: None,
                required_us: Micros::from_millis(50),
            },
            InsertSilence {
                after_word_index: Some(1),
                required_us: Micros::from_millis(125),
            },
        ]
    );
    assert_eq!(total_silence(&insertions), Micros::from_millis(175));
}

#[test]
fn silence_splices_cut_mid_gap_on_the_original_clock() {
    let words = words_from("a b c", 300, 100);
    let at = |after: Option<usize>| {
        silence_splices(
            &words,
            &[InsertSilence {
                after_word_index: after,
                required_us: Micros(1),
            }],
        )[0]
    };
    assert_eq!(
        at(Some(1)),
        SilenceSplice {
            after_word_index: Some(1),
            at_us: Micros::from_millis(750),
            duration_us: Micros(1),
        }
    );
    assert_eq!(at(None).at_us, Micros::ZERO);
    assert_eq!(at(Some(2)).at_us, Micros::from_millis(1_100));
    assert_eq!(at(Some(9)).at_us, Micros::from_millis(1_100));
}

#[test]
fn property_fixpoint_converges_with_valid_spacing() {
    let fps = Fps::FPS_25;
    let config = ScheduleConfig::default();
    for seed in 0..300 {
        let mut rng = Rng::new(seed);
        let mut narration = String::new();
        for i in 0..40 {
            let punctuation = match rng.range(0, 9) {
                0 => ".",
                1 => ",",
                _ => "",
            };
            narration.push_str(&format!("w{i}{punctuation} "));
        }
        let words = words_from(&narration, rng.range(150, 450), rng.range(0, 200));
        let mut steps = Vec::new();
        let mut word = rng.range(0, 3);
        while word < 40 {
            let cue = (rng.range(0, 3) > 0).then(|| format!("w{word}"));
            steps.push(StepSpec {
                id: format!("s{}", steps.len()),
                cue: cue.map(Cue::new),
                min_duration_us: Micros::from_millis(rng.range(0, 3_000)),
            });
            word += rng.range(1, 8);
        }
        let input = input(&narration, &words, &steps, &config);
        let fixed =
            schedule_to_fixpoint(&input, &[], 64).unwrap_or_else(|e| panic!("seed {seed}: {e:?}"));
        assert!(fixed.iterations as usize <= steps.len() + 1, "seed {seed}");
        assert!(fixed.schedule.constraints.is_empty());
        for pair in fixed.schedule.steps.windows(2).zip(&steps) {
            let ([prev, next], spec) = pair else {
                unreachable!()
            };
            let need = fps
                .frame_ceil(spec.min_duration_us.max(config.min_gap_us))
                .max(1);
            assert!(next.target_frame - prev.target_frame >= need, "seed {seed}");
        }
        assert!(fixed
            .words
            .windows(2)
            .all(|w| w[0].end_us() <= w[1].start_us));
        assert_eq!(
            fixed.narration_duration_us,
            input.narration_duration_us + total_silence(&fixed.insertions)
        );
    }
}
