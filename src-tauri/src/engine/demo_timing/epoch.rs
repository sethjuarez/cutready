//! Per-take epoch calibration: `video_pts = offset + host · (1 + drift)`.
//!
//! The recorder flashes calibration markers and logs each marker's host
//! instant (after two animation frames); the video analyzer reports the PTS
//! of the first marker frame. [`fit_epoch`] turns those pairs into an
//! [`EpochFit`]:
//!
//! 1. Pairs with `pts <= 0` are excluded: a marker painted before the
//!    screencast's first frame is clamped to PTS 0 and would bias the fit.
//! 2. Gross outliers (a misdetected marker) are rejected against a robust
//!    line: the median offset on short takes, and on long takes the
//!    in-bounds line through two markers (or zero-drift line through one)
//!    that agrees with the most markers. Never more than half.
//! 3. With at least `min_markers_for_slope` inliers spanning at least
//!    `min_span_for_slope_us`, a least-squares line is fitted and its drift
//!    must be within `max_drift_ppm`. Otherwise the slope is fixed at 1 and the
//!    offset is the median of `pts − host`: frame quantization (±½ frame)
//!    makes a slope over a short span meaningless (±4000 ppm at 10 s).
//! 4. Every inlier residual must be within `max_residual_frames` frames.

use super::units::{Fps, Micros};
use serde::{Deserialize, Serialize};
use std::fmt;

const PPB: i128 = 1_000_000_000;

/// One calibration marker: host instant and video PTS, both relative to `t0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerPair {
    pub host_us: Micros,
    pub pts_us: Micros,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EpochConfig {
    pub max_drift_ppm: u32,
    pub max_residual_frames: u32,
    pub outlier_threshold_frames: u32,
    pub min_markers_for_slope: u32,
    pub min_span_for_slope_us: Micros,
}

impl Default for EpochConfig {
    fn default() -> Self {
        EpochConfig {
            max_drift_ppm: 1_000,
            max_residual_frames: 1,
            outlier_threshold_frames: 3,
            min_markers_for_slope: 3,
            min_span_for_slope_us: Micros(60_000_000),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FitMethod {
    /// Slope fixed at 1, offset = median(pts − host).
    MedianOffset,
    /// Ordinary least squares over the inliers.
    LeastSquares,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExclusionReason {
    /// PTS clamped to the start of the video.
    ClampedStart,
    /// Too far from the robust line to be the same marker.
    Outlier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedMarker {
    pub index: usize,
    pub reason: ExclusionReason,
}

/// The calibrated host → video transform for one take, with fit quality.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpochFit {
    pub offset_us: Micros,
    /// `(slope − 1)` in parts per billion; 0 for [`FitMethod::MedianOffset`].
    pub drift_ppb: i64,
    pub method: FitMethod,
    pub inliers: usize,
    pub excluded: Vec<ExcludedMarker>,
    pub residual_max_us: Micros,
    pub residual_rms_us: Micros,
}

impl EpochFit {
    /// A transform with no drift, for callers that already know the offset.
    pub fn constant(offset_us: Micros) -> Self {
        EpochFit {
            offset_us,
            drift_ppb: 0,
            method: FitMethod::MedianOffset,
            inliers: 0,
            excluded: Vec::new(),
            residual_max_us: Micros::ZERO,
            residual_rms_us: Micros::ZERO,
        }
    }

    pub fn host_to_pts(&self, host: Micros) -> Micros {
        let h = i128::from(host.0);
        let drift = round_div(h * i128::from(self.drift_ppb), PPB);
        Micros(saturate(h + drift + i128::from(self.offset_us.0)))
    }

    pub fn pts_to_host(&self, pts: Micros) -> Micros {
        let shifted = i128::from(pts.0) - i128::from(self.offset_us.0);
        Micros(saturate(round_div(
            shifted * PPB,
            PPB + i128::from(self.drift_ppb),
        )))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EpochError {
    NotEnoughMarkers {
        usable: usize,
    },
    TooManyOutliers {
        outliers: usize,
        usable: usize,
    },
    DriftExceeded {
        drift_ppm: f64,
        max_ppm: u32,
    },
    ResidualExceeded {
        marker_index: usize,
        residual_us: Micros,
        max_us: Micros,
    },
}

impl fmt::Display for EpochError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EpochError::NotEnoughMarkers { usable } => {
                write!(f, "not enough calibration markers ({usable} usable)")
            }
            EpochError::TooManyOutliers { outliers, usable } => {
                write!(f, "{outliers} of {usable} calibration markers are outliers")
            }
            EpochError::DriftExceeded { drift_ppm, max_ppm } => {
                write!(f, "clock drift {drift_ppm:.0} ppm exceeds {max_ppm} ppm")
            }
            EpochError::ResidualExceeded {
                marker_index,
                residual_us,
                max_us,
            } => write!(
                f,
                "marker {marker_index} residual {residual_us} exceeds {max_us}"
            ),
        }
    }
}

impl std::error::Error for EpochError {}

/// Fits the host → PTS transform for one take.
pub fn fit_epoch(
    markers: &[MarkerPair],
    fps: Fps,
    config: &EpochConfig,
) -> Result<EpochFit, EpochError> {
    let mut excluded = Vec::new();
    let mut usable: Vec<(usize, MarkerPair)> = Vec::new();
    for (index, marker) in markers.iter().enumerate() {
        if marker.pts_us <= Micros::ZERO {
            excluded.push(ExcludedMarker {
                index,
                reason: ExclusionReason::ClampedStart,
            });
        } else {
            usable.push((index, *marker));
        }
    }
    if usable.is_empty() {
        return Err(EpochError::NotEnoughMarkers { usable: 0 });
    }

    let frame = fps.frame_duration().0 as f64;
    let wants_slope = |pairs: &[(usize, MarkerPair)]| {
        let span = host_span(pairs);
        pairs.len() >= config.min_markers_for_slope.max(3) as usize
            && span >= config.min_span_for_slope_us.0
            && span > 0
    };

    let threshold = frame * f64::from(config.outlier_threshold_frames);
    let (robust_offset, robust_slope) = if wants_slope(&usable) {
        consensus_line(&usable, threshold, config.max_drift_ppm)
    } else {
        (median_offset(&usable), 1.0)
    };
    let mut inliers = Vec::with_capacity(usable.len());
    let mut outliers = 0usize;
    for &(index, marker) in &usable {
        let predicted = robust_offset + robust_slope * marker.host_us.0 as f64;
        if (marker.pts_us.0 as f64 - predicted).abs() > threshold {
            outliers += 1;
            excluded.push(ExcludedMarker {
                index,
                reason: ExclusionReason::Outlier,
            });
        } else {
            inliers.push((index, marker));
        }
    }
    if outliers * 2 > usable.len() {
        return Err(EpochError::TooManyOutliers {
            outliers,
            usable: usable.len(),
        });
    }
    excluded.sort_by_key(|e| e.index);

    let (method, offset_us, drift_ppb) = if wants_slope(&inliers) {
        let slope = least_squares_slope(&inliers);
        let drift_ppm = (slope - 1.0) * 1e6;
        if drift_ppm.abs() > f64::from(config.max_drift_ppm) {
            return Err(EpochError::DriftExceeded {
                drift_ppm,
                max_ppm: config.max_drift_ppm,
            });
        }
        let drift_ppb = ((slope - 1.0) * 1e9).round() as i64;
        let offset = fitted_offset(&inliers, drift_ppb);
        (FitMethod::LeastSquares, offset, drift_ppb)
    } else {
        (
            FitMethod::MedianOffset,
            Micros(median_offset(&inliers) as i64),
            0,
        )
    };

    let mut fit = EpochFit {
        offset_us,
        drift_ppb,
        method,
        inliers: inliers.len(),
        excluded,
        residual_max_us: Micros::ZERO,
        residual_rms_us: Micros::ZERO,
    };

    let max_us = Micros(frame as i64 * i64::from(config.max_residual_frames));
    let mut sum_sq = 0f64;
    for &(index, marker) in &inliers {
        let residual = (marker.pts_us - fit.host_to_pts(marker.host_us)).abs();
        if residual > max_us {
            return Err(EpochError::ResidualExceeded {
                marker_index: index,
                residual_us: residual,
                max_us,
            });
        }
        fit.residual_max_us = fit.residual_max_us.max(residual);
        sum_sq += (residual.0 as f64).powi(2);
    }
    fit.residual_rms_us = Micros((sum_sq / inliers.len() as f64).sqrt().round() as i64);
    Ok(fit)
}

fn host_span(pairs: &[(usize, MarkerPair)]) -> i64 {
    let min = pairs.iter().map(|(_, m)| m.host_us.0).min().unwrap_or(0);
    let max = pairs.iter().map(|(_, m)| m.host_us.0).max().unwrap_or(0);
    max - min
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n == 0 {
        0.0
    } else if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

fn median_offset(pairs: &[(usize, MarkerPair)]) -> f64 {
    median(
        pairs
            .iter()
            .map(|(_, m)| (m.pts_us.0 - m.host_us.0) as f64)
            .collect(),
    )
    .round()
}

/// Line with the most markers within `threshold`, among lines through each
/// pair of markers whose drift is within bounds and zero-drift lines through
/// each marker. Ties go to the smaller total residual. Unlike Theil–Sen this
/// tolerates one bad marker out of three.
fn consensus_line(pairs: &[(usize, MarkerPair)], threshold: f64, max_drift_ppm: u32) -> (f64, f64) {
    let point = |m: &MarkerPair| (m.host_us.0 as f64, m.pts_us.0 as f64);
    let mut candidates: Vec<(f64, f64)> = pairs
        .iter()
        .map(|(_, m)| {
            let (h, p) = point(m);
            (p - h, 1.0)
        })
        .collect();
    for (i, (_, a)) in pairs.iter().enumerate() {
        for (_, b) in &pairs[i + 1..] {
            let ((ha, pa), (hb, pb)) = (point(a), point(b));
            if hb != ha {
                let slope = (pb - pa) / (hb - ha);
                if ((slope - 1.0) * 1e6).abs() <= f64::from(max_drift_ppm) {
                    candidates.push((pa - slope * ha, slope));
                }
            }
        }
    }
    let score = |&(offset, slope): &(f64, f64)| {
        pairs.iter().fold((0usize, 0f64), |(count, total), (_, m)| {
            let (h, p) = point(m);
            let residual = (p - (offset + slope * h)).abs();
            if residual <= threshold {
                (count + 1, total + residual)
            } else {
                (count, total)
            }
        })
    };
    let mut best = (median_offset(pairs), 1.0);
    let mut best_score = score(&best);
    for candidate in candidates {
        let s = score(&candidate);
        if s.0 > best_score.0 || (s.0 == best_score.0 && s.1 < best_score.1) {
            best = candidate;
            best_score = s;
        }
    }
    best
}

/// Centered ordinary least-squares slope.
fn least_squares_slope(pairs: &[(usize, MarkerPair)]) -> f64 {
    let n = pairs.len() as f64;
    let mean_h = pairs.iter().map(|(_, m)| m.host_us.0 as f64).sum::<f64>() / n;
    let mean_p = pairs.iter().map(|(_, m)| m.pts_us.0 as f64).sum::<f64>() / n;
    let (mut sxy, mut sxx) = (0f64, 0f64);
    for (_, m) in pairs {
        let dh = m.host_us.0 as f64 - mean_h;
        sxy += dh * (m.pts_us.0 as f64 - mean_p);
        sxx += dh * dh;
    }
    if sxx > 0.0 {
        sxy / sxx
    } else {
        1.0
    }
}

/// Mean residual offset given an already-rounded drift, so the integer
/// transform is unbiased.
fn fitted_offset(pairs: &[(usize, MarkerPair)], drift_ppb: i64) -> Micros {
    let zero = EpochFit {
        drift_ppb,
        ..EpochFit::constant(Micros::ZERO)
    };
    let sum: i128 = pairs
        .iter()
        .map(|(_, m)| i128::from((m.pts_us - zero.host_to_pts(m.host_us)).0))
        .sum();
    Micros(saturate(round_div(sum, pairs.len() as i128)))
}

fn round_div(a: i128, b: i128) -> i128 {
    let q = a.div_euclid(b);
    let r = a.rem_euclid(b);
    if 2 * r >= b {
        q + 1
    } else {
        q
    }
}

fn saturate(v: i128) -> i64 {
    v.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}
