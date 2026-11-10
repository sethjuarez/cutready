use super::units::{Fps, Micros};

const NTSC: Fps = match Fps::new(30_000, 1_001) {
    Some(fps) => fps,
    None => Fps::FPS_25,
};

#[test]
fn fps_rejects_zero_and_round_trips_json() {
    assert!(Fps::new(0, 1).is_none());
    assert!(Fps::new(25, 0).is_none());
    let json = serde_json::to_string(&Fps::FPS_25).unwrap();
    assert_eq!(json, r#"{"num":25,"den":1}"#);
    assert_eq!(serde_json::from_str::<Fps>(&json).unwrap(), Fps::FPS_25);
    assert!(serde_json::from_str::<Fps>(r#"{"num":25,"den":0}"#).is_err());
}

#[test]
fn frame_conversions_at_25fps() {
    let fps = Fps::FPS_25;
    let cases: &[(i64, i64, i64, i64)] = &[
        // micros, floor, ceil, round
        (0, 0, 0, 0),
        (1, 0, 1, 0),
        (19_999, 0, 1, 0),
        (20_000, 0, 1, 1),
        (39_999, 0, 1, 1),
        (40_000, 1, 1, 1),
        (40_001, 1, 2, 1),
        (1_000_000, 25, 25, 25),
        (-1, -1, 0, 0),
        (-20_000, -1, 0, 0),
        (-20_001, -1, 0, -1),
        (-40_000, -1, -1, -1),
    ];
    for &(us, floor, ceil, round) in cases {
        let t = Micros(us);
        assert_eq!(fps.frame_floor(t), floor, "floor {us}");
        assert_eq!(fps.frame_ceil(t), ceil, "ceil {us}");
        assert_eq!(fps.frame_round(t), round, "round {us}");
    }
    assert_eq!(fps.frame_start(3), Micros(120_000));
    assert_eq!(fps.frames_to_micros(25), Micros(1_000_000));
    assert_eq!(fps.frame_duration(), Micros(40_000));
}

#[test]
fn ntsc_frame_starts_are_consistent_with_floor_and_ceil() {
    assert_eq!(NTSC.frame_duration(), Micros(33_367));
    for frame in -50..5_000 {
        let start = NTSC.frame_start(frame);
        assert_eq!(NTSC.frame_floor(start), frame, "floor at {frame}");
        assert_eq!(NTSC.frame_ceil(start), frame, "ceil at {frame}");
        assert_eq!(NTSC.frame_ceil(start + Micros(1)), frame + 1);
        assert_eq!(NTSC.frame_floor(start - Micros(1)), frame - 1);
        assert_eq!(NTSC.frame_round(start), frame);
    }
}

#[test]
fn micros_arithmetic_and_serde() {
    let a = Micros::from_millis(5);
    assert_eq!(a + Micros(1), Micros(5_001));
    assert_eq!(a - Micros(6_000), Micros(-1_000));
    assert_eq!((-a).abs(), a);
    assert_eq!(Micros(i64::MIN).abs(), Micros(i64::MAX));
    assert_eq!(serde_json::to_string(&a).unwrap(), "5000");
    assert_eq!(a.to_string(), "5000µs");
}
