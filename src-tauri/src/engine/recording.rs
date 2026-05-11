//! Recording engine — FFmpeg process management for screen + audio capture.
//!
//! The capture pipeline will manage FFmpeg lifecycle, command construction,
//! progress parsing, and multi-track recording. This module currently owns the
//! project storage foundation for local-only recording media.

use std::path::{Path, PathBuf};

const RECORDINGS_DIR: &str = ".cutready/recordings";
const RECORDINGS_GITIGNORE: &str = "*\n!.gitignore\n";

/// Return the local-only recordings directory for a project.
pub fn recordings_dir(project_root: &Path) -> PathBuf {
    project_root.join(RECORDINGS_DIR)
}

/// Initialize the recording storage folder and ignore rules.
///
/// Recording media can be very large, so the directory contains its own
/// `.gitignore` that ignores every take asset while allowing the ignore file
/// itself to be tracked.
pub fn initialize_recording_storage(project_root: &Path) -> anyhow::Result<PathBuf> {
    let dir = recordings_dir(project_root);
    std::fs::create_dir_all(&dir)?;
    ensure_recordings_gitignore(&dir)?;
    Ok(dir)
}

fn ensure_recordings_gitignore(recordings_dir: &Path) -> anyhow::Result<()> {
    let path = recordings_dir.join(".gitignore");
    if !path.exists() {
        std::fs::write(path, RECORDINGS_GITIGNORE)?;
        return Ok(());
    }

    let existing = std::fs::read_to_string(&path)?;
    let mut updated = existing.clone();
    let mut changed = false;

    for rule in ["*", "!.gitignore"] {
        if !existing.lines().any(|line| line.trim() == rule) {
            if !updated.ends_with('\n') {
                updated.push('\n');
            }
            updated.push_str(rule);
            updated.push('\n');
            changed = true;
        }
    }

    if changed {
        std::fs::write(path, updated)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_recording_storage_with_dedicated_gitignore() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();

        assert_eq!(dir, temp.path().join(".cutready").join("recordings"));
        assert!(dir.is_dir());
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "*\n!.gitignore\n"
        );
    }

    #[test]
    fn recording_storage_initialization_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();
        let gitignore = dir.join(".gitignore");
        let first = std::fs::read(&gitignore).unwrap();

        initialize_recording_storage(temp.path()).unwrap();
        let second = std::fs::read(&gitignore).unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn recording_gitignore_keeps_itself_trackable() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        let rules: Vec<&str> = content.lines().collect();

        assert!(rules.contains(&"*"));
        assert!(rules.contains(&"!.gitignore"));
        assert!(
            !content.contains(".cutready/"),
            "recording ignore rules must not ignore other .cutready assets"
        );
    }

    #[test]
    fn existing_recording_gitignore_preserves_extra_rules() {
        let temp = tempfile::tempdir().unwrap();
        let dir = recordings_dir(temp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "# local notes\n*.tmp\n").unwrap();

        initialize_recording_storage(temp.path()).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();

        assert!(content.contains("# local notes"));
        assert!(content.contains("*.tmp"));
        assert!(content.lines().any(|line| line == "*"));
        assert!(content.lines().any(|line| line == "!.gitignore"));
    }
}
