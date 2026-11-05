//! Where a CutReady project keeps its local runtime state (op log, agent
//! state, tabs): inside the git dir, so it never dirties the work tree. Every
//! desktop host resolves it here so the app, CLI and MCP server share one op
//! log per project.

use std::path::{Path, PathBuf};

/// Standalone layout, relative to a folder with its own `.git` directory.
const GIT_STATE_DIR: &str = ".git/cutready";

/// The op log's file name inside a project's state dir.
pub const OP_LOG_FILENAME: &str = "op-log.db";

/// Where a project's local runtime state lives, plus the directory that must
/// contain it (`anchor`), used by containment checks.
pub struct GitStateLocation {
    pub anchor: PathBuf,
    pub dir: PathBuf,
}

/// Resolve the per-project state directory inside the git dir.
/// Standalone single project: `<root>/.git/cutready/`
/// Standalone multi-project: `<root>/.git/cutready/<project-name>/`
/// Hybrid (folder inside a code repo, or a linked worktree):
/// `<gitdir>/cutready/<folder relative to the work tree>/[<project-name>/]`
pub fn git_state_location(repo_root: &Path, project_root: &Path) -> GitStateLocation {
    let (anchor, base) = match enclosing_git_dir(repo_root) {
        Some((git_dir, rel)) => {
            let base = git_dir.join("cutready").join(rel);
            (git_dir, base)
        }
        None => (repo_root.to_path_buf(), repo_root.join(GIT_STATE_DIR)),
    };
    let dir = if repo_root == project_root {
        base
    } else if let Ok(rel) = project_root.strip_prefix(repo_root) {
        base.join(rel)
    } else {
        base
    };
    GitStateLocation { anchor, dir }
}

pub fn git_state_dir(repo_root: &Path, project_root: &Path) -> PathBuf {
    git_state_location(repo_root, project_root).dir
}

/// The canonical git work-tree root when `root` is a CutReady folder inside a
/// larger repository (a hybrid project). `None` for standalone projects, including
/// linked-worktree roots, whose folder is the work-tree root itself.
pub fn hybrid_git_root(root: &Path) -> Option<PathBuf> {
    let (_, rel) = enclosing_git_dir(root)?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    // Walk up from the caller's path (not the canonical one) so the result keeps
    // the same spelling as `root` and Windows `\\?\` prefixes never reach the UI.
    let mut work_tree = root;
    for _ in rel.components() {
        work_tree = work_tree.parent()?;
    }
    Some(work_tree.to_path_buf())
}

/// Whether `path` is a real git directory, not just a folder named `.git`.
/// A stray `.git` holding only CutReady state (an old bug wrote one into
/// hybrid project folders) has no `HEAD`, so it must not count as a repository.
pub fn is_git_dir(path: &Path) -> bool {
    path.join("HEAD").is_file() && (path.join("objects").is_dir() || path.join("commondir").is_file())
}

/// For a CutReady folder without its own `.git` directory, find the enclosing
/// repository's git dir (per-worktree for linked worktrees) and the folder's path
/// relative to the work tree. `None` keeps the standalone `<root>/.git` layout.
pub fn enclosing_git_dir(repo_root: &Path) -> Option<(PathBuf, PathBuf)> {
    if is_git_dir(&repo_root.join(".git")) {
        return None;
    }
    let repo = git2::Repository::discover(repo_root).ok()?;
    let work_dir = std::fs::canonicalize(repo.workdir()?).ok()?;
    let root = std::fs::canonicalize(repo_root).ok()?;
    let rel = root.strip_prefix(&work_dir).ok()?.to_path_buf();
    let git_dir = std::fs::canonicalize(repo.path()).ok()?;
    Some((git_dir, rel))
}
