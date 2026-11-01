//! Plain Markdown notes and their lock manifest (`.cutready/locks.json`).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::document::{read_text, DocumentError};
use crate::ports::Files;

pub const LOCKS_PATH: &str = ".cutready/locks.json";

pub const NOTE_LOCKED_MESSAGE: &str = "This note is locked. Unlock it before editing.";

/// Lock metadata for plain Markdown notes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct NoteLockState {
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LockManifest {
    #[serde(default)]
    pub notes: BTreeMap<String, NoteLockState>,
}

impl LockManifest {
    /// Lock state for a normalized note path; unlisted notes are unlocked.
    pub fn note_lock(&self, rel: &str) -> NoteLockState {
        self.notes.get(rel).cloned().unwrap_or_default()
    }

    /// Unlocking removes the entry, so the manifest only lists locked notes.
    pub fn set_note_lock(&mut self, rel: &str, locked: bool) -> NoteLockState {
        if locked {
            self.notes
                .insert(rel.to_owned(), NoteLockState { locked: true });
        } else {
            self.notes.remove(rel);
        }
        NoteLockState { locked }
    }
}

pub fn normalize_lock_path(relative_path: &str) -> String {
    relative_path.trim().replace('\\', "/")
}

pub fn lock_manifest_from_json(json: &str) -> Result<LockManifest, DocumentError> {
    serde_json::from_str(json).map_err(|e| DocumentError::Parse(e.to_string()))
}

pub fn lock_manifest_to_json(manifest: &LockManifest) -> Result<String, DocumentError> {
    serde_json::to_string_pretty(manifest).map_err(|e| DocumentError::Serialize(e.to_string()))
}

pub fn load_note(files: &dyn Files, path: &Path) -> Result<String, DocumentError> {
    read_text(files, path)
}

pub fn save_note(files: &dyn Files, path: &Path, content: &str) -> Result<(), DocumentError> {
    Ok(files.write_atomic(path, content.as_bytes())?)
}

pub fn load_lock_manifest(files: &dyn Files) -> Result<LockManifest, DocumentError> {
    let path = Path::new(LOCKS_PATH);
    if !files.exists(path)? {
        return Ok(LockManifest::default());
    }
    lock_manifest_from_json(&read_text(files, path)?)
}

pub fn save_lock_manifest(files: &dyn Files, manifest: &LockManifest) -> Result<(), DocumentError> {
    let json = lock_manifest_to_json(manifest)?;
    Ok(files.write_atomic(Path::new(LOCKS_PATH), json.as_bytes())?)
}

pub fn get_note_lock(
    files: &dyn Files,
    relative_path: &str,
) -> Result<NoteLockState, DocumentError> {
    Ok(load_lock_manifest(files)?.note_lock(&normalize_lock_path(relative_path)))
}

pub fn set_note_lock(
    files: &dyn Files,
    relative_path: &str,
    locked: bool,
) -> Result<NoteLockState, DocumentError> {
    let mut manifest = load_lock_manifest(files)?;
    let state = manifest.set_note_lock(&normalize_lock_path(relative_path), locked);
    save_lock_manifest(files, &manifest)?;
    Ok(state)
}

pub fn ensure_note_unlocked(files: &dyn Files, relative_path: &str) -> Result<(), DocumentError> {
    if get_note_lock(files, relative_path)?.locked {
        return Err(DocumentError::Locked(NOTE_LOCKED_MESSAGE.into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MemoryFiles;

    #[test]
    fn lock_round_trip_writes_only_locked_notes() {
        let files = MemoryFiles::new();
        assert!(!get_note_lock(&files, "plan.md").unwrap().locked);
        set_note_lock(&files, " docs\\plan.md ", true).unwrap();
        assert!(get_note_lock(&files, "docs/plan.md").unwrap().locked);
        assert_eq!(
            ensure_note_unlocked(&files, "docs/plan.md").unwrap_err(),
            DocumentError::Locked(NOTE_LOCKED_MESSAGE.into())
        );
        let json = String::from_utf8(files.read(Path::new(LOCKS_PATH)).unwrap()).unwrap();
        assert_eq!(
            json,
            "{\n  \"notes\": {\n    \"docs/plan.md\": {\n      \"locked\": true\n    }\n  }\n}"
        );
        set_note_lock(&files, "docs/plan.md", false).unwrap();
        let json = String::from_utf8(files.read(Path::new(LOCKS_PATH)).unwrap()).unwrap();
        assert_eq!(json, "{\n  \"notes\": {}\n}");
    }

    #[test]
    fn note_round_trip_keeps_bytes() {
        let files = MemoryFiles::new();
        let content = "# Plan\r\n\n- a\n";
        save_note(&files, Path::new("plan.md"), content).unwrap();
        assert_eq!(load_note(&files, Path::new("plan.md")).unwrap(), content);
    }
}
