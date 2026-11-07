//! Bringing the team's sent work in by replaying unsent saves on top of it,
//! so history only holds versions people named themselves.

use std::path::Path;

use draftline::tauri_contract as contract;
use tauri::AppHandle;
use tauri_plugin_auditaur::auditaur_command;

use super::draftline::{context_error, context_for_workspace};
use crate::engine::write_lock;

/// Fetches, then reports whether the unsent saves can be replayed on top of
/// the team's. Changes nothing but the remote-tracking refs.
#[auditaur_command(skip_all)]
pub async fn preflight_rebase_incoming(
    request: contract::RemoteRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<draftline::RebaseIncomingReport> {
    let _guard = write_lock::lock(&request.workspace_path).map_err(context_error)?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::preflight_rebase_incoming_with_context(
        &mut context,
        request,
    ))
}

/// Replays the unsent saves on top of the team's. Every refusal
/// (`incoming_conflicts`, `versions_already_shared`, `rebase_unsupported`,
/// `preflight_failed`, `versions_on_other_timelines`) leaves the repository
/// as it was.
#[auditaur_command(skip_all)]
pub async fn rebase_incoming(
    request: contract::RemoteRequest,
    app: AppHandle,
) -> contract::TauriCommandResult<contract::RebaseIncomingCommandResult> {
    let _guard = write_lock::lock(&request.workspace_path).map_err(context_error)?;
    refuse_if_other_timelines_hold_unsent_saves(&request.workspace_path, &request.remote)?;
    let mut context = context_for_workspace(&request.workspace_path, app)?;
    contract::into_tauri_result(contract::rebase_incoming_with_context(
        &mut context,
        request,
    ))
}

/// Replaying a save another local timeline also holds would leave that
/// timeline on the old copy, so the caller combines the work instead. Checked
/// under the write lock so no timeline can start from a save in between.
fn refuse_if_other_timelines_hold_unsent_saves(
    workspace_path: &Path,
    remote: &str,
) -> Result<(), contract::TauriCommandError> {
    let unsent = unsent_versions(workspace_path, remote).map_err(context_error)?;
    let timelines = variations_containing(workspace_path, &unsent).map_err(context_error)?;
    if timelines.is_empty() {
        return Ok(());
    }
    Err(contract::TauriCommandError {
        code: "versions_on_other_timelines".into(),
        message: "Another timeline holds saves that haven't been sent yet.".into(),
        details: Some(serde_json::json!({ "timelines": timelines })),
    })
}

/// Versions on the current timeline that no remote-tracking ref of `remote`
/// reaches, i.e. the saves a replay would rewrite.
pub(crate) fn unsent_versions(workspace_path: &Path, remote: &str) -> Result<Vec<String>, String> {
    let repo = git2::Repository::discover(workspace_path).map_err(|e| e.to_string())?;
    let Some(head) = repo.head().ok().and_then(|head| head.target()) else {
        return Ok(Vec::new());
    };
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.push(head).map_err(|e| e.to_string())?;
    let prefix = format!("refs/remotes/{remote}/");
    for reference in repo.references().map_err(|e| e.to_string())? {
        let reference = reference.map_err(|e| e.to_string())?;
        let shared = reference
            .name()
            .ok()
            .is_some_and(|name| name.starts_with(&prefix));
        if let (true, Some(target)) = (shared, reference.target()) {
            walk.hide(target).map_err(|e| e.to_string())?;
        }
    }
    walk.map(|id| id.map(|id| id.to_string()).map_err(|e| e.to_string()))
        .collect()
}

pub(crate) fn variations_containing(
    workspace_path: &Path,
    versions: &[String],
) -> Result<Vec<String>, String> {
    if versions.is_empty() {
        return Ok(Vec::new());
    }
    let repo = git2::Repository::discover(workspace_path).map_err(|e| e.to_string())?;
    let targets = versions
        .iter()
        .map(|id| git2::Oid::from_str(id).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    let current = repo
        .head()
        .ok()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().ok().map(str::to_owned));
    let mut found = Vec::new();
    for branch in repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| e.to_string())?
    {
        let (branch, _) = branch.map_err(|e| e.to_string())?;
        let Some(name) = branch.name().map_err(|e| e.to_string())?.map(str::to_owned) else {
            continue;
        };
        if current.as_deref() == Some(name.as_str()) {
            continue;
        }
        let Some(tip) = branch.get().target() else {
            continue;
        };
        let mut contains = false;
        for target in &targets {
            if tip == *target
                || repo
                    .graph_descendant_of(tip, *target)
                    .map_err(|e| e.to_string())?
            {
                contains = true;
                break;
            }
        }
        if contains {
            found.push(name);
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::{unsent_versions, variations_containing};
    use git2::{Repository, Signature};
    use std::path::Path;

    fn commit(repo: &Repository, file: &str, parents: &[git2::Oid]) -> git2::Oid {
        let workdir = repo.workdir().unwrap();
        std::fs::write(workdir.join(file), file).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(file)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("T", "t@example.com").unwrap();
        let parents = parents
            .iter()
            .map(|p| repo.find_commit(*p).unwrap())
            .collect::<Vec<_>>();
        let refs = parents.iter().collect::<Vec<_>>();
        repo.commit(Some("HEAD"), &sig, &sig, file, &tree, &refs)
            .unwrap()
    }

    #[test]
    fn finds_other_timelines_started_from_an_unsent_save() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let base = commit(&repo, "a.md", &[]);
        let unsent = commit(&repo, "b.md", &[base]);
        let current = repo.head().unwrap().shorthand().unwrap().to_owned();
        repo.branch("from-base", &repo.find_commit(base).unwrap(), false)
            .unwrap();
        repo.branch("from-unsent", &repo.find_commit(unsent).unwrap(), false)
            .unwrap();
        repo.set_head("refs/heads/from-unsent").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        commit(&repo, "c.md", &[unsent]);
        repo.set_head(&format!("refs/heads/{current}")).unwrap();

        let found = variations_containing(dir.path(), &[unsent.to_string()]).unwrap();
        assert_eq!(found, vec!["from-unsent".to_string()]);
        assert!(variations_containing(dir.path(), &[]).unwrap().is_empty());
    }

    #[test]
    fn unsent_versions_are_the_ones_no_remote_ref_reaches() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let base = commit(&repo, "a.md", &[]);
        let unsent = commit(&repo, "b.md", &[base]);
        repo.reference("refs/remotes/origin/main", base, true, "test")
            .unwrap();
        repo.reference("refs/remotes/fork/main", unsent, true, "test")
            .unwrap();

        assert_eq!(
            unsent_versions(dir.path(), "origin").unwrap(),
            vec![unsent.to_string()]
        );
        assert!(unsent_versions(dir.path(), "fork").unwrap().is_empty());
    }
}
