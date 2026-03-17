use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A lightweight view of an open project folder.
///
/// In single-project mode, `root` and `repo_root` are the same path.
/// In multi-project mode, `root` is a subdirectory within `repo_root`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectView {
    /// Absolute path to the project folder (where sketches/notes live).
    pub root: PathBuf,
    /// Absolute path to the repo root (where .git/ lives).
    pub repo_root: PathBuf,
    /// Display name (from manifest or derived from folder name).
    pub name: String,
}

impl ProjectView {
    pub fn new(root: PathBuf) -> Self {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".into());
        let repo_root = root.clone();
        Self { root, repo_root, name }
    }

    /// Create a project view for a subdirectory within a repo.
    pub fn in_repo(repo_root: PathBuf, project_path: &str, name: String) -> Self {
        let root = repo_root.join(project_path);
        Self { root, repo_root, name }
    }
}

/// A lightweight view of an open repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoView {
    /// Absolute path to the repo root folder.
    pub root: PathBuf,
    /// Display name (derived from folder name).
    pub name: String,
}

impl RepoView {
    pub fn new(root: PathBuf) -> Self {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".into());
        Self { root, name }
    }
}

/// A project entry in the repo manifest (`.cutready/projects.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    /// Relative path from repo root to project folder.
    pub path: String,
    /// Display name.
    pub name: String,
    /// Optional description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The project manifest listing all projects in a multi-project repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectManifest {
    pub projects: Vec<ProjectEntry>,
}

/// Entry in the recent projects list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentProject {
    /// Absolute path to the project folder.
    pub path: String,
    /// When the project was last opened.
    pub last_opened: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_view_from_path() {
        let view = ProjectView::new(PathBuf::from("/home/user/My Demo"));
        assert_eq!(view.name, "My Demo");
        assert_eq!(view.root, PathBuf::from("/home/user/My Demo"));
        assert_eq!(view.repo_root, view.root, "single-project: repo_root == root");
    }

    #[test]
    fn project_view_in_repo() {
        let view = ProjectView::in_repo(
            PathBuf::from("/repos/my-demos"),
            "login-flow",
            "Login Flow".into(),
        );
        assert_eq!(view.root, PathBuf::from("/repos/my-demos/login-flow"));
        assert_eq!(view.repo_root, PathBuf::from("/repos/my-demos"));
        assert_eq!(view.name, "Login Flow");
    }

    #[test]
    fn project_view_roundtrip() {
        let view = ProjectView::new(PathBuf::from("/projects/demo"));
        let json = serde_json::to_string(&view).unwrap();
        let parsed: ProjectView = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "demo");
        assert_eq!(parsed.repo_root, parsed.root);
    }

    #[test]
    fn repo_view_from_path() {
        let view = RepoView::new(PathBuf::from("/home/user/demos"));
        assert_eq!(view.name, "demos");
    }

    #[test]
    fn project_manifest_roundtrip() {
        let manifest = ProjectManifest {
            projects: vec![
                ProjectEntry { path: "login".into(), name: "Login Flow".into(), description: None },
                ProjectEntry { path: "onboarding".into(), name: "Onboarding".into(), description: Some("User onboarding demo".into()) },
            ],
        };
        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let parsed: ProjectManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.projects.len(), 2);
        assert_eq!(parsed.projects[0].path, "login");
        assert!(parsed.projects[1].description.is_some());
    }

    #[test]
    fn recent_project_roundtrip() {
        let rp = RecentProject {
            path: "/home/user/demo".into(),
            last_opened: Utc::now(),
        };
        let json = serde_json::to_string(&rp).unwrap();
        let parsed: RecentProject = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.path, rp.path);
    }
}
