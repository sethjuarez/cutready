//! Project storage engine — create, load, save, and list project directories.
//!
//! Projects are stored as git-backed directories:
//!   projects/{uuid}/
//!     ├── project.json     (Project data)
//!     ├── sketches/        (future: per-sketch JSON files)
//!     ├── screenshots/     (captured screenshots)
//!     └── .git/            (version history via gix)
//!
//! Legacy `.cutready` flat files are auto-migrated on first scan.

use std::path::{Path, PathBuf};

use crate::engine::versioning;
use crate::models::script::{Project, ProjectSummary};

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
        let project: Project =
            serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))?;
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
}
