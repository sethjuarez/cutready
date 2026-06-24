//! Feature-gated Draftline spike adapter.
//!
//! This module intentionally does not replace CutReady's production project or
//! Git engines. It exercises a narrow workflow against Draftline using a
//! content policy that tracks user-authored CutReady files without sweeping in
//! runtime/UI state.

#![allow(dead_code)]

use std::path::Path;

use draftline::{
    ApplyIncomingReport, ApplyIncomingResult, ChangeSet, ContentPolicy, HistoryEntry,
    PreflightReport, PreviewFile, PublishResult, RemoteCredential, RemoteEndpoint, RemoteOptions,
    Result as DraftlineResult, SwitchPolicy, SyncStatus, Variation, VariationId, VariationMetadata,
    VariationSummary, Version, VersionDiff, VersionId, VersionPreview, Workspace, WorkspaceSummary,
};

const EXCLUDED_RUNTIME_PATHS: &[&str] = &[
    ".chats",
    ".cutready/recordings",
    ".cutready/agent-state.db",
    ".cutready/memory.json",
    ".cutready/locks.json",
];

const CUTREADY_CONTENT_EXTENSIONS: &[&str] = &["sk", "sb", "md"];
const CUTREADY_ASSET_ROOTS: &[&str] = &[".cutready/visuals", "screenshots"];

/// Small CutReady-facing wrapper around a Draftline workspace.
pub struct CutReadyDraftlineAdapter {
    workspace: Workspace,
}

impl CutReadyDraftlineAdapter {
    /// Open or initialize a Draftline workspace for a CutReady project.
    pub fn open_project(root: impl AsRef<Path>) -> DraftlineResult<Self> {
        let policy = cutready_content_policy()?;
        let workspace = Workspace::init_with_policy(root, policy)?;
        Ok(Self { workspace })
    }

    pub fn clone_project_with_options(
        remote_url: &str,
        path: impl AsRef<Path>,
        options: &mut RemoteOptions<'_>,
    ) -> DraftlineResult<Self> {
        let policy = cutready_content_policy()?;
        let workspace =
            Workspace::clone_workspace_with_policy_and_options(remote_url, path, policy, options)?;
        Ok(Self { workspace })
    }

    pub fn root(&self) -> &Path {
        self.workspace.root()
    }

    pub fn inspect_changes(&self) -> DraftlineResult<ChangeSet> {
        self.workspace.changes()
    }

    pub fn workspace_summary(&self) -> DraftlineResult<WorkspaceSummary> {
        self.workspace.workspace_summary()
    }

    pub fn save_version(&self, label: &str) -> DraftlineResult<Version> {
        self.workspace.save_version(label)
    }

    pub fn versions(&self) -> DraftlineResult<Vec<Version>> {
        self.workspace.versions()
    }

    pub fn full_history(&self) -> DraftlineResult<Vec<HistoryEntry>> {
        self.workspace.full_history()
    }

    pub fn preview_version(&self, version: &VersionId) -> DraftlineResult<VersionPreview> {
        self.workspace.preview_version(version)
    }

    pub fn preview_version_file(
        &self,
        version: &VersionId,
        path: impl AsRef<Path>,
    ) -> DraftlineResult<Option<PreviewFile>> {
        self.workspace.preview_version_file(version, path)
    }

    pub fn create_variation_from(
        &self,
        version: &VersionId,
        name: &str,
    ) -> DraftlineResult<Variation> {
        self.workspace.create_variation_from(version, name)
    }

    pub fn current_variation(&self) -> DraftlineResult<String> {
        self.workspace.current_variation()
    }

    pub fn variations(&self) -> DraftlineResult<Vec<Variation>> {
        self.workspace.variations()
    }

    pub fn variation_summaries(&self) -> DraftlineResult<Vec<VariationSummary>> {
        self.workspace.variation_summaries()
    }

    pub fn create_variation_from_with_metadata(
        &self,
        version: &VersionId,
        name: &str,
        label: Option<&str>,
        slug: Option<&str>,
    ) -> DraftlineResult<Variation> {
        self.workspace.create_variation_from_with_metadata(
            version,
            name,
            cutready_variation_metadata(label, slug),
        )
    }

    pub fn variation_metadata(
        &self,
        variation: &VariationId,
    ) -> DraftlineResult<VariationMetadata> {
        self.workspace.variation_metadata(variation)
    }

    pub fn set_variation_metadata(
        &self,
        variation: &VariationId,
        label: Option<&str>,
        slug: Option<&str>,
    ) -> DraftlineResult<Variation> {
        self.workspace
            .set_variation_metadata(variation, cutready_variation_metadata(label, slug))
    }

    pub fn preflight_switch_variation(
        &self,
        variation: &VariationId,
    ) -> DraftlineResult<PreflightReport> {
        self.workspace.preflight_switch_variation(variation)
    }

    pub fn switch_variation(&self, variation: &VariationId) -> DraftlineResult<Variation> {
        self.workspace
            .switch_variation(variation, SwitchPolicy::AbortIfDirty)
    }

    pub fn switch_variation_with_policy(
        &self,
        variation: &VariationId,
        policy: SwitchPolicy,
    ) -> DraftlineResult<Variation> {
        self.workspace.switch_variation(variation, policy)
    }

    pub fn restore_version_as_new_save(
        &self,
        version: &VersionId,
        label: &str,
    ) -> DraftlineResult<Version> {
        self.workspace.restore_version_as_new_save(version, label)
    }

    pub fn squash_versions(&self, count: usize, label: &str) -> DraftlineResult<Version> {
        self.workspace.squash_versions(count, label)
    }

    pub fn diff_versions(&self, from: &VersionId, to: &VersionId) -> DraftlineResult<VersionDiff> {
        self.workspace.diff_versions(from, to)
    }

    pub fn diff_version_to_workspace(&self, version: &VersionId) -> DraftlineResult<VersionDiff> {
        self.workspace.diff_version_to_workspace(version)
    }

    pub fn add_remote(&self, name: &str, url: &str) -> DraftlineResult<RemoteEndpoint> {
        self.workspace.add_remote(name, url)
    }

    pub fn remotes(&self) -> DraftlineResult<Vec<RemoteEndpoint>> {
        self.workspace.remotes()
    }

    pub fn fetch_remote_with_options(
        &self,
        remote: &str,
        options: &mut RemoteOptions<'_>,
    ) -> DraftlineResult<()> {
        self.workspace.fetch_remote_with_options(remote, options)
    }

    pub fn sync_status(&self, remote: &str) -> DraftlineResult<SyncStatus> {
        self.workspace.sync_status(remote)
    }

    pub fn preflight_apply_incoming(&self, remote: &str) -> DraftlineResult<ApplyIncomingReport> {
        self.workspace.preflight_apply_incoming(remote)
    }

    pub fn apply_incoming_with_options(
        &self,
        remote: &str,
        options: &mut RemoteOptions<'_>,
    ) -> DraftlineResult<ApplyIncomingResult> {
        self.workspace.apply_incoming(remote, options)
    }

    pub fn publish_changes_with_options(
        &self,
        remote: &str,
        options: &mut RemoteOptions<'_>,
    ) -> DraftlineResult<PublishResult> {
        self.workspace.publish_changes_with_options(remote, options)
    }
}

/// Build the content policy needed for a safe CutReady Draftline spike.
pub fn cutready_content_policy() -> DraftlineResult<ContentPolicy> {
    ContentPolicy::new()
        .include_paths(CUTREADY_ASSET_ROOTS)?
        .include_extensions(CUTREADY_CONTENT_EXTENSIONS)?
        .exclude_paths(EXCLUDED_RUNTIME_PATHS)
}

pub fn cutready_variation_metadata(label: Option<&str>, slug: Option<&str>) -> VariationMetadata {
    let mut metadata = VariationMetadata::new();
    if let Some(label) = label {
        metadata = metadata.with_label(label);
    }
    if let Some(slug) = slug {
        metadata = metadata.with_slug(slug);
    }
    metadata
}

pub fn cutready_remote_options(github_token: Option<String>) -> RemoteOptions<'static> {
    RemoteOptions::new().with_credentials(move |request| {
        if let Some(token) = github_token.as_ref() {
            if request.allows_username_password {
                return Ok(RemoteCredential::UsernamePassword {
                    username: "x-access-token".to_string(),
                    password: token.clone(),
                });
            }
        }

        if request.allows_ssh_key {
            return Ok(RemoteCredential::SshAgent {
                username: request.username_from_url.unwrap_or("git").to_string(),
            });
        }

        Ok(RemoteCredential::Default)
    })
}

/// Adapter spike findings that should be revisited before any production UI use.
pub fn draftline_spike_gaps() -> &'static [&'static str] {
    &[]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: impl AsRef<Path>, contents: &str) {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn read(path: impl AsRef<Path>) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn configure_identity(root: &Path, name: &str, email: &str) {
        let repo = git2::Repository::open(root).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", name).unwrap();
        config.set_str("user.email", email).unwrap();
    }

    #[test]
    fn narrow_cutready_flow_runs_through_draftline() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"Intro"}"#);
        write(root.join("demo.sb"), r#"{"title":"Demo"}"#);
        write(root.join("planning.md"), "# Plan\n");
        write(
            root.join(".cutready/visuals/frame.json"),
            r#"{"kind":"frame"}"#,
        );
        write(root.join(".cutready/locks.json"), r#"{"notes":{}}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"runs"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();

        let initial_changes = adapter.inspect_changes().unwrap();
        let changed_paths: Vec<_> = initial_changes
            .files
            .iter()
            .map(|file| file.path.as_path())
            .collect();
        assert!(changed_paths.contains(&Path::new("intro.sk")));
        assert!(changed_paths.contains(&Path::new("demo.sb")));
        assert!(changed_paths.contains(&Path::new("planning.md")));
        assert!(changed_paths.contains(&Path::new(".cutready/visuals/frame.json")));
        assert!(!changed_paths.contains(&Path::new(".cutready/locks.json")));
        assert!(!changed_paths.contains(&Path::new(".cutready/ui-state.json")));

        let version = adapter.save_version("Draftline spike save").unwrap();
        assert!(adapter.inspect_changes().unwrap().is_empty());

        write(root.join("intro.sk"), r#"{"title":"Intro updated"}"#);
        let update = adapter.inspect_changes().unwrap();
        assert_eq!(update.files.len(), 1);
        assert_eq!(update.files[0].path.as_path(), Path::new("intro.sk"));

        let updated = adapter.save_version("Update intro sketch").unwrap();
        let preview = adapter.preview_version(updated.id()).unwrap();
        let preview_paths: Vec<_> = preview
            .files
            .iter()
            .map(|file| file.path.as_path())
            .collect();
        assert!(preview_paths.contains(&Path::new("intro.sk")));
        assert!(!preview_paths.contains(&Path::new(".cutready/locks.json")));
        assert!(!preview_paths.contains(&Path::new(".cutready/ui-state.json")));

        let intro_preview = adapter
            .preview_version_file(updated.id(), "intro.sk")
            .unwrap()
            .unwrap();
        assert!(intro_preview
            .content
            .as_deref()
            .is_some_and(|content| content.contains("Intro updated")));
        assert!(adapter
            .preview_version_file(updated.id(), ".cutready/ui-state.json")
            .unwrap()
            .is_none());

        let variation = adapter
            .create_variation_from_with_metadata(
                version.id(),
                "draftline-spike-alt",
                Some("Alternate timeline"),
                Some("alternate-timeline"),
            )
            .unwrap();
        assert!(!variation.is_current);
        assert_eq!(variation.display_label(), "Alternate timeline");
        assert_eq!(
            adapter
                .variation_metadata(variation.id())
                .unwrap()
                .slug
                .as_deref(),
            Some("alternate-timeline")
        );

        let relabeled = adapter
            .set_variation_metadata(
                variation.id(),
                Some("Relabeled alternate"),
                Some("relabeled-alternate"),
            )
            .unwrap();
        assert_eq!(relabeled.display_label(), "Relabeled alternate");

        let switched = adapter.switch_variation(variation.id()).unwrap();
        assert_eq!(switched.name, "draftline-spike-alt");
        assert!(switched.is_current);

        let status = adapter.sync_status("origin").unwrap();
        assert_eq!(status.variation, "draftline-spike-alt");
        assert!(matches!(
            status.state,
            draftline::SyncState::NoRemoteVersion
        ));
    }

    #[test]
    fn content_policy_tracks_cutready_extensions_without_explicit_file_roots() {
        let policy = cutready_content_policy().unwrap();

        assert!(policy.tracks("intro.sk").unwrap());
        assert!(policy.tracks("storyboards/demo.sb").unwrap());
        assert!(policy.tracks("notes/planning.md").unwrap());
        assert!(policy.tracks(".cutready/visuals/frame.json").unwrap());
        assert!(!policy.tracks(".cutready/ui-state.json").unwrap());
        assert!(!policy.tracks(".cutready/locks.json").unwrap());
    }

    #[test]
    fn dirty_variation_switch_preflights_and_preserves_work() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"Base"}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"runs"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let base = adapter.save_version("Base").unwrap();
        let alternate = adapter
            .create_variation_from_with_metadata(
                base.id(),
                "alternate",
                Some("Alternate"),
                Some("alternate"),
            )
            .unwrap();

        write(root.join("intro.sk"), r#"{"title":"Dirty"}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"dirty"}"#);

        let report = adapter.preflight_switch_variation(alternate.id()).unwrap();
        assert!(!report.can_proceed);
        assert_eq!(report.dirty_files.len(), 1);
        assert_eq!(report.dirty_files[0].path.as_path(), Path::new("intro.sk"));
        assert_eq!(report.untracked_assets.len(), 0);

        let error = adapter.switch_variation(alternate.id()).unwrap_err();
        assert!(matches!(
            error,
            draftline::DraftlineError::PreflightFailed(_)
        ));
        assert_eq!(read(root.join("intro.sk")), r#"{"title":"Dirty"}"#);
        assert_eq!(
            read(root.join(".cutready/ui-state.json")),
            r#"{"panel":"dirty"}"#
        );

        let switched = adapter
            .switch_variation_with_policy(
                alternate.id(),
                SwitchPolicy::SaveFirst {
                    label: "Save dirty work before switching".to_string(),
                },
            )
            .unwrap();
        assert_eq!(switched.name, "alternate");
        assert_eq!(adapter.current_variation().unwrap(), "alternate");
        assert_eq!(
            read(root.join(".cutready/ui-state.json")),
            r#"{"panel":"dirty"}"#
        );
    }

    #[test]
    fn created_variation_is_listed_after_reopening_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"Base"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let base = adapter.save_version("Base").unwrap();
        adapter
            .create_variation_from_with_metadata(
                base.id(),
                "persistent-alt",
                Some("Persistent Alt"),
                Some("persistent-alt"),
            )
            .unwrap();

        let reopened = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let names: Vec<_> = reopened
            .variations()
            .unwrap()
            .into_iter()
            .map(|variation| variation.name)
            .collect();

        assert!(
            names.iter().any(|name| name == "persistent-alt"),
            "created variation should survive reopening; got {names:?}"
        );
    }

    #[test]
    fn restore_version_as_new_save_requires_clean_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"One"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let first = adapter.save_version("First").unwrap();
        write(root.join("intro.sk"), r#"{"title":"Two"}"#);
        adapter.save_version("Second").unwrap();

        write(root.join("planning.md"), "# unsaved\n");
        let error = adapter
            .restore_version_as_new_save(first.id(), "Restore first")
            .unwrap_err();
        assert!(matches!(
            error,
            draftline::DraftlineError::PreflightFailed(_)
        ));
        assert_eq!(read(root.join("planning.md")), "# unsaved\n");
    }

    #[test]
    fn restore_version_as_new_save_restores_tracked_content_without_runtime_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"One"}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"one"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let first = adapter.save_version("First").unwrap();
        write(root.join("intro.sk"), r#"{"title":"Two"}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"two"}"#);
        adapter.save_version("Second").unwrap();

        let restored = adapter
            .restore_version_as_new_save(first.id(), "Restore first")
            .unwrap();

        assert_eq!(read(root.join("intro.sk")), r#"{"title":"One"}"#);
        assert_eq!(
            read(root.join(".cutready/ui-state.json")),
            r#"{"panel":"two"}"#
        );
        let restored_preview = adapter
            .preview_version_file(restored.id(), "intro.sk")
            .unwrap()
            .unwrap();
        assert!(restored_preview
            .content
            .as_deref()
            .is_some_and(|content| content.contains("\"One\"")));
    }

    #[test]
    fn remote_options_support_local_publish_and_fetch_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspace");
        let remote = temp.path().join("remote.git");
        git2::Repository::init_bare(&remote).unwrap();

        write(root.join("intro.sk"), r#"{"title":"Intro"}"#);
        let adapter = CutReadyDraftlineAdapter::open_project(&root).unwrap();
        adapter.save_version("Initial").unwrap();
        adapter
            .add_remote("origin", remote.to_str().unwrap())
            .unwrap();

        let mut publish_options = cutready_remote_options(None);
        let published = adapter
            .publish_changes_with_options("origin", &mut publish_options)
            .unwrap();
        assert_eq!(published.remote, "origin");
        assert_eq!(published.published_versions, 1);

        let mut fetch_options = cutready_remote_options(Some("unused-token".to_string()));
        adapter
            .fetch_remote_with_options("origin", &mut fetch_options)
            .unwrap();
        let status = adapter.sync_status("origin").unwrap();
        assert!(matches!(status.state, draftline::SyncState::UpToDate));
    }

    #[test]
    fn sync_status_reports_incoming_versions_after_fetch() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        git2::Repository::init_bare(&remote).unwrap();

        let first_root = temp.path().join("first");
        write(first_root.join("intro.sk"), r#"{"title":"One"}"#);
        let first = CutReadyDraftlineAdapter::open_project(&first_root).unwrap();
        configure_identity(&first_root, "Seth", "seth@example.com");
        first
            .add_remote("origin", remote.to_str().unwrap())
            .unwrap();
        first.save_version("One").unwrap();
        first
            .publish_changes_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();

        let second_root = temp.path().join("second");
        let second = CutReadyDraftlineAdapter::clone_project_with_options(
            remote.to_str().unwrap(),
            &second_root,
            &mut cutready_remote_options(None),
        )
        .unwrap();
        configure_identity(&second_root, "Maria", "maria@example.com");

        write(first_root.join("intro.sk"), r#"{"title":"Two"}"#);
        first.save_version("Two").unwrap();
        first
            .publish_changes_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();

        second
            .fetch_remote_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();
        let status = second.sync_status("origin").unwrap();
        assert!(matches!(
            status.state,
            draftline::SyncState::IncomingAvailable
        ));
        assert_eq!(status.behind, 1);
        assert_eq!(status.incoming.len(), 1);
        assert_eq!(status.incoming[0].label, "Two");
    }

    #[test]
    fn publish_refuses_when_remote_has_incoming_changes() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        git2::Repository::init_bare(&remote).unwrap();

        let first_root = temp.path().join("first");
        write(first_root.join("intro.sk"), r#"{"title":"One"}"#);
        let first = CutReadyDraftlineAdapter::open_project(&first_root).unwrap();
        configure_identity(&first_root, "Seth", "seth@example.com");
        first
            .add_remote("origin", remote.to_str().unwrap())
            .unwrap();
        first.save_version("One").unwrap();
        first
            .publish_changes_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();

        let second_root = temp.path().join("second");
        let second = CutReadyDraftlineAdapter::clone_project_with_options(
            remote.to_str().unwrap(),
            &second_root,
            &mut cutready_remote_options(None),
        )
        .unwrap();
        configure_identity(&second_root, "Maria", "maria@example.com");
        write(second_root.join("intro.sk"), r#"{"title":"Remote two"}"#);
        second.save_version("Remote two").unwrap();
        second
            .publish_changes_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();

        write(first_root.join("intro.sk"), r#"{"title":"Local two"}"#);
        first.save_version("Local two").unwrap();
        first
            .fetch_remote_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();
        let status = first.sync_status("origin").unwrap();
        assert!(matches!(status.state, draftline::SyncState::NeedsMerge));

        let error = first
            .publish_changes_with_options("origin", &mut cutready_remote_options(None))
            .unwrap_err();
        assert!(matches!(
            error,
            draftline::DraftlineError::SyncNeedsMerge(_)
        ));
    }
}
