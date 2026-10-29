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
    /// Absolute path to the folder CutReady opened (where `.cutready/projects.json` lives).
    pub repo_root: PathBuf,
    /// Git work-tree root that Draftline paths are relative to. Equals `repo_root`
    /// unless the project is a hybrid folder inside a larger code repository.
    #[serde(default)]
    pub git_root: PathBuf,
    /// True when `repo_root` is a folder inside an enclosing code repository.
    #[serde(default)]
    pub hybrid: bool,
    /// Display name (from manifest or derived from folder name).
    pub name: String,
}

/// Git work-tree root for a CutReady folder, and whether it is a hybrid project.
fn git_root_for(repo_root: &std::path::Path) -> (PathBuf, bool) {
    match crate::engine::project::hybrid_git_root(repo_root) {
        Some(git_root) => (git_root, true),
        None => (repo_root.to_path_buf(), false),
    }
}

impl ProjectView {
    pub fn new(root: PathBuf) -> Self {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".into());
        let repo_root = root.clone();
        let (git_root, hybrid) = git_root_for(&repo_root);
        Self {
            root,
            repo_root,
            git_root,
            hybrid,
            name,
        }
    }

    /// Create a project view for a subdirectory within a repo.
    pub fn in_repo(repo_root: PathBuf, project_path: &str, name: String) -> Self {
        let root = repo_root.join(project_path);
        let (git_root, hybrid) = git_root_for(&repo_root);
        Self {
            root,
            repo_root,
            git_root,
            hybrid,
            name,
        }
    }
}

/// A lightweight view of an open repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoView {
    /// Absolute path to the repo root folder.
    pub root: PathBuf,
    /// Git work-tree root that Draftline paths are relative to; see [`ProjectView::git_root`].
    #[serde(default)]
    pub git_root: PathBuf,
    /// True when `root` is a folder inside an enclosing code repository.
    #[serde(default)]
    pub hybrid: bool,
    /// Display name (derived from folder name).
    pub name: String,
}

impl RepoView {
    pub fn new(root: PathBuf) -> Self {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".into());
        let (git_root, hybrid) = git_root_for(&root);
        Self {
            root,
            git_root,
            hybrid,
            name,
        }
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
    /// Absolute path to the repo/project folder.
    pub path: String,
    /// When the project was last opened.
    pub last_opened: DateTime<Utc>,
    /// In multi-project repos, the relative path of the last active project.
    /// None for single-project repos. Used to restore the active project on re-open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_active_project: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_view_from_path() {
        let view = ProjectView::new(PathBuf::from("/home/user/My Demo"));
        assert_eq!(view.name, "My Demo");
        assert_eq!(view.root, PathBuf::from("/home/user/My Demo"));
        assert_eq!(
            view.repo_root, view.root,
            "single-project: repo_root == root"
        );
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
    fn standalone_views_are_not_hybrid() {
        let temp = tempfile::tempdir().unwrap();
        git2::Repository::init(temp.path()).unwrap();
        let project = ProjectView::new(temp.path().to_path_buf());
        assert!(!project.hybrid);
        assert_eq!(project.git_root, project.repo_root);
        let repo = RepoView::new(temp.path().to_path_buf());
        assert!(!repo.hybrid);
        assert_eq!(repo.git_root, repo.root);

        let json = serde_json::to_value(&project).unwrap();
        assert_eq!(json["hybrid"], false);
        assert!(json.get("git_root").is_some());
    }

    #[test]
    fn hybrid_views_point_at_the_code_repository() {
        let temp = tempfile::tempdir().unwrap();
        let code = temp.path().join("contoso-app");
        std::fs::create_dir_all(code.join("cutready/alpha")).unwrap();
        git2::Repository::init(&code).unwrap();
        let folder = code.join("cutready");

        let project = ProjectView::in_repo(folder.clone(), "alpha", "Alpha".into());
        assert!(project.hybrid);
        assert_eq!(project.repo_root, folder);
        assert_eq!(
            project.git_root.canonicalize().unwrap(),
            code.canonicalize().unwrap()
        );
        let repo = RepoView::new(folder);
        assert!(repo.hybrid);
        assert_eq!(
            repo.git_root.canonicalize().unwrap(),
            code.canonicalize().unwrap()
        );
        assert!(!code.join("cutready/.git").exists());
    }

    #[test]
    fn project_manifest_roundtrip() {
        let manifest = ProjectManifest {
            projects: vec![
                ProjectEntry {
                    path: "login".into(),
                    name: "Login Flow".into(),
                    description: None,
                },
                ProjectEntry {
                    path: "onboarding".into(),
                    name: "Onboarding".into(),
                    description: Some("User onboarding demo".into()),
                },
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
            last_active_project: None,
        };
        let json = serde_json::to_string(&rp).unwrap();
        let parsed: RecentProject = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.path, rp.path);
        assert!(parsed.last_active_project.is_none());

        // With last_active_project set
        let rp2 = RecentProject {
            path: "/home/user/demos".into(),
            last_opened: Utc::now(),
            last_active_project: Some("login-flow".into()),
        };
        let json2 = serde_json::to_string(&rp2).unwrap();
        let parsed2: RecentProject = serde_json::from_str(&json2).unwrap();
        assert_eq!(parsed2.last_active_project, Some("login-flow".into()));

        // Backward compat: old JSON without the field still parses
        let old_json = r#"{"path":"/old","last_opened":"2025-01-01T00:00:00Z"}"#;
        let old: RecentProject = serde_json::from_str(old_json).unwrap();
        assert!(old.last_active_project.is_none());
    }
}
