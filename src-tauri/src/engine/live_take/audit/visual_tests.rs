use super::*;

const W: usize = 160;
const H: usize = 90;

/// A textured background so SSIM has structure to compare.
fn background() -> Vec<u8> {
    (0..W * H)
        .map(|i| (((i % W) * 3 + (i / W) * 5) % 64 + 96) as u8)
        .collect()
}

fn paint(frame: &mut [u8], x0: usize, y0: usize, x1: usize, y1: usize, v: u8) {
    for y in y0..y1 {
        for x in x0..x1 {
            frame[y * W + x] = v;
        }
    }
}

fn video(n: usize, edit: impl Fn(usize, &mut Vec<u8>)) -> GrayFrames {
    let mut data = Vec::with_capacity(n * W * H);
    for f in 0..n {
        let mut frame = background();
        edit(f, &mut frame);
        data.extend_from_slice(&frame);
    }
    GrayFrames {
        width: W,
        height: H,
        data,
    }
}

fn cfg() -> VisualConfig {
    VisualConfig {
        cell: 10,
        ..VisualConfig::default()
    }
}

fn tiny_box() -> ViewBox {
    ViewBox {
        x: 20.0,
        y: 30.0,
        width: 20.0,
        height: 6.0,
    }
}

#[test]
fn tiny_persistent_change_is_found_by_both_detectors() {
    let v = video(40, |f, fr| {
        if f >= 23 {
            paint(fr, 22, 31, 38, 34, 255);
        }
    });
    let win = Window::around(20, 15, 0, 39);
    let ev = observe(&v, win, Some(tiny_box()), &cfg());
    assert_eq!(ev.grid.onset, Some(23));
    assert!(!ev.ssim.abstained);
    assert_eq!(ev.ssim.onset, Some(23));
    assert_eq!(ev.locality, Locality::AtTarget);
    assert!(!ev.in_progress_at_start);
}

#[test]
fn caret_frozen_off_by_a_hold_does_not_set_the_onset() {
    // A retime hold froze the caret "off" right after the window starts;
    // the real change (placeholder replaced by typed text) comes later.
    let v = video(40, |f, fr| {
        if f <= 5 {
            paint(fr, 12, 30, 13, 40, 0);
        }
        if f >= 25 {
            paint(fr, 20, 30, 100, 40, 255);
        }
    });
    let ev = observe(&v, Window::around(20, 15, 0, 39), None, &cfg());
    assert_eq!(ev.grid.net_cells, 9);
    assert_eq!(ev.grid.onset, Some(25));
}

#[test]
fn transient_blink_does_not_set_the_onset() {
    let v = video(40, |f, fr| {
        // Caret blink at the target before the real change.
        if (10..14).contains(&f) {
            paint(fr, 22, 31, 24, 34, 0);
        }
        if f >= 25 {
            paint(fr, 22, 31, 38, 34, 255);
        }
    });
    let ev = observe(&v, Window::around(20, 15, 0, 39), Some(tiny_box()), &cfg());
    assert_eq!(ev.grid.onset, Some(25));
    assert_eq!(ev.ssim.onset, Some(25));
}

#[test]
fn frozen_frames_after_a_change_keep_the_onset() {
    // The retime may hold a frame; a change that persists through a hold
    // still has one onset.
    let v = video(40, |f, fr| {
        if f >= 18 {
            paint(fr, 22, 31, 38, 34, 255);
        }
    });
    let ev = observe(&v, Window::around(20, 15, 0, 39), Some(tiny_box()), &cfg());
    assert_eq!(ev.grid.onset, Some(18));
}

#[test]
fn no_change_means_no_onset_and_d2_abstains() {
    let v = video(40, |_, _| {});
    let ev = observe(&v, Window::around(20, 15, 0, 39), Some(tiny_box()), &cfg());
    assert_eq!(ev.grid.net_cells, 0);
    assert_eq!(ev.grid.onset, None);
    assert!(ev.ssim.abstained);
}

#[test]
fn change_far_from_the_target_is_elsewhere() {
    let v = video(40, |f, fr| {
        if f >= 22 {
            paint(fr, 120, 70, 140, 80, 0);
        }
    });
    let ev = observe(&v, Window::around(20, 15, 0, 39), Some(tiny_box()), &cfg());
    assert_eq!(ev.locality, Locality::Elsewhere);
}

#[test]
fn whole_view_change_is_global() {
    let v = video(40, |f, fr| {
        if f >= 22 {
            paint(fr, 0, 0, W, H, 30);
        }
    });
    let ev = observe(&v, Window::around(20, 15, 0, 39), Some(tiny_box()), &cfg());
    assert_eq!(ev.locality, Locality::Global);
    assert_eq!(ev.grid.onset, Some(22));
    assert_eq!(ev.ssim.onset, Some(22));
}

#[test]
fn change_under_way_at_window_start_is_flagged() {
    let v = video(40, |f, fr| {
        if f >= 6 {
            paint(fr, 22, 31, 38, 34, 255);
        }
    });
    let ev = observe(&v, Window::around(20, 15, 0, 39), Some(tiny_box()), &cfg());
    assert!(ev.in_progress_at_start);
}

#[test]
fn gradual_scroll_onset_is_its_first_persistent_frame() {
    let v = video(40, |f, fr| {
        if f >= 21 {
            let shift = ((f - 20) * 4).min(40);
            let bg = background();
            for y in 0..H {
                let src = (y + shift).min(H - 1);
                fr[y * W..(y + 1) * W].copy_from_slice(&bg[src * W..(src + 1) * W]);
            }
            paint(fr, 0, H.saturating_sub(shift + 10), W, H, 40);
        }
    });
    let ev = observe(&v, Window::around(20, 15, 0, 39), None, &cfg());
    assert_eq!(ev.grid.onset, Some(21));
    assert_eq!(ev.locality, Locality::Global);
}

#[test]
fn window_validity_and_clipping() {
    let c = cfg();
    let w = Window::around(10, 25, 0, 100);
    assert_eq!((w.lo, w.hi), (0, 35));
    assert!(w.valid(&c));
    let w = Window::around(10, 25, 8, 100);
    assert!(!w.valid(&c));
    let w = Window::around(98, 25, 0, 100);
    assert!(!w.valid(&c));
}

#[test]
fn identical_frames_have_zero_dissimilarity() {
    let a = background();
    assert!(dissimilarity(&a, &a, W, H, 8).abs() < 1e-12);
    let mut b = a.clone();
    paint(&mut b, 0, 0, 40, 40, 0);
    assert!(dissimilarity(&a, &b, W, H, 8) > 0.05);
}
