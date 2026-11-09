//! Aligns an independent transcript of the final audio to the script's
//! narration words, so each cue word gets an observed time from the
//! transcript (not from the TTS word boundaries the planner used).
//!
//! The alignment is a global edit-distance DP over normalized tokens with
//! fuzzy matches (spelling slips) and 2:1 / 1:2 merges and splits
//! ("home page" ↔ "homepage"), so recognition errors degrade single words
//! instead of shifting the rest of the alignment.

use crate::engine::demo_timing::normalize_token;
use crate::engine::demo_timing::text::edit_distance;
use serde::{Deserialize, Serialize};

/// One recognized word on the final audio's clock (ms from its first sample).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttWord {
    pub text: String,
    pub start_ms: f64,
    pub duration_ms: f64,
}

/// How a reference (narration) word was found in the transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RefMatch {
    Exact {
        hyp: usize,
    },
    Fuzzy {
        hyp: usize,
    },
    /// This word and the next were recognized as one token (`hyp`).
    MergedFirst {
        hyp: usize,
    },
    /// The previous word and this one were recognized as one token.
    MergedSecond {
        hyp: usize,
    },
    /// This word was recognized as two tokens starting at `hyp`.
    Split {
        hyp: usize,
    },
    /// A different word was recognized in its place.
    Substituted {
        hyp: usize,
    },
    Missing,
    /// The narration word has no speakable token (punctuation only).
    Silent,
}

impl RefMatch {
    /// The transcript token whose start is this word's start, if any.
    pub fn start_token(self) -> Option<usize> {
        match self {
            RefMatch::Exact { hyp }
            | RefMatch::Fuzzy { hyp }
            | RefMatch::MergedFirst { hyp }
            | RefMatch::Split { hyp } => Some(hyp),
            _ => None,
        }
    }

    /// Whether the word was heard (in any form other than a different word).
    pub fn heard(self) -> bool {
        !matches!(
            self,
            RefMatch::Substituted { .. } | RefMatch::Missing | RefMatch::Silent
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alignment {
    /// One entry per reference word.
    pub refs: Vec<RefMatch>,
    /// Transcript tokens not matched to any reference word.
    pub inserted: Vec<usize>,
    /// Word error rate over speakable reference words
    /// (substitutions + deletions + insertions) / reference words.
    pub wer: f64,
}

/// Similarity in [0, 1] from character edit distance.
fn similarity(a: &str, b: &str) -> f64 {
    let longest = a.chars().count().max(b.chars().count());
    if longest == 0 {
        return 1.0;
    }
    1.0 - edit_distance(a, b) as f64 / longest as f64
}

const FUZZY_MIN: f64 = 0.75;
const MERGE_MIN: f64 = 0.85;

// Costs: exact 0, fuzzy/merge/split 1, deletion/insertion 2, substitution 3,
// so one substitution beats a deletion plus an insertion but a shifted
// run of substitutions doesn't.
const C_FUZZY: u32 = 1;
const C_JOIN: u32 = 1;
const C_EDIT: u32 = 2;
const C_SUB: u32 = 3;

#[derive(Clone, Copy)]
enum Step {
    Match(bool),
    Sub,
    Del,
    Ins,
    Merge,
    Split,
    Skip,
}

/// Aligns transcript tokens `hyp` to narration words `reference`.
pub fn align(reference: &[String], hyp: &[String]) -> Alignment {
    let r: Vec<String> = reference.iter().map(|w| normalize_token(w)).collect();
    let h: Vec<String> = hyp.iter().map(|w| normalize_token(w)).collect();
    let (n, m) = (r.len(), h.len());
    let inf = u32::MAX / 4;
    let mut cost = vec![vec![inf; m + 1]; n + 1];
    let mut back = vec![vec![Step::Skip; m + 1]; n + 1];
    cost[0][0] = 0;
    for i in 0..=n {
        for j in 0..=m {
            let here = cost[i][j];
            if here >= inf {
                continue;
            }
            let mut relax = |ni: usize, nj: usize, c: u32, s: Step| {
                if here + c < cost[ni][nj] {
                    cost[ni][nj] = here + c;
                    back[ni][nj] = s;
                }
            };
            if i < n && r[i].is_empty() {
                relax(i + 1, j, 0, Step::Skip);
                continue;
            }
            if j < m && h[j].is_empty() {
                relax(i, j + 1, 0, Step::Ins);
            }
            if i < n && j < m && !h[j].is_empty() {
                let sim = similarity(&r[i], &h[j]);
                if r[i] == h[j] {
                    relax(i + 1, j + 1, 0, Step::Match(true));
                } else if sim >= FUZZY_MIN {
                    relax(i + 1, j + 1, C_FUZZY, Step::Match(false));
                } else {
                    relax(i + 1, j + 1, C_SUB, Step::Sub);
                }
            }
            if i < n {
                relax(i + 1, j, C_EDIT, Step::Del);
            }
            if j < m && !h[j].is_empty() {
                relax(i, j + 1, C_EDIT, Step::Ins);
            }
            if i + 1 < n && j < m && !r[i + 1].is_empty() {
                let joined = format!("{}{}", r[i], r[i + 1]);
                if similarity(&joined, &h[j]) >= MERGE_MIN {
                    relax(i + 2, j + 1, C_JOIN, Step::Merge);
                }
            }
            if i < n && j + 1 < m && !h[j].is_empty() && !h[j + 1].is_empty() {
                let joined = format!("{}{}", h[j], h[j + 1]);
                if similarity(&r[i], &joined) >= MERGE_MIN {
                    relax(i + 1, j + 2, C_JOIN, Step::Split);
                }
            }
        }
    }

    let mut refs = vec![RefMatch::Missing; n];
    let mut inserted = Vec::new();
    let (mut i, mut j) = (n, m);
    let (mut subs, mut dels, mut ins) = (0usize, 0usize, 0usize);
    while i > 0 || j > 0 {
        match back[i][j] {
            Step::Match(exact) => {
                i -= 1;
                j -= 1;
                refs[i] = if exact {
                    RefMatch::Exact { hyp: j }
                } else {
                    RefMatch::Fuzzy { hyp: j }
                };
            }
            Step::Sub => {
                i -= 1;
                j -= 1;
                refs[i] = RefMatch::Substituted { hyp: j };
                subs += 1;
            }
            Step::Del => {
                i -= 1;
                refs[i] = RefMatch::Missing;
                dels += 1;
            }
            Step::Ins => {
                j -= 1;
                if !h[j].is_empty() {
                    inserted.push(j);
                    ins += 1;
                }
            }
            Step::Merge => {
                i -= 2;
                j -= 1;
                refs[i] = RefMatch::MergedFirst { hyp: j };
                refs[i + 1] = RefMatch::MergedSecond { hyp: j };
            }
            Step::Split => {
                i -= 1;
                j -= 2;
                refs[i] = RefMatch::Split { hyp: j };
            }
            Step::Skip => {
                i -= 1;
                refs[i] = RefMatch::Silent;
            }
        }
    }
    inserted.reverse();
    let speakable = r.iter().filter(|w| !w.is_empty()).count().max(1);
    Alignment {
        refs,
        inserted,
        wer: (subs + dels + ins) as f64 / speakable as f64,
    }
}

/// Why a cue word's transcript time can't be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WordProblem {
    NotHeard,
    /// Recognized merged into the previous word, so its own start is unknown.
    MergedIntoPrevious,
    /// Recognized merged into the next word, so its own end is unknown.
    MergedIntoNext,
    /// A neighbouring narration word wasn't heard, so the match may have
    /// landed on the wrong occurrence.
    WeakContext,
}

/// The transcript token that starts `ref_index`, if the alignment around it
/// is trustworthy: the word itself was heard as itself and its immediate
/// speakable neighbours were heard too.
pub fn cue_token(al: &Alignment, ref_index: usize) -> Result<usize, WordProblem> {
    let here = al.refs.get(ref_index).copied().unwrap_or(RefMatch::Missing);
    let token = match here {
        RefMatch::MergedSecond { .. } => return Err(WordProblem::MergedIntoPrevious),
        m => m.start_token().ok_or(WordProblem::NotHeard)?,
    };
    with_context(al, ref_index, token)
}

/// The transcript token that ends `ref_index`, with the same trust rules as
/// [`cue_token`]. A split word ends with its second token; a word merged
/// with the previous one ends where the merged token ends.
pub fn cue_end_token(al: &Alignment, ref_index: usize) -> Result<usize, WordProblem> {
    let here = al.refs.get(ref_index).copied().unwrap_or(RefMatch::Missing);
    let token = match here {
        RefMatch::Exact { hyp } | RefMatch::Fuzzy { hyp } | RefMatch::MergedSecond { hyp } => hyp,
        RefMatch::Split { hyp } => hyp + 1,
        RefMatch::MergedFirst { .. } => return Err(WordProblem::MergedIntoNext),
        _ => return Err(WordProblem::NotHeard),
    };
    with_context(al, ref_index, token)
}

fn with_context(al: &Alignment, ref_index: usize, token: usize) -> Result<usize, WordProblem> {
    let neighbour = |range: &mut dyn Iterator<Item = usize>| {
        range
            .map(|k| al.refs[k])
            .find(|m| *m != RefMatch::Silent)
            .is_none_or(RefMatch::heard)
    };
    let prev_ok = neighbour(&mut (0..ref_index).rev());
    let next_ok = neighbour(&mut (ref_index + 1..al.refs.len()));
    if prev_ok && next_ok {
        Ok(token)
    } else {
        Err(WordProblem::WeakContext)
    }
}

/// Content mismatches worth showing a reviewer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentIssue {
    pub kind: String,
    pub expected: Option<String>,
    pub heard: Option<String>,
    pub ref_index: Option<usize>,
}

pub fn content_issues(reference: &[String], hyp: &[SttWord], al: &Alignment) -> Vec<ContentIssue> {
    let mut out = Vec::new();
    for (i, m) in al.refs.iter().enumerate() {
        let issue = match *m {
            RefMatch::Missing => Some(("missing", None)),
            RefMatch::Substituted { hyp: j } => Some(("substituted", Some(hyp[j].text.clone()))),
            RefMatch::Fuzzy { hyp: j } => Some(("misheard", Some(hyp[j].text.clone()))),
            _ => None,
        };
        if let Some((kind, heard)) = issue {
            out.push(ContentIssue {
                kind: kind.into(),
                expected: Some(reference[i].clone()),
                heard,
                ref_index: Some(i),
            });
        }
    }
    for &j in &al.inserted {
        out.push(ContentIssue {
            kind: "inserted".into(),
            expected: None,
            heard: Some(hyp[j].text.clone()),
            ref_index: None,
        });
    }
    out
}

/// Whether transcript token `j` starts after a pause (or begins a phrase),
/// which changes the recognizer's start-time bias.
pub fn after_pause(words: &[SttWord], phrase_first: &[bool], j: usize, pause_ms: f64) -> bool {
    if j == 0 || phrase_first.get(j).copied().unwrap_or(false) {
        return true;
    }
    let prev = &words[j - 1];
    words[j].start_ms - (prev.start_ms + prev.duration_ms) >= pause_ms
}

#[cfg(test)]
#[path = "align_tests.rs"]
mod tests;
