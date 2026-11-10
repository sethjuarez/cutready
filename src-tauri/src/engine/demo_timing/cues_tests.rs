use super::cues::{resolve_cues, CandidateKind, Cue, CueError, CueMatch};
use super::test_support::words_from;
use super::units::Micros;
use super::words::WordTiming;

const NARRATION: &str = "Open the panel. Then open the settings panel, and open it again.";
// 0 Open, 1 the, 2 panel., 3 Then, 4 open, 5 the, 6 settings, 7 panel,,
// 8 and, 9 open, 10 it, 11 again.  Word i starts at i * 400 ms.

fn words() -> Vec<WordTiming> {
    words_from(NARRATION, 300, 100)
}

fn resolve(
    words: &[WordTiming],
    cues: &[Option<Cue>],
) -> Result<Vec<Option<CueMatch>>, Vec<CueError>> {
    let refs: Vec<Option<&Cue>> = cues.iter().map(Option::as_ref).collect();
    resolve_cues(words, &refs).map_err(|e| e.errors)
}

fn first_words(resolved: &[Option<CueMatch>]) -> Vec<Option<usize>> {
    resolved.iter().map(|m| m.map(|m| m.first_word)).collect()
}

#[test]
fn unique_cue_resolves_to_word_start() {
    let resolved = resolve(&words(), &[Some(Cue::new("Then"))]).unwrap();
    assert_eq!(
        resolved[0],
        Some(CueMatch {
            first_word: 3,
            last_word: 3,
            anchor_word: 3,
            target_us: Micros::from_millis(1_200),
        })
    );
}

#[test]
fn repeated_word_without_occurrence_is_ambiguous() {
    let errors = resolve(&words(), &[Some(Cue::new("open"))]).unwrap_err();
    let [CueError::Ambiguous {
        candidates,
        search_from_word,
        ..
    }] = errors.as_slice()
    else {
        panic!("expected ambiguous, got {errors:?}");
    };
    assert_eq!(*search_from_word, 0);
    let found: Vec<usize> = candidates.iter().map(|c| c.first_word).collect();
    assert_eq!(found, vec![0, 4, 9]);
    assert!(candidates.iter().all(|c| c.kind == CandidateKind::InRange));
    assert_eq!(candidates[1].text, "open");
    assert_eq!(candidates[1].text_offset, 21);
}

/// Occurrences per step, and the first word each resolves to.
type OccurrenceCase<'a> = (&'a [Option<u32>], &'a [Option<usize>]);
/// (first word, last word, anchor word, target us).
type MatchShape = (usize, usize, usize, i64);

#[test]
fn occurrence_is_counted_after_the_previous_match() {
    let table: &[OccurrenceCase] = &[
        (&[Some(0), Some(0), Some(0)], &[Some(0), Some(4), Some(9)]),
        (&[Some(1), Some(0)], &[Some(4), Some(9)]),
        (&[Some(2)], &[Some(9)]),
        (&[Some(0), Some(1)], &[Some(0), Some(9)]),
    ];
    for &(occurrences, expected) in table {
        let cues: Vec<Option<Cue>> = occurrences
            .iter()
            .map(|n| n.map(|n| Cue::new("open").nth(n)))
            .collect();
        let resolved = resolve(&words(), &cues).unwrap();
        assert_eq!(first_words(&resolved), expected, "{occurrences:?}");
    }
}

#[test]
fn occurrence_past_the_end_reports_available_count() {
    let cues = [Some(Cue::new("open").nth(1)), Some(Cue::new("open").nth(1))];
    let errors = resolve(&words(), &cues).unwrap_err();
    let [CueError::OccurrenceOutOfRange {
        step_index,
        occurrence,
        available,
        search_from_word,
        candidates,
        ..
    }] = errors.as_slice()
    else {
        panic!("expected out of range, got {errors:?}");
    };
    assert_eq!(
        (*step_index, *occurrence, *available, *search_from_word),
        (1, 1, 1, 5)
    );
    let kinds: Vec<(usize, CandidateKind)> =
        candidates.iter().map(|c| (c.first_word, c.kind)).collect();
    assert_eq!(
        kinds,
        vec![
            (4, CandidateKind::BeforeSearchStart),
            (9, CandidateKind::InRange),
            (0, CandidateKind::BeforeSearchStart),
        ]
    );
}

#[test]
fn uncued_steps_do_not_move_the_search_position() {
    let cues = [
        Some(Cue::new("open").nth(0)),
        None,
        Some(Cue::new("open").nth(0)),
    ];
    let resolved = resolve(&words(), &cues).unwrap();
    assert_eq!(first_words(&resolved), vec![Some(0), None, Some(4)]);
}

#[test]
fn ambiguity_is_judged_only_after_the_previous_match() {
    // "settings" consumes word 6; "open" is then unique (word 9).
    let cues = [Some(Cue::new("settings")), Some(Cue::new("open"))];
    let resolved = resolve(&words(), &cues).unwrap();
    assert_eq!(first_words(&resolved), vec![Some(6), Some(9)]);
}

#[test]
fn multiword_cues_and_anchors() {
    let w = words();
    let cases: &[(Cue, MatchShape)] = &[
        (Cue::new("settings panel"), (6, 7, 6, 2_400_000)),
        (Cue::new("Settings  Panel,").at_end(), (6, 7, 7, 3_100_000)),
        (Cue::new("the panel"), (1, 2, 1, 400_000)),
        (
            Cue::new("then").offset(Micros::from_millis(-100)),
            (3, 3, 3, 1_100_000),
        ),
        (
            Cue::new("again").at_end().offset(Micros::from_millis(80)),
            (11, 11, 11, 4_780_000),
        ),
    ];
    for (cue, (first, last, anchor, target)) in cases {
        let resolved = resolve(&w, &[Some(cue.clone())]).unwrap();
        assert_eq!(
            resolved[0],
            Some(CueMatch {
                first_word: *first,
                last_word: *last,
                anchor_word: *anchor,
                target_us: Micros(*target),
            }),
            "{cue:?}"
        );
    }
}

#[test]
fn missing_cue_lists_near_misses() {
    let errors = resolve(&words(), &[Some(Cue::new("pannel"))]).unwrap_err();
    let [CueError::NotFound { candidates, .. }] = errors.as_slice() else {
        panic!("expected not found, got {errors:?}");
    };
    let found: Vec<(usize, CandidateKind)> =
        candidates.iter().map(|c| (c.first_word, c.kind)).collect();
    assert_eq!(
        found,
        vec![
            (2, CandidateKind::NearMiss { distance: 1 }),
            (7, CandidateKind::NearMiss { distance: 1 }),
        ]
    );
}

#[test]
fn missing_multiword_cue_lists_partial_phrases() {
    let errors = resolve(&words(), &[Some(Cue::new("settings menu"))]).unwrap_err();
    let [CueError::NotFound { candidates, .. }] = errors.as_slice() else {
        panic!("expected not found, got {errors:?}");
    };
    assert_eq!(candidates[0].first_word, 6);
    assert_eq!(candidates[0].kind, CandidateKind::PartialPhrase);
}

#[test]
fn cue_before_the_search_position_is_reported_as_such() {
    let cues = [Some(Cue::new("settings")), Some(Cue::new("then"))];
    let errors = resolve(&words(), &cues).unwrap_err();
    let [CueError::NotFound {
        step_index,
        search_from_word,
        candidates,
        ..
    }] = errors.as_slice()
    else {
        panic!("expected not found, got {errors:?}");
    };
    assert_eq!((*step_index, *search_from_word), (1, 7));
    assert_eq!(candidates[0].first_word, 3);
    assert_eq!(candidates[0].kind, CandidateKind::BeforeSearchStart);
}

#[test]
fn every_error_is_collected() {
    let cues = [
        Some(Cue::new("\u{2014}")),
        Some(Cue::new("dashboard")),
        Some(Cue::new("then")),
        Some(Cue::new("open")),
    ];
    let errors = resolve(&words(), &cues).unwrap_err();
    assert!(matches!(errors[0], CueError::Empty { step_index: 0, .. }));
    assert!(matches!(
        &errors[1],
        CueError::NotFound { step_index: 1, candidates, .. } if candidates.is_empty()
    ));
    // "then" resolved (word 3), so "open" is judged from word 4: ambiguous (4, 9).
    assert!(matches!(
        errors[2],
        CueError::Ambiguous {
            step_index: 3,
            search_from_word: 4,
            ..
        }
    ));
    assert_eq!(errors.len(), 3);
}

#[test]
fn digits_do_not_match_number_words() {
    let w = words_from("Click 3 times", 200, 0);
    assert!(resolve(&w, &[Some(Cue::new("three"))]).is_err());
    assert_eq!(
        first_words(&resolve(&w, &[Some(Cue::new("3"))]).unwrap()),
        vec![Some(1)]
    );
}

#[test]
fn hyphenated_words_match_either_tokenization() {
    let split = words_from("drag and drop", 200, 0);
    let joined = words_from("Drag\u{2011}and\u{2011}drop it", 200, 0);
    let m = resolve(&split, &[Some(Cue::new("drag-and-drop").at_end())]).unwrap()[0].unwrap();
    assert_eq!((m.first_word, m.last_word, m.anchor_word), (0, 2, 2));
    let m = resolve(&joined, &[Some(Cue::new("drag and drop"))]).unwrap()[0].unwrap();
    assert_eq!((m.first_word, m.last_word), (0, 0));
    // Word-aligned: "and" never matches inside a hyphenated word.
    assert!(resolve(&joined, &[Some(Cue::new("and"))]).is_err());
    assert!(resolve(&joined, &[Some(Cue::new("drag and"))]).is_err());
}

#[test]
fn curly_quotes_and_case_fold() {
    let w = words_from("\u{201C}Don\u{2019}t STOP\u{201D} now", 200, 0);
    let m = resolve(&w, &[Some(Cue::new("don't stop"))]).unwrap()[0].unwrap();
    assert_eq!((m.first_word, m.last_word), (0, 1));
}

#[test]
fn cue_errors_serialize_with_kind_tags() {
    let errors = resolve(&words(), &[Some(Cue::new("pannel"))]).unwrap_err();
    let json = serde_json::to_value(&errors[0]).unwrap();
    assert_eq!(json["kind"], "notFound");
    assert_eq!(json["searchFromWord"], 0);
    assert_eq!(json["candidates"][0]["kind"], "nearMiss");
    assert_eq!(json["candidates"][0]["distance"], 1);
    let cue: Cue = serde_json::from_str(r#"{"text":"open"}"#).unwrap();
    assert_eq!(cue, Cue::new("open"));
}
