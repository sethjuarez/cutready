//! ffmpeg IO for the independent audit: the final take's frames at audit
//! resolution, its audio as 16 kHz WAV, stream start times, and selected
//! color frames for the contact sheet.

use super::super::analysis::GrayFrames;
use super::super::audio::{encode_wav, Pcm};
use super::super::video::{decode_raw, ok_stdout};
use crate::engine::ffmpeg::{run_ffmpeg, run_ffprobe};
use anyhow::{Context, Result};
use std::path::Path;

/// Audit decode size: fine enough for a 1280-wide link's underline.
pub const AUDIT_SIZE: (usize, usize) = (640, 360);

pub fn gray_frames(path: &Path) -> Result<GrayFrames> {
    let (w, h) = AUDIT_SIZE;
    let data = decode_raw(path, &format!("scale={w}:{h}:flags=area"), "gray")?;
    Ok(GrayFrames {
        width: w,
        height: h,
        data,
    })
}

/// `audio start − video start` in ms: where audio sample 0 sits on the
/// video clock.
pub fn audio_offset_ms(path: &Path) -> Result<f64> {
    let out = run_ffprobe([
        "-v".as_ref(),
        "error".as_ref(),
        "-show_entries".as_ref(),
        "stream=codec_type,start_time".as_ref(),
        "-of".as_ref(),
        "csv=p=0".as_ref(),
        path.as_os_str(),
    ])?;
    let text = String::from_utf8(ok_stdout(out, "ffprobe streams")?)?;
    let start = |kind: &str| -> Result<f64> {
        text.lines()
            .filter_map(|l| l.trim().split_once(','))
            .find(|(k, _)| *k == kind)
            .with_context(|| format!("no {kind} stream in {}", path.display()))
            .and_then(|(_, s)| {
                let s = s.trim_end_matches(',');
                s.parse::<f64>()
                    .with_context(|| format!("{kind} start_time {s:?} in {}", path.display()))
            })
    };
    Ok((start("audio")? - start("video")?) * 1000.0)
}

/// The first audio stream as a mono 16-bit 16 kHz WAV.
pub fn wav_16k(path: &Path) -> Result<Vec<u8>> {
    let out = run_ffmpeg([
        "-v".as_ref(),
        "error".as_ref(),
        "-i".as_ref(),
        path.as_os_str(),
        "-map".as_ref(),
        "0:a:0".as_ref(),
        "-ac".as_ref(),
        "1".as_ref(),
        "-ar".as_ref(),
        "16000".as_ref(),
        "-f".as_ref(),
        "s16le".as_ref(),
        "-".as_ref(),
    ])?;
    let bytes = ok_stdout(out, "ffmpeg audio decode")?;
    let samples = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&b| i16::from_le_bytes(b))
        .collect();
    Ok(encode_wav(&Pcm {
        sample_rate: 16_000,
        channels: 1,
        samples,
    }))
}

/// RGB frames `frames` (sorted, unique) scaled to `size`, in that order.
pub fn rgb_frames(path: &Path, frames: &[usize], size: (u32, u32)) -> Result<Vec<Vec<u8>>> {
    if frames.is_empty() {
        return Ok(Vec::new());
    }
    let select: Vec<String> = frames.iter().map(|f| format!("eq(n\\,{f})")).collect();
    let filter = format!(
        "select={},scale={}:{}:flags=area",
        select.join("+"),
        size.0,
        size.1
    );
    let data = decode_raw(path, &filter, "rgb24")?;
    let len = size.0 as usize * size.1 as usize * 3;
    Ok(data.chunks_exact(len).map(<[u8]>::to_vec).collect())
}
