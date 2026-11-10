//! Narration synthesis through the sidecar's `tts.synthesize`, converted to
//! the timing core's [`WordTiming`]s.
//!
//! Word-boundary ticks (100 ns) are relative to audio sample 0, leading
//! silence included (measured in the calibration spike), so the narration
//! clock *is* the WAV sample clock and nothing is subtracted.

use crate::engine::demo_timing::{Micros, WordSource, WordTiming};
use serde::{Deserialize, Serialize};

/// One boundary event as the sidecar reports it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawBoundary {
    pub text: String,
    pub audio_offset_ticks: i64,
    pub duration_ticks: i64,
    #[serde(default)]
    pub boundary_type: Option<String>,
    /// UTF-16 index into the plain narration (JavaScript string index).
    #[serde(default)]
    pub plain_offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesisResult {
    pub audio_path: String,
    #[serde(default)]
    pub audio_duration_ms: Option<f64>,
    #[serde(default)]
    pub voice: Option<String>,
    pub words: Vec<RawBoundary>,
}

/// Converts a UTF-16 code-unit index into a Unicode scalar (char) index.
pub fn utf16_to_char_offset(text: &str, utf16: usize) -> Option<usize> {
    let mut units = 0usize;
    for (i, c) in text.chars().enumerate() {
        if units == utf16 {
            return Some(i);
        }
        units += c.len_utf16();
        if units > utf16 {
            return None;
        }
    }
    (units == utf16).then(|| text.chars().count())
}

/// 100 ns ticks to whole microseconds (ticks are multiples of 10 in practice).
pub fn ticks_to_us(ticks: i64) -> Micros {
    Micros(ticks.div_euclid(10))
}

/// Keeps word boundaries (drops punctuation/sentence events) and maps them
/// onto the plain narration.
pub fn words_from_boundaries(
    narration: &str,
    raw: &[RawBoundary],
) -> Result<Vec<WordTiming>, String> {
    raw.iter()
        .filter(|b| b.boundary_type.as_deref().unwrap_or("WordBoundary") == "WordBoundary")
        .map(|b| {
            let utf16 = b
                .plain_offset
                .ok_or_else(|| format!("word {:?} has no offset in the narration text", b.text))?;
            let text_offset = utf16_to_char_offset(narration, utf16)
                .ok_or_else(|| format!("word {:?} offset {utf16} splits a character", b.text))?;
            Ok(WordTiming {
                text: b.text.clone(),
                text_offset,
                start_us: ticks_to_us(b.audio_offset_ticks),
                duration_us: ticks_to_us(b.duration_ticks),
                source: WordSource::Tts,
                confidence: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boundary(text: &str, ticks: i64, kind: &str, off: Option<usize>) -> RawBoundary {
        RawBoundary {
            text: text.into(),
            audio_offset_ticks: ticks,
            duration_ticks: 2_000_000,
            boundary_type: Some(kind.into()),
            plain_offset: off,
        }
    }

    #[test]
    fn utf16_offsets_map_to_chars() {
        let text = "a😀 b café";
        assert_eq!(utf16_to_char_offset(text, 0), Some(0));
        assert_eq!(utf16_to_char_offset(text, 1), Some(1));
        assert_eq!(utf16_to_char_offset(text, 2), None); // inside the surrogate pair
        assert_eq!(utf16_to_char_offset(text, 4), Some(3));
        assert_eq!(utf16_to_char_offset(text, 6), Some(5));
        assert_eq!(utf16_to_char_offset(text, 10), Some(9));
        assert_eq!(utf16_to_char_offset(text, 11), None);
    }

    #[test]
    fn keeps_words_and_converts_ticks() {
        let text = "😀 Open it.";
        let raw = [
            boundary("Open", 1_750_000, "WordBoundary", Some(3)),
            boundary("it", 4_000_000, "WordBoundary", Some(8)),
            boundary(".", 5_000_000, "PunctuationBoundary", Some(10)),
        ];
        let words = words_from_boundaries(text, &raw).unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text_offset, 2);
        assert_eq!(words[0].start_us, Micros(175_000));
        assert_eq!(words[0].duration_us, Micros(200_000));
        assert_eq!(words[1].text_offset, 7);
        let missing = [boundary("x", 0, "WordBoundary", None)];
        assert!(words_from_boundaries(text, &missing).is_err());
    }
}
