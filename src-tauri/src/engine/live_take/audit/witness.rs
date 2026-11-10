//! The semantic witness: page-side timestamps of an action's first DOM
//! effect, logged by the sidecar (not measured from pixels). It maps through
//! the marker epoch onto output frames and can only BLOCK a pass when it
//! disagrees with the pixel onset; it never creates a pass by itself.

use super::super::sidecar_io::{StepWitness, WitnessEvent};
use crate::engine::demo_timing::{EpochFit, Fps, FrameIndex, Micros};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessConfig {
    /// Clock uncertainty above this makes the witness too loose to gate.
    pub loose_ms: f64,
    /// Accepted pixel onset relative to the effect span `[first, last]`
    /// (`first + agree_min ..= last + agree_max`), in RAW frames: a retime hold
    /// repeats the last pre-action raw frame, so output-frame distance would
    /// magnify a one-frame capture difference into the hold length.
    pub agree_min: i64,
    pub agree_max: i64,
}

impl Default for WitnessConfig {
    fn default() -> Self {
        Self {
            loose_ms: 20.0,
            agree_min: -1,
            agree_max: 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WitnessStatus {
    Agrees,
    Conflicts,
    /// The page↔host clock is too uncertain to compare.
    Loose,
    /// The take was recorded without a witness.
    Absent,
    /// No effect of the right kind was observed on the page.
    NoEffect,
    /// The step kind has no witnessable effect.
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessEvidence {
    pub status: WitnessStatus,
    pub event_kind: Option<String>,
    /// The effect's animation-frame time on the host clock (ms since t0).
    pub host_ms: Option<f64>,
    pub raw_frame: Option<FrameIndex>,
    pub output_frame: Option<usize>,
    pub clock_uncertainty_ms: Option<f64>,
    /// Raw frame of the LAST fitting effect before the post marker: page
    /// activity from the action (e.g. a route render after its URL change)
    /// can run over several frames.
    pub last_raw_frame: Option<FrameIndex>,
    /// Raw frame shown at the pixel onset.
    pub pixel_raw_frame: Option<FrameIndex>,
    /// `pixel onset raw frame − first effect raw frame`.
    pub delta_frames: Option<i64>,
}

const WITNESSED_KINDS: [&str; 4] = ["click", "type", "scroll", "navigate"];

/// Event kinds that count as the visible effect of a step kind.
fn fits(step_kind: &str, event_kind: &str) -> bool {
    match step_kind {
        "click" => matches!(event_kind, "effect:mutation" | "effect:scroll" | "document"),
        "type" => matches!(event_kind, "effect:input" | "effect:mutation"),
        "scroll" => event_kind == "effect:scroll",
        "navigate" => event_kind == "document",
        _ => false,
    }
}

pub fn clock_uncertainty_ms(w: &StepWitness) -> f64 {
    w.clock_pre.rtt_ms.max(w.clock_post.rtt_ms) / 2.0
        + (w.clock_pre.offset_ms - w.clock_post.offset_ms).abs()
}

/// Whether the step navigated: a new document, or the URL changed between
/// logged events (an SPA route change).
fn navigated(w: &StepWitness) -> bool {
    let mut urls = w.events.iter().filter_map(|e| e.url.as_deref());
    let first = urls.next();
    w.events.iter().any(|e| e.kind == "document") || urls.any(|u| Some(u) != first)
}

/// The earliest logged effect that fits the step kind and, for a step that
/// navigated, the latest one before the post marker (the new route renders
/// over several frames). Otherwise the span is just the first effect, so
/// unrelated later page activity can't widen it.
pub fn effect_span<'a>(
    step_kind: &str,
    w: &'a StepWitness,
) -> Option<(&'a WitnessEvent, &'a WitnessEvent)> {
    let fitting = || w.events.iter().filter(|e| fits(step_kind, &e.kind));
    let first = fitting().min_by(|a, b| a.frame.total_cmp(&b.frame))?;
    if !navigated(w) {
        return Some((first, first));
    }
    let last = fitting().max_by(|a, b| a.frame.total_cmp(&b.frame))?;
    Some((first, last))
}

/// First output frame showing raw frame `raw` or later.
pub fn output_frame_at_or_after(frame_map: &[FrameIndex], raw: FrameIndex) -> Option<usize> {
    frame_map.iter().position(|&s| s >= raw)
}

/// Where the witness says the effect first rendered, in output frames.
pub fn witness(
    step_kind: &str,
    w: Option<&StepWitness>,
    raw_epoch: &EpochFit,
    frame_map: &[FrameIndex],
    fps: Fps,
    pixel_onset: Option<usize>,
    cfg: &WitnessConfig,
) -> WitnessEvidence {
    let mut ev = WitnessEvidence {
        status: WitnessStatus::Absent,
        event_kind: None,
        host_ms: None,
        raw_frame: None,
        output_frame: None,
        clock_uncertainty_ms: None,
        last_raw_frame: None,
        pixel_raw_frame: None,
        delta_frames: None,
    };
    if !WITNESSED_KINDS.contains(&step_kind) {
        ev.status = WitnessStatus::NotApplicable;
        return ev;
    }
    let Some(w) = w else {
        return ev;
    };
    let unc = clock_uncertainty_ms(w);
    ev.clock_uncertainty_ms = Some(unc);
    let Some((e, last)) = effect_span(step_kind, w) else {
        ev.status = WitnessStatus::NoEffect;
        return ev;
    };
    ev.event_kind = Some(e.kind.clone());
    let offset = (w.clock_pre.offset_ms + w.clock_post.offset_ms) / 2.0;
    let raw_at = |page_ms: f64| {
        let host_ms = page_ms + offset;
        (
            host_ms,
            fps.frame_ceil(raw_epoch.host_to_pts(Micros((host_ms * 1000.0).round() as i64))),
        )
    };
    let (host_ms, raw) = raw_at(e.frame);
    let last_raw = raw_at(last.frame).1;
    ev.host_ms = Some(host_ms);
    ev.raw_frame = Some(raw);
    ev.last_raw_frame = Some(last_raw);
    ev.output_frame = output_frame_at_or_after(frame_map, raw);
    ev.pixel_raw_frame = pixel_onset.and_then(|p| frame_map.get(p).copied());
    ev.delta_frames = ev.pixel_raw_frame.map(|p| p - raw);
    ev.status = if unc > cfg.loose_ms {
        WitnessStatus::Loose
    } else {
        match ev.pixel_raw_frame {
            Some(p) if (raw + cfg.agree_min..=last_raw + cfg.agree_max).contains(&p) => {
                WitnessStatus::Agrees
            }
            Some(_) => WitnessStatus::Conflicts,
            None => WitnessStatus::NoEffect,
        }
    };
    ev
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::live_take::sidecar_io::ClockProbe;

    fn probe(offset_ms: f64, rtt_ms: f64) -> ClockProbe {
        ClockProbe {
            host_ms: 0.0,
            page_ms: 0.0,
            rtt_ms,
            offset_ms,
        }
    }

    fn event(kind: &str, frame: f64) -> WitnessEvent {
        WitnessEvent {
            doc: "d".into(),
            kind: kind.into(),
            at: frame,
            frame,
            bbox: None,
            url: Some("/".into()),
            received_ms: None,
        }
    }

    fn at_url(mut e: WitnessEvent, url: &str) -> WitnessEvent {
        e.url = Some(url.into());
        e
    }

    fn step(events: Vec<WitnessEvent>, offset_ms: f64) -> StepWitness {
        StepWitness {
            clock_pre: probe(offset_ms, 1.0),
            clock_post: probe(offset_ms, 2.0),
            events,
        }
    }

    /// Page time 1_000_000 ms ≙ host 1000 ms ≙ raw PTS 1000 ms (frame 25).
    const OFFSET: f64 = -999_000.0;

    fn identity_map(n: usize) -> Vec<FrameIndex> {
        (0..n as FrameIndex).collect()
    }

    #[test]
    fn effect_maps_through_epoch_and_frame_map() {
        let w = step(
            vec![
                event("input:pointerdown", 1_000_000.0),
                event("effect:mutation", 1_000_010.0),
            ],
            OFFSET,
        );
        let epoch = EpochFit::constant(Micros::ZERO);
        let ev = witness(
            "click",
            Some(&w),
            &epoch,
            &identity_map(60),
            Fps::FPS_25,
            Some(27),
            &WitnessConfig::default(),
        );
        assert_eq!(ev.event_kind.as_deref(), Some("effect:mutation"));
        // host = 1010 ms → first frame at or after = 26.
        assert_eq!(ev.raw_frame, Some(26));
        assert_eq!(ev.output_frame, Some(26));
        assert_eq!(ev.delta_frames, Some(1));
        assert_eq!(ev.status, WitnessStatus::Agrees);
    }

    #[test]
    fn retime_holds_shift_the_output_frame() {
        let w = step(vec![event("effect:scroll", 1_000_000.0)], OFFSET);
        // Raw frames 0..20 held for 10 extra frames before raw 20.
        let mut map: Vec<FrameIndex> = (0..20).collect();
        map.extend(std::iter::repeat_n(19, 10));
        map.extend(20..60);
        let epoch = EpochFit::constant(Micros::ZERO);
        let ev = witness(
            "scroll",
            Some(&w),
            &epoch,
            &map,
            Fps::FPS_25,
            Some(30),
            &WitnessConfig::default(),
        );
        assert_eq!(ev.raw_frame, Some(25));
        assert_eq!(ev.output_frame, Some(35));
        assert_eq!(ev.pixel_raw_frame, Some(20));
        assert_eq!(ev.delta_frames, Some(-5));
        assert_eq!(ev.status, WitnessStatus::Conflicts);
    }

    #[test]
    fn pixels_agree_anywhere_within_the_effect_span() {
        // Route change: first mutation at raw 25, the new page renders until
        // raw 28 (host 1120 ms).
        let w = step(
            vec![
                event("effect:mutation", 1_000_000.0),
                at_url(event("effect:mutation", 1_000_120.0), "/docs"),
            ],
            OFFSET,
        );
        let epoch = EpochFit::constant(Micros::ZERO);
        let cfg = WitnessConfig::default();
        let at = |onset| {
            witness(
                "click",
                Some(&w),
                &epoch,
                &identity_map(60),
                Fps::FPS_25,
                Some(onset),
                &cfg,
            )
        };
        assert_eq!(at(28).last_raw_frame, Some(28));
        assert_eq!(at(28).delta_frames, Some(3));
        assert_eq!(at(30).status, WitnessStatus::Agrees);
        assert_eq!(at(24).status, WitnessStatus::Agrees);
        assert_eq!(at(31).status, WitnessStatus::Conflicts);
        assert_eq!(at(23).status, WitnessStatus::Conflicts);
    }

    #[test]
    fn without_navigation_later_activity_does_not_widen_the_span() {
        let w = step(
            vec![
                event("effect:mutation", 1_000_000.0),
                event("effect:mutation", 1_000_120.0),
            ],
            OFFSET,
        );
        let epoch = EpochFit::constant(Micros::ZERO);
        let cfg = WitnessConfig::default();
        let at = |onset| {
            witness(
                "click",
                Some(&w),
                &epoch,
                &identity_map(60),
                Fps::FPS_25,
                Some(onset),
                &cfg,
            )
        };
        assert_eq!(at(28).last_raw_frame, Some(25));
        assert_eq!(at(27).status, WitnessStatus::Agrees);
        assert_eq!(at(28).status, WitnessStatus::Conflicts);
    }

    #[test]
    fn a_hold_before_the_effect_does_not_magnify_the_delta() {
        // The witness maps to raw 19, which the retime holds for 10 extra
        // frames; the change shows in raw 20 at output 30. In output frames
        // that would be 11 apart, in raw frames only 1.
        let w = step(vec![event("effect:mutation", 999_760.0)], OFFSET);
        let mut map: Vec<FrameIndex> = (0..20).collect();
        map.extend(std::iter::repeat_n(19, 10));
        map.extend(20..60);
        let epoch = EpochFit::constant(Micros::ZERO);
        let ev = witness(
            "click",
            Some(&w),
            &epoch,
            &map,
            Fps::FPS_25,
            Some(30),
            &WitnessConfig::default(),
        );
        assert_eq!(ev.raw_frame, Some(19));
        assert_eq!(ev.output_frame, Some(19));
        assert_eq!(ev.pixel_raw_frame, Some(20));
        assert_eq!(ev.delta_frames, Some(1));
        assert_eq!(ev.status, WitnessStatus::Agrees);
    }

    #[test]
    fn wrong_kind_events_are_ignored() {
        let w = step(vec![event("effect:mutation", 1_000_000.0)], OFFSET);
        let epoch = EpochFit::constant(Micros::ZERO);
        let ev = witness(
            "scroll",
            Some(&w),
            &epoch,
            &identity_map(60),
            Fps::FPS_25,
            Some(25),
            &WitnessConfig::default(),
        );
        assert_eq!(ev.status, WitnessStatus::NoEffect);
    }

    #[test]
    fn loose_clock_never_agrees() {
        let mut w = step(vec![event("effect:input", 1_000_000.0)], OFFSET);
        w.clock_post.offset_ms = OFFSET + 30.0;
        let epoch = EpochFit::constant(Micros::ZERO);
        let ev = witness(
            "type",
            Some(&w),
            &epoch,
            &identity_map(80),
            Fps::FPS_25,
            Some(26),
            &WitnessConfig::default(),
        );
        assert_eq!(ev.status, WitnessStatus::Loose);
    }

    #[test]
    fn missing_witness_is_absent_and_waits_are_not_applicable() {
        let epoch = EpochFit::constant(Micros::ZERO);
        let cfg = WitnessConfig::default();
        let ev = witness("click", None, &epoch, &[], Fps::FPS_25, Some(1), &cfg);
        assert_eq!(ev.status, WitnessStatus::Absent);
        let ev = witness("wait", None, &epoch, &[], Fps::FPS_25, Some(1), &cfg);
        assert_eq!(ev.status, WitnessStatus::NotApplicable);
    }
}
