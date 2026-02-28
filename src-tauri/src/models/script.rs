use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A lightweight view of an open project folder.
///
/// Projects are folders on disk — there is no central registry.
/// Sketches (`.sk`) and storyboards (`.sb`) are discovered by scanning the folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectView {
    /// Absolute path to the project folder.
    pub root: PathBuf,
    /// Display name (derived from folder name).
    pub name: String,
}

impl ProjectView {
    pub fn new(root: PathBuf) -> Self {
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".into());
        Self { root, name }
    }
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
    }

    #[test]
    fn project_view_roundtrip() {
        let view = ProjectView::new(PathBuf::from("/projects/demo"));
        let json = serde_json::to_string(&view).unwrap();
        let parsed: ProjectView = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "demo");
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
