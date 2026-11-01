//! Golden files for core's port-based load/save: the same expected bytes the
//! desktop harness (`src-tauri/src/engine/document_goldens.rs`) pins, so every
//! host writes identical documents.

// Fixtures live on disk; the code under test only sees MemoryFiles.
#![allow(clippy::disallowed_methods)]
// Fixture helpers are test code; a failed unwrap is a failed test.
#![allow(clippy::unwrap_used)]

use std::fs;
use std::path::{Path, PathBuf};

use cutready_core::document::{load_sketch, load_storyboard, save_sketch, save_storyboard};
use cutready_core::testing::{MemoryFiles, MemoryLog};
use cutready_core::Files;

const SKETCH: &str = "intro.sk";
const BOARD: &str = "demo.sb";

fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

fn project(inputs: &[(&str, &str)]) -> MemoryFiles {
    let files = MemoryFiles::new();
    for (dest, input) in inputs {
        let bytes = fs::read(golden_dir().join("inputs").join(input)).unwrap();
        files.write_atomic(Path::new(dest), &bytes).unwrap();
    }
    files
}

fn expected_files(dir: &Path, prefix: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let relative = prefix.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            expected_files(&entry.path(), &relative, out);
        } else {
            out.push((relative, fs::read(entry.path()).unwrap()));
        }
    }
}

fn assert_golden(case: &str, files: &MemoryFiles) {
    let mut expected = Vec::new();
    expected_files(
        &golden_dir().join("expected").join(case),
        Path::new(""),
        &mut expected,
    );
    expected.sort();
    let actual: Vec<(PathBuf, Vec<u8>)> = files
        .paths()
        .into_iter()
        .map(|path| {
            let bytes = files.read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    let names = |v: &[(PathBuf, Vec<u8>)]| v.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>();
    assert_eq!(names(&actual), names(&expected), "{case}: file set");
    for ((path, actual), (_, expected)) in actual.iter().zip(&expected) {
        assert!(
            actual == expected,
            "{case}: {} differs\n--- actual\n{}\n--- expected\n{}",
            path.display(),
            String::from_utf8_lossy(actual),
            String::from_utf8_lossy(expected),
        );
    }
}

fn round_trip_sketch(files: &MemoryFiles) {
    let sketch = load_sketch(files, &MemoryLog::default(), Path::new(SKETCH)).unwrap();
    save_sketch(files, Path::new(SKETCH), &sketch).unwrap();
}

#[test]
fn sketch_save_roundtrip() {
    let files = project(&[(SKETCH, "sketch.sk")]);
    round_trip_sketch(&files);
    assert_golden("sketch_save_roundtrip", &files);
}

#[test]
fn sketch_save_nulls_roundtrip() {
    let files = project(&[(SKETCH, "sketch-nulls.sk")]);
    round_trip_sketch(&files);
    assert_golden("sketch_save_nulls_roundtrip", &files);
}

#[test]
fn sketch_read_migrates_inline_visual() {
    let files = project(&[(SKETCH, "sketch-inline-visual.sk")]);
    load_sketch(&files, &MemoryLog::default(), Path::new(SKETCH)).unwrap();
    assert_golden("sketch_read_migrates_inline_visual", &files);
}

#[test]
fn storyboard_save_roundtrip() {
    let files = project(&[(BOARD, "storyboard.sb")]);
    let storyboard = load_storyboard(&files, &MemoryLog::default(), Path::new(BOARD)).unwrap();
    save_storyboard(&files, Path::new(BOARD), &storyboard).unwrap();
    assert_golden("storyboard_save_roundtrip", &files);
}

#[test]
fn storyboard_read_upgrades_legacy() {
    let files = project(&[(BOARD, "storyboard-legacy.sb")]);
    load_storyboard(&files, &MemoryLog::default(), Path::new(BOARD)).unwrap();
    assert_golden("storyboard_read_upgrades_legacy", &files);
}
