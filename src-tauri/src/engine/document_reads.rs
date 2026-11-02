//! Reads of project documents for the app's editors: the parsed document
//! plus the version of the bytes on disk, so the next save can send it as
//! its expected version (ADR 0002, "App saves").

use std::path::Path;

use cutready_core::document;
use cutready_core::edit_ops;
use cutready_core::models::sketch::{Sketch, Storyboard};

use crate::engine::document_writer::{self, Expected};
use crate::engine::project::{self, ProjectError};
use crate::engine::write_lock;

/// Externalize inline visuals and rewrite the `.sk` file over `data`, the
/// bytes it was read from. Returns the rewritten file text.
pub(crate) fn migrate_inline_visuals(
    sketch: &mut Sketch,
    data: &str,
    path: &Path,
    root: &Path,
) -> Option<String> {
    let migration =
        document::externalize_inline_visuals(sketch, |file| project::write_visual_file(root, file));
    for e in &migration.failures {
        eprintln!("[read_sketch] Failed to migrate inline visual: {e}");
    }
    if !migration.changed {
        return None;
    }
    // Rewrite .sk file with path references instead of inline blobs
    let expected = Expected::Version(edit_ops::document_version(data.as_bytes()));
    match document_writer::write_sketch(root, path, sketch, expected) {
        Ok(written) => Some(written.content),
        Err(e) => {
            eprintln!("[read_sketch] Failed to rewrite migrated sketch: {e}");
            None
        }
    }
}

/// A document read once under the write lock, with the version of the bytes
/// now on disk (after any on-read migration), so a save right after it is
/// never stale.
pub fn read_sketch_versioned(
    path: &Path,
    root: &Path,
) -> Result<document_writer::Versioned<Sketch>, ProjectError> {
    let _guard = write_lock::lock(root).map_err(ProjectError::Io)?;
    let data = read_existing(path)?;
    let mut sketch = document::sketch_from_json(&data)?;
    let content = migrate_inline_visuals(&mut sketch, &data, path, root).unwrap_or(data);
    versioned(document::sketch_from_json(&content)?, content)
}

/// A sketch to edit and write back: read under the lock, with the version
/// it was read at, so the write fails rather than overwrite a newer file.
pub fn sketch_for_edit(root: &Path, relative_path: &str) -> Result<(Sketch, Expected), String> {
    let path = project::safe_resolve(root, relative_path).map_err(|e| e.to_string())?;
    let read = read_sketch_versioned(&path, root).map_err(|e| e.to_string())?;
    Ok((read.document, Expected::Version(read.version)))
}

/// [`read_sketch_versioned`] for a storyboard, saving an upgraded shape.
pub fn read_storyboard_versioned(
    path: &Path,
    root: &Path,
) -> Result<document_writer::Versioned<Storyboard>, ProjectError> {
    let _guard = write_lock::lock(root).map_err(ProjectError::Io)?;
    let data = read_existing(path)?;
    let (storyboard, upgraded) = document::storyboard_from_json(&data)?;
    let content = if upgraded {
        let expected = Expected::Version(edit_ops::document_version(data.as_bytes()));
        match document_writer::write_storyboard(root, path, &storyboard, expected) {
            Ok(written) => written.content,
            Err(err) => {
                log::warn!(
                    "could not save upgraded storyboard {}: {err}",
                    path.display()
                );
                data
            }
        }
    } else {
        data
    };
    versioned(document::storyboard_from_json(&content)?.0, content)
}

/// [`read_sketch_versioned`] for a note.
pub fn read_note_versioned(
    path: &Path,
    root: &Path,
) -> Result<document_writer::Versioned<String>, ProjectError> {
    let _guard = write_lock::lock(root).map_err(ProjectError::Io)?;
    let content = read_existing(path)?;
    versioned(content.clone(), content)
}

fn read_existing(path: &Path) -> Result<String, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(path.to_string_lossy().into_owned()));
    }
    std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))
}

fn versioned<T>(
    document: T,
    content: String,
) -> Result<document_writer::Versioned<T>, ProjectError> {
    Ok(document_writer::Versioned {
        document,
        version: edit_ops::document_version(content.as_bytes()),
        content,
        merged: false,
        synced: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_versioned_read_that_migrates_reports_the_migrated_version() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut sketch = Sketch::new("Intro", chrono::Utc::now());
        let mut row = cutready_core::models::sketch::PlanningRow::new();
        row.visual = Some(serde_json::json!({ "root": { "type": "rect" } }));
        sketch.rows.push(row);
        let path = root.join("intro.sk");
        std::fs::write(&path, document::sketch_to_json(&sketch).unwrap()).unwrap();

        let read = read_sketch_versioned(&path, root).unwrap();

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(read.document.rows[0].visual.as_ref().unwrap().is_string());
        assert_eq!(read.content, on_disk);
        assert_eq!(read.version, edit_ops::document_version(on_disk.as_bytes()));
        let op = serde_json::json!({ "kind": "set_title", "title": "Saved" });
        let saved =
            document_writer::save(root, "intro.sk", &read.version, &read.content, &[op]).unwrap();
        assert!(!saved.merged);
    }
}
