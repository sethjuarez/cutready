//! Git-backed document versioning via gix (pure-Rust git).
//!
//! Each project directory is a git repository. Every save auto-commits
//! a snapshot, giving users infinite undo and version history without
//! needing to understand git.

use std::path::Path;

use chrono::{DateTime, TimeZone, Utc};

use crate::models::sketch::VersionEntry;

/// Errors that can occur during versioning operations.
#[derive(Debug, thiserror::Error)]
pub enum VersioningError {
    #[error("Git error: {0}")]
    Git(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("No commits found")]
    NoCommits,
}

/// Initialize a git repository in the given project directory.
pub fn init_project_repo(project_dir: &Path) -> Result<(), VersioningError> {
    gix::init(project_dir).map_err(|e| VersioningError::Git(e.to_string()))?;
    Ok(())
}

/// Stage all files and commit a snapshot with the given message.
pub fn commit_snapshot(project_dir: &Path, message: &str) -> Result<String, VersioningError> {
    let repo = open_repo(project_dir)?;

    // Build a tree from the working directory
    let tree_id = build_tree_from_dir(&repo, project_dir, project_dir)?;

    // Find the parent commit (if any)
    let parent_ids: Vec<gix::ObjectId> = match repo.head_commit() {
        Ok(commit) => vec![commit.id],
        Err(_) => vec![],
    };

    let parents_refs: Vec<&gix::oid> = parent_ids.iter().map(|id| id.as_ref()).collect();

    let committer = gix::actor::SignatureRef {
        name: "CutReady".into(),
        email: "app@cutready.local".into(),
        time: gix::date::Time::now_local_or_utc(),
    };

    let commit_id = repo
        .commit_as(
            committer,
            committer,
            "HEAD",
            message,
            tree_id,
            parents_refs,
        )
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    Ok(commit_id.to_string())
}

/// List all versions (commits) in reverse chronological order.
pub fn list_versions(project_dir: &Path) -> Result<Vec<VersionEntry>, VersioningError> {
    let repo = open_repo(project_dir)?;

    let head = match repo.head_commit() {
        Ok(commit) => commit,
        Err(_) => return Ok(Vec::new()),
    };

    let mut entries = Vec::new();
    let mut current = Some(head.id().detach());

    while let Some(oid) = current {
        let commit_obj = repo
            .find_commit(oid)
            .map_err(|e| VersioningError::Git(e.to_string()))?;

        let message = commit_obj.message_raw_sloppy().to_string();
        let time = commit_obj
            .time()
            .map_err(|e| VersioningError::Git(e.to_string()))?;
        let timestamp = gix_time_to_chrono(time);

        entries.push(VersionEntry {
            id: oid.to_string(),
            message: message.trim().to_string(),
            timestamp,
            summary: String::new(),
        });

        // Follow first parent only (linear history)
        current = commit_obj.parent_ids().next().map(|id| id.detach());
    }

    Ok(entries)
}

/// Get the content of a specific file at a given commit.
pub fn get_file_at_version(
    project_dir: &Path,
    commit_id: &str,
    file_path: &str,
) -> Result<Vec<u8>, VersioningError> {
    let repo = open_repo(project_dir)?;

    let oid: gix::ObjectId = commit_id
        .parse()
        .map_err(|e: gix::hash::decode::Error| VersioningError::Git(e.to_string()))?;

    let commit = repo
        .find_commit(oid)
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    let tree = commit
        .tree()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    let entry = tree
        .lookup_entry_by_path(file_path)
        .map_err(|e| VersioningError::Git(e.to_string()))?
        .ok_or_else(|| {
            VersioningError::Git(format!("File not found at version: {}", file_path))
        })?;

    let object = entry
        .object()
        .map_err(|e| VersioningError::Git(e.to_string()))?;

    Ok(object.data.to_vec())
}

/// Restore the project to a historical version by checking out that commit's
/// content and creating a new commit.
pub fn restore_version(project_dir: &Path, commit_id: &str) -> Result<String, VersioningError> {
    let data = get_file_at_version(project_dir, commit_id, "project.json")?;

    let project_json_path = project_dir.join("project.json");
    std::fs::write(&project_json_path, &data).map_err(|e| VersioningError::Io(e.to_string()))?;

    let short_id = &commit_id[..8.min(commit_id.len())];
    let message = format!("Restored from version {}", short_id);
    commit_snapshot(project_dir, &message)
}

// ── Internal helpers ────────────────────────────────────────────────

fn open_repo(project_dir: &Path) -> Result<gix::Repository, VersioningError> {
    gix::open(project_dir).map_err(|e| VersioningError::Git(e.to_string()))
}

/// Build a git tree object from a directory on disk (recursive).
/// Skips hidden files/dirs (starting with '.').
fn build_tree_from_dir(
    repo: &gix::Repository,
    root: &Path,
    dir: &Path,
) -> Result<gix::ObjectId, VersioningError> {
    let mut entries: Vec<gix::objs::tree::Entry> = Vec::new();

    let read_dir = std::fs::read_dir(dir).map_err(|e| VersioningError::Io(e.to_string()))?;

    for fs_entry in read_dir {
        let fs_entry = fs_entry.map_err(|e| VersioningError::Io(e.to_string()))?;
        let path = fs_entry.path();
        let name = fs_entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            let sub_tree_id = build_tree_from_dir(repo, root, &path)?;
            entries.push(gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Tree.into(),
                filename: name.into(),
                oid: sub_tree_id,
            });
        } else if path.is_file() {
            let data = std::fs::read(&path).map_err(|e| VersioningError::Io(e.to_string()))?;
            let blob_id: gix::ObjectId = repo
                .write_blob(&data)
                .map_err(|e| VersioningError::Git(e.to_string()))?
                .into();
            entries.push(gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Blob.into(),
                filename: name.into(),
                oid: blob_id,
            });
        }
    }

    // gix requires entries sorted by name (with special dir sorting rules)
    entries.sort();

    let tree = gix::objs::Tree { entries };
    let tree_id = repo
        .write_object(&tree)
        .map_err(|e| VersioningError::Git(e.to_string()))?
        .detach();

    Ok(tree_id)
}

fn gix_time_to_chrono(time: gix::date::Time) -> DateTime<Utc> {
    Utc.timestamp_opt(time.seconds, 0)
        .single()
        .unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_project_dir() -> TempDir {
        let tmp = TempDir::new().unwrap();
        std::fs::write(
            tmp.path().join("project.json"),
            r#"{"name": "test", "version": 1}"#,
        )
        .unwrap();
        tmp
    }

    #[test]
    fn init_creates_git_repo() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();
        assert!(tmp.path().join(".git").exists());
    }

    #[test]
    fn commit_and_list_versions() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "Initial commit").unwrap();
        assert!(!id1.is_empty());

        std::fs::write(
            tmp.path().join("project.json"),
            r#"{"name": "test", "version": 2}"#,
        )
        .unwrap();
        let id2 = commit_snapshot(tmp.path(), "Update version").unwrap();
        assert_ne!(id1, id2);

        let versions = list_versions(tmp.path()).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].message, "Update version");
        assert_eq!(versions[1].message, "Initial commit");
    }

    #[test]
    fn list_versions_empty_repo() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();
        let versions = list_versions(tmp.path()).unwrap();
        assert!(versions.is_empty());
    }

    #[test]
    fn get_file_at_version() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1").unwrap();

        std::fs::write(
            tmp.path().join("project.json"),
            r#"{"name": "test", "version": 2}"#,
        )
        .unwrap();
        let _id2 = commit_snapshot(tmp.path(), "v2").unwrap();

        let data = super::get_file_at_version(tmp.path(), &id1, "project.json").unwrap();
        let content = String::from_utf8(data).unwrap();
        assert!(content.contains("\"version\": 1"));
    }

    #[test]
    fn restore_version_works() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let id1 = commit_snapshot(tmp.path(), "v1").unwrap();

        std::fs::write(
            tmp.path().join("project.json"),
            r#"{"name": "test", "version": 2}"#,
        )
        .unwrap();
        commit_snapshot(tmp.path(), "v2").unwrap();

        restore_version(tmp.path(), &id1).unwrap();

        let content = std::fs::read_to_string(tmp.path().join("project.json")).unwrap();
        assert!(content.contains("\"version\": 1"));

        let versions = list_versions(tmp.path()).unwrap();
        assert_eq!(versions.len(), 3);
        assert!(versions[0].message.contains("Restored"));
    }

    #[test]
    fn commit_with_subdirectories() {
        let tmp = setup_project_dir();
        init_project_repo(tmp.path()).unwrap();

        let docs_dir = tmp.path().join("documents");
        std::fs::create_dir_all(&docs_dir).unwrap();
        std::fs::write(docs_dir.join("doc1.json"), r#"{"title": "Doc 1"}"#).unwrap();

        let id = commit_snapshot(tmp.path(), "With subdirs").unwrap();
        assert!(!id.is_empty());

        let data = super::get_file_at_version(tmp.path(), &id, "documents/doc1.json").unwrap();
        let content = String::from_utf8(data).unwrap();
        assert!(content.contains("Doc 1"));
    }
}
