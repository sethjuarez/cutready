//! Finds when an action's visible effect appears in the FINAL video, using
//! detectors that share nothing with the planner's: no planner ROI, no
//! planner frame map, no consecutive-frame differencing. Each window is
//! compared against a fixed baseline (its first frame), and the onset is
//! the first frame from which the net change persists to the window's end.
//! Transients (caret blink, hover flicker) never persist, and frozen frames
//! inserted by the retime can't fake an onset.
//!
//! Two detectors look at the same pixels in different ways:
//! - D1, a coarse grid: which 20x20 cells differ from the baseline.
//! - D2, structural similarity of the whole frame to the baseline.

use super::super::analysis::{GrayFrames, ViewBox};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualConfig {
    /// Per-pixel absolute gray difference counted as changed.
    pub pixel_delta: u8,
    /// Grid cell side in decoded pixels.
    pub cell: usize,
    /// Changed pixels for a cell to count as changed.
    pub cell_min_pixels: usize,
    /// Fraction of the net-changed cells that must already differ for a
    /// frame to count as "after" the onset.
    pub onset_fraction: f64,
    /// Fraction of the grid that counts as a whole-view change for locality.
    pub global_fraction: f64,
    /// Padding around the target box for the locality check, decoded px.
    pub locality_pad: f64,
    /// SSIM block side.
    pub ssim_block: usize,
    /// Frames after the baseline used to estimate D2's noise floor.
    pub noise_frames: usize,
    /// Minimum frames on each side of the expected time for a valid window.
    pub min_side_frames: usize,
}

impl Default for VisualConfig {
    fn default() -> Self {
        Self {
            pixel_delta: 20,
            cell: 20,
            cell_min_pixels: 4,
            onset_fraction: 0.25,
            global_fraction: 0.25,
            locality_pad: 24.0,
            ssim_block: 8,
            noise_frames: 4,
            min_side_frames: 6,
        }
    }
}

/// Output frames `lo..=hi` searched for one action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub lo: usize,
    pub hi: usize,
    /// Frame containing the expected time.
    pub expected: usize,
}

impl Window {
    /// A window of `±radius` frames around `expected`, clipped to
    /// `[min_lo, max_hi]` (neighbouring cues' midpoints and the video).
    pub fn around(expected: usize, radius: usize, min_lo: usize, max_hi: usize) -> Window {
        Window {
            lo: expected.saturating_sub(radius).max(min_lo),
            hi: (expected + radius).min(max_hi),
            expected,
        }
    }

    pub fn valid(&self, cfg: &VisualConfig) -> bool {
        self.lo <= self.expected
            && self.expected <= self.hi
            && self.expected - self.lo >= cfg.min_side_frames
            && self.hi - self.expected >= cfg.min_side_frames
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Locality {
    /// The change overlaps the (padded) target element.
    AtTarget,
    /// The change covers a large part of the view (navigation, scroll).
    Global,
    /// The change is somewhere else; it may belong to something unrelated.
    Elsewhere,
    /// No target box was logged.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridEvidence {
    pub cols: usize,
    pub rows: usize,
    /// Cells changed between the window's first and last frame.
    pub net_cells: usize,
    /// Bounding box of the net-changed cells, decoded px.
    pub net_box: Option<ViewBox>,
    pub onset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SsimEvidence {
    pub noise: f64,
    pub final_dissimilarity: f64,
    pub threshold: f64,
    /// D2 saw no change above its noise floor and abstains.
    pub abstained: bool,
    pub onset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualEvidence {
    pub window: Window,
    pub grid: GridEvidence,
    pub ssim: SsimEvidence,
    pub locality: Locality,
    /// The net change was already under way at the window's first frame.
    pub in_progress_at_start: bool,
}

/// Per-cell count of pixels that differ from the baseline by more than
/// `pixel_delta`, thresholded to a changed-cell mask.
fn changed_cells(base: &[u8], frame: &[u8], w: usize, h: usize, cfg: &VisualConfig) -> Vec<bool> {
    let cols = w.div_ceil(cfg.cell);
    let rows = h.div_ceil(cfg.cell);
    let mut counts = vec![0usize; cols * rows];
    for y in 0..h {
        let row = y / cfg.cell * cols;
        for x in 0..w {
            let i = y * w + x;
            if base[i].abs_diff(frame[i]) > cfg.pixel_delta {
                counts[row + x / cfg.cell] += 1;
            }
        }
    }
    counts
        .into_iter()
        .map(|c| c >= cfg.cell_min_pixels)
        .collect()
}

/// First frame `f` in `lo..=hi` such that `ok(g)` holds for every `g >= f`.
fn persistent_onset(lo: usize, hi: usize, ok: impl Fn(usize) -> bool) -> Option<usize> {
    let mut onset = None;
    for f in (lo..=hi).rev() {
        if ok(f) {
            onset = Some(f);
        } else {
            break;
        }
    }
    onset
}

fn grid_detector(
    frames: &GrayFrames,
    win: Window,
    cfg: &VisualConfig,
) -> (GridEvidence, Vec<bool>) {
    let (w, h) = (frames.width, frames.height);
    let cols = w.div_ceil(cfg.cell);
    let rows = h.div_ceil(cfg.cell);
    let base = frames.frame(win.lo);
    let net = changed_cells(base, frames.frame(win.hi), w, h, cfg);
    let net_cells = net.iter().filter(|c| **c).count();
    let need = ((net_cells as f64 * cfg.onset_fraction).ceil() as usize).max(1);
    let onset = if net_cells == 0 {
        None
    } else {
        let per_frame: Vec<usize> = (win.lo..=win.hi)
            .map(|f| {
                changed_cells(base, frames.frame(f), w, h, cfg)
                    .iter()
                    .zip(&net)
                    .filter(|(c, n)| **c && **n)
                    .count()
            })
            .collect();
        persistent_onset(win.lo, win.hi, |f| per_frame[f - win.lo] >= need)
    };
    let net_box = cells_box(&net, cols, cfg.cell, w, h);
    (
        GridEvidence {
            cols,
            rows,
            net_cells,
            net_box,
            onset,
        },
        net,
    )
}

fn cells_box(mask: &[bool], cols: usize, cell: usize, w: usize, h: usize) -> Option<ViewBox> {
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for (i, _) in mask.iter().enumerate().filter(|(_, c)| **c) {
        let (cx, cy) = (i % cols, i / cols);
        x0 = x0.min(cx * cell);
        y0 = y0.min(cy * cell);
        x1 = x1.max(((cx + 1) * cell).min(w));
        y1 = y1.max(((cy + 1) * cell).min(h));
    }
    (x0 != usize::MAX).then(|| ViewBox {
        x: x0 as f64,
        y: y0 as f64,
        width: (x1 - x0) as f64,
        height: (y1 - y0) as f64,
    })
}

/// Mean structural dissimilarity (1 − SSIM) over non-overlapping blocks.
pub fn dissimilarity(a: &[u8], b: &[u8], w: usize, h: usize, block: usize) -> f64 {
    const C1: f64 = (0.01 * 255.0) * (0.01 * 255.0);
    const C2: f64 = (0.03 * 255.0) * (0.03 * 255.0);
    let (bw, bh) = (w / block, h / block);
    if bw == 0 || bh == 0 {
        return 0.0;
    }
    let n = (block * block) as f64;
    let mut total = 0.0;
    for by in 0..bh {
        for bx in 0..bw {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for y in by * block..(by + 1) * block {
                for x in bx * block..(bx + 1) * block {
                    let (va, vb) = (a[y * w + x] as f64, b[y * w + x] as f64);
                    sa += va;
                    sb += vb;
                    saa += va * va;
                    sbb += vb * vb;
                    sab += va * vb;
                }
            }
            let (ma, mb) = (sa / n, sb / n);
            let (va, vb) = (saa / n - ma * ma, sbb / n - mb * mb);
            let cov = sab / n - ma * mb;
            let ssim = ((2.0 * ma * mb + C1) * (2.0 * cov + C2))
                / ((ma * ma + mb * mb + C1) * (va + vb + C2));
            total += ssim;
        }
    }
    1.0 - total / (bw * bh) as f64
}

/// Dissimilarity below this is treated as identical (encoder noise).
const SSIM_FLOOR: f64 = 0.0005;

fn ssim_detector(frames: &GrayFrames, win: Window, cfg: &VisualConfig) -> SsimEvidence {
    let (w, h) = (frames.width, frames.height);
    let base = frames.frame(win.lo);
    let d: Vec<f64> = (win.lo..=win.hi)
        .map(|f| dissimilarity(base, frames.frame(f), w, h, cfg.ssim_block))
        .collect();
    let noise_end = (cfg.noise_frames + 1).min(d.len());
    let noise = d[1.min(d.len())..noise_end]
        .iter()
        .cloned()
        .fold(0.0, f64::max)
        .max(SSIM_FLOOR);
    let final_d = *d.last().unwrap_or(&0.0);
    let floor = 3.0 * noise;
    let abstained = final_d < floor;
    let threshold = floor.max(0.1 * final_d);
    let onset = if abstained {
        None
    } else {
        persistent_onset(win.lo, win.hi, |f| d[f - win.lo] >= threshold)
    };
    SsimEvidence {
        noise,
        final_dissimilarity: final_d,
        threshold,
        abstained,
        onset,
    }
}

fn locality(
    net: &[bool],
    grid: &GridEvidence,
    target: Option<ViewBox>,
    cfg: &VisualConfig,
) -> Locality {
    let total = grid.cols * grid.rows;
    if total > 0 && grid.net_cells as f64 >= cfg.global_fraction * total as f64 {
        return Locality::Global;
    }
    let Some(t) = target else {
        return Locality::Unknown;
    };
    let (x0, y0) = (t.x - cfg.locality_pad, t.y - cfg.locality_pad);
    let (x1, y1) = (
        t.x + t.width + cfg.locality_pad,
        t.y + t.height + cfg.locality_pad,
    );
    let hit = net.iter().enumerate().filter(|(_, c)| **c).any(|(i, _)| {
        let cx = ((i % grid.cols) * cfg.cell) as f64;
        let cy = ((i / grid.cols) * cfg.cell) as f64;
        let c = cfg.cell as f64;
        cx < x1 && cx + c > x0 && cy < y1 && cy + c > y0
    });
    if hit {
        Locality::AtTarget
    } else {
        Locality::Elsewhere
    }
}

/// Runs both detectors over `win`. `target` is the action's element box in
/// decoded-frame pixels, if the sidecar logged one.
pub fn observe(
    frames: &GrayFrames,
    win: Window,
    target: Option<ViewBox>,
    cfg: &VisualConfig,
) -> VisualEvidence {
    let (grid, net) = grid_detector(frames, win, cfg);
    let ssim = ssim_detector(frames, win, cfg);
    let locality = locality(&net, &grid, target, cfg);
    // The baseline can't differ from itself, so the earliest possible onset
    // is `lo + 1`; an onset there means the change began before the window.
    let early = |o: Option<usize>| o.is_some_and(|f| f <= win.lo + 1);
    let in_progress_at_start = early(grid.onset) || early(ssim.onset);
    VisualEvidence {
        window: win,
        grid,
        ssim,
        locality,
        in_progress_at_start,
    }
}

#[cfg(test)]
#[path = "visual_tests.rs"]
mod tests;
