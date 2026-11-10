//! Token normalization for cue matching.
//!
//! Rules (applied per whitespace-separated token):
//! 1. Curly/prime apostrophes fold to `'`, curly quotes fold to `"`, and every
//!    Unicode hyphen or dash folds to `-`.
//! 2. Unicode-aware lowercase ([`str::to_lowercase`]).
//! 3. Leading and trailing characters that are neither alphanumeric nor a
//!    combining mark are stripped (`"Panel,"` → `panel`, `'open'` → `open`).
//!    Inner apostrophes and hyphens survive (`don't`, `drag-and-drop`).
//! 4. For matching, a token is split on `-` into sub-tokens so a cue
//!    `drag-and-drop` matches whether the voice reported one word or three.
//!
//! Digits are never mapped to number words (`3` does not match `three`).
//! No Unicode normalization form is applied (std has none); precomposed and
//! decomposed accents therefore differ, which callers should avoid upstream.

/// Normalizes one token for comparison. Returns an empty string for
/// punctuation-only tokens.
pub fn normalize_token(raw: &str) -> String {
    let folded: String = raw.chars().map(fold_char).collect();
    folded
        .to_lowercase()
        .trim_matches(|c: char| !is_word_char(c))
        .to_string()
}

/// Splits free text (a cue phrase or one narration word) into normalized,
/// non-empty sub-tokens.
pub fn sub_tokens(text: &str) -> Vec<String> {
    text.split_whitespace()
        .flat_map(|token| {
            normalize_token(token)
                .split('-')
                .map(normalize_token)
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn fold_char(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{2032}' | '\u{FF07}'
        | '\u{02BC}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' | '\u{2033}' | '\u{FF02}' => '"',
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
        | '\u{2212}' | '\u{FE58}' | '\u{FE63}' | '\u{FF0D}' => '-',
        other => other,
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || is_combining_mark(c)
}

fn is_combining_mark(c: char) -> bool {
    matches!(
        c,
        '\u{0300}'..='\u{036F}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{FE20}'..='\u{FE2F}'
    )
}

/// Character-level Levenshtein distance, used only to suggest near misses.
pub fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let substitution = prev[j] + usize::from(ca != cb);
            cur[j + 1] = substitution.min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Strength of a pause point between two narration words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BoundaryClass {
    Word,
    Clause,
    Sentence,
}

/// Classifies the punctuation in `between` (text between two words, plus any
/// punctuation the left word carried itself).
pub fn classify_boundary(between: &str) -> BoundaryClass {
    if between
        .chars()
        .any(|c| matches!(c, '.' | '!' | '?' | '…' | '。' | '！' | '？'))
    {
        BoundaryClass::Sentence
    } else if between.chars().any(|c| {
        matches!(
            c,
            ',' | ';' | ':' | ')' | '\u{2013}' | '\u{2014}' | '，' | '；'
        )
    }) {
        BoundaryClass::Clause
    } else {
        BoundaryClass::Word
    }
}
