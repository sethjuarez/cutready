//! Narration word timings and silence insertion.

use super::text::{classify_boundary, BoundaryClass};
use super::units::Micros;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Where a word's timing came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WordSource {
    /// Speech synthesis word-boundary events.
    Tts,
    /// Forced alignment on the rendered audio.
    Aligned,
    /// Entered or corrected by a person.
    Manual,
}

/// One spoken word, timed on the narration audio's own clock.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordTiming {
    /// The word as it appears in the narration text.
    pub text: String,
    /// Character (Unicode scalar) offset of `text` in the plain narration,
    /// not in any SSML wrapper.
    pub text_offset: usize,
    pub start_us: Micros,
    pub duration_us: Micros,
    pub source: WordSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

impl WordTiming {
    pub fn end_us(&self) -> Micros {
        self.start_us + self.duration_us
    }
}

/// A request to lengthen the narration with silence so a step fits.
///
/// Silence goes after word `after_word_index` (every later word shifts by
/// `required_us`). `None` means before the first word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertSilence {
    pub after_word_index: Option<usize>,
    pub required_us: Micros,
}

/// Where to splice silence into the narration audio, on the clock of the
/// original (unshifted) words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceSplice {
    pub after_word_index: Option<usize>,
    /// Audio instant to cut at: the middle of the gap after the word, the end
    /// of the last word, or 0 for leading silence.
    pub at_us: Micros,
    pub duration_us: Micros,
}

/// Sums insertions at the same boundary and orders them (leading first).
pub fn merge_insertions(insertions: &[InsertSilence]) -> Vec<InsertSilence> {
    let mut merged: BTreeMap<Option<usize>, Micros> = BTreeMap::new();
    for insertion in insertions {
        if insertion.required_us > Micros::ZERO {
            *merged.entry(insertion.after_word_index).or_default() += insertion.required_us;
        }
    }
    merged
        .into_iter()
        .map(|(after_word_index, required_us)| InsertSilence {
            after_word_index,
            required_us,
        })
        .collect()
}

/// Total silence the insertions add.
pub fn total_silence(insertions: &[InsertSilence]) -> Micros {
    insertions
        .iter()
        .filter(|i| i.required_us > Micros::ZERO)
        .fold(Micros::ZERO, |acc, i| acc + i.required_us)
}

/// Returns `words` with every word after each insertion point shifted later.
/// Non-positive insertions are ignored. Durations never change.
pub fn apply_silence(words: &[WordTiming], insertions: &[InsertSilence]) -> Vec<WordTiming> {
    let merged = merge_insertions(insertions);
    words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            let shift = merged
                .iter()
                .filter(|i| i.after_word_index.is_none_or(|after| after < index))
                .fold(Micros::ZERO, |acc, i| acc + i.required_us);
            WordTiming {
                start_us: word.start_us + shift,
                ..word.clone()
            }
        })
        .collect()
}

/// Converts insertions into audio splice points on the original words' clock.
pub fn silence_splices(words: &[WordTiming], insertions: &[InsertSilence]) -> Vec<SilenceSplice> {
    merge_insertions(insertions)
        .into_iter()
        .map(|insertion| {
            let at_us = match insertion.after_word_index {
                None => Micros::ZERO,
                Some(index) => match (words.get(index), words.get(index + 1)) {
                    (Some(word), Some(next)) => {
                        let end = word.end_us();
                        let next_start = next.start_us.0.max(end.0);
                        Micros(end.0 + (next_start - end.0) / 2)
                    }
                    (Some(word), None) => word.end_us(),
                    (None, _) => words.last().map_or(Micros::ZERO, WordTiming::end_us),
                },
            };
            SilenceSplice {
                after_word_index: insertion.after_word_index,
                at_us,
                duration_us: insertion.required_us,
            }
        })
        .collect()
}

/// Classifies the pause after word `index` using the plain narration text
/// between it and the next word, and any punctuation the word itself carries.
pub fn boundary_after(narration: &[char], words: &[WordTiming], index: usize) -> BoundaryClass {
    let Some(word) = words.get(index) else {
        return BoundaryClass::Word;
    };
    let trailing: String = word
        .text
        .chars()
        .rev()
        .take_while(|c| !c.is_alphanumeric())
        .collect();
    let own = classify_boundary(&trailing);
    let end = word.text_offset.saturating_add(word.text.chars().count());
    let next = words
        .get(index + 1)
        .map_or(narration.len(), |w| w.text_offset)
        .min(narration.len());
    let between = if end < next {
        classify_boundary(&narration[end..next].iter().collect::<String>())
    } else {
        BoundaryClass::Word
    };
    own.max(between)
}
