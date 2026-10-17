//! CutReady's Draftline-backed versioning service.
//!
//! This module keeps CutReady's content policy, remote credential behavior, and
//! product-facing naming in one place while Draftline owns the versioning and
//! collaboration mechanics.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use draftline::{
    ApplyIncomingReport, ApplyIncomingResult, ChangeSet, ContentPolicy, Contributor,
    ContributorProfile, HistoryEntry, MergeConflictResolution, MergeIncomingReport,
    MergeIncomingResult, MergeIncomingToken, PreflightReport, PreviewFile, PublishResult,
    RemoteCredential, RemoteEndpoint, RemoteOptions, Result as DraftlineResult, Shelf,
    SwitchPolicy, SyncStatus, Variation, VariationId, VariationMetadata, VariationSummary, Version,
    VersionDiff, VersionId, VersionPreview, Workspace, WorkspaceSummary,
};

use serde::Serialize;

use crate::engine::identity::ResolvedIdentity;

const EXCLUDED_RUNTIME_PATHS: &[&str] = &[
    ".chats",
    ".cutready/recordings",
    ".cutready/agent-state.db",
    ".cutready/memory.json",
    ".cutready/locks.json",
];

const CUTREADY_CONTENT_EXTENSIONS: &[&str] = &[
    "sk", "sb", "md", "cv", "png", "jpg", "jpeg", "webp", "webm", "ogg", "oga", "mp3", "wav",
    "m4a", "flac",
];
const CUTREADY_INCLUDED_PATHS: &[&str] = &[
    ".cutready/projects.json",
    ".cutready/visuals",
    ".cutready/screenshots",
    ".cutready/narration",
];
const CUTREADY_LARGE_FILE_THRESHOLD_BYTES: u64 = 50 * 1024 * 1024;

/// CutReady-facing facade over a Draftline workspace.
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

    pub fn discard_changes(&self) -> DraftlineResult<ChangeSet> {
        self.workspace.discard_changes()
    }

    pub fn discard_file(
        &self,
        path: impl AsRef<Path>,
    ) -> DraftlineResult<Option<draftline::ChangedFile>> {
        self.workspace.discard_file(path)
    }

    pub fn shelve_changes(&self, name: &str) -> DraftlineResult<Shelf> {
        self.workspace.shelve_changes(name)
    }

    pub fn list_shelves(&self) -> DraftlineResult<Vec<Shelf>> {
        self.workspace.list_shelves()
    }

    pub fn apply_shelf(&self, id: &str) -> DraftlineResult<Shelf> {
        self.workspace.apply_shelf(id)
    }

    pub fn delete_shelf(&self, id: &str) -> DraftlineResult<()> {
        self.workspace.delete_shelf(id)
    }

    pub fn workspace_summary(&self) -> DraftlineResult<WorkspaceSummary> {
        self.workspace.workspace_summary()
    }

    /// Unattributed save, for tests only: app saves must name the acting user.
    #[cfg(test)]
    pub fn save_version(&self, label: &str) -> DraftlineResult<Version> {
        self.workspace.save_version(label)
    }

    pub fn save_version_with_profile(
        &self,
        label: &str,
        profile: &ContributorProfile,
    ) -> DraftlineResult<Version> {
        self.workspace.save_version_with_profile(label, profile)
    }

    pub fn changed_files(&self) -> DraftlineResult<Vec<draftline::ChangedFile>> {
        self.workspace.changed_files()
    }

    pub fn save_files_with_profile<I, P>(
        &self,
        paths: I,
        label: &str,
        profile: &ContributorProfile,
    ) -> DraftlineResult<Version>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        self.workspace
            .save_files_with_profile(paths, label, profile)
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

    pub fn delete_variation(&self, variation: &VariationId) -> DraftlineResult<()> {
        self.workspace.delete_variation(variation)
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

    pub fn preflight_merge_incoming(&self, remote: &str) -> DraftlineResult<MergeIncomingReport> {
        self.workspace.preflight_merge_incoming(remote)
    }

    pub fn merge_incoming_with_options(
        &self,
        token: MergeIncomingToken,
        label: &str,
        options: &mut RemoteOptions<'_>,
    ) -> DraftlineResult<MergeIncomingResult> {
        self.workspace.merge_incoming(token, label, options)
    }

    pub fn merge_incoming_with_resolutions_and_options(
        &self,
        token: MergeIncomingToken,
        label: &str,
        resolutions: Vec<MergeConflictResolution>,
        options: &mut RemoteOptions<'_>,
    ) -> DraftlineResult<MergeIncomingResult> {
        self.workspace
            .merge_incoming_with_resolutions(token, label, resolutions, options)
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
        .include_paths(CUTREADY_INCLUDED_PATHS)?
        .include_extensions(CUTREADY_CONTENT_EXTENSIONS)?
        .exclude_paths(EXCLUDED_RUNTIME_PATHS)
        .map(|policy| policy.with_large_file_threshold(CUTREADY_LARGE_FILE_THRESHOLD_BYTES))
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
            if request.allows_username_password && is_github_remote_url(request.url) {
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

pub fn is_github_remote_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    normalized.starts_with("https://github.com/")
        || normalized.starts_with("ssh://git@github.com/")
        || normalized.starts_with("git@github.com:")
}

/// Remaining CutReady-owned integration gaps after Draftline owns versioning.
pub fn draftline_integration_gaps() -> &'static [&'static str] {
    &[]
}

/// Who recorded a change: the acting user as author, CutReady as the tool that saved it.
pub fn contributor_profile_for(author: ResolvedIdentity) -> ContributorProfile {
    ContributorProfile::new(
        Contributor {
            name: author.name,
            email: author.email,
        },
        Contributor {
            name: "CutReady".to_string(),
            email: Some("app@cutready.local".to_string()),
        },
    )
}

/// Shown when CutReady keeps a workspace change pending instead of saving it anonymously.
pub const STRUCTURE_SNAPSHOT_DEFERRED_HINT: &str =
    "Add your name and email in Settings › Profile to save it as a version.";

/// Shown when a workspace change touched files that already had unsaved edits.
pub const STRUCTURE_SNAPSHOT_UNSAVED_HINT: &str =
    "It touched files with unsaved edits, so save a version to record them together.";

/// Why an automatic save stayed in pending changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeferReason {
    /// CutReady doesn't know who is acting.
    Identity,
    /// The change touched files with unsaved edits a version would sweep in.
    UnsavedEdits,
}

/// Result of saving a workspace-structure change automatically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StructureSnapshot {
    /// Recorded as a new version under the acting user.
    Saved,
    /// Nothing to record.
    Clean,
    /// Left in pending changes; the user's next save records it.
    Deferred {
        reason: DeferReason,
        message: String,
    },
}

/// A workspace-structure edit (projects, manifest, settings) that CutReady saves
/// as its own version, authored by the acting user.
///
/// Call [`StructureChange::begin`] before mutating, naming the repo-relative
/// files or folders the edit touches (`.` for the whole workspace). Only those
/// paths are saved, so unrelated pending work stays pending. The save is
/// deferred instead when CutReady doesn't know who is acting, or when those
/// paths already had unsaved edits that the version would otherwise sweep in.
pub struct StructureChange {
    _write_guard: std::sync::MutexGuard<'static, ()>,
    message: String,
    scope: Vec<PathBuf>,
    removed: Vec<PathBuf>,
    pending_before: Vec<PathBuf>,
}

impl StructureChange {
    pub fn begin<I, P>(
        repo_root: &Path,
        message: impl Into<String>,
        scope: I,
    ) -> Result<Self, String>
    where
        I: IntoIterator<Item = P>,
        P: Into<PathBuf>,
    {
        let write_guard = crate::engine::workspace_write_lock::lock()?;
        Self::begin_with_guard(repo_root, message, scope, write_guard)
    }

    pub fn begin_with_guard<I, P>(
        repo_root: &Path,
        message: impl Into<String>,
        scope: I,
        write_guard: std::sync::MutexGuard<'static, ()>,
    ) -> Result<Self, String>
    where
        I: IntoIterator<Item = P>,
        P: Into<PathBuf>,
    {
        let adapter =
            CutReadyDraftlineAdapter::open_project(repo_root).map_err(|e| e.to_string())?;
        let pending_before = adapter
            .changed_files()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|file| file.path)
            .collect();
        Ok(Self {
            _write_guard: write_guard,
            message: message.into(),
            scope: scope.into_iter().map(Into::into).collect(),
            removed: Vec::new(),
            pending_before,
        })
    }

    /// Add a path the edit created, such as a new project folder.
    pub fn touching(mut self, path: impl Into<PathBuf>) -> Self {
        self.scope.push(path.into());
        self
    }

    /// Add a path the edit deleted. Unsaved edits there are gone, so they
    /// don't defer the save.
    pub fn removing(mut self, path: impl Into<PathBuf>) -> Self {
        self.removed.push(path.into());
        self
    }

    pub fn finish(
        self,
        repo_root: &Path,
        author: Result<ResolvedIdentity, String>,
    ) -> Result<StructureSnapshot, String> {
        let adapter =
            CutReadyDraftlineAdapter::open_project(repo_root).map_err(|e| e.to_string())?;
        let touched: Vec<PathBuf> = adapter
            .changed_files()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|file| file.path)
            .filter(|path| self.covers(path) || covered(&self.removed, path))
            .collect();
        if touched.is_empty() {
            return Ok(StructureSnapshot::Clean);
        }
        let message = &self.message;
        let author = match author {
            Ok(author)
                if !author.needs_setup
                    && author.name_source == crate::engine::identity::IdentitySource::Profile
                    && author.email_source
                        == Some(crate::engine::identity::IdentitySource::Profile)
                    && author.profile.as_ref().is_some_and(|profile| {
                        !profile.name.trim().is_empty()
                            && profile
                                .email
                                .as_deref()
                                .is_some_and(|email| !email.trim().is_empty())
                    }) =>
            {
                author
            }
            Ok(_) => {
                return Ok(StructureSnapshot::Deferred {
                    reason: DeferReason::Identity,
                    message: format!(
                    "\"{message}\" is in your pending changes. {STRUCTURE_SNAPSHOT_DEFERRED_HINT}"
                ),
                })
            }
            Err(reason) => {
                let reason = reason.trim().trim_end_matches('.');
                return Ok(StructureSnapshot::Deferred {
                    reason: DeferReason::Identity,
                    message: format!(
                        "\"{message}\" is in your pending changes. {reason}. {STRUCTURE_SNAPSHOT_DEFERRED_HINT}"
                    ),
                });
            }
        };
        if self.pending_before.iter().any(|path| self.covers(path)) {
            return Ok(StructureSnapshot::Deferred {
                reason: DeferReason::UnsavedEdits,
                message: format!(
                    "\"{message}\" is in your pending changes. {STRUCTURE_SNAPSHOT_UNSAVED_HINT}"
                ),
            });
        }
        adapter
            .save_files_with_profile(&touched, message, &contributor_profile_for(author))
            .map(|_| StructureSnapshot::Saved)
            .map_err(|e| e.to_string())
    }

    fn covers(&self, path: &Path) -> bool {
        covered(&self.scope, path)
    }
}

fn covered(scope: &[PathBuf], path: &Path) -> bool {
    scope
        .iter()
        .any(|scope| scope.as_os_str() == "." || path.starts_with(scope))
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

    #[cfg(target_os = "windows")]
    fn hide_test_command_window(command: &mut std::process::Command) {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    #[cfg(not(target_os = "windows"))]
    fn hide_test_command_window(_command: &mut std::process::Command) {}

    fn run_git(root: &Path, args: &[&str]) {
        let mut command = std::process::Command::new("git");
        hide_test_command_window(&mut command);
        let output = command
            .current_dir(root)
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("failed to run git {args:?}: {e}"));
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_legacy_git_repo(root: &Path) {
        run_git(root, &["init", "--initial-branch=main"]);
    }

    fn configure_identity(root: &Path, name: &str, email: &str) {
        run_git(root, &["config", "user.name", name]);
        run_git(root, &["config", "user.email", email]);
    }

    fn commit_all(root: &Path, message: &str) {
        run_git(root, &["add", "--all"]);
        run_git(root, &["commit", "-m", message]);
    }

    fn init_bare_main_remote(path: &Path) {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        run_git(parent, &["init", "--bare", "--initial-branch=main", &name]);
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
        write(
            root.join(".cutready/projects.json"),
            r#"{"projects":[{"path":"demo","name":"Demo"}]}"#,
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
        assert!(changed_paths.contains(&Path::new(".cutready/projects.json")));
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
        assert!(preview_paths.contains(&Path::new(".cutready/projects.json")));
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
        assert!(policy.tracks("reference.png").unwrap());
        assert!(policy.tracks("voiceover.webm").unwrap());
        assert!(policy.tracks("workspace-audio/take.m4a").unwrap());
        assert!(policy.tracks(".cutready/visuals/frame.json").unwrap());
        assert!(policy.tracks(".cutready/projects.json").unwrap());
        assert!(policy.tracks(".cutready/screenshots/demo.webp").unwrap());
        assert!(policy.tracks(".cutready/narration/row.webm").unwrap());
        assert!(!policy.tracks(".cutready/ui-state.json").unwrap());
        assert!(!policy.tracks(".cutready/locks.json").unwrap());
    }

    #[test]
    fn project_manifest_edits_are_tracked_content() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(
            root.join(".cutready/projects.json"),
            r#"{"projects":[{"path":"demo-a","name":"Demo A"},{"path":"demo-b","name":"Demo B"}]}"#,
        );

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        adapter.save_version("Initial workspace manifest").unwrap();

        write(
            root.join(".cutready/projects.json"),
            r#"{"projects":[{"path":"demo-a","name":"Demo A"}]}"#,
        );

        let changes = adapter.inspect_changes().unwrap();
        assert!(changes
            .files
            .iter()
            .any(|file| file.path.as_path() == Path::new(".cutready/projects.json")));
    }

    #[test]
    fn shelf_lifecycle_replaces_git_stash_for_tracked_content() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"Base"}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"base"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        adapter.save_version("Base").unwrap();

        write(root.join("intro.sk"), r#"{"title":"Shelved"}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"dirty"}"#);

        let shelf = adapter.shelve_changes("cutready-stash").unwrap();
        assert_eq!(shelf.id, "cutready-stash");
        assert_eq!(read(root.join("intro.sk")), r#"{"title":"Base"}"#);
        assert_eq!(
            read(root.join(".cutready/ui-state.json")),
            r#"{"panel":"dirty"}"#
        );

        let shelves = adapter.list_shelves().unwrap();
        assert_eq!(shelves.len(), 1);
        assert_eq!(shelves[0].id, "cutready-stash");

        adapter.apply_shelf("cutready-stash").unwrap();
        assert_eq!(read(root.join("intro.sk")), r#"{"title":"Shelved"}"#);
        adapter.delete_shelf("cutready-stash").unwrap();
        assert!(adapter.list_shelves().unwrap().is_empty());
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
    fn profile_save_before_switch_credits_the_acting_user() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"Base"}"#);

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
        let profile = ContributorProfile::new(
            draftline::Contributor {
                name: "Jess".to_string(),
                email: Some("jess@example.com".to_string()),
            },
            draftline::Contributor {
                name: "CutReady".to_string(),
                email: Some("app@cutready.local".to_string()),
            },
        );
        let saved = adapter
            .save_version_with_profile("Save dirty work before switching", &profile)
            .unwrap();
        assert_eq!(saved.author.email.as_deref(), Some("jess@example.com"));
        assert_eq!(saved.saved_by.email.as_deref(), Some("app@cutready.local"));

        let switched = adapter
            .switch_variation_with_policy(alternate.id(), SwitchPolicy::AbortIfDirty)
            .unwrap();
        assert_eq!(switched.name, "alternate");
    }

    #[test]
    fn discard_changes_preserves_excluded_runtime_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"Base"}"#);
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"base"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        adapter.save_version("Base").unwrap();

        write(root.join("intro.sk"), r#"{"title":"Dirty"}"#);
        write(root.join("planning.md"), "# new tracked note\n");
        write(root.join(".cutready/ui-state.json"), r#"{"panel":"dirty"}"#);

        let discarded = adapter.discard_changes().unwrap();
        let discarded_paths: Vec<_> = discarded
            .files
            .iter()
            .map(|file| file.path.as_path())
            .collect();

        assert!(discarded_paths.contains(&Path::new("intro.sk")));
        assert!(discarded_paths.contains(&Path::new("planning.md")));
        assert_eq!(read(root.join("intro.sk")), r#"{"title":"Base"}"#);
        assert!(!root.join("planning.md").exists());
        assert_eq!(
            read(root.join(".cutready/ui-state.json")),
            r#"{"panel":"dirty"}"#
        );
    }

    #[test]
    fn discard_file_resets_only_requested_tracked_content() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"Base intro"}"#);
        write(root.join("demo.sb"), r#"{"title":"Base demo"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        adapter.save_version("Base").unwrap();

        write(root.join("intro.sk"), r#"{"title":"Dirty intro"}"#);
        write(root.join("demo.sb"), r#"{"title":"Dirty demo"}"#);

        let discarded = adapter.discard_file("intro.sk").unwrap().unwrap();

        assert_eq!(discarded.path.as_path(), Path::new("intro.sk"));
        assert_eq!(read(root.join("intro.sk")), r#"{"title":"Base intro"}"#);
        assert_eq!(read(root.join("demo.sb")), r#"{"title":"Dirty demo"}"#);
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
    fn delete_variation_removes_non_current_variation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write(root.join("intro.sk"), r#"{"title":"Base"}"#);

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        let base = adapter.save_version("Base").unwrap();
        let alternate = adapter
            .create_variation_from_with_metadata(
                base.id(),
                "delete-me",
                Some("Delete me"),
                Some("delete-me"),
            )
            .unwrap();

        adapter.delete_variation(alternate.id()).unwrap();
        let names: Vec<_> = adapter
            .variations()
            .unwrap()
            .into_iter()
            .map(|variation| variation.name)
            .collect();

        assert!(!names.iter().any(|name| name == "delete-me"));
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
        init_bare_main_remote(&remote);

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
    fn github_remote_url_detection_accepts_only_github_hosts() {
        assert!(is_github_remote_url(
            "https://github.com/sethjuarez/cutready.git"
        ));
        assert!(is_github_remote_url(
            "git@github.com:sethjuarez/cutready.git"
        ));
        assert!(is_github_remote_url(
            "ssh://git@github.com/sethjuarez/cutready.git"
        ));
        assert!(!is_github_remote_url(
            "https://github.example.com/sethjuarez/cutready.git"
        ));
        assert!(!is_github_remote_url(
            "https://example.com/github.com/sethjuarez/cutready.git"
        ));
    }

    #[test]
    fn existing_plain_git_project_opens_as_draftline_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        init_legacy_git_repo(root);
        configure_identity(root, "Legacy User", "legacy@example.com");
        write(root.join("intro.sk"), r#"{"title":"Legacy intro"}"#);
        write(root.join("demo.sb"), r#"{"title":"Legacy board"}"#);
        write(root.join("notes.md"), "# Legacy notes\n");
        write(root.join(".cutready/locks.json"), r#"{"notes":{}}"#);
        commit_all(root, "legacy cutready snapshot");

        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();

        assert!(root.join(".git/draftline").exists());
        assert!(adapter.inspect_changes().unwrap().is_empty());
        let summary = adapter.workspace_summary().unwrap();
        assert!(summary.versions.len() >= 1);

        write(root.join("intro.sk"), r#"{"title":"Legacy intro updated"}"#);
        let changes = adapter.inspect_changes().unwrap();
        assert_eq!(changes.files.len(), 1);
        assert_eq!(changes.files[0].path.as_path(), Path::new("intro.sk"));
    }

    #[test]
    fn sync_status_reports_incoming_versions_after_fetch() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        init_bare_main_remote(&remote);

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
        init_bare_main_remote(&remote);

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

    #[test]
    fn automatic_pre_push_milestone_range_is_blocked_when_it_crosses_merge_commit() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        init_bare_main_remote(&remote);

        let first_root = temp.path().join("first");
        write(first_root.join("intro.sk"), r#"{"title":"Base"}"#);
        let first = CutReadyDraftlineAdapter::open_project(&first_root).unwrap();
        configure_identity(&first_root, "Seth", "seth@example.com");
        first
            .add_remote("origin", remote.to_str().unwrap())
            .unwrap();
        first.save_version("Base").unwrap();
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
        write(second_root.join("remote.md"), "# Remote note\n");
        second.save_version("Remote note").unwrap();
        second
            .publish_changes_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();

        write(first_root.join("local.md"), "# Local note\n");
        first.save_version("Local note").unwrap();
        first
            .fetch_remote_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();
        let merge_report = first.preflight_merge_incoming("origin").unwrap();
        assert!(merge_report.can_merge_cleanly);
        let merge_result = first
            .merge_incoming_with_options(
                merge_report.token.unwrap(),
                "Merge incoming note",
                &mut cutready_remote_options(None),
            )
            .unwrap();

        write(first_root.join("post-merge-one.md"), "# Post merge one\n");
        first.save_version("Post merge one").unwrap();
        write(first_root.join("post-merge-two.md"), "# Post merge two\n");
        let head = first.save_version("Post merge two").unwrap();

        let status = first.sync_status("origin").unwrap();
        assert_eq!(status.behind, 0);
        assert!(status.ahead >= 3);

        let candidates = first
            .workspace
            .history_compaction_candidates(draftline::HistoryCompactionCandidatesRequest {
                target_variation: Some(draftline::VariationId::from("main")),
                selected_version: head.id().clone(),
                remote: Some("origin".to_string()),
                preserve_named_branches: true,
                preserve_merge_boundaries: true,
            })
            .unwrap();
        let merge_endpoint = candidates
            .candidates
            .iter()
            .find(|candidate| {
                candidate.include_range.start == *merge_result.version.id()
                    && candidate.include_range.end == *head.id()
            })
            .expect(
                "candidate should include the full local-ahead range ending at the merge commit",
            );

        assert!(!merge_endpoint.can_compact);
        assert!(merge_endpoint.blockers.iter().any(|blocker| {
            blocker.code == draftline::CleanupWarningCode::MergeBoundaryRequiresUserChoice
                && blocker.message.contains("crosses merge commit")
        }));

        let error = first
            .workspace
            .preview_history_cleanup(draftline::HistoryCleanupRequest {
                target_variation: Some(draftline::VariationId::from("main")),
                base: draftline::CleanupBase::Auto,
                mode: draftline::CleanupMode::CompactMilestones {
                    milestones: vec![draftline::MilestoneSpec {
                        title: "Invalid merge-crossing milestone".to_string(),
                        description: None,
                        include_range: draftline::CommitRange {
                            start: merge_result.version.id().clone(),
                            end: head.id().clone(),
                        },
                    }],
                    preserve_named_branches: true,
                    preserve_merge_boundaries: true,
                },
                safety: draftline::CleanupSafety {
                    create_backup_ref: true,
                    backup_ref_name: None,
                    require_clean_worktree: true,
                },
                remote_policy: draftline::RemoteRewritePolicy::LocalOnly,
            })
            .unwrap_err();

        assert!(
            matches!(error, draftline::DraftlineError::InvalidHistoryCleanup(ref message) if message.contains("crosses merge commit")),
            "expected invalid cleanup across merge commit, got {error:?}"
        );
    }

    #[test]
    fn two_client_remote_conflict_drill_preserves_resolved_content_and_runtime_state() {
        let temp = tempfile::tempdir().unwrap();
        let remote = temp.path().join("remote.git");
        init_bare_main_remote(&remote);

        let first_root = temp.path().join("first");
        write(
            first_root.join("intro.sk"),
            r#"{"title":"Intro","description":"Base","rows":[{"time":"0:00","duration_seconds":5,"narrative":"Base narration","demo_actions":"Base action","screenshot":"screenshots/base.png","visual":".cutready/visuals/base.json"}]}"#,
        );
        write(
            first_root.join("demo.sb"),
            r#"{"title":"Demo","description":"Base board","items":[{"type":"sketch","path":"intro.sk"}]}"#,
        );
        write(first_root.join("notes.md"), "# Demo notes\n\nBase note.\n");
        write(
            first_root.join(".cutready/visuals/base.json"),
            r#"{"version":"2.0","scene":{"title":"Base"}}"#,
        );
        write(
            first_root.join(".chats/legacy.chat"),
            r#"{"title":"Legacy"}"#,
        );
        write(
            first_root.join(".cutready/memory.json"),
            r#"{"memories":[]}"#,
        );
        write(first_root.join(".cutready/locks.json"), r#"{"notes":{}}"#);

        let first = CutReadyDraftlineAdapter::open_project(&first_root).unwrap();
        configure_identity(&first_root, "Seth", "seth@example.com");
        first
            .add_remote("origin", remote.to_str().unwrap())
            .unwrap();
        first.save_version("Initial demo project").unwrap();
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

        write(
            second_root.join("intro.sk"),
            r#"{"title":"Intro from remote","description":"Remote description","rows":[{"time":"0:00","duration_seconds":8,"narrative":"Remote narration","demo_actions":"Remote action","screenshot":"screenshots/remote.png","visual":".cutready/visuals/remote.json"}]}"#,
        );
        write(
            second_root.join("demo.sb"),
            r#"{"title":"Remote board","description":"Remote board description","items":[{"type":"section","title":"Remote setup"},{"type":"sketch","path":"intro.sk"}]}"#,
        );
        write(
            second_root.join("notes.md"),
            "# Demo notes\n\nRemote note.\n",
        );
        write(
            second_root.join(".cutready/visuals/remote.json"),
            r#"{"version":"2.0","scene":{"title":"Remote"}}"#,
        );
        second.save_version("Remote collaboration edits").unwrap();
        second
            .publish_changes_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();

        write(
            first_root.join("intro.sk"),
            r#"{"title":"Intro from local","description":"Local description","rows":[{"time":"0:00","duration_seconds":13,"narrative":"Local narration","demo_actions":"Local action","screenshot":"screenshots/local.png","visual":".cutready/visuals/local.json"}]}"#,
        );
        write(
            first_root.join("demo.sb"),
            r#"{"title":"Local board","description":"Local board description","items":[{"type":"sketch","path":"intro.sk"},{"type":"section","title":"Local close"}]}"#,
        );
        write(first_root.join("notes.md"), "# Demo notes\n\nLocal note.\n");
        write(
            first_root.join(".cutready/visuals/local.json"),
            r#"{"version":"2.0","scene":{"title":"Local"}}"#,
        );
        first.save_version("Local collaboration edits").unwrap();
        first
            .fetch_remote_with_options("origin", &mut cutready_remote_options(None))
            .unwrap();

        let report = first.preflight_merge_incoming("origin").unwrap();
        assert!(!report.can_merge_cleanly);
        assert!(report
            .conflicts
            .iter()
            .any(|conflict| conflict.path == Path::new("intro.sk")));
        assert!(report
            .conflicts
            .iter()
            .any(|conflict| conflict.path == Path::new("demo.sb")));
        assert!(report
            .conflicts
            .iter()
            .any(|conflict| conflict.path == Path::new("notes.md")));
        let token = report.token.unwrap();

        let resolved_sketch = r#"{"title":"Resolved intro","description":"Combined description","rows":[{"time":"0:00","duration_seconds":13,"narrative":"Local narration + remote note","demo_actions":"Remote action","screenshot":"screenshots/local.png","visual":".cutready/visuals/remote.json"}]}"#;
        let resolved_storyboard = r#"{"title":"Resolved board","description":"Combined board","items":[{"type":"section","title":"Remote setup"},{"type":"sketch","path":"intro.sk"},{"type":"section","title":"Local close"}]}"#;
        let resolved_notes = "# Demo notes\n\nLocal note.\n\nRemote note.\n";
        let result = first
            .merge_incoming_with_resolutions_and_options(
                token,
                "Resolve collaboration drill",
                vec![
                    MergeConflictResolution::new(
                        "intro.sk",
                        draftline::MergeResolutionChoice::UseContent {
                            content: resolved_sketch.to_string(),
                        },
                    ),
                    MergeConflictResolution::new(
                        "demo.sb",
                        draftline::MergeResolutionChoice::UseContent {
                            content: resolved_storyboard.to_string(),
                        },
                    ),
                    MergeConflictResolution::new(
                        "notes.md",
                        draftline::MergeResolutionChoice::UseContent {
                            content: resolved_notes.to_string(),
                        },
                    ),
                ],
                &mut cutready_remote_options(None),
            )
            .unwrap();

        assert!(result
            .merged_files
            .iter()
            .any(|path| path == Path::new("intro.sk")));
        assert_eq!(read(first_root.join("intro.sk")), resolved_sketch);
        assert_eq!(read(first_root.join("demo.sb")), resolved_storyboard);
        assert_eq!(read(first_root.join("notes.md")), resolved_notes);
        assert!(read(first_root.join(".cutready/visuals/local.json")).contains("Local"));
        assert!(read(first_root.join(".cutready/visuals/remote.json")).contains("Remote"));
        assert!(first_root.join(".chats/legacy.chat").exists());
        assert!(first_root.join(".cutready/memory.json").exists());
        assert!(!first_root.join(".git/cutready/locks.json").exists());
        assert!(first.inspect_changes().unwrap().is_empty());
    }

    fn acting_as(name: &str, email: Option<&str>) -> ResolvedIdentity {
        use crate::engine::identity::{Identity, IdentitySource};
        ResolvedIdentity {
            name: name.into(),
            email: email.map(str::to_string),
            name_source: IdentitySource::Profile,
            email_source: email.map(|_| IdentitySource::Profile),
            profile: email.map(|email| Identity {
                name: name.into(),
                email: Some(email.into()),
            }),
            needs_setup: email.is_none(),
        }
    }

    const MANIFEST: &str = ".cutready/projects.json";

    struct Head {
        id: git2::Oid,
        author: String,
        committer: String,
        paths: Vec<String>,
    }

    fn head(root: &Path) -> Head {
        let repo = git2::Repository::open(root).unwrap();
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        let parent_tree = commit.parent(0).ok().map(|parent| parent.tree().unwrap());
        let diff = repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree().unwrap()), None)
            .unwrap();
        let paths = diff
            .deltas()
            .filter_map(|delta| delta.new_file().path().or(delta.old_file().path()))
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();
        let author = commit.author();
        let committer = commit.committer();
        let result = Head {
            id: commit.id(),
            author: format!("{} <{}>", author.name().unwrap(), author.email().unwrap()),
            committer: format!(
                "{} <{}>",
                committer.name().unwrap(),
                committer.email().unwrap()
            ),
            paths,
        };
        result
    }

    fn pending(adapter: &CutReadyDraftlineAdapter) -> Vec<String> {
        adapter
            .changed_files()
            .unwrap()
            .into_iter()
            .map(|file| file.path.to_string_lossy().replace('\\', "/"))
            .collect()
    }

    fn grace() -> Result<ResolvedIdentity, String> {
        Ok(acting_as("Grace Hopper", Some("grace@example.com")))
    }

    /// A saved workspace with a manifest and one project, attributed to Ada.
    fn structure_repo(root: &Path) -> CutReadyDraftlineAdapter {
        write(
            root.join(MANIFEST),
            r#"{"projects":[{"path":"demo","name":"Demo"}]}"#,
        );
        write(root.join("demo/intro.sk"), "{}");
        let adapter = CutReadyDraftlineAdapter::open_project(root).unwrap();
        configure_identity(root, "Git Config", "git-config@example.com");
        adapter
            .save_version_with_profile(
                "Initial",
                &contributor_profile_for(acting_as("Ada Lovelace", Some("ada@example.com"))),
            )
            .unwrap();
        adapter
    }

    fn add_project(root: &Path) {
        write(
            root.join(MANIFEST),
            r#"{"projects":[{"path":"demo","name":"Demo"},{"path":"extra","name":"Extra"}]}"#,
        );
    }

    #[test]
    fn structure_change_is_authored_by_the_acting_user() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);

        let change = StructureChange::begin(root, "Add Extra to workspace", [MANIFEST]).unwrap();
        add_project(root);
        let result = change.finish(root, grace()).unwrap();

        assert_eq!(result, StructureSnapshot::Saved);
        assert!(pending(&adapter).is_empty());
        let head = head(root);
        assert_eq!(
            head.author, "Grace Hopper <grace@example.com>",
            "profile beats git config"
        );
        assert_eq!(head.committer, "CutReady <app@cutready.local>");
    }

    #[test]
    fn structure_change_holds_the_shared_write_lock() {
        use std::sync::mpsc;
        use std::time::Duration;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        structure_repo(root);
        let change = StructureChange::begin(root, "Add Extra to workspace", [MANIFEST]).unwrap();

        let (started_tx, started_rx) = mpsc::channel();
        let (acquired_tx, acquired_rx) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let _guard = crate::engine::workspace_write_lock::lock().unwrap();
            acquired_tx.send(()).unwrap();
        });

        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(acquired_rx.recv_timeout(Duration::from_millis(50)).is_err());

        drop(change);
        acquired_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        writer.join().unwrap();
    }

    #[test]
    fn structure_change_leaves_unrelated_pending_work_alone() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);
        write(root.join("demo/notes.md"), "draft");

        let change = StructureChange::begin(root, "Add Extra to workspace", [MANIFEST]).unwrap();
        add_project(root);
        let result = change.finish(root, grace()).unwrap();

        assert_eq!(result, StructureSnapshot::Saved);
        assert_eq!(head(root).paths, vec![MANIFEST.to_string()]);
        assert_eq!(pending(&adapter), vec!["demo/notes.md".to_string()]);
    }

    #[test]
    fn structure_change_defers_when_its_files_had_unsaved_edits() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);
        write(root.join(MANIFEST), r#"{"projects":[]}"#);
        let before = head(root).id;

        let change = StructureChange::begin(root, "Add Extra to workspace", [MANIFEST]).unwrap();
        add_project(root);
        let result = change.finish(root, grace()).unwrap();

        assert_eq!(
            result,
            StructureSnapshot::Deferred {
                reason: DeferReason::UnsavedEdits,
                message: format!(
                    "\"Add Extra to workspace\" is in your pending changes. {STRUCTURE_SNAPSHOT_UNSAVED_HINT}"
                ),
            }
        );
        assert_eq!(head(root).id, before);
        assert_eq!(pending(&adapter), vec![MANIFEST.to_string()]);
    }

    #[test]
    fn whole_workspace_change_defers_on_any_unsaved_edit() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        structure_repo(root);
        write(root.join("demo/notes.md"), "draft");
        let before = head(root).id;

        let change = StructureChange::begin(root, "Organize workspace projects", ["."]).unwrap();
        add_project(root);
        let result = change.finish(root, grace()).unwrap();

        assert!(matches!(
            result,
            StructureSnapshot::Deferred {
                reason: DeferReason::UnsavedEdits,
                ..
            }
        ));
        assert_eq!(head(root).id, before);
    }

    #[test]
    fn structure_change_records_moved_project_folders() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);

        let change =
            StructureChange::begin(root, "Rename workspace project", [MANIFEST, "demo"]).unwrap();
        std::fs::rename(root.join("demo"), root.join("renamed")).unwrap();
        write(
            root.join(MANIFEST),
            r#"{"projects":[{"path":"renamed","name":"Renamed"}]}"#,
        );
        let result = change.touching("renamed").finish(root, grace()).unwrap();

        assert_eq!(result, StructureSnapshot::Saved);
        assert!(pending(&adapter).is_empty(), "{:?}", pending(&adapter));
        let mut paths = head(root).paths;
        paths.sort();
        assert_eq!(paths, vec![MANIFEST, "demo/intro.sk", "renamed/intro.sk"]);
    }

    #[test]
    fn deleting_a_project_with_unsaved_edits_still_saves() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);
        write(root.join("demo/intro.sk"), r#"{"title":"unsaved"}"#);

        let change = StructureChange::begin(root, "Delete workspace project", [MANIFEST]).unwrap();
        std::fs::remove_dir_all(root.join("demo")).unwrap();
        write(root.join(MANIFEST), r#"{"projects":[]}"#);
        let result = change.removing("demo").finish(root, grace()).unwrap();

        assert_eq!(result, StructureSnapshot::Saved);
        assert!(pending(&adapter).is_empty(), "{:?}", pending(&adapter));
    }

    #[test]
    fn renaming_only_the_display_name_ignores_dirty_project_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);
        write(root.join("demo/intro.sk"), r#"{"title":"unsaved"}"#);

        let change = StructureChange::begin(root, "Rename workspace project", [MANIFEST]).unwrap();
        write(
            root.join(MANIFEST),
            r#"{"projects":[{"path":"demo","name":"Renamed"}]}"#,
        );
        let result = change.finish(root, grace()).unwrap();

        assert_eq!(result, StructureSnapshot::Saved);
        assert_eq!(pending(&adapter), vec!["demo/intro.sk".to_string()]);
    }

    #[test]
    fn structure_change_defers_without_an_email() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);
        let before = head(root).id;

        let change = StructureChange::begin(root, "Add Extra to workspace", [MANIFEST]).unwrap();
        add_project(root);
        let result = change.finish(root, Ok(acting_as("sejuare", None))).unwrap();

        assert_eq!(
            result,
            StructureSnapshot::Deferred {
                reason: DeferReason::Identity,
                message: format!(
                    "\"Add Extra to workspace\" is in your pending changes. {STRUCTURE_SNAPSHOT_DEFERRED_HINT}"
                ),
            }
        );
        assert_eq!(head(root).id, before, "no anonymous commit");
        assert_eq!(pending(&adapter), vec![MANIFEST.to_string()]);
    }

    #[test]
    fn structure_change_defers_when_only_git_config_identity_is_available() {
        use crate::engine::identity::IdentitySource;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);

        let change = StructureChange::begin(root, "Add Extra to workspace", [MANIFEST]).unwrap();
        add_project(root);
        let author = ResolvedIdentity {
            name: "Git Config".into(),
            email: Some("git-config@example.com".into()),
            name_source: IdentitySource::GitConfig,
            email_source: Some(IdentitySource::GitConfig),
            profile: None,
            needs_setup: false,
        };
        let result = change.finish(root, Ok(author)).unwrap();

        assert!(matches!(
            result,
            StructureSnapshot::Deferred {
                reason: DeferReason::Identity,
                ..
            }
        ));
        assert_eq!(head(root).author, "Ada Lovelace <ada@example.com>");
        assert_eq!(pending(&adapter), vec![MANIFEST.to_string()]);
    }

    #[test]
    fn structure_change_defers_when_profile_email_would_fall_back_to_git_config() {
        use crate::engine::identity::{Identity, IdentitySource};

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);

        let change = StructureChange::begin(root, "Add Extra to workspace", [MANIFEST]).unwrap();
        add_project(root);
        let author = ResolvedIdentity {
            name: "Grace Hopper".into(),
            email: Some("git-config@example.com".into()),
            name_source: IdentitySource::Profile,
            email_source: Some(IdentitySource::GitConfig),
            profile: Some(Identity {
                name: "Grace Hopper".into(),
                email: None,
            }),
            needs_setup: false,
        };
        let result = change.finish(root, Ok(author)).unwrap();

        assert!(matches!(
            result,
            StructureSnapshot::Deferred {
                reason: DeferReason::Identity,
                ..
            }
        ));
        assert_eq!(head(root).author, "Ada Lovelace <ada@example.com>");
        assert_eq!(pending(&adapter), vec![MANIFEST.to_string()]);
    }

    #[test]
    fn structure_change_defers_when_the_profile_is_unreadable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        structure_repo(root);
        let before = head(root).id;

        let change = StructureChange::begin(root, "Add Extra to workspace", [MANIFEST]).unwrap();
        add_project(root);
        let result = change
            .finish(
                root,
                Err("Couldn't read your saved profile: bad json.".into()),
            )
            .unwrap();

        assert_eq!(
            result,
            StructureSnapshot::Deferred {
                reason: DeferReason::Identity,
                message: format!(
                    "\"Add Extra to workspace\" is in your pending changes. Couldn't read your saved profile: bad json. {STRUCTURE_SNAPSHOT_DEFERRED_HINT}"
                ),
            }
        );
        assert_eq!(head(root).id, before);
    }

    #[test]
    fn structure_change_is_clean_when_its_files_are_not_versioned() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let adapter = structure_repo(root);
        write(root.join("demo/notes.md"), "draft");

        let change = StructureChange::begin(
            root,
            "Update workspace settings",
            [".cutready/settings.json"],
        )
        .unwrap();
        write(root.join(".cutready/settings.json"), r#"{"theme":"dark"}"#);
        let result = change.finish(root, Err("no profile".into())).unwrap();

        assert_eq!(result, StructureSnapshot::Clean);
        assert_eq!(pending(&adapter), vec!["demo/notes.md".to_string()]);
    }
}
