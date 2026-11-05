//! Repair for hybrid folders an old bug left holding a stray `.git`.
//!
//! Debug builds once wrote Prompty traces to `<CutReady folder>/.git`. Git
//! treats any folder with a `.git` as a nested repository, so the enclosing
//! repository stopped reporting the folder's files and saves found nothing.

use std::path::{Path, PathBuf};

use cutready_desktop_io::state_dir::enclosing_git_dir;

use super::project::{folder_state_dir, remove_empty_dirs, ProjectError};

/// Repair a folder inside a repository that an old bug left holding a stray
/// `.git` directory (no `HEAD`, only CutReady state). Git treats a folder with
/// a `.git` as a nested repository and stops reporting its files, so the stray
/// directory hides every change. Its state moves to where it belongs inside
/// the enclosing git dir; an entry whose target already exists is kept beside
/// it as `<name>.recovered-<timestamp>`, so nothing is lost. Returns whether
/// the folder was repaired. Leaves anything it does not recognize untouched.
pub fn recover_stray_git_dir(root: &Path) -> Result<bool, ProjectError> {
    let stray = root.join(".git");
    if !stray.is_dir() || cutready_desktop_io::state_dir::is_git_dir(&stray) {
        return Ok(false);
    }
    let Some((git_dir, folder)) = enclosing_git_dir(root) else {
        return Ok(false);
    };
    let io = |e: std::io::Error| ProjectError::Io(e.to_string());
    let only_state = std::fs::read_dir(&stray)
        .map_err(io)?
        .filter_map(Result::ok)
        .all(|entry| entry.file_name() == "cutready");
    if !only_state {
        return Ok(false);
    }

    let source = stray.join("cutready");
    let target = folder_state_dir(&git_dir, &folder);
    if source.is_dir() {
        let created_target = !target.exists();
        std::fs::create_dir_all(&target).map_err(io)?;
        let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
        let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
        let result = (|| -> std::io::Result<()> {
            for entry in std::fs::read_dir(&source)? {
                let entry = entry?;
                let name = entry.file_name();
                let mut dest = target.join(&name);
                if dest.exists() {
                    dest = target.join(format!("{}.recovered-{stamp}", name.to_string_lossy()));
                }
                std::fs::rename(entry.path(), &dest)?;
                moved.push((entry.path(), dest));
            }
            std::fs::remove_dir(&source)
        })();
        if let Err(err) = result {
            // All or nothing: a half-moved state would leave history split.
            for (src, dest) in moved.into_iter().rev() {
                let _ = std::fs::rename(dest, src);
            }
            if created_target {
                remove_empty_dirs(Some(&target), Some(&git_dir));
            }
            return Err(io(err));
        }
    }
    std::fs::remove_dir(&stray).map_err(io)?;
    Ok(true)
}

/// Run [`recover_stray_git_dir`] before a folder opens. Opening anyway after a
/// failed repair would split history between two state folders and keep git
/// blind to the folder's changes, so a failure refuses the open.
pub fn repair_before_open(root: &Path) -> Result<(), ProjectError> {
    match recover_stray_git_dir(root) {
        Ok(repaired) => {
            if repaired {
                log::warn!(
                    "[project] moved stray .git state out of {} into the enclosing repository",
                    root.display()
                );
            }
            Ok(())
        }
        Err(err) => Err(ProjectError::Io(format!(
            "{} holds a leftover .git folder that hides its changes, and CutReady \
             could not move it ({err}). Close other CutReady windows and try again.",
            root.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::project::{
        folder_git_location, git_repository_root, git_state_dir, open_repo_with,
    };

    /// The old Prompty trace bug wrote `<hybrid folder>/.git/cutready/...`.
    fn hybrid_with_stray_git() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let code = tmp.path().join("alaska");
        git2::Repository::init(&code).unwrap();
        let folder = code.join("cutready");
        std::fs::create_dir_all(folder.join("alaska")).unwrap();
        std::fs::write(folder.join("alaska").join("compass.sk"), "{}").unwrap();
        let stray = folder.join(".git").join("cutready");
        std::fs::create_dir_all(stray.join("prompty-traces")).unwrap();
        std::fs::create_dir_all(stray.join("alaska")).unwrap();
        std::fs::write(stray.join("alaska").join("agent-state.db"), "new").unwrap();
        let git_dir = std::fs::canonicalize(code.join(".git")).unwrap();
        (tmp, folder, git_dir)
    }

    fn untracked_paths(repo: &Path) -> Vec<String> {
        let repo = git2::Repository::open(repo).unwrap();
        let mut options = git2::StatusOptions::new();
        options.include_untracked(true).recurse_untracked_dirs(true);
        let paths = repo
            .statuses(Some(&mut options))
            .unwrap()
            .iter()
            .filter_map(|entry| entry.path().ok().map(str::to_string))
            .collect();
        paths
    }

    #[test]
    fn stray_git_dir_is_not_a_repository() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        assert!(!cutready_desktop_io::state_dir::is_git_dir(
            &folder.join(".git")
        ));
        assert_eq!(
            folder_git_location(&folder),
            Some((git_dir.clone(), PathBuf::from("cutready")))
        );
        assert_eq!(
            git_state_dir(&folder, &folder.join("alaska")),
            git_dir.join("cutready").join("cutready").join("alaska")
        );
        assert_eq!(
            git_repository_root(&folder),
            folder.parent().map(Path::to_path_buf)
        );
    }

    #[test]
    fn stray_git_dir_hides_hybrid_changes_until_recovered() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        let code = git_dir.parent().unwrap().to_path_buf();
        // Git treats a folder holding `.git` as a nested repository and lists
        // only the folder itself, never the files inside it.
        let before = untracked_paths(&code);
        assert!(
            !before.iter().any(|path| path.ends_with("compass.sk")),
            "{before:?}"
        );

        assert!(recover_stray_git_dir(&folder).unwrap());
        assert!(!folder.join(".git").exists());
        let after = untracked_paths(&code);
        assert!(
            after.contains(&"cutready/alaska/compass.sk".to_string()),
            "{after:?}"
        );
        let state = git_dir.join("cutready").join("cutready");
        assert_eq!(
            std::fs::read_to_string(state.join("alaska").join("agent-state.db")).unwrap(),
            "new"
        );
        assert!(state.join("prompty-traces").is_dir());
        assert!(!recover_stray_git_dir(&folder).unwrap(), "idempotent");
    }

    #[test]
    fn stray_git_recovery_keeps_both_copies_on_conflict() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        let state = git_dir.join("cutready").join("cutready");
        std::fs::create_dir_all(state.join("alaska")).unwrap();
        std::fs::write(state.join("alaska").join("agent-state.db"), "old").unwrap();

        assert!(recover_stray_git_dir(&folder).unwrap());
        assert_eq!(
            std::fs::read_to_string(state.join("alaska").join("agent-state.db")).unwrap(),
            "old"
        );
        let recovered: Vec<_> = std::fs::read_dir(&state)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("alaska.recovered-"))
            .collect();
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            std::fs::read_to_string(state.join(&recovered[0]).join("agent-state.db")).unwrap(),
            "new"
        );
    }

    #[cfg(windows)]
    #[test]
    fn stray_git_recovery_rolls_back_when_a_file_is_open() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        let stray = folder.join(".git").join("cutready");
        let _open = std::fs::File::open(stray.join("alaska").join("agent-state.db")).unwrap();

        assert!(recover_stray_git_dir(&folder).is_err());
        assert!(stray.join("alaska").join("agent-state.db").exists());
        assert!(stray.join("prompty-traces").is_dir());
        assert!(!git_dir.join("cutready").join("cutready").exists());
        assert!(open_repo_with(&folder, false).is_err());
    }

    #[test]
    fn stray_git_recovery_leaves_unknown_contents_and_real_repos_alone() {
        let (_tmp, folder, _git_dir) = hybrid_with_stray_git();
        std::fs::write(folder.join(".git").join("config"), "").unwrap();
        assert!(!recover_stray_git_dir(&folder).unwrap());
        assert!(folder.join(".git").join("cutready").exists());

        let tmp = tempfile::tempdir().unwrap();
        let outer = tmp.path().join("outer");
        git2::Repository::init(&outer).unwrap();
        let nested = outer.join("nested");
        git2::Repository::init(&nested).unwrap();
        assert!(!recover_stray_git_dir(&nested).unwrap());
        assert!(nested.join(".git").join("HEAD").exists());
    }

    #[test]
    fn opening_a_hybrid_folder_recovers_a_stray_git_dir() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        let _ = open_repo_with(&folder, false);
        assert!(!folder.join(".git").exists());
        assert!(git_dir
            .join("cutready")
            .join("cutready")
            .join("alaska")
            .join("agent-state.db")
            .exists());
    }
}
