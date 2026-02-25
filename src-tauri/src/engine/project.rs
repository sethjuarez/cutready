//! Project storage engine — create, load, save, and list project directories.
//!
//! Projects are stored as git-backed directories:
//!   projects/{uuid}/
//!     ├── project.json     (Project config, storyboards, recordings)
//!     ├── sketches/        (per-sketch JSON files: {sketch_uuid}.json)
//!     ├── screenshots/     (captured screenshots)
//!     └── .git/            (version history via gix)
//!
//! Legacy `.cutready` flat files are auto-migrated on first scan.

use std::path::{Path, PathBuf};

use crate::engine::versioning;
use crate::models::script::{Project, ProjectSummary};
use crate::models::sketch::{Sketch, SketchSummary};

/// Create a new project directory with git versioning.
pub fn create_project(name: &str, projects_dir: &Path) -> Result<Project, ProjectError> {
    let project = Project::new(name);
    let project_dir = project_dir_path(projects_dir, &project.id.to_string());

    // Create directory structure
    std::fs::create_dir_all(&project_dir).map_err(|e| ProjectError::Io(e.to_string()))?;
    std::fs::create_dir_all(project_dir.join("sketches"))
        .map_err(|e| ProjectError::Io(e.to_string()))?;
    std::fs::create_dir_all(project_dir.join("screenshots"))
        .map_err(|e| ProjectError::Io(e.to_string()))?;

    // Write project.json
    write_project_json(&project, &project_dir)?;

    // Initialize git repo and make initial commit
    versioning::init_project_repo(&project_dir)
        .map_err(|e| ProjectError::Io(e.to_string()))?;
    versioning::commit_snapshot(&project_dir, "Initial project creation")
        .map_err(|e| ProjectError::Io(e.to_string()))?;

    Ok(project)
}

/// Load a project from its directory by ID.
pub fn load_project(project_id: &str, projects_dir: &Path) -> Result<Project, ProjectError> {
    // Try directory-based format first
    let project_dir = project_dir_path(projects_dir, project_id);
    let project_json = project_dir.join("project.json");

    if project_json.exists() {
        let data =
            std::fs::read_to_string(&project_json).map_err(|e| ProjectError::Io(e.to_string()))?;
        let mut project: Project =
            serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))?;

        // Auto-migrate inline sketches to individual files
        migrate_inline_sketches(&mut project, &project_dir)?;

        return Ok(project);
    }

    // Fall back to legacy flat file format
    let legacy_path = projects_dir.join(format!("{}.cutready", project_id));
    if legacy_path.exists() {
        let data =
            std::fs::read_to_string(&legacy_path).map_err(|e| ProjectError::Io(e.to_string()))?;
        let project: Project =
            serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))?;

        // Auto-migrate to directory format
        migrate_legacy_project(&project, &legacy_path, projects_dir)?;

        return Ok(project);
    }

    Err(ProjectError::NotFound(project_id.to_string()))
}

/// Save an existing project (overwrites project.json and auto-commits).
pub fn save_project(project: &Project, projects_dir: &Path) -> Result<(), ProjectError> {
    let project_dir = project_dir_path(projects_dir, &project.id.to_string());
    std::fs::create_dir_all(&project_dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    write_project_json(project, &project_dir)?;

    // Auto-commit if the project has a git repo
    if project_dir.join(".git").exists() {
        let _ = versioning::commit_snapshot(&project_dir, "Auto-save");
    }

    Ok(())
}

/// Save with a user-provided label (for named versions).
pub fn save_with_label(
    project: &Project,
    label: &str,
    projects_dir: &Path,
) -> Result<String, ProjectError> {
    let project_dir = project_dir_path(projects_dir, &project.id.to_string());
    write_project_json(project, &project_dir)?;

    if project_dir.join(".git").exists() {
        versioning::commit_snapshot(&project_dir, label)
            .map_err(|e| ProjectError::Io(e.to_string()))
    } else {
        Ok(String::new())
    }
}

/// List all projects in the projects directory.
pub fn list_projects(projects_dir: &Path) -> Result<Vec<ProjectSummary>, ProjectError> {
    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let mut summaries = Vec::new();
    let entries = std::fs::read_dir(projects_dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    for entry in entries {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();

        // Directory-based projects
        if path.is_dir() {
            let project_json = path.join("project.json");
            if project_json.exists() {
                if let Ok(data) = std::fs::read_to_string(&project_json) {
                    if let Ok(project) = serde_json::from_str::<Project>(&data) {
                        summaries.push(ProjectSummary::from(&project));
                    }
                }
            }
        }

        // Legacy flat files
        if path.is_file() && path.extension().is_some_and(|ext| ext == "cutready") {
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(project) = serde_json::from_str::<Project>(&data) {
                    summaries.push(ProjectSummary::from(&project));
                }
            }
        }
    }

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Delete a project (directory or legacy file).
pub fn delete_project(project_id: &str, projects_dir: &Path) -> Result<(), ProjectError> {
    // Try directory first
    let project_dir = project_dir_path(projects_dir, project_id);
    if project_dir.exists() && project_dir.is_dir() {
        std::fs::remove_dir_all(&project_dir).map_err(|e| ProjectError::Io(e.to_string()))?;
        return Ok(());
    }

    // Try legacy flat file
    let legacy_path = projects_dir.join(format!("{}.cutready", project_id));
    if legacy_path.exists() {
        std::fs::remove_file(&legacy_path).map_err(|e| ProjectError::Io(e.to_string()))?;
        return Ok(());
    }

    Err(ProjectError::NotFound(project_id.to_string()))
}

/// Get the project directory path for a given project ID.
pub fn project_dir_path(projects_dir: &Path, project_id: &str) -> PathBuf {
    projects_dir.join(project_id)
}

// ── Sketch file I/O ────────────────────────────────────────────────
//
// Each sketch is stored as `sketches/{uuid}.json` within the project dir.
// Filenames are stable UUIDs; titles are internal metadata.

/// Save a sketch to its individual file and auto-commit.
pub fn save_sketch(sketch: &Sketch, project_dir: &Path) -> Result<(), ProjectError> {
    let sketches_dir = project_dir.join("sketches");
    std::fs::create_dir_all(&sketches_dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    let json = serde_json::to_string_pretty(sketch)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(sketches_dir.join(format!("{}.json", sketch.id)), json)
        .map_err(|e| ProjectError::Io(e.to_string()))?;

    // Auto-commit
    if project_dir.join(".git").exists() {
        let _ = versioning::commit_snapshot(project_dir, "Auto-save sketch");
    }
    Ok(())
}

/// Load a sketch from its individual file.
pub fn load_sketch(sketch_id: &str, project_dir: &Path) -> Result<Sketch, ProjectError> {
    let path = project_dir.join("sketches").join(format!("{}.json", sketch_id));
    if !path.exists() {
        return Err(ProjectError::NotFound(format!("Sketch {}", sketch_id)));
    }
    let data = std::fs::read_to_string(&path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))
}

/// Delete a sketch file.
pub fn delete_sketch_file(sketch_id: &str, project_dir: &Path) -> Result<(), ProjectError> {
    let path = project_dir.join("sketches").join(format!("{}.json", sketch_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    if project_dir.join(".git").exists() {
        let _ = versioning::commit_snapshot(project_dir, "Delete sketch");
    }
    Ok(())
}

/// List all sketch summaries by scanning the sketches/ directory.
pub fn list_sketches(project_dir: &Path) -> Result<Vec<SketchSummary>, ProjectError> {
    let sketches_dir = project_dir.join("sketches");
    if !sketches_dir.exists() {
        return Ok(Vec::new());
    }

    let mut summaries = Vec::new();
    let entries =
        std::fs::read_dir(&sketches_dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    for entry in entries {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            if let Ok(data) = std::fs::read_to_string(&path) {
                if let Ok(sketch) = serde_json::from_str::<Sketch>(&data) {
                    summaries.push(SketchSummary::from(&sketch));
                }
            }
        }
    }

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Check if a sketch file exists.
pub fn sketch_exists(sketch_id: &str, project_dir: &Path) -> bool {
    project_dir
        .join("sketches")
        .join(format!("{}.json", sketch_id))
        .exists()
}

/// Migrate inline sketches from project.json to individual files.
/// Called after loading a project that still has sketches embedded.
pub fn migrate_inline_sketches(project: &mut Project, project_dir: &Path) -> Result<bool, ProjectError> {
    if project.sketches.is_empty() {
        return Ok(false);
    }

    let sketches_dir = project_dir.join("sketches");
    std::fs::create_dir_all(&sketches_dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    for sketch in &project.sketches {
        let path = sketches_dir.join(format!("{}.json", sketch.id));
        if !path.exists() {
            let json = serde_json::to_string_pretty(sketch)
                .map_err(|e| ProjectError::Serialize(e.to_string()))?;
            std::fs::write(&path, json).map_err(|e| ProjectError::Io(e.to_string()))?;
        }
    }

    // Clear inline sketches and re-save project.json
    project.sketches.clear();
    write_project_json(project, project_dir)?;

    Ok(true)
}

// ── Internal helpers ────────────────────────────────────────────────

fn write_project_json(project: &Project, project_dir: &Path) -> Result<(), ProjectError> {
    let json = serde_json::to_string_pretty(project)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(project_dir.join("project.json"), json)
        .map_err(|e| ProjectError::Io(e.to_string()))?;
    Ok(())
}

/// Migrate a legacy `.cutready` flat file to directory format.
fn migrate_legacy_project(
    project: &Project,
    legacy_path: &Path,
    projects_dir: &Path,
) -> Result<(), ProjectError> {
    let project_dir = project_dir_path(projects_dir, &project.id.to_string());

    // Create directory structure
    std::fs::create_dir_all(&project_dir).map_err(|e| ProjectError::Io(e.to_string()))?;
    std::fs::create_dir_all(project_dir.join("sketches"))
        .map_err(|e| ProjectError::Io(e.to_string()))?;
    std::fs::create_dir_all(project_dir.join("screenshots"))
        .map_err(|e| ProjectError::Io(e.to_string()))?;

    // Write project.json
    write_project_json(project, &project_dir)?;

    // Initialize git and commit
    if versioning::init_project_repo(&project_dir).is_ok() {
        let _ = versioning::commit_snapshot(&project_dir, "Migrated from legacy format");
    }

    // Remove legacy file
    let _ = std::fs::remove_file(legacy_path);

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
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn create_and_load_project() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let project = create_project("My Demo", dir).unwrap();
        assert_eq!(project.name, "My Demo");

        // Verify directory structure
        let project_dir = dir.join(project.id.to_string());
        assert!(project_dir.join("project.json").exists());
        assert!(project_dir.join("sketches").exists());
        assert!(project_dir.join("screenshots").exists());
        assert!(project_dir.join(".git").exists());

        let loaded = load_project(&project.id.to_string(), dir).unwrap();
        assert_eq!(loaded.id, project.id);
        assert_eq!(loaded.name, "My Demo");
    }

    #[test]
    fn save_and_reload_project() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let mut project = create_project("Test", dir).unwrap();
        project.name = "Updated Name".into();
        save_project(&project, dir).unwrap();

        let loaded = load_project(&project.id.to_string(), dir).unwrap();
        assert_eq!(loaded.name, "Updated Name");
    }

    #[test]
    fn list_projects_empty_dir() {
        let tmp = TempDir::new().unwrap();
        let result = list_projects(tmp.path()).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_projects_nonexistent_dir() {
        let result = list_projects(Path::new("/nonexistent/path")).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_projects_finds_all() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        create_project("Alpha", dir).unwrap();
        create_project("Beta", dir).unwrap();
        create_project("Gamma", dir).unwrap();

        let summaries = list_projects(dir).unwrap();
        assert_eq!(summaries.len(), 3);
    }

    #[test]
    fn delete_project_removes_directory() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let project = create_project("To Delete", dir).unwrap();
        let id = project.id.to_string();

        assert!(load_project(&id, dir).is_ok());
        delete_project(&id, dir).unwrap();
        assert!(load_project(&id, dir).is_err());
    }

    #[test]
    fn load_nonexistent_project_errors() {
        let tmp = TempDir::new().unwrap();
        let result = load_project("nonexistent-id", tmp.path());
        assert!(result.is_err());
    }

    #[test]
    fn save_with_label_creates_named_version() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        let project = create_project("Labeled", dir).unwrap();
        let commit_id = save_with_label(&project, "v1.0 release", dir).unwrap();
        assert!(!commit_id.is_empty());

        let project_dir = project_dir_path(dir, &project.id.to_string());
        let versions = versioning::list_versions(&project_dir).unwrap();
        assert!(versions.iter().any(|v| v.message == "v1.0 release"));
    }

    #[test]
    fn legacy_migration_on_load() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();

        // Create a legacy flat file
        let project = Project::new("Legacy Project");
        let legacy_path = dir.join(format!("{}.cutready", project.id));
        std::fs::create_dir_all(dir).unwrap();
        let json = serde_json::to_string_pretty(&project).unwrap();
        std::fs::write(&legacy_path, json).unwrap();

        // Loading should auto-migrate
        let loaded = load_project(&project.id.to_string(), dir).unwrap();
        assert_eq!(loaded.name, "Legacy Project");

        // Legacy file should be removed
        assert!(!legacy_path.exists());

        // Directory format should exist
        let project_dir = dir.join(project.id.to_string());
        assert!(project_dir.join("project.json").exists());
        assert!(project_dir.join(".git").exists());
    }

    // ── Sketch file I/O tests ───────────────────────────────────────

    #[test]
    fn save_and_load_sketch_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let project = create_project("Sketch Test", dir).unwrap();
        let project_dir = project_dir_path(dir, &project.id.to_string());

        let sketch = Sketch::new("My Sketch".to_string());
        save_sketch(&sketch, &project_dir).unwrap();

        let loaded = load_sketch(&sketch.id.to_string(), &project_dir).unwrap();
        assert_eq!(loaded.id, sketch.id);
        assert_eq!(loaded.title, "My Sketch");
    }

    #[test]
    fn delete_sketch_file_removes_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let project = create_project("Delete Sketch", dir).unwrap();
        let project_dir = project_dir_path(dir, &project.id.to_string());

        let sketch = Sketch::new("To Delete".to_string());
        save_sketch(&sketch, &project_dir).unwrap();
        assert!(sketch_exists(&sketch.id.to_string(), &project_dir));

        delete_sketch_file(&sketch.id.to_string(), &project_dir).unwrap();
        assert!(!sketch_exists(&sketch.id.to_string(), &project_dir));
    }

    #[test]
    fn list_sketches_returns_all() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let project = create_project("List Sketches", dir).unwrap();
        let project_dir = project_dir_path(dir, &project.id.to_string());

        save_sketch(&Sketch::new("A".to_string()), &project_dir).unwrap();
        save_sketch(&Sketch::new("B".to_string()), &project_dir).unwrap();
        save_sketch(&Sketch::new("C".to_string()), &project_dir).unwrap();

        let summaries = list_sketches(&project_dir).unwrap();
        assert_eq!(summaries.len(), 3);
    }

    #[test]
    fn list_sketches_empty_dir() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let project = create_project("Empty", dir).unwrap();
        let project_dir = project_dir_path(dir, &project.id.to_string());

        let summaries = list_sketches(&project_dir).unwrap();
        assert!(summaries.is_empty());
    }

    #[test]
    fn sketch_exists_returns_correct_values() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let project = create_project("Exists Test", dir).unwrap();
        let project_dir = project_dir_path(dir, &project.id.to_string());

        let sketch = Sketch::new("Test".to_string());
        assert!(!sketch_exists(&sketch.id.to_string(), &project_dir));

        save_sketch(&sketch, &project_dir).unwrap();
        assert!(sketch_exists(&sketch.id.to_string(), &project_dir));
    }

    #[test]
    fn load_nonexistent_sketch_errors() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let project = create_project("No Sketch", dir).unwrap();
        let project_dir = project_dir_path(dir, &project.id.to_string());

        let result = load_sketch("nonexistent-id", &project_dir);
        assert!(result.is_err());
    }

    #[test]
    fn migrate_inline_sketches_moves_to_files() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let mut project = create_project("Migrate Test", dir).unwrap();
        let project_dir = project_dir_path(dir, &project.id.to_string());

        // Add inline sketches to project
        let s1 = Sketch::new("Sketch One".to_string());
        let s2 = Sketch::new("Sketch Two".to_string());
        let s1_id = s1.id.to_string();
        let s2_id = s2.id.to_string();
        project.sketches.push(s1);
        project.sketches.push(s2);
        write_project_json(&project, &project_dir).unwrap();

        // Migrate
        let migrated = migrate_inline_sketches(&mut project, &project_dir).unwrap();
        assert!(migrated);
        assert!(project.sketches.is_empty());

        // Sketch files should exist
        assert!(sketch_exists(&s1_id, &project_dir));
        assert!(sketch_exists(&s2_id, &project_dir));

        // Summaries should list both
        let summaries = list_sketches(&project_dir).unwrap();
        assert_eq!(summaries.len(), 2);
    }

    #[test]
    fn migrate_inline_sketches_noop_when_empty() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let mut project = create_project("No Migrate", dir).unwrap();
        let project_dir = project_dir_path(dir, &project.id.to_string());

        let migrated = migrate_inline_sketches(&mut project, &project_dir).unwrap();
        assert!(!migrated);
    }
}
