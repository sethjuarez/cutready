//! Starting a project in a code repository: what a failed clone means for the
//! user, and whether a checkout skipped old file contents.
//!
//! Draftline does the clone (`clone_repository`, which never claims the
//! checkout) and creates the project folder (`init_project_in_repository`);
//! this module only interprets the results for CutReady's UI.

use std::path::Path;

use draftline::DraftlineError;

/// Why talking to a remote failed, when Draftline reports it as a Git error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteFailure {
    /// The remote rejected the credentials, or none were available.
    Auth,
    /// The remote couldn't be reached.
    Network,
}

impl RemoteFailure {
    /// The error code the UI branches on.
    pub fn code(self) -> &'static str {
        match self {
            Self::Auth => "auth_failed",
            Self::Network => "network_failed",
        }
    }
}

/// Whether `error` came from signing in to, or reaching, a remote.
pub fn remote_failure(error: &DraftlineError) -> Option<RemoteFailure> {
    match error {
        DraftlineError::Git(error) => git_remote_failure(error),
        DraftlineError::RemoteOperationTimedOut { .. } => Some(RemoteFailure::Network),
        _ => None,
    }
}

fn git_remote_failure(error: &git2::Error) -> Option<RemoteFailure> {
    let lower = error.message().to_ascii_lowercase();
    if error.code() == git2::ErrorCode::Auth
        || error.class() == git2::ErrorClass::Ssh
        || lower.contains("authentication")
        || lower.contains("credential")
        || lower.contains("401")
        || lower.contains("403")
    {
        Some(RemoteFailure::Auth)
    } else if matches!(
        error.class(),
        git2::ErrorClass::Net | git2::ErrorClass::Http | git2::ErrorClass::Ssl
    ) || lower.contains("resolve")
        || lower.contains("timed out")
    {
        Some(RemoteFailure::Network)
    } else {
        None
    }
}

/// True when the checkout at `root` is a partial (blobless) clone: Git fetches
/// old file contents on demand, which CutReady's history views can't do.
pub fn is_partial_clone(root: &Path) -> bool {
    let Ok(repository) = git2::Repository::open(root) else {
        return false;
    };
    let Ok(config) = repository
        .config()
        .and_then(|config| config.open_level(git2::ConfigLevel::Local))
    else {
        return false;
    };
    if config.get_string("extensions.partialclone").is_ok() {
        return true;
    }
    let Ok(remotes) = repository.remotes() else {
        return false;
    };
    let promisor = remotes.iter().filter_map(|remote| remote.ok().flatten()).any(|remote| {
        config
            .get_bool(&format!("remote.{remote}.promisor"))
            .unwrap_or(false)
    });
    promisor
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(code: git2::ErrorCode, class: git2::ErrorClass, message: &str) -> DraftlineError {
        DraftlineError::Git(git2::Error::new(code, class, message))
    }

    #[test]
    fn remote_failures_map_to_stable_codes() {
        use git2::{ErrorClass, ErrorCode};
        let auth = git(ErrorCode::Auth, ErrorClass::Http, "denied");
        assert_eq!(remote_failure(&auth), Some(RemoteFailure::Auth));
        assert_eq!(RemoteFailure::Auth.code(), "auth_failed");
        let net = git(
            ErrorCode::GenericError,
            ErrorClass::Net,
            "failed to resolve address",
        );
        assert_eq!(remote_failure(&net), Some(RemoteFailure::Network));
        assert_eq!(RemoteFailure::Network.code(), "network_failed");
        let timeout = DraftlineError::RemoteOperationTimedOut {
            operation: "clone".into(),
            timeout_ms: 1,
        };
        assert_eq!(remote_failure(&timeout), Some(RemoteFailure::Network));
        let filter = git(ErrorCode::GenericError, ErrorClass::Filter, "smudge failed");
        assert_eq!(remote_failure(&filter), None);
        let folder = DraftlineError::FolderNotEmpty("x".into());
        assert_eq!(remote_failure(&folder), None);
    }

    #[test]
    fn partial_clones_are_recognized_from_local_config() {
        let temp = tempfile::tempdir().unwrap();
        let repository = git2::Repository::init(temp.path()).unwrap();
        assert!(!is_partial_clone(temp.path()));
        repository
            .remote("origin", "https://example.com/o/r.git")
            .unwrap();
        assert!(!is_partial_clone(temp.path()));
        repository
            .config()
            .unwrap()
            .set_bool("remote.origin.promisor", true)
            .unwrap();
        assert!(is_partial_clone(temp.path()));
        assert!(!is_partial_clone(&temp.path().join("missing")));
    }
}
