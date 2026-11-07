//! Shared fixtures for demo timing tests.

use super::units::Micros;
use super::words::{WordSource, WordTiming};

/// Words for every whitespace-separated token of `narration`, each
/// `word_ms` long with `gap_ms` between them, starting at 0.
pub(super) fn words_from(narration: &str, word_ms: i64, gap_ms: i64) -> Vec<WordTiming> {
    let mut words = Vec::new();
    let mut start: Option<usize> = None;
    let chars: Vec<char> = narration.chars().collect();
    for (i, c) in chars.iter().chain(std::iter::once(&' ')).enumerate() {
        match (c.is_whitespace(), start) {
            (false, None) => start = Some(i),
            (true, Some(s)) => {
                let index = words.len() as i64;
                words.push(WordTiming {
                    text: chars[s..i].iter().collect(),
                    text_offset: s,
                    start_us: Micros::from_millis(index * (word_ms + gap_ms)),
                    duration_us: Micros::from_millis(word_ms),
                    source: WordSource::Tts,
                    confidence: None,
                });
                start = None;
            }
            _ => {}
        }
    }
    words
}

/// Tiny deterministic xorshift64* generator, so property loops need no deps.
pub(super) struct Rng(u64);

impl Rng {
    pub(super) fn new(seed: u64) -> Self {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub(super) fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform-ish integer in `[lo, hi]`.
    pub(super) fn range(&mut self, lo: i64, hi: i64) -> i64 {
        let width = (hi - lo + 1) as u64;
        lo + (self.next_u64() % width) as i64
    }
}
