//! ffmpeg/ffprobe IO for live takes: frame PTS, thumbnails, marker scores,
//! decoded audio and the frame-exact raw-pipe render.

use super::analysis::{marker_score, GrayFrames};
use crate::engine::demo_timing::{FrameIndex, Micros};
use crate::engine::ffmpeg::{command_for_ffmpeg, run_ffmpeg, run_ffprobe};
use anyhow::{anyhow, bail, Context, Result};
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;

pub const THUMB: (usize, usize) = (320, 180);
const MARKER_THUMB: (usize, usize) = (32, 18);

pub(super) fn ok_stdout(out: std::process::Output, what: &str) -> Result<Vec<u8>> {
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.lines().rev().take(6).collect::<Vec<_>>().join(" | ");
        bail!("{what} failed: {tail}");
    }
    Ok(out.stdout)
}

/// Presentation time of every video frame, in decode order.
pub fn frame_pts(path: &Path) -> Result<Vec<Micros>> {
    let out = run_ffprobe([
        "-v".as_ref(),
        "error".as_ref(),
        "-select_streams".as_ref(),
        "v:0".as_ref(),
        "-show_entries".as_ref(),
        "frame=best_effort_timestamp_time".as_ref(),
        "-of".as_ref(),
        "csv=p=0".as_ref(),
        path.as_os_str(),
    ])?;
    let text = String::from_utf8(ok_stdout(out, "ffprobe frames")?)?;
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| {
            let secs: f64 = l
                .trim_end_matches(',')
                .parse()
                .with_context(|| format!("bad frame time {l:?}"))?;
            Ok(Micros((secs * 1e6).round() as i64))
        })
        .collect()
}

/// Checks a CFR cadence: PTS relative to the first frame are `i · frame`
/// within `tolerance`. Returns the first frame's PTS.
pub fn check_cadence(pts: &[Micros], frame: Micros, tolerance: Micros) -> Result<Micros> {
    let first = *pts.first().ok_or_else(|| anyhow!("video has no frames"))?;
    for (i, &p) in pts.iter().enumerate() {
        let expected = Micros(frame.get() * i as i64);
        let actual = p - first;
        if (actual - expected).abs() > tolerance {
            bail!("frame {i} at {actual} breaks the {frame} cadence (expected {expected})");
        }
    }
    Ok(first)
}

pub(super) fn decode_raw(path: &Path, filter: &str, pix_fmt: &str) -> Result<Vec<u8>> {
    let out = run_ffmpeg([
        "-v".as_ref(),
        "error".as_ref(),
        "-i".as_ref(),
        path.as_os_str(),
        "-map".as_ref(),
        "0:v:0".as_ref(),
        "-vf".as_ref(),
        filter.as_ref(),
        "-fps_mode".as_ref(),
        "passthrough".as_ref(),
        "-pix_fmt".as_ref(),
        pix_fmt.as_ref(),
        "-f".as_ref(),
        "rawvideo".as_ref(),
        "-".as_ref(),
    ])?;
    ok_stdout(out, "ffmpeg decode")
}

/// Every frame as an area-averaged gray thumbnail.
pub fn gray_thumbnails(path: &Path) -> Result<GrayFrames> {
    let (w, h) = THUMB;
    let data = decode_raw(path, &format!("scale={w}:{h}:flags=area"), "gray")?;
    Ok(GrayFrames {
        width: w,
        height: h,
        data,
    })
}

/// Fraction of calibration-magenta pixels per frame.
pub fn marker_scores(path: &Path) -> Result<Vec<f32>> {
    let (w, h) = MARKER_THUMB;
    let data = decode_raw(path, &format!("scale={w}:{h}:flags=area"), "rgb24")?;
    Ok(data.chunks_exact(w * h * 3).map(marker_score).collect())
}

/// First audio stream as mono f32 at `rate`.
pub fn decode_audio_mono(path: &Path, rate: u32) -> Result<Vec<f32>> {
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
        rate.to_string().as_ref(),
        "-f".as_ref(),
        "s16le".as_ref(),
        "-".as_ref(),
    ])?;
    let bytes = ok_stdout(out, "ffmpeg audio decode")?;
    Ok(bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&b| f32::from(i16::from_le_bytes(b)) / 32768.0)
        .collect())
}

pub struct RenderRequest<'a> {
    pub source: &'a Path,
    pub audio: &'a Path,
    pub output: &'a Path,
    pub log: &'a Path,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Source frame for every output frame; must be non-decreasing.
    pub frame_map: &'a [FrameIndex],
}

/// Streams the source's decoded frames through `frame_map` into an H.264
/// encoder at exactly `fps`, muxed with `audio`. Each output frame is a
/// copy of a decoded source frame, so the picture timing is frame-exact.
pub fn render(req: &RenderRequest) -> Result<()> {
    if !req.width.is_multiple_of(2) || !req.height.is_multiple_of(2) {
        bail!(
            "yuv420p needs even dimensions, got {}x{}",
            req.width,
            req.height
        );
    }
    if req.frame_map.windows(2).any(|w| w[1] < w[0]) || req.frame_map.first() < Some(&0) {
        bail!("frame map must be non-decreasing and non-negative");
    }
    let frame_bytes = (req.width * req.height * 3 / 2) as usize;
    let size = format!("{}x{}", req.width, req.height);

    let mut decoder = command_for_ffmpeg()?;
    decoder
        .args(["-v", "error", "-i"])
        .arg(req.source)
        .args(["-map", "0:v:0", "-fps_mode", "passthrough", "-vf"])
        .arg(format!("scale={size}:flags=bicubic"))
        .args(["-pix_fmt", "yuv420p", "-f", "rawvideo", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut decoder = decoder.spawn().context("spawn ffmpeg decoder")?;

    let log = std::fs::File::create(req.log)?;
    let mut encoder = command_for_ffmpeg()?;
    encoder
        .args([
            "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s",
        ])
        .arg(&size)
        .args(["-framerate", &req.fps.to_string(), "-i", "pipe:0", "-i"])
        .arg(req.audio)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
        ])
        .arg(req.output)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    let mut encoder = encoder.spawn().context("spawn ffmpeg encoder")?;

    let result = (|| -> Result<()> {
        let mut src = decoder
            .stdout
            .take()
            .ok_or_else(|| anyhow!("no decoder stdout"))?;
        let mut sink = encoder
            .stdin
            .take()
            .ok_or_else(|| anyhow!("no encoder stdin"))?;
        let mut current = vec![0u8; frame_bytes];
        let mut current_index: FrameIndex = -1;
        for (o, &want) in req.frame_map.iter().enumerate() {
            while current_index < want {
                src.read_exact(&mut current).with_context(|| {
                    format!("source ended before frame {want} (output frame {o})")
                })?;
                current_index += 1;
            }
            sink.write_all(&current)?;
        }
        Ok(())
    })();
    let _ = decoder.kill();
    let _ = decoder.wait();
    let status = encoder.wait()?;
    result?;
    if !status.success() {
        bail!("ffmpeg encoder failed; see {}", req.log.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cadence_check() {
        let f = Micros(40_000);
        let pts = [Micros(7_000), Micros(47_000), Micros(87_100)];
        assert_eq!(check_cadence(&pts, f, Micros(500)).unwrap(), Micros(7_000));
        let bad = [Micros(0), Micros(40_000), Micros(120_000)];
        assert!(check_cadence(&bad, f, Micros(500)).is_err());
        assert!(check_cadence(&[], f, Micros(500)).is_err());
    }
}
