//! Cue resolution: map each step's cue phrase to narration words.
//!
//! A [`Cue`] is a phrase of one or more tokens, an optional occurrence index,
//! an anchor (start of its first word or end of its last word) and an offset.
//!
//! **Occurrence semantics.** Matches are searched only *after* the previous
//! cued step's match: from the word following that match's last word (word 0
//! for the first cued step). `occurrence: Some(n)` picks the n-th (0-based)
//! match in that range. `occurrence: None` requires exactly one match in that
//! range and reports [`CueError::Ambiguous`] otherwise. Because every search
//! starts after the previous match, resolved cues are strictly monotonic in
//! word order. Steps without a cue do not move the search position.
//!
//! Matches are word-aligned: a phrase must start on a word's first sub-token
//! and end on a word's last sub-token, so `and` never matches inside
//! `drag-and-drop`. See [`super::text`] for normalization.

use super::text::{edit_distance, sub_tokens};
use super::units::Micros;
use super::words::WordTiming;
use serde::{Deserialize, Serialize};
use std::fmt;

const MAX_CANDIDATES: usize = 8;

/// Which edge of the matched phrase the step's target time follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CueAnchor {
    /// Start of the phrase's first word.
    #[default]
    WordStart,
    /// End of the phrase's last word.
    WordEnd,
}

/// Ties a step to a spoken phrase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence: Option<u32>,
    #[serde(default)]
    pub anchor: CueAnchor,
    #[serde(default)]
    pub offset_us: Micros,
}

impl Cue {
    pub fn new(text: impl Into<String>) -> Self {
        Cue {
            text: text.into(),
            occurrence: None,
            anchor: CueAnchor::WordStart,
            offset_us: Micros::ZERO,
        }
    }

    pub fn nth(mut self, occurrence: u32) -> Self {
        self.occurrence = Some(occurrence);
        self
    }

    pub fn at_end(mut self) -> Self {
        self.anchor = CueAnchor::WordEnd;
        self
    }

    pub fn offset(mut self, offset_us: Micros) -> Self {
        self.offset_us = offset_us;
        self
    }
}

/// A resolved cue: the matched words and the target narration instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueMatch {
    pub first_word: usize,
    pub last_word: usize,
    pub anchor_word: usize,
    /// Anchor word edge plus the cue offset, on the narration clock.
    pub target_us: Micros,
}

/// Why a phrase is suggested in a diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CandidateKind {
    /// The full phrase, but before the search position.
    BeforeSearchStart,
    /// The full phrase, inside the search range.
    InRange,
    /// Only the first token of a multiword phrase matches.
    PartialPhrase,
    /// A word within a small edit distance of the first token.
    NearMiss { distance: usize },
}

/// A nearby phrase a caller can offer as a fix.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueCandidate {
    pub first_word: usize,
    pub last_word: usize,
    pub text: String,
    pub text_offset: usize,
    pub start_us: Micros,
    #[serde(flatten)]
    pub kind: CandidateKind,
}

/// A cue that could not be resolved, with suggestions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CueError {
    /// The cue text normalizes to no tokens.
    Empty { step_index: usize, cue: String },
    /// No match at or after `search_from_word`.
    NotFound {
        step_index: usize,
        cue: String,
        search_from_word: usize,
        candidates: Vec<CueCandidate>,
    },
    /// Fewer than `occurrence + 1` matches in range.
    OccurrenceOutOfRange {
        step_index: usize,
        cue: String,
        occurrence: u32,
        available: usize,
        search_from_word: usize,
        candidates: Vec<CueCandidate>,
    },
    /// More than one match in range and no occurrence given.
    Ambiguous {
        step_index: usize,
        cue: String,
        search_from_word: usize,
        candidates: Vec<CueCandidate>,
    },
}

/// Every unresolved cue, so authors can fix them in one pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueResolutionError {
    pub errors: Vec<CueError>,
}

impl fmt::Display for CueResolutionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} cue(s) could not be resolved", self.errors.len())?;
        for error in &self.errors {
            match error {
                CueError::Empty { step_index, cue } => {
                    write!(f, "; step {step_index}: cue {cue:?} is empty")?
                }
                CueError::NotFound {
                    step_index, cue, ..
                } => write!(f, "; step {step_index}: {cue:?} not found")?,
                CueError::OccurrenceOutOfRange {
                    step_index,
                    cue,
                    occurrence,
                    available,
                    ..
                } => write!(
                    f,
                    "; step {step_index}: {cue:?} occurrence {occurrence} requested, {available} available"
                )?,
                CueError::Ambiguous {
                    step_index, cue, ..
                } => write!(f, "; step {step_index}: {cue:?} is ambiguous")?,
            }
        }
        Ok(())
    }
}

impl std::error::Error for CueResolutionError {}

struct SubToken {
    word: usize,
    token: String,
    first_in_word: bool,
    last_in_word: bool,
}

/// Narration words flattened into normalized sub-tokens.
struct TokenStream<'a> {
    words: &'a [WordTiming],
    subs: Vec<SubToken>,
}

impl<'a> TokenStream<'a> {
    fn new(words: &'a [WordTiming]) -> Self {
        let mut subs = Vec::new();
        for (word, timing) in words.iter().enumerate() {
            let tokens = sub_tokens(&timing.text);
            let count = tokens.len();
            for (i, token) in tokens.into_iter().enumerate() {
                subs.push(SubToken {
                    word,
                    token,
                    first_in_word: i == 0,
                    last_in_word: i + 1 == count,
                });
            }
        }
        TokenStream { words, subs }
    }

    /// Every word-aligned match of `phrase`, as (first word, last word).
    fn find_all(&self, phrase: &[String]) -> Vec<(usize, usize)> {
        if phrase.is_empty() || phrase.len() > self.subs.len() {
            return Vec::new();
        }
        (0..=self.subs.len() - phrase.len())
            .filter_map(|start| {
                let window = &self.subs[start..start + phrase.len()];
                let first = &window[0];
                let last = &window[window.len() - 1];
                let aligned = first.first_in_word && last.last_in_word;
                let equal = window.iter().zip(phrase).all(|(s, p)| &s.token == p);
                (aligned && equal).then_some((first.word, last.word))
            })
            .collect()
    }

    fn candidate(&self, first: usize, last: usize, kind: CandidateKind) -> CueCandidate {
        let text = self.words[first..=last]
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        CueCandidate {
            first_word: first,
            last_word: last,
            text,
            text_offset: self.words[first].text_offset,
            start_us: self.words[first].start_us,
            kind,
        }
    }

    fn exact_candidates(&self, matches: &[(usize, usize)], from: usize) -> Vec<CueCandidate> {
        let mut candidates: Vec<CueCandidate> = matches
            .iter()
            .map(|&(first, last)| {
                let kind = if first < from {
                    CandidateKind::BeforeSearchStart
                } else {
                    CandidateKind::InRange
                };
                self.candidate(first, last, kind)
            })
            .collect();
        rank_by_proximity(&mut candidates, from);
        candidates
    }

    fn near_candidates(&self, phrase: &[String], from: usize) -> Vec<CueCandidate> {
        let head = &phrase[0];
        let max_distance = (head.chars().count() / 3).clamp(1, 2);
        let mut candidates = Vec::new();
        if phrase.len() > 1 {
            for (first, last) in self.find_all(std::slice::from_ref(head)) {
                candidates.push(self.candidate(first, last, CandidateKind::PartialPhrase));
            }
        }
        for sub in &self.subs {
            let distance = edit_distance(&sub.token, head);
            if distance > 0 && distance <= max_distance {
                candidates.push(self.candidate(
                    sub.word,
                    sub.word,
                    CandidateKind::NearMiss { distance },
                ));
            }
        }
        candidates.dedup_by(|a, b| a.first_word == b.first_word && a.kind == b.kind);
        rank_by_proximity(&mut candidates, from);
        candidates
    }

    fn target(&self, cue: &Cue, first: usize, last: usize) -> CueMatch {
        let (anchor_word, edge) = match cue.anchor {
            CueAnchor::WordStart => (first, self.words[first].start_us),
            CueAnchor::WordEnd => (last, self.words[last].end_us()),
        };
        CueMatch {
            first_word: first,
            last_word: last,
            anchor_word,
            target_us: edge + cue.offset_us,
        }
    }
}

fn rank_by_proximity(candidates: &mut Vec<CueCandidate>, from: usize) {
    candidates.sort_by_key(|c| (c.first_word.abs_diff(from), c.first_word));
    candidates.truncate(MAX_CANDIDATES);
}

/// Resolves cues in step order. `cues[i]` is step `i`'s cue (or `None`).
///
/// Returns one entry per step, or every error found. After an error the
/// search position is left unchanged so later cues are still checked.
pub fn resolve_cues(
    words: &[WordTiming],
    cues: &[Option<&Cue>],
) -> Result<Vec<Option<CueMatch>>, CueResolutionError> {
    let stream = TokenStream::new(words);
    let mut from = 0usize;
    let mut resolved = Vec::with_capacity(cues.len());
    let mut errors = Vec::new();

    for (step_index, cue) in cues.iter().enumerate() {
        let Some(cue) = cue else {
            resolved.push(None);
            continue;
        };
        let phrase = sub_tokens(&cue.text);
        if phrase.is_empty() {
            errors.push(CueError::Empty {
                step_index,
                cue: cue.text.clone(),
            });
            resolved.push(None);
            continue;
        }
        let all = stream.find_all(&phrase);
        let in_range: Vec<(usize, usize)> = all
            .iter()
            .copied()
            .filter(|&(first, _)| first >= from)
            .collect();

        let picked = match (cue.occurrence, in_range.len()) {
            (_, 0) => {
                let mut candidates = stream.exact_candidates(&all, from);
                if candidates.is_empty() {
                    candidates = stream.near_candidates(&phrase, from);
                }
                errors.push(CueError::NotFound {
                    step_index,
                    cue: cue.text.clone(),
                    search_from_word: from,
                    candidates,
                });
                None
            }
            (None, 1) => Some(in_range[0]),
            (None, _) => {
                errors.push(CueError::Ambiguous {
                    step_index,
                    cue: cue.text.clone(),
                    search_from_word: from,
                    candidates: stream.exact_candidates(&in_range, from),
                });
                None
            }
            (Some(n), available) => match in_range.get(n as usize) {
                Some(&found) => Some(found),
                None => {
                    errors.push(CueError::OccurrenceOutOfRange {
                        step_index,
                        cue: cue.text.clone(),
                        occurrence: n,
                        available,
                        search_from_word: from,
                        candidates: stream.exact_candidates(&all, from),
                    });
                    None
                }
            },
        };

        match picked {
            Some((first, last)) => {
                from = last + 1;
                resolved.push(Some(stream.target(cue, first, last)));
            }
            None => resolved.push(None),
        }
    }

    if errors.is_empty() {
        Ok(resolved)
    } else {
        Err(CueResolutionError { errors })
    }
}
