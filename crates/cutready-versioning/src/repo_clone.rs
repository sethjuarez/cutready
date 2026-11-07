//! Clones a code repository without letting Draftline claim it.
//!
//! Draftline 0.13's clone claims the checkout: a repository without a
//! `.draftline` marker gets its root claimed, so a CutReady folder can't be
//! started inside it afterwards. "New in existing repo" needs the plain
//! checkout, so this clones with git2 and only reads the marker.
//!
//! Seam: replace with Draftline's non-claiming clone / `inspect_repository`
//! once they ship, keeping [`ClonedRepository`] as the result shape.

use std::fmt;
use std::path::{Path, PathBuf};

use draftline::{FolderState, Workspace};
use serde::Serialize;

use crate::{is_github_remote_url, CUTREADY_VARIATION_NAMESPACE};

/// libgit2 asks again after a rejected credential; stop before it loops.
const MAX_CREDENTIAL_ATTEMPTS: usize = 3;

/// A fresh checkout and the CutReady folder its marker names, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClonedRepository {
    pub root: PathBuf,
    /// The folder a committed `.draftline` marker manages, created when the
    /// marker names a folder the checkout doesn't have yet.
    pub managed_folder: Option<PathBuf>,
}

/// Why a clone failed, with a stable code the UI branches on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepoCloneError {
    /// The destination already exists and isn't empty.
    DestinationNotEmpty(PathBuf),
    /// The remote rejected the credentials, or none were available.
    AuthFailed(String),
    /// The remote couldn't be reached.
    NetworkFailed(String),
    /// The repository's `.draftline` marker can't be read by this version.
    InvalidMarker(String),
    Failed(String),
}

impl RepoCloneError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::DestinationNotEmpty(_) => "destination_not_empty",
            Self::AuthFailed(_) => "auth_failed",
            Self::NetworkFailed(_) => "network_failed",
            Self::InvalidMarker(_) => "invalid_marker",
            Self::Failed(_) => "clone_failed",
        }
    }

    fn from_git(error: &git2::Error) -> Self {
        let message = error.message().to_string();
        let lower = message.to_ascii_lowercase();
        if error.code() == git2::ErrorCode::Auth
            || error.class() == git2::ErrorClass::Ssh
            || lower.contains("authentication")
            || lower.contains("credential")
            || lower.contains("401")
            || lower.contains("403")
        {
            Self::AuthFailed(message)
        } else if matches!(
            error.class(),
            git2::ErrorClass::Net | git2::ErrorClass::Http | git2::ErrorClass::Ssl
        ) || lower.contains("resolve")
            || lower.contains("timed out")
        {
            Self::NetworkFailed(message)
        } else {
            Self::Failed(message)
        }
    }
}

impl fmt::Display for RepoCloneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DestinationNotEmpty(path) => {
                write!(f, "{} already exists and isn't empty", path.display())
            }
            Self::AuthFailed(message) => write!(f, "Couldn't sign in to the remote: {message}"),
            Self::NetworkFailed(message) => write!(f, "Couldn't reach the remote: {message}"),
            Self::InvalidMarker(message) => write!(f, "{message}"),
            Self::Failed(message) => write!(f, "Couldn't download the repository: {message}"),
        }
    }
}

impl std::error::Error for RepoCloneError {}

/// Clone `url` into `dest` with plain git, then read its `.draftline` marker.
/// Credentials mirror [`crate::cutready_remote_options`].
pub fn clone_repository(
    url: &str,
    dest: &Path,
    github_token: Option<String>,
) -> Result<ClonedRepository, RepoCloneError> {
    if dest
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
    {
        return Err(RepoCloneError::DestinationNotEmpty(dest.to_path_buf()));
    }
    let existed = dest.exists();
    let result = clone_into(url, dest, github_token).and_then(|()| managed_folder(dest));
    match result {
        Ok(managed_folder) => Ok(ClonedRepository {
            root: dest.to_path_buf(),
            managed_folder,
        }),
        Err(error) => {
            // Leave the destination as it was so trying again doesn't find it non-empty.
            discard_partial_clone(dest, existed);
            Err(error)
        }
    }
}

fn discard_partial_clone(dest: &Path, existed: bool) {
    if !existed {
        let _ = std::fs::remove_dir_all(dest);
        return;
    }
    for entry in dest.read_dir().into_iter().flatten().flatten() {
        let path = entry.path();
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}

fn clone_into(url: &str, dest: &Path, github_token: Option<String>) -> Result<(), RepoCloneError> {
    let mut attempts = 0;
    let mut callbacks = git2::RemoteCallbacks::new();
    callbacks.credentials(move |url, username_from_url, allowed| {
        attempts += 1;
        if attempts > MAX_CREDENTIAL_ATTEMPTS {
            return Err(git2::Error::new(
                git2::ErrorCode::Auth,
                git2::ErrorClass::Net,
                "authentication failed",
            ));
        }
        if let Some(token) = github_token.as_ref() {
            if allowed.contains(git2::CredentialType::USER_PASS_PLAINTEXT)
                && is_github_remote_url(url)
            {
                return git2::Cred::userpass_plaintext("x-access-token", token);
            }
        }
        if allowed.contains(git2::CredentialType::SSH_KEY) {
            return git2::Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"));
        }
        git2::Cred::default()
    });
    let mut fetch = git2::FetchOptions::new();
    fetch.remote_callbacks(callbacks);
    git2::build::RepoBuilder::new()
        .fetch_options(fetch)
        .clone(url, dest)
        .map(|_| ())
        .map_err(|error| RepoCloneError::from_git(&error))
}

/// The folder the checkout's committed marker names, created if missing.
fn managed_folder(root: &Path) -> Result<Option<PathBuf>, RepoCloneError> {
    let probe = Workspace::probe_with_namespace(root, CUTREADY_VARIATION_NAMESPACE)
        .map_err(|error| RepoCloneError::Failed(error.to_string()))?;
    match probe.state {
        FolderState::Ready | FolderState::ManagedElsewhere | FolderState::FolderMissing => {
            let Some(folder) = probe.folder else {
                return Ok(None);
            };
            let path = root.join(folder);
            std::fs::create_dir_all(&path)
                .map_err(|error| RepoCloneError::Failed(error.to_string()))?;
            Ok(Some(path))
        }
        FolderState::InvalidMarker | FolderState::NewerFormat => Err(
            RepoCloneError::InvalidMarker(probe.detail.unwrap_or_else(|| {
                "This repository's CutReady marker can't be read by this version of CutReady"
                    .to_string()
            })),
        ),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CutReadyDraftlineAdapter;

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// A developer's code repository on `main`, optionally with a saved
    /// CutReady folder at `cutready/` (which commits the root marker).
    fn code_repo(temp: &Path, with_cutready_folder: bool) -> PathBuf {
        let dev = temp.join("dev");
        let mut options = git2::RepositoryInitOptions::new();
        options.initial_head("main");
        let repo = git2::Repository::init_opts(&dev, &options).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Dev").unwrap();
            config.set_str("user.email", "dev@example.com").unwrap();
        }
        write(&dev.join("README.md"), "# Contoso\n");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        index.write().unwrap();
        let signature = git2::Signature::now("Dev", "dev@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "Initial", &tree, &[])
            .unwrap();
        if with_cutready_folder {
            write(&dev.join("cutready/intro.sk"), r#"{"title":"Intro"}"#);
            let adapter = CutReadyDraftlineAdapter::open_project(dev.join("cutready")).unwrap();
            adapter.save_version("Add CutReady").unwrap();
        }
        dev
    }

    fn url(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn clone_of_marked_repo_reports_the_marker_folder() {
        let temp = tempfile::tempdir().unwrap();
        let dev = code_repo(temp.path(), true);
        let dest = temp.path().join("clone");

        let cloned = clone_repository(&url(&dev), &dest, None).unwrap();

        assert_eq!(cloned.root, dest);
        assert_eq!(cloned.managed_folder, Some(dest.join("cutready")));
        let adapter = CutReadyDraftlineAdapter::open_project(dest.join("cutready")).unwrap();
        assert_eq!(adapter.scope(), Path::new("cutready"));
    }

    #[test]
    fn clone_of_unmarked_repo_leaves_room_for_a_hybrid_folder() {
        let temp = tempfile::tempdir().unwrap();
        let dev = code_repo(temp.path(), false);
        let dest = temp.path().join("clone");

        let cloned = clone_repository(&url(&dev), &dest, None).unwrap();

        assert_eq!(cloned.managed_folder, None);
        assert!(!dest.join(".draftline").exists());
        let folder = dest.join("demo");
        std::fs::create_dir_all(&folder).unwrap();
        let adapter = CutReadyDraftlineAdapter::open_project(&folder).unwrap();
        assert!(adapter.is_hybrid());
        assert_eq!(adapter.scope(), Path::new("demo"));
    }

    #[test]
    fn clone_refuses_a_non_empty_destination() {
        let temp = tempfile::tempdir().unwrap();
        let dev = code_repo(temp.path(), false);
        let dest = temp.path().join("clone");
        write(&dest.join("keep.txt"), "mine");

        let error = clone_repository(&url(&dev), &dest, None).unwrap_err();

        assert_eq!(error.code(), "destination_not_empty");
        assert_eq!(
            std::fs::read_to_string(dest.join("keep.txt")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn clone_of_missing_repo_fails_without_leaving_a_claim() {
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("clone");

        let error = clone_repository(&url(&temp.path().join("nope")), &dest, None).unwrap_err();

        assert!(!error.to_string().is_empty());
        assert!(!dest.exists());
    }

    #[test]
    fn a_failed_clone_leaves_the_destination_ready_to_try_again() {
        let temp = tempfile::tempdir().unwrap();
        let dev = code_repo(temp.path(), false);
        write(&dev.join(".draftline"), "not a marker");
        let repo = git2::Repository::open(&dev).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(".draftline")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Dev", "dev@example.com").unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "Bad marker",
            &tree,
            &[&parent],
        )
        .unwrap();
        let dest = temp.path().join("clone");
        std::fs::create_dir(&dest).unwrap();

        let error = clone_repository(&url(&dev), &dest, None).unwrap_err();

        assert_eq!(error.code(), "invalid_marker");
        assert!(dest.is_dir(), "a folder the user chose stays");
        assert_eq!(dest.read_dir().unwrap().count(), 0);
        let good = code_repo(&temp.path().join("good"), false);
        assert!(clone_repository(&url(&good), &dest, None).is_ok());
    }

    #[test]
    fn git_errors_map_to_stable_codes() {
        let auth = git2::Error::new(git2::ErrorCode::Auth, git2::ErrorClass::Http, "denied");
        assert_eq!(RepoCloneError::from_git(&auth).code(), "auth_failed");
        let net = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Net,
            "failed to resolve address",
        );
        assert_eq!(RepoCloneError::from_git(&net).code(), "network_failed");
        let other = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Filter,
            "smudge failed",
        );
        assert_eq!(RepoCloneError::from_git(&other).code(), "clone_failed");
    }
}
