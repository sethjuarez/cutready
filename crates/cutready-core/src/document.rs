//! Canonical load/save for `.sk` sketches and `.sb` storyboards.
//!
//! The codec functions turn documents into the exact bytes every host writes;
//! the `load_*`/`save_*` functions run them over the [`Files`] port. Golden
//! files in `tests/golden/` pin the bytes.

use std::path::Path;

use sha2::{Digest, Sha256};

use crate::models::sketch::{Sketch, Storyboard};
use crate::ports::{Files, Log, LogLevel, PortError};

/// Folder (project-relative) that holds externalized Elucim visuals.
pub const VISUALS_DIR: &str = ".cutready/visuals";

const LOG_TARGET: &str = "cutready_core::document";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DocumentError {
    #[error(transparent)]
    Port(#[from] PortError),
    /// The file isn't valid UTF-8 JSON of the expected shape (serde's message).
    #[error("{0}")]
    Parse(String),
    #[error("{0}")]
    Serialize(String),
}

pub fn sketch_to_json(sketch: &Sketch) -> Result<String, DocumentError> {
    serde_json::to_string_pretty(sketch).map_err(|e| DocumentError::Serialize(e.to_string()))
}

pub fn sketch_from_json(json: &str) -> Result<Sketch, DocumentError> {
    serde_json::from_str(json).map_err(|e| DocumentError::Parse(e.to_string()))
}

pub fn storyboard_to_json(storyboard: &Storyboard) -> Result<String, DocumentError> {
    serde_json::to_string_pretty(storyboard).map_err(|e| DocumentError::Serialize(e.to_string()))
}

/// Parses a storyboard, upgrading older on-disk shapes. The flag is true when
/// the file used an older shape and should be saved back.
pub fn storyboard_from_json(json: &str) -> Result<(Storyboard, bool), DocumentError> {
    Storyboard::from_json_upgraded(json).map_err(|e| DocumentError::Parse(e.to_string()))
}

/// An Elucim visual as its own file under [`VISUALS_DIR`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisualFile {
    /// Project-relative path, e.g. `.cutready/visuals/a1b2c3d4e5f6.json`.
    pub path: String,
    pub json: String,
}

/// Names a visual by the first 6 bytes of the SHA-256 of its pretty JSON, so
/// equal visuals share one file.
pub fn visual_file(visual: &serde_json::Value) -> Result<VisualFile, DocumentError> {
    let json = serde_json::to_string_pretty(visual)
        .map_err(|e| DocumentError::Serialize(e.to_string()))?;
    let digest = Sha256::digest(json.as_bytes());
    let short_hash: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    Ok(VisualFile {
        path: format!("{VISUALS_DIR}/{short_hash}.json"),
        json,
    })
}

/// What [`externalize_inline_visuals`] did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct VisualMigration {
    /// At least one row now points at a visual file; save the sketch.
    pub changed: bool,
    /// Visuals that stayed inline because writing their file failed.
    pub failures: Vec<String>,
}

/// Moves legacy inline visuals (JSON objects in `row.visual`) to their own
/// files. `write` stores each file; a row switches to the path only when its
/// write succeeds.
pub fn externalize_inline_visuals<E: std::fmt::Display>(
    sketch: &mut Sketch,
    mut write: impl FnMut(&VisualFile) -> Result<(), E>,
) -> VisualMigration {
    let mut migration = VisualMigration::default();
    for row in &mut sketch.rows {
        let Some(visual) = row.visual.as_ref().filter(|v| v.is_object()) else {
            continue;
        };
        let written = visual_file(visual)
            .map_err(|e| e.to_string())
            .and_then(|file| write(&file).map(|()| file).map_err(|e| e.to_string()));
        match written {
            Ok(file) => {
                row.visual = Some(serde_json::Value::String(file.path));
                migration.changed = true;
            }
            Err(err) => migration.failures.push(err),
        }
    }
    migration
}

fn read_text(files: &dyn Files, path: &Path) -> Result<String, DocumentError> {
    String::from_utf8(files.read(path)?).map_err(|e| DocumentError::Parse(e.to_string()))
}

/// Loads a sketch and externalizes any inline visuals, saving the sketch when
/// that changed it. Migration is best effort: failures are logged and the
/// sketch is still returned.
pub fn load_sketch(files: &dyn Files, log: &dyn Log, path: &Path) -> Result<Sketch, DocumentError> {
    let mut sketch = sketch_from_json(&read_text(files, path)?)?;
    let migration = externalize_inline_visuals(&mut sketch, |file| {
        files.write_atomic(Path::new(&file.path), file.json.as_bytes())
    });
    for failure in &migration.failures {
        log.log(
            LogLevel::Warn,
            LOG_TARGET,
            &format!(
                "could not migrate inline visual in {}: {failure}",
                path.display()
            ),
        );
    }
    if migration.changed {
        if let Err(err) = save_sketch(files, path, &sketch) {
            log.log(
                LogLevel::Warn,
                LOG_TARGET,
                &format!("could not save migrated sketch {}: {err}", path.display()),
            );
        }
    }
    Ok(sketch)
}

pub fn save_sketch(files: &dyn Files, path: &Path, sketch: &Sketch) -> Result<(), DocumentError> {
    Ok(files.write_atomic(path, sketch_to_json(sketch)?.as_bytes())?)
}

/// Loads a storyboard, saving it back when it was upgraded from an older shape.
/// The save is best effort: on failure the file upgrades again next load.
pub fn load_storyboard(
    files: &dyn Files,
    log: &dyn Log,
    path: &Path,
) -> Result<Storyboard, DocumentError> {
    let (storyboard, upgraded) = storyboard_from_json(&read_text(files, path)?)?;
    if upgraded {
        if let Err(err) = save_storyboard(files, path, &storyboard) {
            log.log(
                LogLevel::Warn,
                LOG_TARGET,
                &format!(
                    "could not save upgraded storyboard {}: {err}",
                    path.display()
                ),
            );
        }
    }
    Ok(storyboard)
}

pub fn save_storyboard(
    files: &dyn Files,
    path: &Path,
    storyboard: &Storyboard,
) -> Result<(), DocumentError> {
    Ok(files.write_atomic(path, storyboard_to_json(storyboard)?.as_bytes())?)
}
