//! Narration audio: PCM16 WAV IO, silence splicing, and an independent
//! cue-word locator used by the audit.
//!
//! The planner names silences on the *original* narration clock
//! ([`SilenceSplice::at_us`]). Splicing rounds each to a sample, so the
//! actually inserted durations are recorded and reported, not assumed.
//!
//! The audit must not trust the planner's word times, so
//! [`locate_word_edge`] finds where a word's original audio really sits in
//! the final (decoded MP4) audio by normalized cross-correlation.

use crate::engine::demo_timing::{Micros, SilenceSplice};
use serde::{Deserialize, Serialize};

/// Mono or interleaved 16-bit PCM.
#[derive(Debug, Clone, PartialEq)]
pub struct Pcm {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<i16>,
}

impl Pcm {
    pub fn frames(&self) -> usize {
        self.samples.len() / usize::from(self.channels.max(1))
    }

    pub fn duration_us(&self) -> Micros {
        Micros(samples_to_us(self.frames() as i64, self.sample_rate))
    }

    /// Mono `f32` samples (channels averaged).
    pub fn mono_f32(&self) -> Vec<f32> {
        let ch = usize::from(self.channels.max(1));
        self.samples
            .chunks_exact(ch)
            .map(|c| c.iter().map(|&s| f32::from(s)).sum::<f32>() / ch as f32)
            .collect()
    }
}

pub fn us_to_samples(us: i64, rate: u32) -> i64 {
    // Round half away from zero; times here are non-negative.
    (i128::from(us) * i128::from(rate) + 500_000).div_euclid(1_000_000) as i64
}

pub fn samples_to_us(samples: i64, rate: u32) -> i64 {
    (i128::from(samples) * 1_000_000 / i128::from(rate)) as i64
}

fn u16_at(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}

/// Parses a RIFF/WAVE PCM16 file.
pub fn parse_wav(bytes: &[u8]) -> Result<Pcm, String> {
    if bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut pos = 12;
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32_at(bytes, pos + 4).ok_or("truncated chunk")? as usize;
        let body = pos + 8;
        let end = body.saturating_add(size).min(bytes.len());
        if id == b"fmt " {
            fmt = Some((
                u16_at(bytes, body).ok_or("truncated fmt")?,
                u16_at(bytes, body + 2).ok_or("truncated fmt")?,
                u32_at(bytes, body + 4).ok_or("truncated fmt")?,
                u16_at(bytes, body + 14).ok_or("truncated fmt")?,
            ));
        } else if id == b"data" {
            let (format, channels, sample_rate, bits) = fmt.ok_or("data before fmt")?;
            if format != 1 || bits != 16 || channels == 0 || sample_rate == 0 {
                return Err(format!(
                    "unsupported WAV: format {format}, {bits} bits, {channels} ch"
                ));
            }
            let samples = bytes[body..end]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&c| i16::from_le_bytes(c))
                .collect();
            return Ok(Pcm {
                sample_rate,
                channels,
                samples,
            });
        }
        pos = body + size + (size & 1);
    }
    Err("WAV has no data chunk".into())
}

pub fn encode_wav(pcm: &Pcm) -> Vec<u8> {
    let data_len = (pcm.samples.len() * 2) as u32;
    let block = pcm.channels * 2;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&pcm.channels.to_le_bytes());
    out.extend_from_slice(&pcm.sample_rate.to_le_bytes());
    out.extend_from_slice(&(pcm.sample_rate * u32::from(block)).to_le_bytes());
    out.extend_from_slice(&block.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in &pcm.samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// A splice as applied: where (original sample frame) and how much.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedSplice {
    pub at_sample: i64,
    pub inserted_samples: i64,
    pub at_us: Micros,
    pub inserted_us: Micros,
}

/// Inserts zero samples at each splice point (original clock).
pub fn splice_silence(pcm: &Pcm, splices: &[SilenceSplice]) -> (Pcm, Vec<AppliedSplice>) {
    let ch = usize::from(pcm.channels.max(1));
    let total = pcm.frames() as i64;
    let mut applied: Vec<AppliedSplice> = splices
        .iter()
        .filter(|s| s.duration_us > Micros::ZERO)
        .map(|s| {
            let at_sample = us_to_samples(s.at_us.get(), pcm.sample_rate).clamp(0, total);
            let inserted_samples = us_to_samples(s.duration_us.get(), pcm.sample_rate);
            AppliedSplice {
                at_sample,
                inserted_samples,
                at_us: Micros(samples_to_us(at_sample, pcm.sample_rate)),
                inserted_us: Micros(samples_to_us(inserted_samples, pcm.sample_rate)),
            }
        })
        .collect();
    applied.sort_by_key(|a| a.at_sample);
    let extra: i64 = applied.iter().map(|a| a.inserted_samples).sum();
    let mut out = Vec::with_capacity(pcm.samples.len() + extra as usize * ch);
    let mut cursor = 0usize;
    for a in &applied {
        let at = a.at_sample as usize * ch;
        out.extend_from_slice(&pcm.samples[cursor..at]);
        out.resize(out.len() + a.inserted_samples as usize * ch, 0);
        cursor = at;
    }
    out.extend_from_slice(&pcm.samples[cursor..]);
    (
        Pcm {
            sample_rate: pcm.sample_rate,
            channels: pcm.channels,
            samples: out,
        },
        applied,
    )
}

/// Maps an original-clock instant through applied splices. A splice at
/// exactly `t` shifts it (the silence goes before the word that starts there).
pub fn shift_through_splices(t: Micros, applied: &[AppliedSplice], rate: u32) -> Micros {
    let sample = us_to_samples(t.get(), rate);
    let shift: i64 = applied
        .iter()
        .filter(|a| a.at_sample <= sample)
        .map(|a| a.inserted_samples)
        .sum();
    Micros(samples_to_us(sample + shift, rate))
}

/// Box-filter decimation to reduce cross-correlation cost.
pub fn decimate(samples: &[f32], factor: usize) -> Vec<f32> {
    let factor = factor.max(1);
    samples
        .chunks(factor)
        .map(|c| c.iter().sum::<f32>() / c.len() as f32)
        .collect()
}

/// Best normalized cross-correlation of `needle` within `hay`, for lags in
/// `[lo, hi]`. Returns `(lag, score)`; score is in `[-1, 1]`.
pub fn best_match(needle: &[f32], hay: &[f32], lo: usize, hi: usize) -> Option<(usize, f32)> {
    let n = needle.len();
    if n == 0 || hay.len() < n {
        return None;
    }
    let hi = hi.min(hay.len() - n);
    if lo > hi {
        return None;
    }
    let needle_norm = needle.iter().map(|x| x * x).sum::<f32>().sqrt();
    if needle_norm == 0.0 {
        return None;
    }
    let mut best: Option<(usize, f32)> = None;
    for lag in lo..=hi {
        let seg = &hay[lag..lag + n];
        let (mut dot, mut energy) = (0f32, 0f32);
        for (a, b) in needle.iter().zip(seg) {
            dot += a * b;
            energy += b * b;
        }
        if energy == 0.0 {
            continue;
        }
        let score = dot / (needle_norm * energy.sqrt());
        if best.is_none_or(|(_, s)| score > s) {
            best = Some((lag, score));
        }
    }
    best
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge {
    Start,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedEdge {
    pub us: Micros,
    pub score: f32,
}

/// Locates a word edge of the original narration in the final audio.
///
/// The needle is `window_us` of original audio starting at the edge
/// (`Start`) or ending at it (`End`), so silence inserted on the far side of
/// the edge never enters the needle. The search covers `expected ± radius`.
/// Both signals are decimated by `factor` (resolution = factor / rate).
#[allow(clippy::too_many_arguments)]
pub fn locate_word_edge(
    original: &[f32],
    final_audio: &[f32],
    rate: u32,
    edge_us: Micros,
    edge: Edge,
    expected_us: Micros,
    window_us: Micros,
    radius_us: Micros,
    factor: usize,
) -> Option<LocatedEdge> {
    let factor = factor.max(1);
    let win = us_to_samples(window_us.get(), rate).max(1);
    let edge_s = us_to_samples(edge_us.get(), rate);
    let (from, to) = match edge {
        Edge::Start => (edge_s, edge_s + win),
        Edge::End => (edge_s - win, edge_s),
    };
    let from = from.clamp(0, original.len() as i64) as usize;
    let to = to.clamp(0, original.len() as i64) as usize;
    if to <= from {
        return None;
    }
    let needle = decimate(&original[from..to], factor);
    let hay = decimate(final_audio, factor);
    // Where the needle's first sample should land in the final audio.
    let expected_from = us_to_samples(expected_us.get(), rate) - (edge_s - from as i64);
    let radius = us_to_samples(radius_us.get(), rate);
    let lo = ((expected_from - radius).max(0) / factor as i64) as usize;
    let hi = ((expected_from + radius).max(0) / factor as i64) as usize;
    let (lag, score) = best_match(&needle, &hay, lo, hi)?;
    let found_from = lag as i64 * factor as i64;
    let found_edge = found_from + (edge_s - from as i64);
    Some(LocatedEdge {
        us: Micros(samples_to_us(found_edge, rate)),
        score,
    })
}

/// First sample whose magnitude reaches `threshold` (≈ −40 dBFS at 328).
pub fn first_onset(samples: &[f32], threshold: f32) -> Option<usize> {
    samples.iter().position(|s| s.abs() >= threshold)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(len: usize, seed: u32) -> Vec<i16> {
        // Deterministic pseudo-noise so cross-correlation has one clear peak.
        let mut x = seed;
        (0..len)
            .map(|_| {
                x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                ((x >> 16) as i16) / 4
            })
            .collect()
    }

    #[test]
    fn wav_roundtrip() {
        let pcm = Pcm {
            sample_rate: 24_000,
            channels: 1,
            samples: tone(1000, 7),
        };
        let back = parse_wav(&encode_wav(&pcm)).unwrap();
        assert_eq!(back, pcm);
        assert_eq!(back.duration_us(), Micros(41_666));
        assert!(parse_wav(b"nope").is_err());
    }

    #[test]
    fn splice_inserts_rounded_samples_and_shifts_times() {
        let pcm = Pcm {
            sample_rate: 24_000,
            channels: 1,
            samples: tone(24_000, 3),
        };
        let splices = [
            SilenceSplice {
                after_word_index: Some(4),
                at_us: Micros(500_010),
                duration_us: Micros(120_000),
            },
            SilenceSplice {
                after_word_index: Some(1),
                at_us: Micros(250_000),
                duration_us: Micros(40_000),
            },
        ];
        let (out, applied) = splice_silence(&pcm, &splices);
        assert_eq!(applied[0].at_sample, 6_000);
        assert_eq!(applied[0].inserted_samples, 960);
        assert_eq!(applied[1].at_sample, 12_000);
        assert_eq!(applied[1].inserted_samples, 2_880);
        assert_eq!(out.samples.len(), 24_000 + 960 + 2_880);
        assert!(out.samples[6_000..6_960].iter().all(|&s| s == 0));
        assert_eq!(out.samples[6_960], pcm.samples[6_000]);
        assert_eq!(out.samples[12_000 + 960 + 2_880], pcm.samples[12_000]);
        let r = pcm.sample_rate;
        assert_eq!(
            shift_through_splices(Micros(100_000), &applied, r),
            Micros(100_000)
        );
        assert_eq!(
            shift_through_splices(Micros(250_000), &applied, r),
            Micros(290_000)
        );
        assert_eq!(
            shift_through_splices(Micros(900_000), &applied, r),
            Micros(1_060_000)
        );
    }

    #[test]
    fn locates_word_edges_across_a_splice() {
        let rate = 24_000;
        let pcm = Pcm {
            sample_rate: rate,
            channels: 1,
            samples: tone(48_000, 11),
        };
        // 300 ms of silence goes in right before a word at 1.0 s.
        let splice = SilenceSplice {
            after_word_index: Some(3),
            at_us: Micros(1_000_000),
            duration_us: Micros(300_000),
        };
        let (out, _) = splice_silence(&pcm, &[splice]);
        let (orig, fin) = (pcm.mono_f32(), out.mono_f32());
        let start = locate_word_edge(
            &orig,
            &fin,
            rate,
            Micros(1_000_000),
            Edge::Start,
            Micros(1_250_000), // deliberately off by 50 ms
            Micros(200_000),
            Micros(150_000),
            3,
        )
        .unwrap();
        assert!((start.us.get() - 1_300_000).abs() <= 125, "{start:?}");
        assert!(start.score > 0.99);
        // The edge before the splice ends where it was.
        let end = locate_word_edge(
            &orig,
            &fin,
            rate,
            Micros(1_000_000),
            Edge::End,
            Micros(1_000_000),
            Micros(200_000),
            Micros(150_000),
            3,
        )
        .unwrap();
        assert!((end.us.get() - 1_000_000).abs() <= 125, "{end:?}");
    }

    #[test]
    fn best_match_handles_degenerate_input() {
        assert_eq!(best_match(&[], &[1.0], 0, 0), None);
        assert_eq!(best_match(&[0.0, 0.0], &[1.0, 2.0, 3.0], 0, 1), None);
        assert_eq!(
            best_match(&[1.0, 2.0], &[0.0, 1.0, 2.0], 0, 5),
            Some((1, 1.0))
        );
    }
}
