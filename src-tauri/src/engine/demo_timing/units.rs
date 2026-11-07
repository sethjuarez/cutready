//! Integer time units: microseconds and frame indices at a rational frame rate.
//!
//! Times are never floats. Host instants and word times are [`Micros`]
//! relative to a take epoch `t0`; edit decisions are [`FrameIndex`] values on
//! the grid of a declared [`Fps`].

use serde::{Deserialize, Serialize};
use std::fmt;
use std::ops::{Add, AddAssign, Neg, Sub, SubAssign};

const MICROS_PER_SECOND: i128 = 1_000_000;

/// A signed duration or instant in integer microseconds.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct Micros(pub i64);

impl Micros {
    pub const ZERO: Micros = Micros(0);

    pub const fn from_millis(ms: i64) -> Self {
        Micros(ms * 1_000)
    }

    pub const fn get(self) -> i64 {
        self.0
    }

    pub const fn abs(self) -> Micros {
        Micros(self.0.saturating_abs())
    }
}

impl fmt::Display for Micros {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}µs", self.0)
    }
}

impl Add for Micros {
    type Output = Micros;
    fn add(self, rhs: Micros) -> Micros {
        Micros(self.0 + rhs.0)
    }
}

impl AddAssign for Micros {
    fn add_assign(&mut self, rhs: Micros) {
        self.0 += rhs.0;
    }
}

impl Sub for Micros {
    type Output = Micros;
    fn sub(self, rhs: Micros) -> Micros {
        Micros(self.0 - rhs.0)
    }
}

impl SubAssign for Micros {
    fn sub_assign(&mut self, rhs: Micros) {
        self.0 -= rhs.0;
    }
}

impl Neg for Micros {
    type Output = Micros;
    fn neg(self) -> Micros {
        Micros(-self.0)
    }
}

/// A zero-based frame index (or frame count) on an [`Fps`] grid.
pub type FrameIndex = i64;

/// A rational, strictly positive frame rate (`num / den` frames per second).
///
/// Construct with [`Fps::new`]; deserialization rejects a zero numerator or
/// denominator, so every `Fps` value is valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "FpsRepr", into = "FpsRepr")]
pub struct Fps {
    num: u32,
    den: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FpsRepr {
    num: u32,
    den: u32,
}

impl TryFrom<FpsRepr> for Fps {
    type Error = String;
    fn try_from(repr: FpsRepr) -> Result<Self, Self::Error> {
        Fps::new(repr.num, repr.den).ok_or_else(|| format!("invalid fps {}/{}", repr.num, repr.den))
    }
}

impl From<Fps> for FpsRepr {
    fn from(fps: Fps) -> Self {
        FpsRepr {
            num: fps.num,
            den: fps.den,
        }
    }
}

impl Fps {
    /// Playwright's `recordVideo` rate, measured as strict CFR in the spike.
    pub const FPS_25: Fps = Fps { num: 25, den: 1 };

    pub const fn new(num: u32, den: u32) -> Option<Fps> {
        if num == 0 || den == 0 {
            None
        } else {
            Some(Fps { num, den })
        }
    }

    pub const fn num(self) -> u32 {
        self.num
    }

    pub const fn den(self) -> u32 {
        self.den
    }

    fn scale(self) -> (i128, i128) {
        (
            i128::from(self.num),
            i128::from(self.den) * MICROS_PER_SECOND,
        )
    }

    /// Index of the frame whose display interval contains `t`.
    pub fn frame_floor(self, t: Micros) -> FrameIndex {
        let (n, d) = self.scale();
        clamp_i64((i128::from(t.0) * n).div_euclid(d))
    }

    /// Index of the first frame whose [`Fps::frame_start`] is at or after
    /// `t`, so `frame_ceil(frame_start(f)) == f` at every rate.
    pub fn frame_ceil(self, t: Micros) -> FrameIndex {
        let (n, d) = self.scale();
        clamp_i64((i128::from(t.0) - 1).saturating_mul(n).div_euclid(d) + 1)
    }

    /// Nearest frame to `t` (half rounds up).
    pub fn frame_round(self, t: Micros) -> FrameIndex {
        let (n, d) = self.scale();
        clamp_i64((2 * i128::from(t.0) * n + d).div_euclid(2 * d))
    }

    /// Start time of `frame`, rounded up to the next whole microsecond so
    /// `frame_floor(frame_start(f)) == f` holds for every rate.
    pub fn frame_start(self, frame: FrameIndex) -> Micros {
        let (n, d) = self.scale();
        Micros(clamp_i64(div_ceil(i128::from(frame) * d, n)))
    }

    /// Duration of `frames` frames, rounded up to whole microseconds.
    pub fn frames_to_micros(self, frames: FrameIndex) -> Micros {
        self.frame_start(frames)
    }

    /// One frame period, rounded up to whole microseconds.
    pub fn frame_duration(self) -> Micros {
        self.frame_start(1)
    }
}

/// Ceiling division for a strictly positive divisor.
pub(crate) fn div_ceil(a: i128, b: i128) -> i128 {
    -((-a).div_euclid(b))
}

fn clamp_i64(v: i128) -> i64 {
    v.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}
