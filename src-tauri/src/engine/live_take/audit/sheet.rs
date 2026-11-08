//! Review contact sheet: for each cue, the frames around the cue word with
//! the word printed, the target element outlined, and the frame holding the
//! word and the detected onset marked, so a person can check in seconds.

use super::super::analysis::ViewBox;
use crate::engine::ffmpeg::command_for_ffmpeg;
use anyhow::{bail, Result};
use image::{Rgb, RgbImage};
use std::path::Path;

pub const THUMB: (u32, u32) = (320, 180);
const PAD: u32 = 6;
const HEADER: u32 = 28;
const CAPTION: u32 = 20;

pub struct SheetFrame {
    pub frame: usize,
    pub rgb: Vec<u8>,
    pub caption: String,
    /// The frame holding the expected (word) time.
    pub is_word: bool,
    /// The detected onset frame.
    pub is_onset: bool,
}

pub struct SheetRow {
    pub header: String,
    /// Target element in thumbnail pixels.
    pub target: Option<ViewBox>,
    pub frames: Vec<SheetFrame>,
}

const WORD_COLOR: Rgb<u8> = Rgb([64, 200, 255]);
const ONSET_COLOR: Rgb<u8> = Rgb([255, 80, 200]);
const TARGET_COLOR: Rgb<u8> = Rgb([255, 220, 0]);
const BG: Rgb<u8> = Rgb([32, 30, 28]);

fn rect(img: &mut RgbImage, x0: i64, y0: i64, x1: i64, y1: i64, width: i64, c: Rgb<u8>) {
    let (w, h) = (img.width() as i64, img.height() as i64);
    for t in 0..width {
        for x in x0 - t..=x1 + t {
            for y in [y0 - t, y1 + t] {
                if (0..w).contains(&x) && (0..h).contains(&y) {
                    img.put_pixel(x as u32, y as u32, c);
                }
            }
        }
        for y in y0 - t..=y1 + t {
            for x in [x0 - t, x1 + t] {
                if (0..w).contains(&x) && (0..h).contains(&y) {
                    img.put_pixel(x as u32, y as u32, c);
                }
            }
        }
    }
}

struct Label {
    text: String,
    x: u32,
    y: u32,
    size: u32,
}

fn compose(rows: &[SheetRow]) -> (RgbImage, Vec<Label>) {
    let (tw, th) = THUMB;
    let cols = rows
        .iter()
        .map(|r| r.frames.len())
        .max()
        .unwrap_or(1)
        .max(1) as u32;
    let row_h = HEADER + CAPTION + th + PAD;
    let mut img =
        RgbImage::from_pixel(PAD + cols * (tw + PAD), PAD + rows.len() as u32 * row_h, BG);
    let mut labels = Vec::new();
    for (r, row) in rows.iter().enumerate() {
        let top = PAD + r as u32 * row_h;
        labels.push(Label {
            text: row.header.clone(),
            x: PAD,
            y: top + 6,
            size: 16,
        });
        for (c, f) in row.frames.iter().enumerate() {
            let x = PAD + c as u32 * (tw + PAD);
            let y = top + HEADER + CAPTION;
            labels.push(Label {
                text: f.caption.clone(),
                x: x + 2,
                y: top + HEADER + 2,
                size: 13,
            });
            for (i, px) in f.rgb.as_chunks::<3>().0.iter().enumerate() {
                let (px_x, px_y) = (i as u32 % tw, i as u32 / tw);
                if px_y < th {
                    img.put_pixel(x + px_x, y + px_y, Rgb([px[0], px[1], px[2]]));
                }
            }
            if let Some(b) = row.target {
                rect(
                    &mut img,
                    x as i64 + b.x.floor() as i64,
                    y as i64 + b.y.floor() as i64,
                    x as i64 + (b.x + b.width).ceil() as i64,
                    y as i64 + (b.y + b.height).ceil() as i64,
                    1,
                    TARGET_COLOR,
                );
            }
            let (x0, y0) = (x as i64 - 1, y as i64 - 1);
            let (x1, y1) = (x0 + tw as i64 + 1, y0 + th as i64 + 1);
            if f.is_word {
                rect(&mut img, x0, y0, x1, y1, 2, WORD_COLOR);
            }
            if f.is_onset {
                rect(&mut img, x0 - 2, y0 - 2, x1 + 2, y1 + 2, 2, ONSET_COLOR);
            }
        }
    }
    (img, labels)
}

fn font_option() -> &'static str {
    if cfg!(target_os = "windows") {
        "fontfile='C\\:/Windows/Fonts/segoeui.ttf':"
    } else {
        ""
    }
}

/// Writes `out` (PNG). Text is drawn by ffmpeg's drawtext; if that fails the
/// sheet is still written without text and the error is returned as a note.
pub fn write_sheet(rows: &[SheetRow], out: &Path) -> Result<Option<String>> {
    let (img, labels) = compose(rows);
    let work = out.with_extension("sheet-work");
    std::fs::create_dir_all(&work)?;
    let raw = work.join("raw.png");
    img.save(&raw)?;
    let mut filters = Vec::new();
    for (i, l) in labels.iter().enumerate() {
        let name = format!("l{i}.txt");
        std::fs::write(work.join(&name), &l.text)?;
        filters.push(format!(
            "drawtext={}textfile={name}:x={}:y={}:fontsize={}:fontcolor=white",
            font_option(),
            l.x,
            l.y,
            l.size
        ));
    }
    std::fs::write(work.join("filters.txt"), filters.join(",\n"))?;
    let result = (|| -> Result<()> {
        let mut cmd = command_for_ffmpeg()?;
        cmd.current_dir(&work)
            .args(["-y", "-v", "error", "-i", "raw.png", "-/vf", "filters.txt"]);
        cmd.arg(out);
        let o = cmd.output()?;
        if !o.status.success() {
            bail!(
                "drawtext failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            );
        }
        Ok(())
    })();
    let note = match result {
        Ok(()) => None,
        Err(e) => {
            std::fs::copy(&raw, out)?;
            Some(e.to_string())
        }
    };
    let _ = std::fs::remove_dir_all(&work);
    Ok(note)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_places_rows_and_marks() {
        let frame = |n: usize, is_word: bool, is_onset: bool| SheetFrame {
            frame: n,
            rgb: vec![10; (THUMB.0 * THUMB.1 * 3) as usize],
            caption: format!("f{n}"),
            is_word,
            is_onset,
        };
        let rows = vec![SheetRow {
            header: "cue".into(),
            target: Some(ViewBox {
                x: 10.0,
                y: 10.0,
                width: 20.0,
                height: 5.0,
            }),
            frames: vec![frame(1, false, false), frame(2, true, true)],
        }];
        let (img, labels) = compose(&rows);
        assert_eq!(img.width(), PAD + 2 * (THUMB.0 + PAD));
        assert_eq!(labels.len(), 3);
        let y = PAD + HEADER + CAPTION;
        assert_eq!(*img.get_pixel(PAD + 10, y + 10), TARGET_COLOR);
        let x2 = PAD + THUMB.0 + PAD;
        assert_eq!(*img.get_pixel(x2 + 100, y - 3), ONSET_COLOR);
        assert_eq!(*img.get_pixel(x2 + 100, y - 1), WORD_COLOR);
    }
}
