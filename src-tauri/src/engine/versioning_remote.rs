//! Remote git operations via libgit2 (git2 crate).
//!
//! Handles fetch, push, pull, remote management, and ahead/behind
//! calculations. Complements the local-only `versioning` module (gix).

use std::path::Path;

use git2::{Cred, FetchOptions, PushOptions, RemoteCallbacks, Repository};

/// Info about a configured remote.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

/// Ahead/behind counts relative to a remote tracking branch.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncStatus {
    /// Local commits not on the remote ("unpublished").
    pub ahead: usize,
    /// Remote commits not yet merged locally ("incoming").
    pub behind: usize,
}

/// Errors from remote operations.
#[derive(Debug, thiserror::Error)]
pub enum RemoteError {
    #[error("Git error: {0}")]
    Git(#[from] git2::Error),
    #[error("{0}")]
    Other(String),
}

// ─── Remote CRUD ────────────────────────────────────────────────

/// Add a named remote to the repository.
pub fn add_remote(project_dir: &Path, name: &str, url: &str) -> Result<(), RemoteError> {
    let repo = Repository::open(project_dir)?;
    repo.remote(name, url)?;
    Ok(())
}

/// Remove a named remote.
pub fn remove_remote(project_dir: &Path, name: &str) -> Result<(), RemoteError> {
    let repo = Repository::open(project_dir)?;
    repo.remote_delete(name)?;
    Ok(())
}

/// List all configured remotes with their URLs.
pub fn list_remotes(project_dir: &Path) -> Result<Vec<RemoteInfo>, RemoteError> {
    let repo = Repository::open(project_dir)?;
    let names = repo.remotes()?;
    let mut out = Vec::new();
    for name in names.iter().flatten() {
        if let Ok(remote) = repo.find_remote(name) {
            out.push(RemoteInfo {
                name: name.to_string(),
                url: remote.url().unwrap_or("").to_string(),
            });
        }
    }
    Ok(out)
}

/// Auto-detect the first configured remote (usually "origin").
pub fn detect_remote(project_dir: &Path) -> Result<Option<RemoteInfo>, RemoteError> {
    let remotes = list_remotes(project_dir)?;
    Ok(remotes.into_iter().next())
}

// ─── Credential helpers ─────────────────────────────────────────

/// Build remote callbacks with credential support.
/// Tries: provided token (for HTTPS), then SSH agent, then git credential helpers.
fn make_callbacks(token: Option<&str>) -> RemoteCallbacks<'_> {
    let mut callbacks = RemoteCallbacks::new();
    let token_owned = token.map(|t| t.to_string());
    let mut ssh_tried = false;
    callbacks.credentials(move |_url, username_from_url, allowed_types| {
        // HTTPS with token (e.g. from `gh auth token`)
        if allowed_types.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
            if let Some(ref tok) = token_owned {
                return Cred::userpass_plaintext("x-access-token", tok);
            }
        }
        // SSH agent
        if allowed_types.contains(git2::CredentialType::SSH_KEY) && !ssh_tried {
            ssh_tried = true;
            let user = username_from_url.unwrap_or("git");
            return Cred::ssh_key_from_agent(user);
        }
        // Default credential helper
        if allowed_types.contains(git2::CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::from_str("no credentials available"))
    });
    callbacks
}

// ─── Fetch ──────────────────────────────────────────────────────

/// Fetch from a named remote.
pub fn fetch_remote(
    project_dir: &Path,
    remote_name: &str,
    token: Option<&str>,
) -> Result<(), RemoteError> {
    let repo = Repository::open(project_dir)?;
    let mut remote = repo.find_remote(remote_name)?;
    let callbacks = make_callbacks(token);
    let mut opts = FetchOptions::new();
    opts.remote_callbacks(callbacks);
    // Fetch all branches
    remote.fetch(&[] as &[&str], Some(&mut opts), None)?;
    Ok(())
}

// ─── Ahead / Behind ─────────────────────────────────────────────

/// Calculate how many commits the local branch is ahead/behind
/// relative to its remote tracking branch.
pub fn get_ahead_behind(
    project_dir: &Path,
    local_branch: &str,
    remote_name: &str,
) -> Result<SyncStatus, RemoteError> {
    let repo = Repository::open(project_dir)?;
    let local_ref = format!("refs/heads/{}", local_branch);
    let remote_ref = format!("refs/remotes/{}/{}", remote_name, local_branch);

    let local_oid = repo
        .refname_to_id(&local_ref)
        .map_err(|_| RemoteError::Other(format!("Local branch '{}' not found", local_branch)))?;
    let remote_oid = match repo.refname_to_id(&remote_ref) {
        Ok(oid) => oid,
        Err(_) => {
            // No remote tracking branch yet — everything is "unpublished"
            // Count commits from local HEAD back to root
            let mut count = 0usize;
            let mut revwalk = repo.revwalk()?;
            revwalk.push(local_oid)?;
            for _ in revwalk {
                count += 1;
            }
            return Ok(SyncStatus {
                ahead: count,
                behind: 0,
            });
        }
    };

    let (ahead, behind) = repo.graph_ahead_behind(local_oid, remote_oid)?;
    Ok(SyncStatus { ahead, behind })
}

// ─── Push ───────────────────────────────────────────────────────

/// Push a local branch to a remote.
pub fn push_remote(
    project_dir: &Path,
    remote_name: &str,
    local_branch: &str,
    token: Option<&str>,
) -> Result<(), RemoteError> {
    let repo = Repository::open(project_dir)?;
    let mut remote = repo.find_remote(remote_name)?;
    let callbacks = make_callbacks(token);
    let mut opts = PushOptions::new();
    opts.remote_callbacks(callbacks);
    let refspec = format!("refs/heads/{}:refs/heads/{}", local_branch, local_branch);
    remote.push(&[&refspec], Some(&mut opts))?;
    Ok(())
}

// ─── Pull (fast-forward merge) ──────────────────────────────────

/// Pull from remote: fetch + fast-forward merge.
/// Returns an error if the merge is not a simple fast-forward.
pub fn pull_remote(
    project_dir: &Path,
    remote_name: &str,
    branch: &str,
    token: Option<&str>,
) -> Result<PullResult, RemoteError> {
    // Step 1: fetch
    fetch_remote(project_dir, remote_name, token)?;

    let repo = Repository::open(project_dir)?;
    let remote_ref = format!("refs/remotes/{}/{}", remote_name, branch);
    let remote_oid = match repo.refname_to_id(&remote_ref) {
        Ok(oid) => oid,
        Err(_) => return Ok(PullResult::UpToDate),
    };

    let local_ref = format!("refs/heads/{}", branch);
    let local_oid = match repo.refname_to_id(&local_ref) {
        Ok(oid) => oid,
        Err(_) => return Err(RemoteError::Other(format!("Local branch '{}' not found", branch))),
    };

    if local_oid == remote_oid {
        return Ok(PullResult::UpToDate);
    }

    // Check if fast-forward is possible
    let can_ff = repo.graph_descendant_of(remote_oid, local_oid)?;
    if !can_ff {
        // Diverged — try three-way merge instead of failing
        let (ahead, behind) = repo.graph_ahead_behind(local_oid, remote_oid)?;

        // Attempt three-way merge using the merge engine
        let merge_result = crate::engine::versioning_merge::merge_timelines(
            project_dir,
            &remote_ref,
            &local_ref,
        );

        match merge_result {
            Ok(crate::engine::versioning_merge::MergeResult::Clean { commit_id }) => {
                return Ok(PullResult::Merged { commits: behind, commit_id });
            }
            Ok(crate::engine::versioning_merge::MergeResult::Conflicts { conflicts }) => {
                return Ok(PullResult::Conflicts {
                    ahead,
                    behind,
                    conflicts,
                });
            }
            Ok(crate::engine::versioning_merge::MergeResult::Nothing) => {
                return Ok(PullResult::UpToDate);
            }
            Ok(crate::engine::versioning_merge::MergeResult::FastForward { .. }) => {
                // Shouldn't happen since we checked, but handle gracefully
                return Ok(PullResult::FastForward { commits: behind });
            }
            Err(_e) => {
                return Ok(PullResult::Diverged { ahead, behind });
            }
        }
    }

    // Fast-forward: move local branch ref + checkout
    let mut local_branch_ref = repo.find_reference(&local_ref)?;
    local_branch_ref.set_target(remote_oid, &format!("pull: fast-forward to {}", &remote_oid.to_string()[..8]))?;
    repo.set_head(&local_ref)?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))?;

    Ok(PullResult::FastForward {
        commits: repo.graph_ahead_behind(remote_oid, local_oid).map(|(a, _)| a).unwrap_or(0),
    })
}

/// Result of a pull operation.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum PullResult {
    /// Already up to date.
    UpToDate,
    /// Fast-forwarded N commits.
    FastForward { commits: usize },
    /// Branches diverged but merge was clean — created merge commit.
    Merged { commits: usize, commit_id: String },
    /// Branches have diverged and merge has conflicts — needs resolution.
    Conflicts {
        ahead: usize,
        behind: usize,
        conflicts: Vec<crate::engine::versioning_merge::ConflictFile>,
    },
    /// Branches have diverged — merge failed (fallback).
    Diverged { ahead: usize, behind: usize },
}

// ─── Remote branches ────────────────────────────────────────────

/// List branches available on the remote (after fetching).
pub fn list_remote_branches(
    project_dir: &Path,
    remote_name: &str,
) -> Result<Vec<String>, RemoteError> {
    let repo = Repository::open(project_dir)?;
    let prefix = format!("refs/remotes/{}/", remote_name);
    let mut branches = Vec::new();
    for reference in repo.references()? {
        let reference = reference?;
        if let Some(name) = reference.name() {
            if name.starts_with(&prefix) && !name.ends_with("/HEAD") {
                let branch_name = name.strip_prefix(&prefix).unwrap_or(name);
                branches.push(branch_name.to_string());
            }
        }
    }
    Ok(branches)
}

// ─── Checkout remote branch ─────────────────────────────────────

/// Check out a remote branch as a new local tracking branch.
pub fn checkout_remote_branch(
    project_dir: &Path,
    remote_name: &str,
    branch: &str,
) -> Result<(), RemoteError> {
    let repo = Repository::open(project_dir)?;
    let remote_ref = format!("refs/remotes/{}/{}", remote_name, branch);
    let remote_oid = repo.refname_to_id(&remote_ref)?;
    let commit = repo.find_commit(remote_oid)?;

    // Create local branch pointing to the same commit
    repo.branch(branch, &commit, false)
        .map_err(|e| RemoteError::Other(format!("Branch '{}' already exists locally: {}", branch, e)))?;

    // Set upstream tracking
    let mut local_branch = repo.find_branch(branch, git2::BranchType::Local)?;
    local_branch.set_upstream(Some(&format!("{}/{}", remote_name, branch)))?;

    // Switch to it
    let local_ref = format!("refs/heads/{}", branch);
    repo.set_head(&local_ref)?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))?;

    Ok(())
}

// ─── Clone from URL ─────────────────────────────────────────────

/// Clone a repository from a URL into the given destination directory.
pub fn clone_from_url(
    url: &str,
    dest: &Path,
    token: Option<&str>,
) -> Result<(), RemoteError> {
    // If no explicit token, try to get one from `gh auth token`
    let gh_token: Option<String> = if token.is_none() {
        std::process::Command::new("gh")
            .args(["auth", "token"])
            .output()
            .ok()
            .and_then(|o| if o.status.success() {
                String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
            } else {
                None
            })
    } else {
        None
    };
    let effective_token: Option<&str> = token.or(gh_token.as_deref());

    let callbacks = make_callbacks(effective_token);
    let mut fetch_opts = FetchOptions::new();
    fetch_opts.remote_callbacks(callbacks);

    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fetch_opts);
    builder.clone(url, dest)?;

    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Create a bare "remote" repo and a local repo with remote configured.
    fn setup_repos() -> (TempDir, TempDir) {
        let remote_dir = TempDir::new().unwrap();
        let local_dir = TempDir::new().unwrap();

        // Init bare remote
        Repository::init_bare(remote_dir.path()).unwrap();

        // Init local repo
        let local_repo = Repository::init(local_dir.path()).unwrap();

        // Set HEAD to main
        let head_path = local_repo.path().join("HEAD");
        fs::write(&head_path, "ref: refs/heads/main\n").unwrap();

        // Add remote — use platform-appropriate file URL
        let remote_url = format!("file:///{}", remote_dir.path().display().to_string().replace('\\', "/"));
        local_repo.remote("origin", &remote_url).unwrap();

        (remote_dir, local_dir)
    }

    /// Make a commit in a repo so it has at least one ref.
    fn make_commit(repo_path: &Path, message: &str) {
        let repo = Repository::open(repo_path).unwrap();
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        let tree_oid = {
            let mut index = repo.index().unwrap();
            // Write a file
            let file_path = repo_path.join("test.txt");
            fs::write(&file_path, format!("content for {}", message)).unwrap();
            index.add_path(Path::new("test.txt")).unwrap();
            index.write().unwrap();
            index.write_tree().unwrap()
        };
        let tree = repo.find_tree(tree_oid).unwrap();

        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("refs/heads/main"), &sig, &sig, message, &tree, &parents).unwrap();
    }

    #[test]
    fn test_add_remove_list_remotes() {
        let dir = TempDir::new().unwrap();
        Repository::init(dir.path()).unwrap();

        // Initially no remotes
        let remotes = list_remotes(dir.path()).unwrap();
        assert!(remotes.is_empty());

        // Add a remote
        add_remote(dir.path(), "origin", "https://github.com/test/repo.git").unwrap();
        let remotes = list_remotes(dir.path()).unwrap();
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].url, "https://github.com/test/repo.git");

        // Verify URL via list_remotes
        let remotes2 = list_remotes(dir.path()).unwrap();
        assert_eq!(remotes2[0].url, "https://github.com/test/repo.git");

        // Remove it
        remove_remote(dir.path(), "origin").unwrap();
        let remotes = list_remotes(dir.path()).unwrap();
        assert!(remotes.is_empty());
    }

    #[test]
    fn test_add_duplicate_remote_fails() {
        let dir = TempDir::new().unwrap();
        Repository::init(dir.path()).unwrap();

        add_remote(dir.path(), "origin", "https://example.com/repo.git").unwrap();
        let result = add_remote(dir.path(), "origin", "https://example.com/other.git");
        assert!(result.is_err());
    }

    #[test]
    fn test_detect_remote() {
        let dir = TempDir::new().unwrap();
        Repository::init(dir.path()).unwrap();

        // No remote
        assert!(detect_remote(dir.path()).unwrap().is_none());

        // Add one
        add_remote(dir.path(), "origin", "https://github.com/user/repo.git").unwrap();
        let detected = detect_remote(dir.path()).unwrap().unwrap();
        assert_eq!(detected.name, "origin");
    }

    #[test]
    fn test_fetch_from_local_bare() {
        let (remote_dir, local_dir) = setup_repos();

        // Make a commit in the local repo and push it to the bare remote
        make_commit(local_dir.path(), "initial");
        push_remote(local_dir.path(), "origin", "main", None).unwrap();

        // Create a second local clone
        let clone_dir = TempDir::new().unwrap();
        let clone_url = format!("file:///{}", remote_dir.path().display().to_string().replace('\\', "/"));
        Repository::clone(&clone_url, clone_dir.path()).unwrap();

        // Make another commit in original and push
        make_commit(local_dir.path(), "second");
        push_remote(local_dir.path(), "origin", "main", None).unwrap();

        // Fetch in clone
        fetch_remote(clone_dir.path(), "origin", None).unwrap();

        // Clone should see 1 incoming
        let status = get_ahead_behind(clone_dir.path(), "main", "origin").unwrap();
        assert_eq!(status.behind, 1);
        assert_eq!(status.ahead, 0);
    }

    #[test]
    fn test_ahead_behind_no_remote_tracking() {
        let (_remote_dir, local_dir) = setup_repos();
        make_commit(local_dir.path(), "first");
        make_commit(local_dir.path(), "second");

        // No push yet — everything is unpublished
        let status = get_ahead_behind(local_dir.path(), "main", "origin").unwrap();
        assert_eq!(status.ahead, 2);
        assert_eq!(status.behind, 0);
    }

    #[test]
    fn test_push_and_ahead_behind() {
        let (_remote_dir, local_dir) = setup_repos();
        make_commit(local_dir.path(), "first");

        // Push
        push_remote(local_dir.path(), "origin", "main", None).unwrap();

        // Fetch to update tracking refs
        fetch_remote(local_dir.path(), "origin", None).unwrap();

        // Should be in sync
        let status = get_ahead_behind(local_dir.path(), "main", "origin").unwrap();
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);

        // Make another local commit
        make_commit(local_dir.path(), "second");
        let status = get_ahead_behind(local_dir.path(), "main", "origin").unwrap();
        assert_eq!(status.ahead, 1);
        assert_eq!(status.behind, 0);
    }

    #[test]
    fn test_pull_fast_forward() {
        let (remote_dir, local_dir) = setup_repos();

        // Push initial commit to remote
        make_commit(local_dir.path(), "initial");
        push_remote(local_dir.path(), "origin", "main", None).unwrap();

        // Clone a second copy
        let clone_dir = TempDir::new().unwrap();
        let clone_url = format!("file:///{}", remote_dir.path().display().to_string().replace('\\', "/"));
        Repository::clone(&clone_url, clone_dir.path()).unwrap();

        // Make 2 more commits in original and push
        make_commit(local_dir.path(), "second");
        make_commit(local_dir.path(), "third");
        push_remote(local_dir.path(), "origin", "main", None).unwrap();

        // Pull in clone should fast-forward
        let result = pull_remote(clone_dir.path(), "origin", "main", None).unwrap();
        match result {
            PullResult::FastForward { .. } => {} // expected
            other => panic!("Expected FastForward, got {:?}", other),
        }

        // Should now be up to date
        let status = get_ahead_behind(clone_dir.path(), "main", "origin").unwrap();
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
    }

    #[test]
    fn test_pull_already_up_to_date() {
        let (remote_dir, local_dir) = setup_repos();
        make_commit(local_dir.path(), "initial");
        push_remote(local_dir.path(), "origin", "main", None).unwrap();

        let clone_dir = TempDir::new().unwrap();
        let clone_url = format!("file:///{}", remote_dir.path().display().to_string().replace('\\', "/"));
        Repository::clone(&clone_url, clone_dir.path()).unwrap();

        // Pull with nothing new
        let result = pull_remote(clone_dir.path(), "origin", "main", None).unwrap();
        match result {
            PullResult::UpToDate => {} // expected
            other => panic!("Expected UpToDate, got {:?}", other),
        }
    }

    #[test]
    fn test_list_remote_branches() {
        let (remote_dir, local_dir) = setup_repos();
        make_commit(local_dir.path(), "initial");
        push_remote(local_dir.path(), "origin", "main", None).unwrap();

        // Create and push a second branch
        {
            let repo = Repository::open(local_dir.path()).unwrap();
            let head = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("feature", &head, false).unwrap();
        }
        push_remote(local_dir.path(), "origin", "feature", None).unwrap();

        // Fetch in a clone to get remote tracking branches
        let clone_dir = TempDir::new().unwrap();
        let clone_url = format!("file:///{}", remote_dir.path().display().to_string().replace('\\', "/"));
        Repository::clone(&clone_url, clone_dir.path()).unwrap();

        let branches = list_remote_branches(clone_dir.path(), "origin").unwrap();
        assert!(branches.contains(&"main".to_string()));
        assert!(branches.contains(&"feature".to_string()));
    }
}
