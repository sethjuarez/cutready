use super::*;

fn s(words: &str) -> Vec<String> {
    words.split_whitespace().map(String::from).collect()
}

#[test]
fn exact_alignment_has_zero_wer() {
    let r = s("Here is the home page.");
    let al = align(&r, &s("Here is the home page"));
    assert_eq!(al.wer, 0.0);
    assert!(al.refs.iter().all(|m| matches!(m, RefMatch::Exact { .. })));
}

#[test]
fn recognizer_merge_maps_both_words() {
    let r = s("open the home page now");
    let al = align(&r, &s("open the homepage. now"));
    assert_eq!(al.refs[2], RefMatch::MergedFirst { hyp: 2 });
    assert_eq!(al.refs[3], RefMatch::MergedSecond { hyp: 2 });
    assert_eq!(al.refs[4], RefMatch::Exact { hyp: 3 });
    assert_eq!(al.wer, 0.0);
    assert_eq!(cue_token(&al, 2), Ok(2));
    assert_eq!(cue_token(&al, 3), Err(WordProblem::MergedIntoPrevious));
}

#[test]
fn recognizer_split_maps_to_first_token() {
    let r = s("use playwright today");
    let al = align(&r, &s("use play wright today"));
    assert_eq!(al.refs[1], RefMatch::Split { hyp: 1 });
    assert_eq!(al.refs[2], RefMatch::Exact { hyp: 3 });
}

#[test]
fn spelling_slip_is_fuzzy_and_reported() {
    let r = s("then scroll down");
    let hyp = s("then scrol down");
    let al = align(&r, &hyp);
    assert_eq!(al.refs[1], RefMatch::Fuzzy { hyp: 1 });
    let words: Vec<SttWord> = hyp
        .iter()
        .map(|t| SttWord {
            text: t.clone(),
            start_ms: 0.0,
            duration_ms: 0.0,
        })
        .collect();
    let issues = content_issues(&r, &words, &al);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].kind, "misheard");
}

#[test]
fn missing_and_inserted_words_count_in_wer() {
    let r = s("click the big button");
    let al = align(&r, &s("click the button um"));
    assert_eq!(al.refs[2], RefMatch::Missing);
    assert_eq!(al.inserted, vec![3]);
    assert!((al.wer - 0.5).abs() < 1e-9);
}

#[test]
fn cue_with_unheard_neighbour_is_weak() {
    let r = s("now type a name");
    let al = align(&r, &s("type a name"));
    assert_eq!(al.refs[0], RefMatch::Missing);
    assert_eq!(cue_token(&al, 1), Err(WordProblem::WeakContext));
    assert_eq!(cue_token(&al, 2), Ok(1));
}

#[test]
fn repeated_word_aligns_to_the_right_occurrence() {
    let r = s("scroll down then scroll again");
    let al = align(&r, &s("scroll down then scroll again"));
    assert_eq!(cue_token(&al, 3), Ok(3));
    let al = align(&r, &s("down then scroll again"));
    assert_eq!(al.refs[0], RefMatch::Missing);
    assert_eq!(al.refs[3], RefMatch::Exact { hyp: 2 });
}

#[test]
fn punctuation_only_words_are_silent() {
    let r = s("hello — world");
    let al = align(&r, &s("hello world"));
    assert_eq!(al.refs[1], RefMatch::Silent);
    assert_eq!(cue_token(&al, 2), Ok(1));
    assert_eq!(al.wer, 0.0);
}

#[test]
fn pause_detection_uses_transcript_gaps() {
    let w = |start_ms: f64, duration_ms: f64| SttWord {
        text: "x".into(),
        start_ms,
        duration_ms,
    };
    let words = vec![w(0.0, 200.0), w(220.0, 100.0), w(500.0, 100.0)];
    let first = vec![true, false, false];
    assert!(after_pause(&words, &first, 0, 100.0));
    assert!(!after_pause(&words, &first, 1, 100.0));
    assert!(after_pause(&words, &first, 2, 100.0));
}
