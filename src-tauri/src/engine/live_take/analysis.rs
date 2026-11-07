//! Pure frame analysis: marker runs, marker ↔ log matching, ROI change
//! detection and the EDL frame map. IO lives in `video.rs`.

use crate::engine::demo_timing::{FrameIndex, Micros, Segment, SegmentKind};
use serde::{Deserialize, Serialize};

/// Downscaled single-channel frames, row-major, back to back.
#[derive(Debug, Clone, PartialEq)]
pub struct GrayFrames {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl GrayFrames {
    pub fn len(&self) -> usize {
        self.data.len() / (self.width * self.height).max(1)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn frame(&self, i: usize) -> &[u8] {
        let n = self.width * self.height;
        &self.data[i * n..(i + 1) * n]
    }
}

/// A rectangle in viewport CSS pixels, as Playwright reports it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ViewBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A half-open rectangle in thumbnail pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Roi {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
}

impl Roi {
    pub fn full(width: usize, height: usize) -> Roi {
        Roi {
            x0: 0,
            y0: 0,
            x1: width,
            y1: height,
        }
    }

    pub fn area(&self) -> usize {
        (self.x1 - self.x0) * (self.y1 - self.y0)
    }
}

/// Union of `boxes` (viewport px), padded by `pad` viewport px, scaled to a
/// `thumb` grid and clipped. `None` when nothing usable remains (fewer than
/// `min_area` thumbnail pixels).
pub fn roi_from_boxes(
    boxes: &[ViewBox],
    viewport: (u32, u32),
    thumb: (usize, usize),
    pad: f64,
    min_area: usize,
) -> Option<Roi> {
    let (vw, vh) = (f64::from(viewport.0), f64::from(viewport.1));
    let (tw, th) = thumb;
    let mut it = boxes.iter().filter(|b| b.width > 0.0 && b.height > 0.0);
    let first = it.next()?;
    let (mut x0, mut y0) = (first.x, first.y);
    let (mut x1, mut y1) = (first.x + first.width, first.y + first.height);
    for b in it {
        x0 = x0.min(b.x);
        y0 = y0.min(b.y);
        x1 = x1.max(b.x + b.width);
        y1 = y1.max(b.y + b.height);
    }
    let sx = tw as f64 / vw;
    let sy = th as f64 / vh;
    let clip = |v: f64, max: usize| (v.max(0.0) as usize).min(max);
    let roi = Roi {
        x0: clip(((x0 - pad) * sx).floor(), tw),
        y0: clip(((y0 - pad) * sy).floor(), th),
        x1: clip(((x1 + pad) * sx).ceil(), tw),
        y1: clip(((y1 + pad) * sy).ceil(), th),
    };
    (roi.x1 > roi.x0 && roi.y1 > roi.y0 && roi.area() >= min_area).then_some(roi)
}

pub fn mean_abs_diff(a: &[u8], b: &[u8], width: usize, roi: Roi) -> f32 {
    let mut sum = 0u64;
    for y in roi.y0..roi.y1 {
        let row = y * width;
        for x in roi.x0..roi.x1 {
            sum += u64::from(a[row + x].abs_diff(b[row + x]));
        }
    }
    sum as f32 / roi.area().max(1) as f32
}

/// Fraction of RGB24 pixels that are calibration magenta.
pub fn marker_score(rgb: &[u8]) -> f32 {
    let px = rgb.len() / 3;
    let hits = rgb
        .as_chunks::<3>()
        .0
        .iter()
        .filter(|p| p[0] >= 200 && p[2] >= 200 && p[1] <= 70)
        .count();
    hits as f32 / px.max(1) as f32
}

/// A run of consecutive marker frames, `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub start: usize,
    pub end: usize,
}

pub fn marker_runs(scores: &[f32], threshold: f32) -> Vec<Run> {
    let mut runs = Vec::new();
    let mut start = None;
    for (i, &s) in scores.iter().enumerate() {
        match (s >= threshold, start) {
            (true, None) => start = Some(i),
            (false, Some(st)) => {
                runs.push(Run { start: st, end: i });
                start = None;
            }
            _ => {}
        }
    }
    if let Some(st) = start {
        runs.push(Run {
            start: st,
            end: scores.len(),
        });
    }
    runs
}

/// Frames to hide or skip: every frame with any marker coverage, widened by
/// `pad` frames each side to cover blended transition frames.
pub fn excluded_frames(scores: &[f32], threshold: f32, pad: usize) -> Vec<bool> {
    let mut out = vec![false; scores.len()];
    for (i, &s) in scores.iter().enumerate() {
        if s >= threshold {
            let lo = i.saturating_sub(pad);
            let hi = (i + pad + 1).min(scores.len());
            out[lo..hi].iter_mut().for_each(|e| *e = true);
        }
    }
    out
}

/// True when any of `span` frames from `frame` is excluded (covered by a
/// marker), so an action dispatched there has no clean frames to measure.
pub fn masked(excluded: &[bool], frame: usize, span: usize) -> bool {
    (frame..frame + span).any(|f| excluded.get(f).copied().unwrap_or(false))
}

/// One logged marker matched to one detected run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerMatch {
    pub logged_index: usize,
    pub run_index: usize,
    pub host_us: Micros,
    pub pts_us: Micros,
}

/// Aligns logged marker onsets (host clock) to detected run onsets (video
/// clock) as a contiguous subsequence: `logged[i] ↔ runs[i + k]`. Picks the
/// shift `k` with the most pairs whose offset is within `tolerance` of the
/// shift's median offset (ties: smallest spread), so a missed first marker
/// or a stray magenta run does not derail the pairing.
pub fn match_markers(
    logged: &[Micros],
    runs: &[Micros],
    tolerance: Micros,
    min_pairs: usize,
) -> Result<Vec<MarkerMatch>, String> {
    let mut best: Option<(usize, i64, Vec<MarkerMatch>)> = None;
    let (l, r) = (logged.len() as i64, runs.len() as i64);
    for k in (1 - l)..r {
        let pairs: Vec<MarkerMatch> = (0..l)
            .filter_map(|i| {
                let j = i + k;
                (0..r).contains(&j).then(|| MarkerMatch {
                    logged_index: i as usize,
                    run_index: j as usize,
                    host_us: logged[i as usize],
                    pts_us: runs[j as usize],
                })
            })
            .collect();
        if pairs.is_empty() {
            continue;
        }
        let mut offsets: Vec<i64> = pairs.iter().map(|p| (p.pts_us - p.host_us).get()).collect();
        offsets.sort_unstable();
        let median = offsets[offsets.len() / 2];
        let inliers: Vec<MarkerMatch> = pairs
            .into_iter()
            .filter(|p| ((p.pts_us - p.host_us).get() - median).abs() <= tolerance.get())
            .collect();
        let spread = inliers
            .iter()
            .map(|p| ((p.pts_us - p.host_us).get() - median).abs())
            .max()
            .unwrap_or(0);
        let better = match &best {
            None => true,
            Some((n, s, _)) => inliers.len() > *n || (inliers.len() == *n && spread < *s),
        };
        if better {
            best = Some((inliers.len(), spread, inliers));
        }
    }
    match best {
        Some((n, _, pairs)) if n >= min_pairs => Ok(pairs),
        Some((n, _, _)) => Err(format!(
            "only {n} of {} logged markers matched {} detected runs",
            logged.len(),
            runs.len()
        )),
        None => Err(format!(
            "no marker runs detected ({} logged markers)",
            logged.len()
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChangeConfig {
    /// Mean-abs-diff floor (0–255 scale) for a change.
    pub min_threshold: f32,
    /// Threshold is at least this multiple of the pre-reference noise.
    pub noise_factor: f32,
    /// Consecutive changed frames required (rejects one-frame flicker).
    pub persist: usize,
    /// Frames before the reference used to estimate noise.
    pub noise_frames: usize,
}

impl Default for ChangeConfig {
    fn default() -> Self {
        ChangeConfig {
            min_threshold: 1.5,
            noise_factor: 3.0,
            persist: 2,
            noise_frames: 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub reference: usize,
    pub frame: Option<usize>,
    pub threshold: f32,
    pub noise: f32,
    pub peak: f32,
    pub roi: Roi,
}

/// First frame in `[from, until)` whose ROI differs from `reference` by
/// more than the threshold for `persist` consecutive non-excluded frames.
/// Excluded (marker) frames are skipped and never used as the reference.
pub fn first_change(
    frames: &GrayFrames,
    reference: usize,
    from: usize,
    until: usize,
    roi: Roi,
    excluded: &[bool],
    config: &ChangeConfig,
) -> Detection {
    let is_ex = |i: usize| excluded.get(i).copied().unwrap_or(false);
    let mut reference = reference.min(frames.len().saturating_sub(1));
    while reference > 0 && is_ex(reference) {
        reference -= 1;
    }
    let refr = frames.frame(reference);
    let diff = |i: usize| mean_abs_diff(frames.frame(i), refr, frames.width, roi);
    let noise = (reference.saturating_sub(config.noise_frames)..reference)
        .filter(|&i| !is_ex(i))
        .map(diff)
        .fold(0f32, f32::max);
    let threshold = config.min_threshold.max(noise * config.noise_factor);
    let until = until.min(frames.len());
    let candidates: Vec<usize> = (from.max(reference + 1)..until)
        .filter(|&i| !is_ex(i))
        .collect();
    let mut peak = 0f32;
    let mut found = None;
    let persist = config.persist.max(1);
    let changed: Vec<bool> = candidates
        .iter()
        .map(|&i| {
            let d = diff(i);
            peak = peak.max(d);
            d > threshold
        })
        .collect();
    for w in 0..=changed.len().saturating_sub(persist) {
        let window = &candidates[w..w + persist];
        let consecutive = window.windows(2).all(|p| p[1] == p[0] + 1);
        if consecutive && changed[w..w + persist].iter().all(|&c| c) {
            found = Some(candidates[w]);
            break;
        }
    }
    Detection {
        reference,
        frame: found,
        threshold,
        noise,
        peak,
        roi,
    }
}

/// Output frame → source frame for every output frame of an EDL.
pub fn output_frame_map(
    segments: &[Segment],
    output_frame_count: FrameIndex,
) -> Result<Vec<FrameIndex>, String> {
    let mut map = vec![-1; output_frame_count.max(0) as usize];
    for s in segments {
        for o in s.output_start_frame..s.output_end_frame {
            let src = match s.kind {
                SegmentKind::Play => s.source_start_frame + (o - s.output_start_frame),
                SegmentKind::Freeze => s.source_start_frame,
                SegmentKind::Drop => continue,
            };
            *map.get_mut(o as usize)
                .ok_or_else(|| format!("segment writes output frame {o} past the end"))? = src;
        }
    }
    if let Some(o) = map.iter().position(|&s| s < 0) {
        return Err(format!("output frame {o} has no source frame"));
    }
    Ok(map)
}

/// Replaces marker frames with the nearest earlier clean frame (or the next
/// clean one at the very start). Markers flash while the page is settled,
/// so the substitute shows the same picture.
pub fn substitute_excluded(map: &mut [FrameIndex], excluded: &[bool]) -> usize {
    let is_ex = |f: FrameIndex| f >= 0 && excluded.get(f as usize).copied().unwrap_or(false);
    let mut replaced = 0;
    for f in map.iter_mut() {
        if !is_ex(*f) {
            continue;
        }
        let mut g = *f;
        while g > 0 && is_ex(g) {
            g -= 1;
        }
        if is_ex(g) {
            g = *f;
            while is_ex(g) {
                g += 1;
            }
        }
        *f = g;
        replaced += 1;
    }
    replaced
}

/// Last output frame showing a source frame at or before `source` (the
/// reference for re-detecting an action in the output).
pub fn output_frame_showing(map: &[FrameIndex], source: FrameIndex) -> Option<usize> {
    map.iter().rposition(|&s| s <= source)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(values: &[u8], w: usize, h: usize) -> GrayFrames {
        let mut data = Vec::new();
        for &v in values {
            data.extend(std::iter::repeat_n(v, w * h));
        }
        GrayFrames {
            width: w,
            height: h,
            data,
        }
    }

    #[test]
    fn rois_union_pad_scale_and_clip() {
        let a = ViewBox {
            x: 100.0,
            y: 100.0,
            width: 100.0,
            height: 40.0,
        };
        let b = ViewBox {
            x: 1200.0,
            y: 700.0,
            width: 200.0,
            height: 100.0,
        };
        let roi = roi_from_boxes(&[a], (1280, 720), (320, 180), 8.0, 4).unwrap();
        assert_eq!(
            roi,
            Roi {
                x0: 23,
                y0: 23,
                x1: 52,
                y1: 37
            }
        );
        let roi = roi_from_boxes(&[a, b], (1280, 720), (320, 180), 0.0, 4).unwrap();
        assert_eq!(
            roi,
            Roi {
                x0: 25,
                y0: 25,
                x1: 320,
                y1: 180
            }
        );
        let tiny = ViewBox {
            x: 10.0,
            y: 10.0,
            width: 1.0,
            height: 1.0,
        };
        assert_eq!(
            roi_from_boxes(&[tiny], (1280, 720), (320, 180), 0.0, 4),
            None
        );
        assert_eq!(roi_from_boxes(&[], (1280, 720), (320, 180), 0.0, 4), None);
    }

    #[test]
    fn marker_runs_and_exclusion() {
        let magenta = [255u8, 0, 255, 255, 0, 255];
        let mixed = [255u8, 0, 255, 10, 10, 10];
        assert_eq!(marker_score(&magenta), 1.0);
        assert_eq!(marker_score(&mixed), 0.5);
        let scores = [0.0, 0.9, 1.0, 0.2, 0.0, 0.0, 1.0];
        assert_eq!(
            marker_runs(&scores, 0.5),
            vec![Run { start: 1, end: 3 }, Run { start: 6, end: 7 }]
        );
        assert_eq!(
            excluded_frames(&scores, 0.1, 1),
            vec![true, true, true, true, true, true, true]
        );
        assert_eq!(
            excluded_frames(&scores, 0.5, 0),
            vec![false, true, true, false, false, false, true]
        );
    }

    #[test]
    fn markers_match_despite_a_missed_first_and_a_stray_last_run() {
        let ms = Micros::from_millis;
        let logged = [ms(100), ms(600), ms(1100), ms(1600)];
        // First marker lost before the video starts, offset −400 ms, plus a
        // stray magenta run after the last marker.
        let runs = [ms(200), ms(700), ms(1200), ms(1500)];
        let pairs = match_markers(&logged, &runs, ms(60), 3).unwrap();
        assert_eq!(pairs.len(), 3);
        assert_eq!((pairs[0].logged_index, pairs[0].run_index), (1, 0));
        assert!(pairs.iter().all(|p| p.pts_us - p.host_us == ms(-400)));
        // Jittered offsets stay inliers within tolerance.
        let runs = [ms(210), ms(690), ms(1200)];
        let pairs = match_markers(&logged, &runs, ms(60), 3).unwrap();
        assert_eq!(pairs.len(), 3);
        assert!(match_markers(&logged, &[], ms(60), 1).is_err());
        assert!(match_markers(&logged, &runs, ms(60), 4).is_err());
    }

    #[test]
    fn first_change_needs_persistence_and_skips_markers() {
        // ref=2; frame 4 flickers once; marker at 6; real change from 7.
        let f = frames(&[10, 10, 10, 10, 60, 10, 200, 60, 60, 60], 4, 2);
        let mut excluded = vec![false; 10];
        excluded[6] = true;
        let cfg = ChangeConfig::default();
        let roi = Roi::full(4, 2);
        let d = first_change(&f, 2, 3, 10, roi, &excluded, &cfg);
        assert_eq!(d.frame, Some(7));
        assert_eq!(d.reference, 2);
        assert_eq!(d.threshold, 1.5);
        // Reference on a marker walks back.
        excluded[2] = true;
        assert_eq!(
            first_change(&f, 2, 3, 10, roi, &excluded, &cfg).reference,
            1
        );
        // No change in range.
        let d = first_change(&f, 0, 1, 4, roi, &[], &cfg);
        assert_eq!(d.frame, None);
        // A lone changed last frame is not a persistent change.
        let tail = frames(&[10, 10, 10, 60], 1, 1);
        let d = first_change(&tail, 0, 1, 4, Roi::full(1, 1), &[], &cfg);
        assert_eq!(d.frame, None);
        // Changed frames on either side of a marker run aren't consecutive.
        let gap = frames(&[10, 10, 60, 200, 200, 10], 1, 1);
        let ex = [false, false, false, true, true, false];
        let d = first_change(&gap, 0, 1, 6, Roi::full(1, 1), &ex, &cfg);
        assert_eq!(d.frame, None);
    }

    #[test]
    fn noise_raises_the_threshold() {
        let f = frames(&[10, 14, 10, 10, 13, 13, 30, 30], 2, 2);
        let d = first_change(&f, 3, 4, 8, Roi::full(2, 2), &[], &ChangeConfig::default());
        assert_eq!(d.noise, 4.0);
        assert_eq!(d.threshold, 12.0);
        assert_eq!(d.frame, Some(6));
    }

    #[test]
    fn dispatch_under_a_marker_is_masked() {
        let excluded = [false, false, true, true, false, false];
        assert!(masked(&excluded, 1, 2));
        assert!(masked(&excluded, 3, 2));
        assert!(!masked(&excluded, 4, 2));
        assert!(!masked(&excluded, 0, 2));
        assert!(!masked(&excluded, 5, 4));
    }

    #[test]
    fn frame_map_follows_segments_and_hides_markers() {
        let seg = |kind, ss, se, os, oe| Segment {
            kind,
            source_start_frame: ss,
            source_end_frame: se,
            output_start_frame: os,
            output_end_frame: oe,
        };
        let segments = [
            seg(SegmentKind::Play, 0, 3, 0, 3),
            seg(SegmentKind::Drop, 3, 5, 3, 3),
            seg(SegmentKind::Freeze, 5, 6, 3, 5),
            seg(SegmentKind::Play, 5, 8, 5, 8),
        ];
        let mut map = output_frame_map(&segments, 8).unwrap();
        assert_eq!(map, vec![0, 1, 2, 5, 5, 5, 6, 7]);
        assert!(output_frame_map(&segments, 9).is_err());
        let excluded = [true, false, false, false, false, true, true, false];
        assert_eq!(substitute_excluded(&mut map, &excluded), 5);
        assert_eq!(map, vec![1, 1, 2, 4, 4, 4, 4, 7]);
        assert_eq!(output_frame_showing(&map, 4), Some(6));
        assert_eq!(output_frame_showing(&map, 0), None);
    }
}
