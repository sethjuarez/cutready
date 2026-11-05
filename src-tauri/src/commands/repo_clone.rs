//! Commands that download a repository to start or open a CutReady project.

use std::path::PathBuf;

use draftline::tauri_contract as contract;
use draftline::{ClonedRepository, DraftlineError};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri_plugin_auditaur::auditaur_command;

use crate::commands::draftline::{reject_remote_url_credentials, resolve_remote_credential};
use crate::commands::github::github_credential_token;
use crate::commands::CmdError;
use crate::engine::draftline_adapter::repository::{is_partial_clone, remote_failure};
use crate::engine::draftline_adapter::{
    cutready_content_policy, cutready_remote_options, is_github_remote_url,
    CutReadyDraftlineAdapter, CUTREADY_VARIATION_NAMESPACE,
};

/// The GitHub token to offer `url`'s remote, when it is a GitHub remote.
pub(crate) fn github_token_for(url: &str) -> Option<String> {
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

/// A finished clone, and whether Git skipped old file contents.
#[derive(Debug, Serialize)]
pub struct ClonedRepositoryResult {
    #[serde(flatten)]
    pub repository: ClonedRepository,
    pub is_partial_clone: bool,
}

/// Downloads `url` into `dest` without starting a project, so the caller can
/// create a CutReady folder inside it. `project_path` is set when the
/// repository already has a project, which the caller should open instead.
#[auditaur_command(skip_all)]
pub async fn clone_repository_for_project(
    url: String,
    dest: String,
    branch: Option<String>,
    blobless: bool,
    on_progress: Channel<contract::CloneProgressEvent>,
) -> contract::TauriCommandResult<ClonedRepositoryResult> {
    reject_remote_url_credentials(&url).map_err(|message| failed("invalid_remote_url", message))?;
    let dest = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || {
        let mut context = repository_context()?.with_clone_progress_sink(move |event| {
            let _ = on_progress.send(event);
        });
        let repository = contract::clone_repository_with_context(
            &mut context,
            contract::CloneRepositoryRequest {
                remote_url: url,
                workspace_path: dest.clone(),
                branch: branch.filter(|branch| !branch.trim().is_empty()),
                progress_id: None,
                blobless,
            },
        )
        .map_err(|error| repository_error(error, &dest))?;
        let is_partial_clone = repository
            .inspection
            .root
            .as_deref()
            .is_some_and(is_partial_clone);
        Ok(ClonedRepositoryResult {
            repository,
            is_partial_clone,
        })
    })
    .await
    .map_err(|error| failed("failed", error.to_string()))?
}

/// Creates the CutReady folder `name` inside `parent` (a folder in a Git
/// checkout) and records it in the repository's `.draftline` marker. Nothing
/// is committed. Open the returned `workspace_path`.
#[auditaur_command(skip_all)]
pub async fn init_project_in_repository_for_project(
    parent: String,
    name: String,
    base_branch: Option<String>,
) -> contract::TauriCommandResult<contract::InitProjectInRepositoryResult> {
    let parent = PathBuf::from(parent);
    tauri::async_runtime::spawn_blocking(move || {
        let mut context = repository_context()?;
        contract::init_project_in_repository_with_context(
            &mut context,
            contract::InitProjectInRepositoryRequest {
                parent_path: parent.clone(),
                name,
                base_branch: base_branch.filter(|branch| !branch.trim().is_empty()),
                commit_template: None,
            },
        )
        .map_err(|error| repository_error(error, &parent))
    })
    .await
    .map_err(|error| failed("failed", error.to_string()))?
}

/// Policy and credentials for working with a repository CutReady doesn't
/// manage yet. Variations stay under `cutready/`, as in every hybrid project.
fn repository_context(
) -> contract::TauriCommandResult<contract::DraftlineCommandContext<'static>> {
    let policy = cutready_content_policy().map_err(|error| failed("failed", error.to_string()))?;
    contract::DraftlineCommandContext::new()
        .with_content_policy(policy)
        .with_credentials(resolve_remote_credential)
        .with_variation_namespace(CUTREADY_VARIATION_NAMESPACE)
        .map_err(contract::TauriCommandError::from)
}

/// Draftline's error, with a code the UI can explain for failed sign-ins and
/// unreachable remotes, and the folder for `folder_not_empty`.
fn repository_error(error: DraftlineError, folder: &std::path::Path) -> contract::TauriCommandError {
    let failure = remote_failure(&error);
    let folder_not_empty = match &error {
        DraftlineError::FolderNotEmpty(path) => Some(path.clone()),
        _ => None,
    };
    let mut command_error = contract::TauriCommandError::from(error);
    if let Some(failure) = failure {
        command_error.code = failure.code().to_string();
    }
    if let Some(path) = folder_not_empty {
        let path = if path.as_os_str().is_empty() {
            folder.to_path_buf()
        } else {
            path
        };
        command_error.details = Some(serde_json::json!({ "path": path }));
    }
    command_error
}

fn failed(code: &str, message: impl Into<String>) -> contract::TauriCommandError {
    contract::TauriCommandError {
        code: code.to_string(),
        message: message.into(),
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_errors_keep_codes_ui_can_explain() {
        let folder = std::path::Path::new("dest");
        let busy = repository_error(DraftlineError::FolderNotEmpty("dest/demo".into()), folder);
        assert_eq!(busy.code, "folder_not_empty");
        assert_eq!(busy.details.unwrap()["path"], "dest/demo");

        let auth = repository_error(
            DraftlineError::Git(git2::Error::new(
                git2::ErrorCode::Auth,
                git2::ErrorClass::Http,
                "denied",
            )),
            folder,
        );
        assert_eq!(auth.code, "auth_failed");
        assert!(auth.message.contains("denied"));

        let missing = repository_error(
            DraftlineError::NotARepository("dest".into()),
            folder,
        );
        assert_eq!(missing.code, "not_a_repository");
    }

    #[test]
    fn init_creates_a_hybrid_project_folder_inside_a_checkout() {
        let temp = tempfile::tempdir().unwrap();
        git2::Repository::init(temp.path()).unwrap();
        let mut context = repository_context().unwrap();
        let result = contract::init_project_in_repository_with_context(
            &mut context,
            contract::InitProjectInRepositoryRequest {
                parent_path: temp.path().to_path_buf(),
                name: "Launch Demo".into(),
                base_branch: Some("main".into()),
                commit_template: None,
            },
        )
        .unwrap();
        assert!(result.workspace_path.ends_with("launch-demo"));
        assert!(result.workspace_path.is_dir());
        assert!(temp.path().join(".draftline").is_file());
        assert_eq!(result.settings.base_branch.as_deref(), Some("main"));

        let again = contract::init_project_in_repository_with_context(
            &mut repository_context().unwrap(),
            contract::InitProjectInRepositoryRequest {
                parent_path: temp.path().to_path_buf(),
                name: "Other".into(),
                base_branch: None,
                commit_template: None,
            },
        );
        assert!(again.is_err());
    }
}
