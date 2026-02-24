//! Project storage engine — create, load, save, and list `.cutready` project files.

use std::path::{Path, PathBuf};

use crate::models::script::{Project, ProjectSummary};

/// Create a new project and save it to disk.
pub fn create_project(name: &str, projects_dir: &Path) -> Result<Project, ProjectError> {
    let project = Project::new(name);
    let path = project_file_path(projects_dir, &project.id.to_string());

    std::fs::create_dir_all(projects_dir).map_err(|e| ProjectError::Io(e.to_string()))?;
    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| ProjectError::Io(e.to_string()))?;

    Ok(project)
}

/// Load a project from disk by its ID.
pub fn load_project(project_id: &str, projects_dir: &Path) -> Result<Project, ProjectError> {
    let path = project_file_path(projects_dir, project_id);
    if !path.exists() {
        return Err(ProjectError::NotFound(project_id.to_string()));
    }
    let data = std::fs::read_to_string(&path).map_err(|e| ProjectError::Io(e.to_string()))?;
    let project: Project =
        serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))?;
    Ok(project)
}

/// Save an existing project to disk (overwrites the file).
pub fn save_project(project: &Project, projects_dir: &Path) -> Result<(), ProjectError> {
    let path = project_file_path(projects_dir, &project.id.to_string());
    std::fs::create_dir_all(projects_dir).map_err(|e| ProjectError::Io(e.to_string()))?;
    let json = serde_json::to_string_pretty(project)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| ProjectError::Io(e.to_string()))?;
    Ok(())
}

/// List all projects in the projects directory (reads only enough to extract summaries).
pub fn list_projects(projects_dir: &Path) -> Result<Vec<ProjectSummary>, ProjectError> {
    if !projects_dir.exists() {
        return Ok(Vec::new());
    }

    let mut summaries = Vec::new();
    let entries = std::fs::read_dir(projects_dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    for entry in entries {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "cutready") {
            match std::fs::read_to_string(&path) {
                Ok(data) => {
                    if let Ok(project) = serde_json::from_str::<Project>(&data) {
                        summaries.push(ProjectSummary::from(&project));
                    }
                }
                Err(_) => continue, // Skip unreadable files
            }
        }
    }

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

/// Delete a project file from disk.
pub fn delete_project(project_id: &str, projects_dir: &Path) -> Result<(), ProjectError> {
    let path = project_file_path(projects_dir, project_id);
    if !path.exists() {
        return Err(ProjectError::NotFound(project_id.to_string()));
    }
    std::fs::remove_file(&path).map_err(|e| ProjectError::Io(e.to_string()))?;
    Ok(())
}

/// Construct the file path for a project.
fn project_file_path(projects_dir: &Path, project_id: &str) -> PathBuf {
    projects_dir.join(format!("{}.cutready", project_id))
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
    fn delete_project_removes_file() {
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
}
