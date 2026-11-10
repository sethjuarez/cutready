use super::epoch::{
    fit_epoch, EpochConfig, EpochError, EpochFit, ExclusionReason, FitMethod, MarkerPair,
};
use super::test_support::Rng;
use super::units::{Fps, Micros};

fn pair(host_ms: i64, pts_ms: i64) -> MarkerPair {
    MarkerPair {
        host_us: Micros::from_millis(host_ms),
        pts_us: Micros::from_millis(pts_ms),
    }
}

fn fit(markers: &[MarkerPair]) -> Result<EpochFit, EpochError> {
    fit_epoch(markers, Fps::FPS_25, &EpochConfig::default())
}

#[test]
fn short_take_uses_median_offset_and_excludes_clamped_start() {
    let markers = [
        pair(100, 0),
        pair(1_000, 710),
        pair(2_000, 1_685),
        pair(3_000, 2_705),
        pair(4_000, 3_700),
        pair(5_000, 4_680),
    ];
    let fit = fit(&markers).unwrap();
    assert_eq!(fit.method, FitMethod::MedianOffset);
    assert_eq!(fit.offset_us, Micros::from_millis(-300));
    assert_eq!(fit.drift_ppb, 0);
    assert_eq!(fit.inliers, 5);
    assert_eq!(fit.excluded.len(), 1);
    assert_eq!(fit.excluded[0].index, 0);
    assert_eq!(fit.excluded[0].reason, ExclusionReason::ClampedStart);
    assert_eq!(fit.residual_max_us, Micros::from_millis(20));
    assert_eq!(fit.residual_rms_us, Micros(12_247));
}

#[test]
fn long_take_fits_slope_by_least_squares() {
    let markers: Vec<MarkerPair> = (1..=13)
        .map(|i| {
            let host = i * 10_000_000;
            MarkerPair {
                host_us: Micros(host),
                pts_us: Micros(host + host / 5_000 - 500_000),
            }
        })
        .collect();
    let fit = fit(&markers).unwrap();
    assert_eq!(fit.method, FitMethod::LeastSquares);
    assert!((fit.drift_ppb - 200_000).abs() <= 1, "{}", fit.drift_ppb);
    assert!(
        (fit.offset_us.0 + 500_000).abs() <= 2,
        "{:?}",
        fit.offset_us
    );
    assert!(fit.residual_max_us <= Micros(2));
    assert!(fit.excluded.is_empty());
}

#[test]
fn drift_beyond_limit_is_rejected() {
    let markers: Vec<MarkerPair> = (1..=13)
        .map(|i| {
            let host = i * 10_000_000;
            MarkerPair {
                host_us: Micros(host),
                pts_us: Micros(host + host / 500 - 500_000),
            }
        })
        .collect();
    match fit(&markers) {
        Err(EpochError::DriftExceeded { drift_ppm, max_ppm }) => {
            assert!((drift_ppm - 2_000.0).abs() < 1.0);
            assert_eq!(max_ppm, 1_000);
        }
        other => panic!("expected drift error, got {other:?}"),
    }
}

#[test]
fn short_span_quantization_does_not_fake_drift() {
    // ±20 ms of frame jitter over 10 s looks like 4000 ppm of slope.
    let markers = [pair(1_000, 680), pair(6_000, 5_700), pair(11_000, 10_720)];
    let fit = fit(&markers).unwrap();
    assert_eq!(fit.method, FitMethod::MedianOffset);
    assert_eq!(fit.offset_us, Micros::from_millis(-300));

    let eager = EpochConfig {
        min_span_for_slope_us: Micros::ZERO,
        ..EpochConfig::default()
    };
    assert!(matches!(
        fit_epoch(&markers, Fps::FPS_25, &eager),
        Err(EpochError::DriftExceeded { .. })
    ));
}

#[test]
fn gross_outlier_is_excluded() {
    let markers = [
        pair(1_000, 700),
        pair(2_000, 1_700),
        pair(3_000, 3_200),
        pair(4_000, 3_710),
        pair(5_000, 4_690),
        pair(6_000, 5_700),
    ];
    let fit = fit(&markers).unwrap();
    assert_eq!(fit.inliers, 5);
    assert_eq!(fit.excluded.len(), 1);
    assert_eq!(fit.excluded[0].index, 2);
    assert_eq!(fit.excluded[0].reason, ExclusionReason::Outlier);
    assert_eq!(fit.offset_us, Micros::from_millis(-300));
}

#[test]
fn outlier_on_long_take_is_excluded_from_slope() {
    let mut markers: Vec<MarkerPair> = (1..=13)
        .map(|i| {
            let host = i * 10_000_000;
            MarkerPair {
                host_us: Micros(host),
                pts_us: Micros(host + host / 10_000 - 250_000),
            }
        })
        .collect();
    markers[6].pts_us += Micros::from_millis(900);
    let fit = fit(&markers).unwrap();
    assert_eq!(fit.method, FitMethod::LeastSquares);
    assert_eq!(fit.excluded.len(), 1);
    assert_eq!(fit.excluded[0].index, 6);
    assert!((fit.drift_ppb - 100_000).abs() <= 1);
}

#[test]
fn endpoint_outlier_among_three_long_take_markers_is_excluded() {
    // Theil–Sen would tilt the line and reject the good middle marker.
    let markers = [
        pair(10_000, 10_200),
        pair(70_000, 69_700),
        pair(130_000, 129_700),
    ];
    let three = fit(&markers).unwrap();
    assert_eq!(three.excluded.len(), 1);
    assert_eq!(three.excluded[0].index, 0);
    assert_eq!(three.excluded[0].reason, ExclusionReason::Outlier);
    // Two inliers are too few for a slope.
    assert_eq!(three.method, FitMethod::MedianOffset);
    assert_eq!(three.offset_us, Micros::from_millis(-300));

    // With four markers and real drift, the slope survives the outlier.
    let mut drifting: Vec<MarkerPair> = (1..=4)
        .map(|i| {
            let host = i * 40_000_000;
            MarkerPair {
                host_us: Micros(host),
                pts_us: Micros(host + host / 2_000 - 300_000),
            }
        })
        .collect();
    drifting[3].pts_us += Micros::from_millis(700);
    let four = fit(&drifting).unwrap();
    assert_eq!(four.method, FitMethod::LeastSquares);
    assert_eq!(four.excluded[0].index, 3);
    assert!((four.drift_ppb - 500_000).abs() <= 1, "{}", four.drift_ppb);
}

#[test]
fn two_markers_never_fit_a_slope() {
    let config = EpochConfig {
        min_markers_for_slope: 2,
        ..EpochConfig::default()
    };
    let markers = [pair(10_000, 9_700), pair(130_000, 129_720)];
    let fit = fit_epoch(&markers, Fps::FPS_25, &config).unwrap();
    assert_eq!(fit.method, FitMethod::MedianOffset);
}

#[test]
fn failure_cases() {
    assert_eq!(
        fit(&[pair(10, 0), pair(20, -5)]),
        Err(EpochError::NotEnoughMarkers { usable: 0 })
    );
    assert_eq!(fit(&[]), Err(EpochError::NotEnoughMarkers { usable: 0 }));
    assert_eq!(
        fit(&[pair(1_000, 700), pair(2_000, 2_200), pair(3_000, 3_700)]),
        Err(EpochError::TooManyOutliers {
            outliers: 2,
            usable: 3
        })
    );
    assert_eq!(
        fit(&[pair(1_000, 700), pair(2_000, 1_700), pair(3_000, 2_640)]),
        Err(EpochError::ResidualExceeded {
            marker_index: 2,
            residual_us: Micros::from_millis(60),
            max_us: Micros::from_millis(40),
        })
    );
}

#[test]
fn single_marker_is_enough_for_an_offset() {
    let fit = fit(&[pair(50, 0), pair(1_000, 640)]).unwrap();
    assert_eq!(fit.offset_us, Micros::from_millis(-360));
    assert_eq!(fit.inliers, 1);
}

#[test]
fn transform_round_trips() {
    let fit = EpochFit {
        drift_ppb: 500_000,
        ..EpochFit::constant(Micros::from_millis(-300))
    };
    assert_eq!(fit.host_to_pts(Micros(10_000_000)), Micros(9_705_000));
    let mut rng = Rng::new(7);
    for _ in 0..1_000 {
        let host = Micros(rng.range(-10_000_000, 3_600_000_000));
        let back = fit.pts_to_host(fit.host_to_pts(host));
        assert!((back - host).abs() <= Micros(1), "{host:?} -> {back:?}");
    }
}

#[test]
fn epoch_fit_serializes_camel_case() {
    let fit = fit(&[pair(100, 0), pair(1_000, 700)]).unwrap();
    let json = serde_json::to_value(&fit).unwrap();
    assert_eq!(json["offsetUs"], -300_000);
    assert_eq!(json["method"], "medianOffset");
    assert_eq!(json["excluded"][0]["reason"], "clampedStart");
    assert_eq!(serde_json::from_value::<EpochFit>(json).unwrap(), fit);
}
