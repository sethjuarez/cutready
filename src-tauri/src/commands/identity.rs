//! Tauri commands for the acting user's identity.
//!
//! The CutReady profile is per user, so it lives in the app data store rather
//! than in a project file that collaborators would inherit.

use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_auditaur::auditaur_command;
use tauri_plugin_store::StoreExt;

use crate::engine::identity::{self, Identity, ResolvedIdentity};
use crate::AppState;

const IDENTITY_STORE_FILE: &str = "identity.json";
const PROFILE_KEY: &str = "profile";

/// The identity the user saved in CutReady, if any. An unreadable store is an
/// error, not "no profile", so commits never silently fall through to git config.
pub fn saved_profile(app: &AppHandle) -> Result<Option<Identity>, String> {
    let store = app
        .store(IDENTITY_STORE_FILE)
        .map_err(|e| format!("Couldn't open your saved profile: {e}"))?;
    profile_from_store_value(store.get(PROFILE_KEY))
}

fn profile_from_store_value(value: Option<serde_json::Value>) -> Result<Option<Identity>, String> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value)
            .map(Some)
            .map_err(|e| format!("Couldn't read your saved profile: {e}")),
    }
}

/// Resolve the acting identity for a project, failing when the saved profile can't be read.
pub fn try_resolve_identity(
    app: Option<&AppHandle>,
    project_root: Option<&std::path::Path>,
) -> Result<ResolvedIdentity, String> {
    let profile = match app {
        Some(app) => saved_profile(app)?,
        None => None,
    };
    Ok(identity::resolve(project_root, profile))
}

/// Best-effort identity for contexts that never record a change (an unreadable profile is skipped).
pub fn resolve_identity(
    app: Option<&AppHandle>,
    project_root: Option<&std::path::Path>,
) -> ResolvedIdentity {
    let profile = app.and_then(|app| saved_profile(app).ok().flatten());
    identity::resolve(project_root, profile)
}

fn current_repo_root(state: &AppState) -> Option<PathBuf> {
    let current = state.current_project.lock().ok()?;
    current.as_ref().map(|view| view.repo_root.clone())
}

#[auditaur_command(skip_all, err)]
pub async fn get_contributor_identity(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResolvedIdentity, String> {
    let root = current_repo_root(&state);
    try_resolve_identity(Some(&app), root.as_deref())
}

#[auditaur_command(skip_all, err)]
pub async fn set_contributor_identity(
    name: String,
    email: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResolvedIdentity, String> {
    let profile = identity::validate_profile(&name, &email)?;
    let store = app.store(IDENTITY_STORE_FILE).map_err(|e| e.to_string())?;
    store.set(
        PROFILE_KEY,
        serde_json::to_value(&profile).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    let root = current_repo_root(&state);
    try_resolve_identity(Some(&app), root.as_deref())
}

#[auditaur_command(skip_all, err)]
pub async fn clear_contributor_identity(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ResolvedIdentity, String> {
    let store = app.store(IDENTITY_STORE_FILE).map_err(|e| e.to_string())?;
    store.delete(PROFILE_KEY);
    store.save().map_err(|e| e.to_string())?;
    let root = current_repo_root(&state);
    try_resolve_identity(Some(&app), root.as_deref())
}

#[cfg(test)]
mod tests {
    use super::profile_from_store_value;
    use serde_json::json;

    #[test]
    fn missing_or_null_profile_means_no_profile() {
        assert_eq!(profile_from_store_value(None), Ok(None));
        assert_eq!(profile_from_store_value(Some(json!(null))), Ok(None));
    }

    #[test]
    fn saved_profile_round_trips() {
        let profile = profile_from_store_value(Some(json!({
            "name": "Jess",
            "email": "jess@example.com"
        })))
        .expect("valid profile")
        .expect("profile present");
        assert_eq!(profile.name, "Jess");
        assert_eq!(profile.email.as_deref(), Some("jess@example.com"));
    }

    #[test]
    fn unreadable_profile_is_an_error_not_a_fallback() {
        let error = profile_from_store_value(Some(json!("not a profile")))
            .expect_err("wrong shape must fail closed");
        assert!(error.starts_with("Couldn't read your saved profile"));
    }
}
