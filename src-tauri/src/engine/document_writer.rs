//! The desktop's single write path for project documents (`.sk`, `.sb`, `.md`).
//!
//! Every edit runs as an op batch through `cutready_core::edit_ops::edit_document`
//! against the bytes on disk, then the canonical bytes are written atomically.
//! `scripts/check-document-writes.mjs` keeps raw document writes out of the
//! rest of the app. Callers hold `workspace_write_lock`.

use std::io::Write;
use std::path::{Path, PathBuf};

use cutready_core::contracts::DocumentKind;
use cutready_core::document::{self, DocumentError};
use cutready_core::edit_ops::{self, ContentEditError, NoteLock};
use cutready_core::models::sketch::{Sketch, Storyboard};
use serde_json::{json, Value};

use crate::engine::project::{self, ProjectError};

/// What the caller expects on disk before its ops apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expected {
    /// The file's bytes must have this version.
    // Version-tracking callers (agent tools, frontend saves) arrive in 4.8–4.9.
    #[allow(dead_code)]
    Version(String),
    /// The file must not exist yet.
    Absent,
    /// Whatever is on disk now. Legacy IPC that doesn't track versions; not
    /// optimistic concurrency.
    Unchecked,
}

/// Why a document write failed.
#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error(transparent)]
    Project(#[from] ProjectError),
    #[error("{}", edit_message(.0))]
    Edit(#[from] ContentEditError),
}

/// Unreadable or unsavable documents keep the app's `ProjectError` wording.
fn edit_message(err: &ContentEditError) -> String {
    match err {
        ContentEditError::Document(doc) => ProjectError::from(doc.clone()).to_string(),
        other => other.to_string(),
    }
}

impl From<DocumentError> for WriteError {
    fn from(err: DocumentError) -> Self {
        WriteError::Project(err.into())
    }
}

impl From<WriteError> for String {
    fn from(err: WriteError) -> Self {
        err.to_string()
    }
}

/// A document after a successful write.
#[derive(Debug, Clone)]
#[allow(dead_code)] // `version` and `changed` serve version-tracking callers.
pub struct Written {
    pub content: String,
    pub version: String,
    /// Whether the bytes on disk changed.
    pub changed: bool,
    /// The note's lock, for notes.
    pub note_lock: Option<NoteLock>,
}

impl Written {
    pub fn sketch(&self) -> Result<Sketch, WriteError> {
        Ok(document::sketch_from_json(&self.content)?)
    }

    pub fn storyboard(&self) -> Result<Storyboard, WriteError> {
        Ok(document::storyboard_from_json(&self.content)?.0)
    }
}

/// The document kind for a project path, from its extension.
pub fn kind_of(path: &Path) -> Result<DocumentKind, ProjectError> {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("sk") => Ok(DocumentKind::Sketch),
        Some("sb") => Ok(DocumentKind::Storyboard),
        Some("md") => Ok(DocumentKind::Note),
        _ => Err(ProjectError::Invalid(format!(
            "Not a project document: {}",
            path.display()
        ))),
    }
}

/// Apply `ops` to the document at project-relative `rel`.
pub fn edit(
    root: &Path,
    rel: &str,
    expected: Expected,
    ops: &[Value],
) -> Result<Written, WriteError> {
    let abs = project::safe_resolve(root, rel)?;
    let kind = kind_of(&abs)?;
    let lock = (kind == DocumentKind::Note).then_some((root, rel));
    edit_at(&abs, kind, lock, expected, ops)
}

/// [`edit`] for a sketch, returning the sketch after the ops.
pub fn edit_sketch(
    root: &Path,
    rel: &str,
    expected: Expected,
    ops: &[Value],
) -> Result<Sketch, WriteError> {
    edit(root, rel, expected, ops)?.sketch()
}

/// [`edit`] for a storyboard, returning the storyboard after the ops.
pub fn edit_storyboard(
    root: &Path,
    rel: &str,
    expected: Expected,
    ops: &[Value],
) -> Result<Storyboard, WriteError> {
    edit(root, rel, expected, ops)?.storyboard()
}

/// Write a whole sketch, creating or replacing the file.
pub fn replace_sketch(path: &Path, sketch: &Sketch) -> Result<Written, WriteError> {
    let op = json!({ "kind": "replace_sketch", "sketch": to_value(sketch)? });
    edit_at(path, DocumentKind::Sketch, None, Expected::Unchecked, &[op])
}

/// Write a whole storyboard, creating or replacing the file.
pub fn replace_storyboard(path: &Path, storyboard: &Storyboard) -> Result<Written, WriteError> {
    let op = json!({ "kind": "replace_storyboard", "storyboard": to_value(storyboard)? });
    edit_at(
        path,
        DocumentKind::Storyboard,
        None,
        Expected::Unchecked,
        &[op],
    )
}

/// Write a whole note, creating or replacing the file. Not lock-gated.
pub fn replace_note(path: &Path, content: &str) -> Result<Written, WriteError> {
    let op = json!({ "kind": "replace_note", "content": content });
    edit_at(path, DocumentKind::Note, None, Expected::Unchecked, &[op])
}

/// Remove a document file. A missing file is already deleted.
pub fn delete(path: &Path) -> Result<(), ProjectError> {
    kind_of(path)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(ProjectError::Io(err.to_string())),
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, WriteError> {
    serde_json::to_value(value)
        .map_err(|e| WriteError::Project(ProjectError::Invalid(e.to_string())))
}

/// `lock` is the project root and the note's lock key, for note edits that
/// follow the lock manifest.
fn edit_at(
    abs: &Path,
    kind: DocumentKind,
    lock: Option<(&Path, &str)>,
    expected: Expected,
    ops: &[Value],
) -> Result<Written, WriteError> {
    let current = read_current(abs)?;
    let expected_version = match expected {
        Expected::Version(version) => Some(version),
        Expected::Absent => None,
        Expected::Unchecked => match &current {
            Some(content) => Some(edit_ops::document_version(content.as_bytes())),
            None if starts_with_replacement(ops) => None,
            // Legacy commands read the file first and fail when it's gone.
            None => return Err(ProjectError::NotFound(abs.to_string_lossy().into_owned()).into()),
        },
    };
    let note_locked = match lock {
        Some((root, rel)) => project::get_note_lock(root, rel)?.locked,
        None => false,
    };
    let edit = edit_ops::edit_document(
        kind,
        current.as_deref(),
        expected_version.as_deref(),
        ops,
        chrono::Utc::now(),
        note_locked,
    )?;
    let changed = edit.changes(current.as_deref());
    if changed {
        write_atomic(abs, edit.content.as_bytes())?;
    }
    if let (Some((root, rel)), Some(note_lock)) = (lock, edit.note_lock) {
        if note_lock.changed {
            project::set_note_lock(root, rel, note_lock.locked)?;
        }
    }
    Ok(Written {
        content: edit.content,
        version: edit.version,
        changed,
        note_lock: edit.note_lock,
    })
}

fn starts_with_replacement(ops: &[Value]) -> bool {
    matches!(
        ops.first()
            .and_then(|op| op.get("kind"))
            .and_then(Value::as_str),
        Some("replace_sketch" | "replace_storyboard" | "replace_note")
    )
}

fn read_current(path: &Path) -> Result<Option<String>, ProjectError> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(ProjectError::Io(err.to_string())),
    }
}

/// Write through a temp file in the same folder, then rename over the target
/// so readers never see a partial document. `fs::rename` replaces an existing
/// file on every platform (MoveFileExW with MOVEFILE_REPLACE_EXISTING on
/// Windows). When it's refused anyway, say because another process holds the
/// file without delete sharing, fall back to an in-place write, which is what
/// the app always did.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ProjectError> {
    let io = |e: std::io::Error| ProjectError::Io(e.to_string());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let temp = temp_path(path);
    let staged = std::fs::File::create(&temp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(err) = staged {
        let _ = std::fs::remove_file(&temp);
        return Err(io(err));
    }
    match std::fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            log::warn!(
                "atomic replace of {} refused ({err}); writing in place",
                path.display()
            );
            let _ = std::fs::remove_file(&temp);
            std::fs::write(path, bytes).map_err(io)
        }
    }
}

fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.{}.{nanos}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cutready_core::models::sketch::PlanningRow;

    fn project() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn rename_replaces_an_existing_file() {
        // write_atomic relies on this; the in-place fallback must stay rare.
        let dir = project();
        let target = dir.path().join("a.md");
        let staged = dir.path().join("a.md.tmp");
        std::fs::write(&target, "old").unwrap();
        std::fs::write(&staged, "new").unwrap();

        std::fs::rename(&staged, &target).unwrap();

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert!(!staged.exists());
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn replace_creates_then_replaces_without_leaving_temp_files() {
        let dir = project();
        let path = dir.path().join("nested/intro.sk");
        let mut sketch = Sketch::new("Intro", chrono::Utc::now());
        let first = replace_sketch(&path, &sketch).unwrap();
        assert!(first.changed);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            document::sketch_to_json(&sketch).unwrap()
        );

        sketch.title = "Renamed".into();
        let second = replace_sketch(&path, &sketch).unwrap();
        assert!(second.changed);
        assert_ne!(first.version, second.version);
        assert_eq!(files_in(&dir.path().join("nested")), vec!["intro.sk"]);
    }

    #[test]
    fn unchanged_bytes_are_not_rewritten() {
        let dir = project();
        let path = dir.path().join("intro.sk");
        let sketch = Sketch::new("Intro", chrono::Utc::now());
        replace_sketch(&path, &sketch).unwrap();
        let again = replace_sketch(&path, &sketch).unwrap();
        assert!(!again.changed);
    }

    #[test]
    fn expected_absent_rejects_an_existing_file() {
        let dir = project();
        replace_note(&dir.path().join("a.md"), "hi").unwrap();
        let op = json!({ "kind": "replace_note", "content": "" });
        let err = edit(dir.path(), "a.md", Expected::Absent, &[op]).unwrap_err();
        assert!(matches!(
            err,
            WriteError::Edit(ContentEditError::Stale(ref stale)) if stale.current_version.is_some()
        ));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "hi"
        );
    }

    #[test]
    fn expected_version_must_match() {
        let dir = project();
        let written = replace_note(&dir.path().join("a.md"), "one").unwrap();
        let op = json!({ "kind": "write_note", "content": "two" });
        let stale = edit(
            dir.path(),
            "a.md",
            Expected::Version("sha256:00".into()),
            std::slice::from_ref(&op),
        );
        assert!(stale.is_err());
        let ok = edit(
            dir.path(),
            "a.md",
            Expected::Version(written.version),
            &[op],
        )
        .unwrap();
        assert_eq!(ok.content, "two");
    }

    #[test]
    fn unchecked_edit_of_a_missing_file_is_not_found() {
        let dir = project();
        let op = json!({ "kind": "set_title", "title": "x" });
        let err = edit(dir.path(), "gone.sk", Expected::Unchecked, &[op]).unwrap_err();
        assert!(err.to_string().starts_with("Project not found:"), "{err}");
    }

    #[test]
    fn note_lock_ops_update_the_manifest_not_the_note() {
        let dir = project();
        replace_note(&dir.path().join("notes/a.md"), "body").unwrap();
        let lock = json!({ "kind": "set_lock", "locked": true });
        let written = edit(dir.path(), "notes/a.md", Expected::Unchecked, &[lock]).unwrap();
        assert!(!written.changed);
        assert!(
            project::get_note_lock(dir.path(), "notes/a.md")
                .unwrap()
                .locked
        );

        let write = json!({ "kind": "write_note", "content": "new" });
        let err = edit(dir.path(), "notes/a.md", Expected::Unchecked, &[write]).unwrap_err();
        assert_eq!(err.to_string(), cutready_core::notes::NOTE_LOCKED_MESSAGE);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("notes/a.md")).unwrap(),
            "body"
        );
    }

    #[test]
    fn rejected_batches_leave_the_file_untouched() {
        let dir = project();
        let path = dir.path().join("intro.sk");
        let mut sketch = Sketch::new("Intro", chrono::Utc::now());
        sketch.rows.push(PlanningRow::new());
        sketch.locked = true;
        replace_sketch(&path, &sketch).unwrap();
        let before = std::fs::read(&path).unwrap();

        let op = json!({ "kind": "set_title", "title": "x" });
        let err = edit(dir.path(), "intro.sk", Expected::Unchecked, &[op]).unwrap_err();
        assert!(err.to_string().contains("locked"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn unreadable_documents_keep_the_project_error_wording() {
        let dir = project();
        std::fs::write(dir.path().join("bad.sk"), "{").unwrap();
        let op = json!({ "kind": "touch" });
        let err = edit(dir.path(), "bad.sk", Expected::Unchecked, &[op]).unwrap_err();
        assert!(
            err.to_string().starts_with("Deserialization error"),
            "{err}"
        );
    }

    #[test]
    fn non_documents_are_refused() {
        let dir = project();
        let op = json!({ "kind": "touch" });
        assert!(edit(dir.path(), "a.json", Expected::Unchecked, &[op]).is_err());
        assert!(delete(&dir.path().join("a.json")).is_err());
    }

    #[test]
    fn delete_tolerates_a_missing_file() {
        let dir = project();
        let path = dir.path().join("a.md");
        replace_note(&path, "x").unwrap();
        delete(&path).unwrap();
        delete(&path).unwrap();
        assert!(!path.exists());
    }
}
