//! Project storage engine — folder-based projects with .sk/.sb files.
//!
//! A project is any folder containing `.sk` (sketch) and/or `.sb` (storyboard)
//! files. There is no central registry — projects are opened by path.
//!
//!   My Demo/
//!     ├── intro.sk             (sketch JSON)
//!     ├── flows/
//!     │   └── login.sk         (sketches in subfolders)
//!     ├── full-demo.sb         (storyboard, references .sk by path)
//!     ├── assets/              (screenshots, images)
//!     └── .git/                (version history via gix)

use std::path::{Path, PathBuf};

use crate::engine::versioning;
use crate::models::script::ProjectView;
use crate::models::sketch::{
    Sketch, SketchSummary, Storyboard, StoryboardSummary,
};

// ── Path safety ────────────────────────────────────────────────────

/// Resolve a user-provided relative path against a project root,
/// ensuring the result stays within the project directory.
///
/// Rejects absolute paths, `..` traversal, and any result that escapes root.
pub fn safe_resolve(root: &Path, relative_path: &str) -> Result<PathBuf, ProjectError> {
    let rel = Path::new(relative_path);

    // Reject absolute paths
    if rel.is_absolute() {
        return Err(ProjectError::PathTraversal(relative_path.to_string()));
    }

    // Reject any component that is ".." or has a prefix (e.g., C:)
    for component in rel.components() {
        match component {
            std::path::Component::ParentDir | std::path::Component::Prefix(_) => {
                return Err(ProjectError::PathTraversal(relative_path.to_string()));
            }
            _ => {}
        }
    }

    let resolved = root.join(rel);

    // Belt-and-suspenders: when the file or its parent exists on disk,
    // canonicalize and verify containment within root.
    if let Ok(canonical_root) = root.canonicalize() {
        let check = if resolved.exists() {
            resolved.canonicalize().ok()
        } else if let Some(parent) = resolved.parent() {
            parent.canonicalize().ok().map(|p| p.join(resolved.file_name().unwrap_or_default()))
        } else {
            None
        };

        if let Some(canonical_resolved) = check {
            if !canonical_resolved.starts_with(&canonical_root) {
                return Err(ProjectError::PathTraversal(relative_path.to_string()));
            }
        }
        // If neither file nor parent exist, we rely on the component check above
    }

    Ok(resolved)
}

// ── Project folder operations ──────────────────────────────────────

/// Initialize a new project in the given folder.
///
/// Creates the folder if it doesn't exist, inits git, and returns a ProjectView.
pub fn init_project_folder(root: &Path) -> Result<ProjectView, ProjectError> {
    std::fs::create_dir_all(root).map_err(|e| ProjectError::Io(e.to_string()))?;

    // Init git if not already a repo
    if !root.join(".git").exists() {
        versioning::init_project_repo(root).map_err(|e| ProjectError::Io(e.to_string()))?;
        let _ = versioning::commit_snapshot(root, "Initialize project");
    }

    Ok(ProjectView::new(root.to_path_buf()))
}

/// Open an existing project folder by scanning for .sk/.sb files.
/// Initializes git if not already a repo (needed for snapshots).
pub fn open_project_folder(root: &Path) -> Result<ProjectView, ProjectError> {
    if !root.exists() || !root.is_dir() {
        return Err(ProjectError::NotFound(
            root.to_string_lossy().into_owned(),
        ));
    }

    // Init git if not already a repo so snapshots work
    if !root.join(".git").exists() {
        versioning::init_project_repo(root).map_err(|e| ProjectError::Io(e.to_string()))?;
        let _ = versioning::commit_snapshot(root, "Initialize project");
    }

    Ok(ProjectView::new(root.to_path_buf()))
}

// ── Sketch file I/O (.sk) ─────────────────────────────────────────
//
// Sketches are stored as `.sk` files anywhere in the project tree.
// The relative path from project root is the sketch's identity.

/// Write a sketch to a `.sk` file.
pub fn write_sketch(sketch: &Sketch, path: &Path, _project_root: &Path) -> Result<(), ProjectError> {
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    let json = serde_json::to_string_pretty(sketch)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| ProjectError::Io(e.to_string()))?;

    Ok(())
}

/// Read a sketch from a `.sk` file.
pub fn read_sketch(path: &Path) -> Result<Sketch, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(
            path.to_string_lossy().into_owned(),
        ));
    }
    let data = std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))
}

/// Delete a sketch file and auto-commit.
pub fn delete_sketch(path: &Path, project_root: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    if project_root.join(".git").exists() {
        let _ = versioning::commit_snapshot(project_root, "Delete sketch");
    }
    Ok(())
}

/// Rename/move a sketch file and auto-commit.
pub fn rename_sketch(
    old_path: &Path,
    new_path: &Path,
    project_root: &Path,
) -> Result<(), ProjectError> {
    if !old_path.exists() {
        return Err(ProjectError::NotFound(
            old_path.to_string_lossy().into_owned(),
        ));
    }
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    std::fs::rename(old_path, new_path).map_err(|e| ProjectError::Io(e.to_string()))?;

    if project_root.join(".git").exists() {
        let _ = versioning::commit_snapshot(project_root, "Rename sketch");
    }
    Ok(())
}

// ── Storyboard file I/O (.sb) ─────────────────────────────────────

/// Write a storyboard to a `.sb` file.
pub fn write_storyboard(
    sb: &Storyboard,
    path: &Path,
    _project_root: &Path,
) -> Result<(), ProjectError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    let json = serde_json::to_string_pretty(sb)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| ProjectError::Io(e.to_string()))?;

    Ok(())
}

/// Read a storyboard from a `.sb` file.
pub fn read_storyboard(path: &Path) -> Result<Storyboard, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(
            path.to_string_lossy().into_owned(),
        ));
    }
    let data = std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))
}

/// Delete a storyboard file and auto-commit.
pub fn delete_storyboard(path: &Path, project_root: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    if project_root.join(".git").exists() {
        let _ = versioning::commit_snapshot(project_root, "Delete storyboard");
    }
    Ok(())
}

// ── Folder scanning ────────────────────────────────────────────────

/// Recursively scan a project folder for all `.sk` files.
/// Returns summaries with relative paths from project root.
pub fn scan_sketches(project_root: &Path) -> Result<Vec<SketchSummary>, ProjectError> {
    let mut summaries = Vec::new();
    scan_files_recursive(project_root, project_root, "sk", &mut |rel_path, abs_path| {
        if let Ok(data) = std::fs::read_to_string(abs_path) {
            if let Ok(sketch) = serde_json::from_str::<Sketch>(&data) {
                summaries.push(SketchSummary::from_sketch(&sketch, rel_path));
            }
        }
    })?;
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Recursively scan a project folder for all `.sb` files.
/// Returns summaries with relative paths from project root.
pub fn scan_storyboards(project_root: &Path) -> Result<Vec<StoryboardSummary>, ProjectError> {
    let mut summaries = Vec::new();
    scan_files_recursive(project_root, project_root, "sb", &mut |rel_path, abs_path| {
        if let Ok(data) = std::fs::read_to_string(abs_path) {
            if let Ok(sb) = serde_json::from_str::<Storyboard>(&data) {
                summaries.push(StoryboardSummary::from_storyboard(&sb, rel_path));
            }
        }
    })?;
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Check if a sketch file exists given a relative path from project root.
pub fn sketch_file_exists(relative_path: &str, project_root: &Path) -> bool {
    project_root.join(relative_path).exists()
}

// ── Versioning helpers ─────────────────────────────────────────────

/// Save with a user-provided label (for named versions).
pub fn save_with_label(project_root: &Path, label: &str) -> Result<String, ProjectError> {
    // Auto-init git if missing so snapshots always work
    if !project_root.join(".git").exists() {
        versioning::init_project_repo(project_root)
            .map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    versioning::commit_snapshot(project_root, label)
        .map_err(|e| ProjectError::Io(e.to_string()))
}

// ── Internal helpers ────────────────────────────────────────────────

/// Recursively find files with a given extension, skipping `.git` and hidden dirs.
fn scan_files_recursive(
    dir: &Path,
    project_root: &Path,
    extension: &str,
    callback: &mut dyn FnMut(&str, &Path),
) -> Result<(), ProjectError> {
    if !dir.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    for entry in entries {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // Skip hidden directories and .git
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            scan_files_recursive(&path, project_root, extension, callback)?;
        } else if path.extension().is_some_and(|ext| ext == extension) {
            // Compute relative path using forward slashes for portability
            if let Ok(rel) = path.strip_prefix(project_root) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                callback(&rel_str, &path);
            }
        }
    }

    Ok(())
}

/// Errors that can occur during project operations.
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("I/O error: {0}")]
    Io(String),
    #[error("Serialization error: {0}")]
    Serialize(String),
    #[error("Deserialization error: {0}")]
    Deserialize(String),
    #[error("Project not found: {0}")]
    NotFound(String),
    #[error("Path traversal rejected: {0}")]
    PathTraversal(String),
    #[error("File already exists: {0}")]
    AlreadyExists(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn init_project_folder_creates_git() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("My Demo");

        let view = init_project_folder(&root).unwrap();
        assert_eq!(view.name, "My Demo");
        assert!(root.join(".git").exists());
    }

    #[test]
    fn open_project_folder_returns_view() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("Test Project");
        std::fs::create_dir_all(&root).unwrap();

        let view = open_project_folder(&root).unwrap();
        assert_eq!(view.name, "Test Project");
    }

    #[test]
    fn open_nonexistent_folder_errors() {
        let result = open_project_folder(Path::new("/nonexistent/path"));
        assert!(result.is_err());
    }

    #[test]
    fn write_and_read_sketch() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("My Sketch");
        let path = root.join("intro.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());

        let loaded = read_sketch(&path).unwrap();
        assert_eq!(loaded.title, "My Sketch");
    }

    #[test]
    fn write_sketch_creates_subdirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Nested");
        let path = root.join("flows").join("login.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn delete_sketch_removes_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Delete Me");
        let path = root.join("temp.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());

        delete_sketch(&path, root).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn rename_sketch_moves_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Rename Me");
        let old_path = root.join("old.sk");
        let new_path = root.join("new.sk");

        write_sketch(&sketch, &old_path, root).unwrap();
        rename_sketch(&old_path, &new_path, root).unwrap();

        assert!(!old_path.exists());
        assert!(new_path.exists());
        let loaded = read_sketch(&new_path).unwrap();
        assert_eq!(loaded.title, "Rename Me");
    }

    #[test]
    fn read_nonexistent_sketch_errors() {
        let result = read_sketch(Path::new("/nonexistent/sketch.sk"));
        assert!(result.is_err());
    }

    #[test]
    fn scan_sketches_finds_all() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_sketch(&Sketch::new("A"), &root.join("a.sk"), root).unwrap();
        write_sketch(&Sketch::new("B"), &root.join("b.sk"), root).unwrap();
        write_sketch(
            &Sketch::new("C"),
            &root.join("sub").join("c.sk"),
            root,
        )
        .unwrap();

        let summaries = scan_sketches(root).unwrap();
        assert_eq!(summaries.len(), 3);

        let paths: Vec<&str> = summaries.iter().map(|s| s.path.as_str()).collect();
        assert!(paths.contains(&"a.sk"));
        assert!(paths.contains(&"b.sk"));
        assert!(paths.contains(&"sub/c.sk"));
    }

    #[test]
    fn scan_sketches_skips_hidden_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_sketch(&Sketch::new("Visible"), &root.join("visible.sk"), root).unwrap();
        // Put a sketch in .git — should be skipped
        let hidden = root.join(".git").join("hidden.sk");
        std::fs::create_dir_all(hidden.parent().unwrap()).unwrap();
        std::fs::write(&hidden, r#"{"title":"Hidden","state":"draft","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}"#).unwrap();

        let summaries = scan_sketches(root).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "Visible");
    }

    #[test]
    fn scan_sketches_empty_dir() {
        let tmp = TempDir::new().unwrap();
        let summaries = scan_sketches(tmp.path()).unwrap();
        assert!(summaries.is_empty());
    }

    #[test]
    fn write_and_read_storyboard() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sb = Storyboard::new("Full Demo");
        let path = root.join("demo.sb");

        write_storyboard(&sb, &path, root).unwrap();
        let loaded = read_storyboard(&path).unwrap();
        assert_eq!(loaded.title, "Full Demo");
    }

    #[test]
    fn scan_storyboards_finds_all() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_storyboard(&Storyboard::new("A"), &root.join("a.sb"), root).unwrap();
        write_storyboard(&Storyboard::new("B"), &root.join("b.sb"), root).unwrap();

        let summaries = scan_storyboards(root).unwrap();
        assert_eq!(summaries.len(), 2);
    }

    #[test]
    fn sketch_file_exists_checks_correctly() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        assert!(!sketch_file_exists("intro.sk", root));
        write_sketch(&Sketch::new("Intro"), &root.join("intro.sk"), root).unwrap();
        assert!(sketch_file_exists("intro.sk", root));
    }

    #[test]
    fn save_with_label_creates_named_version() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        init_project_folder(root).unwrap();
        write_sketch(&Sketch::new("Test"), &root.join("test.sk"), root).unwrap();

        let commit_id = save_with_label(root, "v1.0 release").unwrap();
        assert!(!commit_id.is_empty());

        let versions = versioning::list_versions(root).unwrap();
        assert!(versions.iter().any(|v| v.message == "v1.0 release"));
    }

    // ── safe_resolve tests ─────────────────────────────────

    #[test]
    fn safe_resolve_accepts_normal_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let result = safe_resolve(root, "intro.sk").unwrap();
        assert_eq!(result, root.join("intro.sk"));

        let result = safe_resolve(root, "flows/login.sk").unwrap();
        assert_eq!(result, root.join("flows/login.sk"));
    }

    #[test]
    fn safe_resolve_rejects_parent_traversal() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        assert!(safe_resolve(root, "../escape.sk").is_err());
        assert!(safe_resolve(root, "sub/../../escape.sk").is_err());
        assert!(safe_resolve(root, "..").is_err());
    }

    #[test]
    fn safe_resolve_rejects_absolute_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        #[cfg(target_os = "windows")]
        assert!(safe_resolve(root, "C:\\Windows\\System32\\cmd.exe").is_err());

        #[cfg(not(target_os = "windows"))]
        assert!(safe_resolve(root, "/etc/passwd").is_err());
    }
}
