//! Commands that download a repository to start or open a CutReady project.

use std::path::{Path, PathBuf};

use cutready_contracts::model::{CmdErrorCode, CmdErrorDetails};
use tauri_plugin_auditaur::auditaur_command;

use crate::commands::draftline::reject_remote_url_credentials;
use crate::commands::github::github_credential_token;
use crate::commands::CmdError;
use crate::engine::draftline_adapter::repo_clone::{
    clone_repository, ClonedRepository, RepoCloneError,
};
use crate::engine::draftline_adapter::{
    cutready_remote_options, is_github_remote_url, CutReadyDraftlineAdapter,
};

/// The GitHub token to offer `url`'s remote, when it is a GitHub remote.
fn github_token_for(url: &str) -> Option<String> {
    let credential = is_github_remote_url(url)
        .then(github_credential_token)
        .flatten()?;
    tracing::debug!(
        source = credential.source,
        "Using GitHub token credential for clone"
    );
    Some(credential.token)
}

/// Clones `url` into `dest` as a CutReady project and returns the folder
/// Draftline opened: the marker's folder for a hybrid repository, `dest`
/// otherwise. Open that folder, not `dest`.
#[auditaur_command(skip_all, err)]
pub async fn clone_from_url(url: String, dest: String) -> Result<String, CmdError> {
    reject_remote_url_credentials(&url)?;
    let token = github_token_for(&url);
    tauri::async_runtime::spawn_blocking(move || {
        let mut options = cutready_remote_options(token);
        CutReadyDraftlineAdapter::clone_project_with_options(
            &url,
            PathBuf::from(&dest),
            &mut options,
        )
        .map(|adapter| opened_folder(&adapter))
    })
    .await
    .map_err(|error| CmdError::failed(error.to_string()))?
    .map_err(|error| CmdError::failed(error.to_string()))
}

fn opened_folder(adapter: &CutReadyDraftlineAdapter) -> String {
    adapter
        .root()
        .join(adapter.scope())
        .to_string_lossy()
        .into_owned()
}

/// Downloads `url` into `dest` without starting a project, so the caller can
/// create a CutReady folder inside it. Reports the folder an existing
/// `.draftline` marker manages, which the caller should open instead.
#[auditaur_command(skip_all, err)]
pub async fn clone_repository_for_project(
    url: String,
    dest: String,
) -> Result<ClonedRepository, CmdError> {
    reject_remote_url_credentials(&url)?;
    let token = github_token_for(&url);
    let dest = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || clone_repository(&url, &dest, token))
        .await
        .map_err(|error| CmdError::failed(error.to_string()))?
        .map_err(clone_error)
}

fn clone_error(error: RepoCloneError) -> CmdError {
    let path = match &error {
        RepoCloneError::DestinationNotEmpty(path) => Some(display(path)),
        _ => None,
    };
    CmdError {
        code: CmdErrorCode::Other(error.code().to_string()),
        message: error.to_string(),
        details: path.map(|path| CmdErrorDetails {
            path: Some(path),
            ..Default::default()
        }),
    }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The path of a new CutReady folder `name` directly inside the checkout at
/// `root`. Refuses with `file_exists` when it is already there, so a new
/// project never takes over a folder of code.
#[auditaur_command(skip_all, err)]
pub fn reserve_project_folder(root: String, name: String) -> Result<String, CmdError> {
    reserve_folder(Path::new(&root), &name)
}

fn reserve_folder(root: &Path, name: &str) -> Result<String, CmdError> {
    let folder = new_folder_path(root, name)?;
    if folder.exists() {
        return Err(CmdError::file_exists(&display(&folder)));
    }
    Ok(display(&folder))
}

fn new_folder_path(root: &Path, name: &str) -> Result<PathBuf, CmdError> {
    let name = name.trim();
    if !is_plain_folder_name(name) {
        return Err(CmdError::failed(format!(
            "\"{name}\" can't be used as a folder name"
        )));
    }
    Ok(root.join(name))
}

/// A single folder name that works on every OS and isn't one CutReady or Git owns.
fn is_plain_folder_name(name: &str) -> bool {
    const RESERVED: [&str; 5] = [".", "..", ".git", ".cutready", ".draftline"];
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or_default();
    let windows_device = matches!(stem, "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    !name.is_empty()
        && !RESERVED.contains(&lower.as_str())
        && !windows_device
        && !name.ends_with(['.', ' '])
        && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        && !name.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_errors_keep_their_codes() {
        let error = clone_error(RepoCloneError::DestinationNotEmpty(PathBuf::from("x")));
        assert_eq!(
            error.code,
            CmdErrorCode::Other("destination_not_empty".into())
        );
        assert_eq!(error.details.unwrap().path.as_deref(), Some("x"));
        let auth = clone_error(RepoCloneError::AuthFailed("denied".into()));
        assert_eq!(auth.code, CmdErrorCode::Other("auth_failed".into()));
        assert!(auth.message.contains("denied"));
    }

    #[test]
    fn reserved_folders_must_be_new_plain_names() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let path = reserve_folder(root, "demo").unwrap();
        assert_eq!(PathBuf::from(path), temp.path().join("demo"));

        std::fs::create_dir(temp.path().join("src")).unwrap();
        let taken = reserve_folder(root, "src").unwrap_err();
        assert_eq!(taken.code, CmdErrorCode::FileExists);

        for bad in [
            "", "..", ".git", "a/b", "a\\b", "c:", "demo.", "CON", "nul.txt", "com1", "LPT9.md",
            "a?b",
        ] {
            assert!(reserve_folder(root, bad).is_err(), "{bad}");
        }
        for good in ["console", "com0", "my.demo", "lpt"] {
            assert!(reserve_folder(root, good).is_ok(), "{good}");
        }
    }
}
