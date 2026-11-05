//! Project storage engine — folder-based projects with .sk/.sb files.
//!
//! A project is any folder containing `.sk` (sketch) and/or `.sb` (storyboard)
//! files. A repo can host one project (legacy) or many (manifest-driven).
//!
//!   my-demos/                   (repo root, has .git/)
//!     ├── .cutready/
//!     │   └── projects.json     (manifest listing project subdirs)
//!     ├── login-flow/           (project 1)
//!     │   ├── sketches/
//!     │   └── notes/
//!     ├── onboarding/           (project 2)
//!     └── storyboards/          (repo-level storyboards)

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::engine::document_writer::{self, Expected};
use crate::engine::draftline_adapter::CutReadyDraftlineAdapter;
use crate::models::script::{ProjectEntry, ProjectManifest, ProjectView, RepoView};
use cutready_core::assets::{
    extract_screenshot_refs, extract_sketch_screenshot_refs, extract_sketch_visual_refs,
    replace_sketch_screenshot_references, replace_sketch_visual_references,
    rewrite_markdown_screenshot_refs,
};
use cutready_core::document::{self, VisualFile};
use cutready_core::edit_ops;
use cutready_core::models::sketch::{
    NoteSummary, Sketch, SketchSummary, Storyboard, StoryboardSummary,
};
pub use cutready_core::notes::NoteLockState;
use cutready_core::notes::{self, normalize_lock_path, LockManifest, LOCKS_PATH};
use cutready_core::sketch_edits;

/// Sidebar ordering manifest stored in `.cutready-order.json`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct SidebarOrder {
    #[serde(default)]
    pub storyboards: Vec<String>,
    #[serde(default)]
    pub sketches: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

// ── Path safety ────────────────────────────────────────────────────

/// Resolve a user-provided relative path against a project root,
/// ensuring the result stays within the project directory.
///
/// Rejects absolute paths, drive-less root paths, `..` traversal, and any
/// result that escapes root.
pub fn safe_resolve(root: &Path, relative_path: &str) -> Result<PathBuf, ProjectError> {
    let rel = Path::new(relative_path);

    // Reject absolute paths
    if rel.is_absolute() {
        return Err(ProjectError::PathTraversal(relative_path.to_string()));
    }

    // Reject any component that is "..", root-relative, or has a prefix (e.g., C:).
    // On Windows, `/foo` is a drive-less root path: `Path::is_absolute()` is
    // false, but `root.join("/foo")` escapes to the drive root.
    for component in rel.components() {
        match component {
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(ProjectError::PathTraversal(relative_path.to_string()));
            }
            _ => {}
        }
    }

    let resolved = root.join(rel);

    // Belt-and-suspenders: when the file or its parent exists on disk,
    // canonicalize and verify containment within root.
    if let Ok(canonical_root) = root.canonicalize() {
        let check = if resolved.exists() {
            resolved.canonicalize().ok()
        } else if let Some(parent) = resolved.parent() {
            parent
                .canonicalize()
                .ok()
                .map(|p| p.join(resolved.file_name().unwrap_or_default()))
        } else {
            None
        };

        if let Some(canonical_resolved) = check {
            if !canonical_resolved.starts_with(&canonical_root) {
                return Err(ProjectError::PathTraversal(relative_path.to_string()));
            }
        }
        // If neither file nor parent exist, we rely on the component check above
    }

    Ok(resolved)
}

// ── Project folder operations ──────────────────────────────────────

/// Initialize a new project in the given folder.
///
/// Creates the folder if it doesn't exist, initializes Draftline, and returns a ProjectView.
pub fn init_project_folder(root: &Path) -> Result<ProjectView, ProjectError> {
    let created = !root.exists();
    std::fs::create_dir_all(root).map_err(|e| ProjectError::Io(e.to_string()))?;

    // Draftline owns workspace initialization and existing-workspace detection.
    if let Err(error) = CutReadyDraftlineAdapter::open_project(root) {
        if created && is_workspace_claim_error(&error) {
            // Leave no empty folder behind for a refused new project.
            let _ = std::fs::remove_dir(root);
        }
        return Err(draftline_open_error(error));
    }

    Ok(ProjectView::new(root.to_path_buf()))
}

/// A repository's committed `.draftline` marker names the one folder Draftline
/// manages; opening any other folder, or a broken marker, is refused.
fn is_workspace_claim_error(error: &draftline::DraftlineError) -> bool {
    matches!(
        error,
        draftline::DraftlineError::FolderIsElsewhere(_)
            | draftline::DraftlineError::FolderMissing(_)
            | draftline::DraftlineError::InvalidFolderMarker(_)
            | draftline::DraftlineError::NewerFolderMarker(_)
            | draftline::DraftlineError::RecoveryInOtherFolder(_)
    )
}

/// Keep Draftline's code and details on workspace-claim refusals so the UI can
/// name the folder that holds the repository's CutReady project.
fn draftline_open_error(error: draftline::DraftlineError) -> ProjectError {
    if !is_workspace_claim_error(&error) {
        return ProjectError::Io(error.to_string());
    }
    let error = draftline::tauri_contract::TauriCommandError::from(error);
    match serde_json::to_string(&error) {
        Ok(json) => ProjectError::Draftline(json),
        Err(_) => ProjectError::Io(error.message),
    }
}

// ── Multi-project manifest ────────────────────────────────────────

pub const MANIFEST_PATH: &str = ".cutready/projects.json";

/// Workspace manifest health state.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceManifestStatus {
    Valid,
    Missing,
    Malformed,
}

/// A manifest entry that points at an unsafe, missing, or non-project folder.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceManifestIssue {
    pub entry: ProjectEntry,
    pub reason: String,
}

/// Inspection result for `.cutready/projects.json` recovery UI and tooling.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceManifestInspection {
    pub status: WorkspaceManifestStatus,
    pub manifest_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<ProjectManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<String>,
    pub legacy_single_project_fallback: bool,
    pub stale_entries: Vec<WorkspaceManifestIssue>,
    pub unlisted_projects: Vec<ProjectEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposed_manifest: Option<ProjectManifest>,
}

/// Result from an explicit manifest repair.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceManifestRepair {
    pub inspection: WorkspaceManifestInspection,
    pub manifest: ProjectManifest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

/// Read the project manifest from a repo root. Returns None if no manifest
/// exists (single-project / legacy mode).
pub fn read_manifest(repo_root: &Path) -> Option<ProjectManifest> {
    read_manifest_result(repo_root).ok().flatten()
}

/// Read the project manifest while preserving I/O and parse errors.
pub fn read_manifest_result(repo_root: &Path) -> Result<Option<ProjectManifest>, ProjectError> {
    let path = repo_root.join(MANIFEST_PATH);
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data)
        .map(Some)
        .map_err(|e| ProjectError::Deserialize(e.to_string()))
}

/// Write the project manifest to a repo root.
pub fn write_manifest(repo_root: &Path, manifest: &ProjectManifest) -> Result<(), ProjectError> {
    let path = repo_root.join(MANIFEST_PATH);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    let json =
        serde_json::to_string_pretty(manifest).map_err(|e| ProjectError::Io(e.to_string()))?;
    std::fs::write(&path, json).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Inspect workspace manifest health without mutating the workspace.
pub fn inspect_workspace_manifest(
    repo_root: &Path,
) -> Result<WorkspaceManifestInspection, ProjectError> {
    let legacy_single_project_fallback = looks_like_project_folder(repo_root);
    let discovered_projects = discover_child_projects(repo_root)?;

    match read_manifest_result(repo_root) {
        Ok(Some(manifest)) => {
            let stale_entries = stale_manifest_entries(repo_root, &manifest.projects);
            let unlisted_projects =
                unlisted_child_projects(&manifest.projects, &discovered_projects);
            let proposed_manifest = repaired_manifest(
                manifest.projects.clone(),
                &stale_entries,
                &unlisted_projects,
                None,
            );
            Ok(WorkspaceManifestInspection {
                status: WorkspaceManifestStatus::Valid,
                manifest_path: display_repo_relative(MANIFEST_PATH),
                manifest: Some(manifest),
                parse_error: None,
                legacy_single_project_fallback,
                stale_entries,
                unlisted_projects,
                proposed_manifest: Some(proposed_manifest),
            })
        }
        Ok(None) => {
            let fallback_entry = legacy_single_project_fallback.then(|| ProjectEntry {
                path: ".".into(),
                name: repo_root
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Project".into()),
                description: None,
            });
            let proposed_manifest = if discovered_projects.is_empty() {
                None
            } else {
                Some(repaired_manifest(
                    Vec::new(),
                    &[],
                    &discovered_projects,
                    fallback_entry,
                ))
            };
            Ok(WorkspaceManifestInspection {
                status: WorkspaceManifestStatus::Missing,
                manifest_path: display_repo_relative(MANIFEST_PATH),
                manifest: None,
                parse_error: None,
                legacy_single_project_fallback,
                stale_entries: Vec::new(),
                unlisted_projects: discovered_projects,
                proposed_manifest,
            })
        }
        Err(err @ ProjectError::Deserialize(_)) => {
            let fallback_entry = legacy_single_project_fallback.then(|| ProjectEntry {
                path: ".".into(),
                name: repo_root
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Project".into()),
                description: None,
            });
            let proposed_manifest =
                repaired_manifest(Vec::new(), &[], &discovered_projects, fallback_entry);
            Ok(WorkspaceManifestInspection {
                status: WorkspaceManifestStatus::Malformed,
                manifest_path: display_repo_relative(MANIFEST_PATH),
                manifest: None,
                parse_error: Some(err.to_string()),
                legacy_single_project_fallback,
                stale_entries: Vec::new(),
                unlisted_projects: discovered_projects,
                proposed_manifest: Some(proposed_manifest),
            })
        }
        Err(err) => Err(err),
    }
}

/// Explicitly repair `.cutready/projects.json` from the current inspection.
///
/// Missing manifests are only written when child project folders were discovered.
/// Malformed manifests are backed up before replacement.
pub fn repair_workspace_manifest(
    repo_root: &Path,
) -> Result<WorkspaceManifestRepair, ProjectError> {
    let inspection = inspect_workspace_manifest(repo_root)?;
    let manifest = inspection
        .proposed_manifest
        .clone()
        .ok_or_else(|| ProjectError::Io("No workspace manifest repair is available".into()))?;

    validate_manifest_entries(&manifest)?;
    let backup_path = if inspection.status == WorkspaceManifestStatus::Malformed {
        Some(backup_malformed_manifest(repo_root)?)
    } else {
        None
    };
    write_manifest(repo_root, &manifest)?;

    Ok(WorkspaceManifestRepair {
        inspection,
        manifest,
        backup_path,
    })
}

fn repaired_manifest(
    current_entries: Vec<ProjectEntry>,
    stale_entries: &[WorkspaceManifestIssue],
    unlisted_projects: &[ProjectEntry],
    fallback_entry: Option<ProjectEntry>,
) -> ProjectManifest {
    let stale_paths = stale_entries
        .iter()
        .map(|issue| issue.entry.path.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut projects = current_entries
        .into_iter()
        .filter(|entry| !stale_paths.contains(entry.path.as_str()))
        .collect::<Vec<_>>();

    if projects.is_empty() {
        if let Some(entry) = fallback_entry {
            projects.push(entry);
        }
    }

    for project in unlisted_projects {
        if !projects.iter().any(|entry| entry.path == project.path) {
            projects.push(project.clone());
        }
    }

    ProjectManifest { projects }
}

fn stale_manifest_entries(
    repo_root: &Path,
    entries: &[ProjectEntry],
) -> Vec<WorkspaceManifestIssue> {
    entries
        .iter()
        .filter_map(|entry| match validate_manifest_entry_path(&entry.path) {
            Ok(()) => {
                let project_root = if entry.path == "." {
                    repo_root.to_path_buf()
                } else {
                    repo_root.join(&entry.path)
                };
                if !project_root.exists() {
                    Some(WorkspaceManifestIssue {
                        entry: entry.clone(),
                        reason: "missing_folder".into(),
                    })
                } else if !project_root.is_dir() {
                    Some(WorkspaceManifestIssue {
                        entry: entry.clone(),
                        reason: "not_a_folder".into(),
                    })
                } else if !looks_like_project_folder(&project_root) {
                    Some(WorkspaceManifestIssue {
                        entry: entry.clone(),
                        reason: "not_project_like".into(),
                    })
                } else {
                    None
                }
            }
            Err(reason) => Some(WorkspaceManifestIssue {
                entry: entry.clone(),
                reason,
            }),
        })
        .collect()
}

fn unlisted_child_projects(
    manifest_projects: &[ProjectEntry],
    discovered_projects: &[ProjectEntry],
) -> Vec<ProjectEntry> {
    discovered_projects
        .iter()
        .filter(|project| {
            !manifest_projects
                .iter()
                .any(|entry| entry.path == project.path)
        })
        .cloned()
        .collect()
}

fn discover_child_projects(repo_root: &Path) -> Result<Vec<ProjectEntry>, ProjectError> {
    let mut projects = Vec::new();
    for entry in std::fs::read_dir(repo_root).map_err(|e| ProjectError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || validate_manifest_entry_path(&name).is_err() {
            continue;
        }
        if looks_like_project_folder(&path) {
            projects.push(ProjectEntry {
                path: name.clone(),
                name,
                description: None,
            });
        }
    }
    projects.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(projects)
}

fn looks_like_project_folder(project_root: &Path) -> bool {
    if !project_root.is_dir() {
        return false;
    }

    for marker in ["sketches", "storyboards", "notes"] {
        if project_root.join(marker).is_dir() {
            return true;
        }
    }
    for marker in [
        ".cutready/settings.json",
        ".cutready/screenshots",
        ".cutready/visuals",
    ] {
        if project_root.join(marker).exists() {
            return true;
        }
    }

    let Ok(entries) = std::fs::read_dir(project_root) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        entry.path().is_file()
            && entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| matches!(ext, "sk" | "sb" | "md"))
    })
}

fn backup_malformed_manifest(repo_root: &Path) -> Result<String, ProjectError> {
    let manifest_path = repo_root.join(MANIFEST_PATH);
    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S%.3f");
    let backup_relative = format!(".cutready/projects.recovery-{timestamp}.json");
    let backup_path = repo_root.join(&backup_relative);
    std::fs::copy(&manifest_path, &backup_path).map_err(|e| ProjectError::Io(e.to_string()))?;
    Ok(display_repo_relative(&backup_relative))
}

fn validate_manifest_entries(manifest: &ProjectManifest) -> Result<(), ProjectError> {
    for entry in &manifest.projects {
        validate_manifest_entry_path(&entry.path).map_err(ProjectError::PathTraversal)?;
    }
    Ok(())
}

fn validate_manifest_entry_path(path: &str) -> Result<(), String> {
    if path == "." {
        return Ok(());
    }
    let path_ref = Path::new(path);
    if path_ref.as_os_str().is_empty() || path_ref.is_absolute() {
        return Err("invalid_path".into());
    }
    if path_ref.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
                | std::path::Component::CurDir
        )
    }) {
        return Err("invalid_path".into());
    }
    Ok(())
}

fn display_repo_relative(path: &str) -> String {
    path.replace('\\', "/")
}

/// Whether this repo has a multi-project manifest.
pub fn is_multi_project(repo_root: &Path) -> bool {
    repo_root.join(MANIFEST_PATH).exists()
}

/// List projects in a repo. If no manifest exists, returns a single entry
/// representing the repo root itself (backward-compatible single-project mode).
pub fn list_projects(repo_root: &Path) -> Vec<ProjectEntry> {
    if let Some(manifest) = read_manifest(repo_root) {
        manifest.projects
    } else {
        // Legacy single-project: the repo root IS the project
        let name = repo_root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Project".into());
        vec![ProjectEntry {
            path: ".".into(),
            name,
            description: None,
        }]
    }
}

/// Opening a folder a commit renamed; details name the old and new folders.
pub const PROJECT_FOLDER_RENAMED: &str = "project_folder_renamed";

/// Opening a folder with someone else's files (typically a code repository)
/// that Draftline has never managed; details name the folder, its repository,
/// and a suggested CutReady subfolder.
pub const NOT_A_CUTREADY_PROJECT: &str = "not_a_cutready_project";

const CUTREADY_EXTENSIONS: &[&str] = &["sk", "sb", "cv"];
const PLAIN_EXTENSIONS: &[&str] = &["md", "png", "jpg", "jpeg", "gif", "webp", "svg"];
const PLAIN_FOLDERS: &[&str] = &["screenshots", "chat-artifacts", "visuals", "notes"];

/// True when `root` already holds CutReady content: its metadata folder, a
/// legacy chat folder, or a sketch/storyboard/chat artifact a few levels down.
fn has_cutready_content(root: &Path) -> bool {
    if root.join(".cutready").is_dir() || root.join(".chats").is_dir() {
        return true;
    }
    fn walk(dir: &Path, depth: usize) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        entries.flatten().any(|entry| {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                depth > 0
                    && !name.starts_with('.')
                    && name != "node_modules"
                    && walk(&path, depth - 1)
            } else {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        CUTREADY_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
                    })
            }
        })
    }
    walk(root, 2)
}

/// True when `root` itself (not a subfolder) holds CutReady content: its
/// metadata folder or a top-level sketch, storyboard, or chat artifact.
fn has_own_cutready_content(root: &Path) -> bool {
    if root.join(".cutready").is_dir() {
        return true;
    }
    std::fs::read_dir(root).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let path = entry.path();
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| {
                        CUTREADY_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
                    })
        })
    })
}

/// True when `root` has top-level files or folders CutReady never creates.
/// Hidden entries (`.git`, `.gitignore`, `.vscode`) don't count.
fn has_foreign_content(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            return false;
        }
        let path = entry.path();
        if path.is_dir() {
            return !PLAIN_FOLDERS.contains(&name.as_ref());
        }
        !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| PLAIN_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
    })
}

/// Refuse to start managing a folder that looks like someone else's work (a
/// code repository root or one of its source folders) until the user confirms.
fn refuse_unclaimed_folder(root: &Path) -> Result<(), ProjectError> {
    if !CutReadyDraftlineAdapter::is_unmanaged(root)
        || has_cutready_content(root)
        || !has_foreign_content(root)
    {
        return Ok(());
    }
    let repository = git_repository_root(root);
    let base = repository.clone().unwrap_or_else(|| root.to_path_buf());
    let suggested = base.join("cutready");
    let error = draftline::tauri_contract::TauriCommandError {
        code: NOT_A_CUTREADY_PROJECT.into(),
        message: format!(
            "`{}` isn't a CutReady project yet and has other files in it.",
            root.display()
        ),
        details: Some(serde_json::json!({
            "folder": root.to_string_lossy(),
            "repository": repository.map(|path| path.to_string_lossy().into_owned()),
            "suggested": suggested.to_string_lossy(),
            "suggested_exists": suggested.exists(),
        })),
    };
    Err(match serde_json::to_string(&error) {
        Ok(json) => ProjectError::Draftline(json),
        Err(_) => ProjectError::Io(error.message),
    })
}

/// The work-tree root of the Git repository holding `path`, if any.
fn git_repository_root(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|dir| {
            let dot_git = dir.join(".git");
            dot_git.is_file() || cutready_desktop_io::state_dir::is_git_dir(&dot_git)
        })
        .map(Path::to_path_buf)
}

/// Open a repo folder, detecting single vs multi-project mode.
/// Returns the repo view and list of projects.
///
/// Refuses (with [`NOT_A_CUTREADY_PROJECT`]) to start managing a folder that
/// has other files and no CutReady content; see [`open_repo_with`].
#[cfg(test)]
pub fn open_repo(root: &Path) -> Result<(RepoView, Vec<ProjectEntry>), ProjectError> {
    open_repo_with(root, false)
}

/// [`open_repo`], starting to manage an unrecognized folder when
/// `adopt_unrecognized` is set (the user confirmed it).
pub fn open_repo_with(
    root: &Path,
    adopt_unrecognized: bool,
) -> Result<(RepoView, Vec<ProjectEntry>), ProjectError> {
    match recover_stray_git_dir(root) {
        Ok(true) => log::warn!(
            "[project] moved stray .git state out of {} into the enclosing repository",
            root.display()
        ),
        Ok(false) => {}
        // Opening anyway would split history between two state folders and
        // keep git blind to the folder's changes.
        Err(err) => {
            return Err(ProjectError::Io(format!(
                "{} holds a leftover .git folder that hides its changes, and CutReady \
                 could not move it ({err}). Close other CutReady windows and try again.",
                root.display()
            )))
        }
    }
    let renamed = if root.is_dir() {
        // A root project whose content a commit moved into a subfolder. Only a
        // prompt: the user may keep the root (`adopt_unrecognized`), and a root
        // holding its own CutReady content again is simply opened.
        (!adopt_unrecognized && !has_own_cutready_content(root))
            .then(|| CutReadyDraftlineAdapter::renamed_project_folder(root))
            .flatten()
            .filter(|(from, _)| from.as_os_str().is_empty())
    } else {
        CutReadyDraftlineAdapter::renamed_project_folder(root)
    };
    if let Some((from, to)) = renamed {
        let moved_root = from.as_os_str().is_empty();
        let from = from.to_string_lossy().replace('\\', "/");
        let from = if from.is_empty() {
            ".".to_string()
        } else {
            from
        };
        let to_display = to.to_string_lossy().replace('\\', "/");
        let details = if moved_root {
            let suggested = root.join(&to);
            serde_json::json!({
                "folder": root.to_string_lossy(),
                "to": to_display,
                "moved_root": true,
                "repository": root.to_string_lossy(),
                "suggested": suggested.to_string_lossy(),
                "suggested_exists": suggested.is_dir(),
            })
        } else {
            serde_json::json!({ "folder": from, "to": to_display })
        };
        let error = draftline::tauri_contract::TauriCommandError {
            code: PROJECT_FOLDER_RENAMED.into(),
            message: if moved_root {
                format!("This project's content was moved to `{to_display}`.")
            } else {
                format!("The project folder `{from}` was renamed to `{to_display}`.")
            },
            details: Some(details),
        };
        return Err(match serde_json::to_string(&error) {
            Ok(json) => ProjectError::Draftline(json),
            Err(_) => ProjectError::Io(error.message),
        });
    }
    if !root.is_dir() {
        return Err(ProjectError::NotFound(root.to_string_lossy().into_owned()));
    }

    if !adopt_unrecognized {
        refuse_unclaimed_folder(root)?;
    }

    // Draftline owns workspace initialization and existing-workspace detection.
    CutReadyDraftlineAdapter::open_project(root).map_err(draftline_open_error)?;

    // Repair: move orphaned repo-level assets into the first project.
    // This fixes workspaces migrated before the asset-move fix.
    repair_orphaned_assets(root);

    let repo = RepoView::new(root.to_path_buf());
    let projects = list_projects(root);
    Ok((repo, projects))
}

/// Move orphaned `.cutready/screenshots` and `.cutready/visuals` from repo root
/// into the first project's `.cutready/` directory. This repairs workspaces that
/// were migrated to multi-project before the migration learned to move assets.
fn repair_orphaned_assets(repo_root: &Path) {
    let manifest = match read_manifest(repo_root) {
        Some(m) if !m.projects.is_empty() => m,
        _ => return, // single-project or empty — nothing to repair
    };

    // Only repair if the first project is NOT "." (i.e. truly multi-project)
    let first = &manifest.projects[0];
    if first.path == "." {
        return;
    }

    let cutready = repo_root.join(".cutready");
    let target_cutready = repo_root.join(&first.path).join(".cutready");

    for subdir in &["screenshots", "visuals"] {
        let src = cutready.join(subdir);
        if !src.exists() || !src.is_dir() {
            continue;
        }

        // Check if there are actual files to move
        let has_files = std::fs::read_dir(&src)
            .map(|rd| rd.count() > 0)
            .unwrap_or(false);
        if !has_files {
            continue;
        }

        // Ensure destination exists
        let dest_dir = target_cutready.join(subdir);
        if let Err(error) = std::fs::create_dir_all(&dest_dir) {
            log::warn!(
                "[project] could not create asset repair directory {}: {error}",
                dest_dir.display()
            );
            continue;
        }

        // Move each file (don't overwrite existing)
        if let Ok(entries) = std::fs::read_dir(&src) {
            for entry in entries.flatten() {
                let dest_file = dest_dir.join(entry.file_name());
                if !dest_file.exists() {
                    if let Err(error) = std::fs::rename(entry.path(), &dest_file) {
                        log::warn!(
                            "[project] could not repair orphaned asset into {}: {error}",
                            dest_file.display()
                        );
                    }
                }
            }
        }

        // Remove the now-empty source dir
        match std::fs::remove_dir(&src) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
                log::warn!(
                    "[project] orphaned asset directory still contains files after repair: {}",
                    src.display()
                );
            }
            Err(error) => {
                log::warn!(
                    "[project] could not remove repaired asset directory {}: {error}",
                    src.display()
                );
            }
        }
    }
}

/// Create a new project within a multi-project repo.
/// Creates the subdirectory and updates the manifest.
pub fn create_project_in_repo(
    repo_root: &Path,
    name: &str,
    description: Option<&str>,
) -> Result<ProjectEntry, ProjectError> {
    // Sanitize name to create a folder-safe path
    let path = name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-")
        .trim_matches('-')
        .to_string();

    if path.is_empty() {
        return Err(ProjectError::Io("Invalid project name".into()));
    }

    let project_dir = repo_root.join(&path);
    if project_dir.exists() {
        return Err(ProjectError::Io(format!(
            "Directory '{}' already exists",
            path
        )));
    }

    let mut manifest = read_manifest_result(repo_root)?.unwrap_or(ProjectManifest {
        projects: Vec::new(),
    });

    // Create the project subdirectory structure
    std::fs::create_dir_all(project_dir.join("sketches"))
        .map_err(|e| ProjectError::Io(e.to_string()))?;
    std::fs::create_dir_all(project_dir.join("notes"))
        .map_err(|e| ProjectError::Io(e.to_string()))?;

    let entry = ProjectEntry {
        path: path.clone(),
        name: name.to_string(),
        description: description.map(|s| s.to_string()),
    };

    // Update manifest
    manifest.projects.push(entry.clone());
    write_manifest(repo_root, &manifest)?;

    Ok(entry)
}

/// Migrate a single-project repo to multi-project by moving existing files
/// into a named subdirectory and creating the manifest.
///
/// Returns the ProjectEntry for the migrated (existing) project.
pub fn migrate_to_multi_project(
    repo_root: &Path,
    existing_project_name: &str,
) -> Result<ProjectEntry, ProjectError> {
    if is_multi_project(repo_root) {
        return Err(ProjectError::Io("Already a multi-project repo".into()));
    }

    let path = existing_project_name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-")
        .trim_matches('-')
        .to_string();

    if path.is_empty() {
        return Err(ProjectError::Io("Invalid project name".into()));
    }

    let target = repo_root.join(&path);

    // A fresh conversion must not adopt a stale runtime-state namespace left by an
    // aborted prior attempt; merging unknown leftovers into the new project is
    // unsafe. Require the destination state dir to be absent or empty up front.
    let target_state = git_state_dir(repo_root, &target);
    if target_state.exists()
        && std::fs::read_dir(&target_state)
            .map(|mut it| it.next().is_some())
            .unwrap_or(true)
    {
        return Err(ProjectError::Io(format!(
            "Refusing to convert to multi-project: stale runtime state exists at {}",
            target_state.display()
        )));
    }

    // Relocate local runtime state (agent DB, memory, workspace/sidebar state)
    // into the project's new namespace first. Doing this before any content moves
    // means a live database (active run holding a lock) rejects the conversion
    // up front, leaving the working tree untouched.
    relocate_project_state(repo_root, repo_root, &target)?;

    // Everything below mutates the working tree. Track content moves so any later
    // failure rewinds the tree and returns the runtime state to the single-project
    // namespace, leaving the original project fully recoverable.
    let mut moved_content: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    let build = (|| -> Result<ProjectEntry, ProjectError> {
        // Create the target subdirectory
        std::fs::create_dir_all(&target).map_err(|e| ProjectError::Io(e.to_string()))?;

        // Move all project files (not .git, not .cutready, not the target dir) into the subdirectory
        let skip = [".git", ".cutready", &path as &str];
        for entry in std::fs::read_dir(repo_root).map_err(|e| ProjectError::Io(e.to_string()))? {
            let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if skip.iter().any(|s| *s == name_str.as_ref()) {
                continue;
            }
            let src = entry.path();
            let dest = target.join(&name);
            std::fs::rename(&src, &dest).map_err(|e| ProjectError::Io(e.to_string()))?;
            moved_content.push((src, dest));
        }

        // Move asset directories (.cutready/screenshots, .cutready/visuals) into the project.
        // The repo-level .cutready/ is kept for the manifest; only asset subdirs move.
        let cutready_dir = repo_root.join(".cutready");
        for subdir in &["screenshots", "visuals"] {
            let src = cutready_dir.join(subdir);
            if src.exists() {
                let dest_cutready = target.join(".cutready");
                std::fs::create_dir_all(&dest_cutready)
                    .map_err(|e| ProjectError::Io(e.to_string()))?;
                let dest = dest_cutready.join(subdir);
                std::fs::rename(&src, &dest).map_err(|e| ProjectError::Io(e.to_string()))?;
                moved_content.push((src, dest));
            }
        }

        let entry = ProjectEntry {
            path: path.clone(),
            name: existing_project_name.to_string(),
            description: None,
        };

        // Create manifest with the single migrated project
        let manifest = ProjectManifest {
            projects: vec![entry.clone()],
        };
        write_manifest(repo_root, &manifest)?;

        Ok(entry)
    })();

    match build {
        Ok(entry) => Ok(entry),
        Err(err) => {
            // Rewind content moves (reverse order), return runtime state to the
            // single-project namespace, and drop the freshly written manifest so
            // `is_multi_project` cannot misclassify the rolled-back checkout.
            let mut stranded: Vec<String> = Vec::new();
            for (src, dest) in moved_content.iter().rev() {
                if std::fs::rename(dest, src).is_err() {
                    stranded.push(dest.display().to_string());
                }
            }
            if let Err(state_err) = relocate_project_state(repo_root, &target, repo_root) {
                stranded.push(format!("runtime state ({state_err})"));
            }
            let _ = std::fs::remove_file(repo_root.join(MANIFEST_PATH));
            let _ = std::fs::remove_dir(&target);
            if stranded.is_empty() {
                Err(err)
            } else {
                Err(ProjectError::Io(format!(
                    "Failed to convert to multi-project ({err}); rollback incomplete, artifacts stranded at: {}",
                    stranded.join(", ")
                )))
            }
        }
    }
}

// ── Sketch file I/O (.sk) ─────────────────────────────────────────
//
// Sketches are stored as `.sk` files anywhere in the project tree.
// The relative path from project root is the sketch's identity.

// ── Visual file I/O ───────────────────────────────────────────────
//
// Visuals are elucim DSL documents stored as separate JSON files in
// `.cutready/visuals/<hash>.json`. Rows reference them by relative path.

/// Write an elucim visual to `.cutready/visuals/<hash>.json`.
/// Returns the relative path from project root (e.g., ".cutready/visuals/a1b2c3d4e5f6.json").
pub fn write_visual(
    project_root: &Path,
    visual: &serde_json::Value,
) -> Result<String, ProjectError> {
    let file = document::visual_file(visual)?;
    write_visual_file(project_root, &file)?;
    Ok(file.path)
}

pub(crate) fn write_visual_file(root: &Path, file: &VisualFile) -> Result<(), ProjectError> {
    let abs_path = root.join(&file.path);
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    std::fs::write(&abs_path, &file.json).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Read an elucim visual from a relative path.
pub fn read_visual(
    project_root: &Path,
    visual_path: &str,
) -> Result<serde_json::Value, ProjectError> {
    let abs_path = safe_resolve(project_root, visual_path)?;
    if !abs_path.exists() {
        return Err(ProjectError::NotFound(visual_path.to_owned()));
    }
    let data = std::fs::read_to_string(&abs_path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))
}

/// Write a sketch to a `.sk` file, whatever is on disk.
#[cfg(test)]
pub fn write_sketch(sketch: &Sketch, path: &Path, project_root: &Path) -> Result<(), ProjectError> {
    document_writer::replace_sketch(project_root, path, sketch)?;
    Ok(())
}

pub fn ensure_sketch_unlocked(sketch: &Sketch) -> Result<(), ProjectError> {
    sketch_edits::ensure_unlocked(sketch).map_err(ProjectError::from)
}

fn ensure_sketch_has_no_locked_content(sketch: &Sketch) -> Result<(), ProjectError> {
    ensure_sketch_unlocked(sketch)?;
    if sketch.rows.iter().any(|row| row.locked || row.locks.any()) {
        return Err(ProjectError::Locked(
            "This sketch contains locked rows or cells. Unlock them before deleting or renaming."
                .into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub fn validate_rows_update_allowed(
    existing: &[cutready_core::models::sketch::PlanningRow],
    updated: &[cutready_core::models::sketch::PlanningRow],
) -> Result<(), ProjectError> {
    sketch_edits::check_rows_update(existing, updated).map_err(ProjectError::from)
}

/// Read a sketch from a `.sk` file, migrating any inline visuals to external files.
///
/// If a row's `visual` field contains a JSON object (legacy inline format),
/// it is written to `.cutready/visuals/<hash>.json` and replaced with the path string.
/// The `.sk` file is rewritten after migration.
pub fn read_sketch(path: &Path) -> Result<Sketch, ProjectError> {
    read_sketch_inner(path, None)
}

/// Read a sketch with optional migration of inline visuals.
/// When `project_root` is provided, inline visuals are externalized to files.
pub fn read_sketch_with_migration(
    path: &Path,
    project_root: &Path,
) -> Result<Sketch, ProjectError> {
    read_sketch_inner(path, Some(project_root))
}

fn read_sketch_inner(path: &Path, project_root: Option<&Path>) -> Result<Sketch, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(path.to_string_lossy().into_owned()));
    }
    let data = std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    let mut sketch = document::sketch_from_json(&data)?;

    // Migrate inline visuals to external files when project root is available
    if let Some(root) = project_root {
        crate::engine::document_reads::migrate_inline_visuals(&mut sketch, &data, path, root);
    }

    Ok(sketch)
}

/// Delete an unlocked sketch file and remove storyboard references to it.
/// The caller holds the write lock, so each storyboard is rewritten over the
/// version it was read at.
pub fn delete_sketch(path: &Path, project_root: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        let sketch = read_sketch(path)?;
        ensure_sketch_has_no_locked_content(&sketch)?;
        let sketch_rel_path = relative_project_path(path, project_root)?;
        let storyboard_updates = storyboards_with_sketch_removed(project_root, &sketch_rel_path)?;

        document_writer::delete(project_root, path)?;
        for (path, storyboard, expected) in storyboard_updates {
            document_writer::write_storyboard(project_root, &path, &storyboard, expected)?;
        }
    }
    Ok(())
}

fn storyboards_with_sketch_removed(
    project_root: &Path,
    sketch_rel_path: &str,
) -> Result<Vec<(PathBuf, Storyboard, Expected)>, ProjectError> {
    let mut updates = Vec::new();
    let mut locked_error = None;
    scan_files_recursive(
        project_root,
        project_root,
        "sb",
        &mut |_rel_path, abs_path| {
            if let Ok(data) = std::fs::read_to_string(abs_path) {
                if let Ok((mut storyboard, _)) = document::storyboard_from_json(&data) {
                    if storyboard.remove_sketch_references(sketch_rel_path) > 0 {
                        if storyboard.locked {
                            locked_error = Some(ProjectError::Locked(format!(
                                "Storyboard \"{}\" references this sketch. Unlock it before deleting the sketch.",
                                storyboard.title
                            )));
                        } else {
                            storyboard.updated_at = chrono::Utc::now();
                            let version = edit_ops::document_version(data.as_bytes());
                            let expected = Expected::Version(version);
                            updates.push((abs_path.to_path_buf(), storyboard, expected));
                        }
                    }
                }
            }
        },
    )?;
    if let Some(err) = locked_error {
        return Err(err);
    }
    Ok(updates)
}

fn relative_project_path(path: &Path, project_root: &Path) -> Result<String, ProjectError> {
    let rel = path
        .strip_prefix(project_root)
        .map_err(|_| ProjectError::PathTraversal(path.to_string_lossy().into_owned()))?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

/// Rename/move an unlocked project file and auto-commit.
#[allow(dead_code)]
pub fn rename_file(
    old_path: &Path,
    new_path: &Path,
    project_root: &Path,
    label: &str,
) -> Result<(), ProjectError> {
    if !old_path.exists() {
        return Err(ProjectError::NotFound(
            old_path.to_string_lossy().into_owned(),
        ));
    }
    if new_path.exists() {
        return Err(ProjectError::Io(format!(
            "Destination already exists: {}",
            new_path.to_string_lossy()
        )));
    }
    match label {
        "note" => {
            let rel = relative_project_path(old_path, project_root)?;
            ensure_note_unlocked(project_root, &rel)?;
        }
        "sketch" => {
            let sketch = read_sketch(old_path)?;
            ensure_sketch_has_no_locked_content(&sketch)?;
        }
        _ => {}
    }
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    std::fs::rename(old_path, new_path).map_err(|e| ProjectError::Io(e.to_string()))?;

    Ok(())
}

/// Rename/move a sketch file and auto-commit.
#[allow(dead_code)]
pub fn rename_sketch(
    old_path: &Path,
    new_path: &Path,
    project_root: &Path,
) -> Result<(), ProjectError> {
    rename_file(old_path, new_path, project_root, "sketch")
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameReferenceUpdate {
    pub path: String,
    pub count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameProjectAssetPlan {
    pub old_path: String,
    pub new_path: String,
    pub kind: String,
    pub updated_references: Vec<RenameReferenceUpdate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RenameAssetKind {
    Sketch,
    Storyboard,
    Note,
    ChatArtifact,
    Screenshot,
    Visual,
}

impl RenameAssetKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sketch => "sketch",
            Self::Storyboard => "storyboard",
            Self::Note => "note",
            Self::ChatArtifact => "chat-artifact",
            Self::Screenshot => "screenshot",
            Self::Visual => "visual",
        }
    }
}

#[derive(Debug, Clone)]
struct PlannedFileWrite {
    rel_path: String,
    abs_path: PathBuf,
    original: Vec<u8>,
    next: Vec<u8>,
    reference_count: usize,
}

#[derive(Debug, Clone)]
struct RenameProjectAssetTransaction {
    plan: RenameProjectAssetPlan,
    old_abs: PathBuf,
    new_abs: PathBuf,
    writes: Vec<PlannedFileWrite>,
}

pub fn preview_rename_project_asset(
    project_root: &Path,
    old_path: &str,
    new_path: &str,
) -> Result<RenameProjectAssetPlan, ProjectError> {
    Ok(build_rename_project_asset_transaction(project_root, old_path, new_path)?.plan)
}

pub fn rename_project_asset(
    project_root: &Path,
    old_path: &str,
    new_path: &str,
) -> Result<RenameProjectAssetPlan, ProjectError> {
    let transaction = build_rename_project_asset_transaction(project_root, old_path, new_path)?;
    apply_rename_project_asset_transaction(&transaction)?;
    Ok(transaction.plan.clone())
}

fn build_rename_project_asset_transaction(
    project_root: &Path,
    old_path: &str,
    new_path: &str,
) -> Result<RenameProjectAssetTransaction, ProjectError> {
    let old_rel = normalize_project_asset_path(old_path)?;
    let new_rel = normalize_project_asset_path(new_path)?;
    let old_abs = safe_resolve(project_root, &old_rel)?;
    let new_abs = safe_resolve(project_root, &new_rel)?;

    if old_rel == new_rel {
        let kind = classify_rename_asset_path(&old_rel)?;
        return Ok(RenameProjectAssetTransaction {
            plan: RenameProjectAssetPlan {
                old_path: old_rel,
                new_path: new_rel,
                kind: kind.as_str().to_owned(),
                updated_references: Vec::new(),
            },
            old_abs,
            new_abs,
            writes: Vec::new(),
        });
    }

    if !old_abs.exists() {
        return Err(ProjectError::NotFound(old_rel));
    }
    if old_abs.is_dir() {
        return Err(ProjectError::Io(
            "Folder renames are not supported yet. Rename files individually.".into(),
        ));
    }

    let kind = classify_rename_asset_path(&old_rel)?;
    validate_rename_project_asset_destination(kind, &old_rel, &new_rel)?;
    validate_renamed_file_unlocked(kind, project_root, &old_abs, &old_rel)?;

    if new_abs.exists() && !paths_refer_to_same_file(&old_abs, &new_abs) {
        return Err(ProjectError::Io(format!(
            "Destination already exists: {new_rel}"
        )));
    }

    let writes = plan_reference_rewrites(project_root, kind, &old_rel, &new_rel)?;
    let updated_references = writes
        .iter()
        .map(|write| RenameReferenceUpdate {
            path: write.rel_path.clone(),
            count: write.reference_count,
        })
        .collect();

    Ok(RenameProjectAssetTransaction {
        plan: RenameProjectAssetPlan {
            old_path: old_rel,
            new_path: new_rel,
            kind: kind.as_str().to_owned(),
            updated_references,
        },
        old_abs,
        new_abs,
        writes,
    })
}

fn normalize_project_asset_path(path: &str) -> Result<String, ProjectError> {
    let normalized = path
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_owned();
    if normalized.is_empty() {
        return Err(ProjectError::PathTraversal(path.to_owned()));
    }
    Ok(normalized)
}

fn classify_rename_asset_path(path: &str) -> Result<RenameAssetKind, ProjectError> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".sk") {
        return Ok(RenameAssetKind::Sketch);
    }
    if lower.ends_with(".sb") {
        return Ok(RenameAssetKind::Storyboard);
    }
    if lower.ends_with(".md") {
        return Ok(RenameAssetKind::Note);
    }
    if lower.ends_with(".cv") {
        return Ok(RenameAssetKind::ChatArtifact);
    }
    if lower.starts_with(".cutready/screenshots/") {
        return Ok(RenameAssetKind::Screenshot);
    }
    if lower.starts_with(".cutready/visuals/") && lower.ends_with(".json") {
        return Ok(RenameAssetKind::Visual);
    }
    Err(ProjectError::Io(format!(
        "Renaming is only supported for sketches, storyboards, notes, promoted chats, screenshots, and visual assets: {path}"
    )))
}

fn validate_rename_project_asset_destination(
    kind: RenameAssetKind,
    old_path: &str,
    new_path: &str,
) -> Result<(), ProjectError> {
    let new_kind = classify_rename_asset_path(new_path)?;
    if new_kind != kind {
        return Err(ProjectError::Io(
            "Rename must keep the same CutReady asset type and folder.".into(),
        ));
    }
    let old_ext = Path::new(old_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let new_ext = Path::new(new_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if old_ext != new_ext {
        return Err(ProjectError::Io(
            "Rename must preserve the original file extension.".into(),
        ));
    }
    match kind {
        RenameAssetKind::Screenshot => {
            if !new_path
                .to_ascii_lowercase()
                .starts_with(".cutready/screenshots/")
            {
                return Err(ProjectError::Io(
                    "Screenshots must stay under .cutready/screenshots.".into(),
                ));
            }
        }
        RenameAssetKind::Visual
            if !new_path
                .to_ascii_lowercase()
                .starts_with(".cutready/visuals/") =>
        {
            return Err(ProjectError::Io(
                "Visual assets must stay under .cutready/visuals.".into(),
            ));
        }
        _ => {}
    }
    Ok(())
}

fn validate_renamed_file_unlocked(
    kind: RenameAssetKind,
    project_root: &Path,
    old_abs: &Path,
    old_rel: &str,
) -> Result<(), ProjectError> {
    match kind {
        RenameAssetKind::Sketch => {
            let sketch = read_sketch(old_abs)?;
            ensure_sketch_has_no_locked_content(&sketch)?;
        }
        RenameAssetKind::Storyboard => {
            let storyboard = read_storyboard(old_abs)?;
            ensure_storyboard_unlocked(&storyboard)?;
        }
        RenameAssetKind::Note => ensure_note_unlocked(project_root, old_rel)?,
        RenameAssetKind::ChatArtifact | RenameAssetKind::Screenshot | RenameAssetKind::Visual => {}
    }
    Ok(())
}

fn paths_refer_to_same_file(old_path: &Path, new_path: &Path) -> bool {
    match (old_path.canonicalize(), new_path.canonicalize()) {
        (Ok(old_canonical), Ok(new_canonical)) => old_canonical == new_canonical,
        _ => false,
    }
}

fn plan_reference_rewrites(
    project_root: &Path,
    kind: RenameAssetKind,
    old_rel: &str,
    new_rel: &str,
) -> Result<Vec<PlannedFileWrite>, ProjectError> {
    match kind {
        RenameAssetKind::Sketch => {
            plan_storyboard_sketch_reference_rewrites(project_root, old_rel, new_rel)
        }
        RenameAssetKind::Screenshot => {
            let mut writes = plan_sketch_asset_reference_rewrites(
                project_root,
                old_rel,
                new_rel,
                RenameAssetKind::Screenshot,
            )?;
            writes.extend(plan_markdown_screenshot_reference_rewrites(
                project_root,
                old_rel,
                new_rel,
            )?);
            Ok(writes)
        }
        RenameAssetKind::Visual => plan_sketch_asset_reference_rewrites(
            project_root,
            old_rel,
            new_rel,
            RenameAssetKind::Visual,
        ),
        RenameAssetKind::Storyboard | RenameAssetKind::Note | RenameAssetKind::ChatArtifact => {
            Ok(Vec::new())
        }
    }
}

fn plan_storyboard_sketch_reference_rewrites(
    project_root: &Path,
    old_rel: &str,
    new_rel: &str,
) -> Result<Vec<PlannedFileWrite>, ProjectError> {
    let mut writes = Vec::new();
    let mut error = None;
    scan_files_recursive(
        project_root,
        project_root,
        "sb",
        &mut |rel_path, abs_path| {
            if error.is_some() {
                return;
            }
            match std::fs::read(abs_path)
                .map_err(|e| ProjectError::Io(e.to_string()))
                .and_then(|original| {
                    let (mut storyboard, _) = Storyboard::from_json_bytes_upgraded(&original)
                        .map_err(|e| ProjectError::Deserialize(e.to_string()))?;
                    let count = storyboard.replace_sketch_references(old_rel, new_rel);
                    if count == 0 {
                        return Ok(None);
                    }
                    ensure_storyboard_unlocked(&storyboard)?;
                    storyboard.updated_at = chrono::Utc::now();
                    let next = serde_json::to_vec_pretty(&storyboard)
                        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
                    Ok(Some(PlannedFileWrite {
                        rel_path: rel_path.to_owned(),
                        abs_path: abs_path.to_path_buf(),
                        original,
                        next,
                        reference_count: count,
                    }))
                }) {
                Ok(Some(write)) => writes.push(write),
                Ok(None) => {}
                Err(err) => error = Some(err),
            }
        },
    )?;
    if let Some(err) = error {
        return Err(err);
    }
    Ok(writes)
}

fn plan_sketch_asset_reference_rewrites(
    project_root: &Path,
    old_rel: &str,
    new_rel: &str,
    kind: RenameAssetKind,
) -> Result<Vec<PlannedFileWrite>, ProjectError> {
    let mut writes = Vec::new();
    let mut error = None;
    scan_files_recursive(
        project_root,
        project_root,
        "sk",
        &mut |rel_path, abs_path| {
            if error.is_some() {
                return;
            }
            match std::fs::read(abs_path)
                .map_err(|e| ProjectError::Io(e.to_string()))
                .and_then(|original| {
                    let text = std::str::from_utf8(&original)
                        .map_err(|e| ProjectError::Deserialize(e.to_string()))?;
                    let mut sketch = document::sketch_from_json(text)?;
                    let count = match kind {
                        RenameAssetKind::Screenshot => {
                            replace_sketch_screenshot_references(&mut sketch, old_rel, new_rel)?
                        }
                        RenameAssetKind::Visual => {
                            replace_sketch_visual_references(&mut sketch, old_rel, new_rel)?
                        }
                        _ => 0,
                    };
                    if count == 0 {
                        return Ok(None);
                    }
                    sketch.updated_at = chrono::Utc::now();
                    let next = document::sketch_to_json(&sketch)?.into_bytes();
                    Ok(Some(PlannedFileWrite {
                        rel_path: rel_path.to_owned(),
                        abs_path: abs_path.to_path_buf(),
                        original,
                        next,
                        reference_count: count,
                    }))
                }) {
                Ok(Some(write)) => writes.push(write),
                Ok(None) => {}
                Err(err) => error = Some(err),
            }
        },
    )?;
    if let Some(err) = error {
        return Err(err);
    }
    Ok(writes)
}

fn plan_markdown_screenshot_reference_rewrites(
    project_root: &Path,
    old_rel: &str,
    new_rel: &str,
) -> Result<Vec<PlannedFileWrite>, ProjectError> {
    let mut writes = Vec::new();
    let mut error = None;
    scan_files_recursive(
        project_root,
        project_root,
        "md",
        &mut |rel_path, abs_path| {
            if error.is_some() {
                return;
            }
            match std::fs::read(abs_path)
                .map_err(|e| ProjectError::Io(e.to_string()))
                .and_then(|original| {
                    let content = String::from_utf8(original.clone())
                        .map_err(|e| ProjectError::Deserialize(e.to_string()))?;
                    let (next_content, count) =
                        rewrite_markdown_screenshot_refs(&content, old_rel, new_rel);
                    if count == 0 {
                        return Ok(None);
                    }
                    ensure_note_unlocked(project_root, rel_path)?;
                    Ok(Some(PlannedFileWrite {
                        rel_path: rel_path.to_owned(),
                        abs_path: abs_path.to_path_buf(),
                        original,
                        next: next_content.into_bytes(),
                        reference_count: count,
                    }))
                }) {
                Ok(Some(write)) => writes.push(write),
                Ok(None) => {}
                Err(err) => error = Some(err),
            }
        },
    )?;
    if let Some(err) = error {
        return Err(err);
    }
    Ok(writes)
}

fn apply_rename_project_asset_transaction(
    transaction: &RenameProjectAssetTransaction,
) -> Result<(), ProjectError> {
    if transaction.plan.old_path == transaction.plan.new_path {
        return Ok(());
    }

    let temp_id = uuid::Uuid::new_v4().simple().to_string();
    let mut staged_paths = Vec::new();
    for (index, write) in transaction.writes.iter().enumerate() {
        if std::fs::read(&write.abs_path).map_err(|e| ProjectError::Io(e.to_string()))?
            != write.original
        {
            cleanup_paths(&staged_paths);
            return Err(ProjectError::Io(format!(
                "Project changed while preparing rename; refresh and try again: {}",
                write.rel_path
            )));
        }
        let staged = sidecar_path(&write.abs_path, &format!("{temp_id}-{index}.tmp"));
        std::fs::write(&staged, &write.next).map_err(|e| ProjectError::Io(e.to_string()))?;
        staged_paths.push(staged);
    }

    if let Some(parent) = transaction.new_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    let renamed_target_temp = if transaction.new_abs.exists()
        && paths_refer_to_same_file(&transaction.old_abs, &transaction.new_abs)
    {
        let temp = sidecar_path(&transaction.old_abs, &format!("{temp_id}-case-rename.tmp"));
        std::fs::rename(&transaction.old_abs, &temp).map_err(|e| {
            cleanup_paths(&staged_paths);
            ProjectError::Io(format!("Failed to prepare case-only rename: {e}"))
        })?;
        Some(temp)
    } else {
        None
    };

    let target_rename_result = if let Some(temp) = renamed_target_temp.as_ref() {
        std::fs::rename(temp, &transaction.new_abs)
    } else {
        std::fs::rename(&transaction.old_abs, &transaction.new_abs)
    };
    if let Err(error) = target_rename_result {
        if let Some(temp) = renamed_target_temp.as_ref() {
            let _ = std::fs::rename(temp, &transaction.old_abs);
        }
        cleanup_paths(&staged_paths);
        return Err(ProjectError::Io(format!("Failed to rename asset: {error}")));
    }

    let mut backups: HashMap<PathBuf, PathBuf> = HashMap::new();
    for (write, staged) in transaction.writes.iter().zip(staged_paths.iter()) {
        let backup = sidecar_path(&write.abs_path, &format!("{temp_id}.bak"));
        if let Err(error) = std::fs::rename(&write.abs_path, &backup) {
            rollback_rename_project_asset(transaction, &backups, &staged_paths);
            return Err(ProjectError::Io(format!(
                "Rename rolled back after failing to back up {}: {error}",
                write.rel_path
            )));
        }
        backups.insert(write.abs_path.clone(), backup.clone());
        if let Err(error) = std::fs::rename(staged, &write.abs_path) {
            rollback_rename_project_asset(transaction, &backups, &staged_paths);
            return Err(ProjectError::Io(format!(
                "Rename rolled back after failing to update {}: {error}",
                write.rel_path
            )));
        }
    }

    cleanup_paths(&backups.into_values().collect::<Vec<_>>());
    cleanup_paths(&staged_paths);
    Ok(())
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "asset".into());
    path.with_file_name(format!(".{file_name}.cutready-rename-{suffix}"))
}

fn cleanup_paths(paths: &[PathBuf]) {
    for path in paths {
        if path.exists() {
            if let Err(error) = std::fs::remove_file(path) {
                log::warn!(
                    "[project] failed to clean up rename sidecar {}: {error}",
                    path.display()
                );
            }
        }
    }
}

fn rollback_rename_project_asset(
    transaction: &RenameProjectAssetTransaction,
    backups: &HashMap<PathBuf, PathBuf>,
    staged_paths: &[PathBuf],
) {
    for (original, backup) in backups {
        if original.exists() {
            if let Err(error) = std::fs::remove_file(original) {
                log::warn!(
                    "[project] failed to remove partially updated file during rename rollback {}: {error}",
                    original.display()
                );
            }
        }
        if backup.exists() {
            if let Err(error) = std::fs::rename(backup, original) {
                log::error!(
                    "[project] failed to restore rename backup {} -> {}: {error}",
                    backup.display(),
                    original.display()
                );
            }
        }
    }
    if transaction.new_abs.exists() {
        if let Err(error) = std::fs::rename(&transaction.new_abs, &transaction.old_abs) {
            log::error!(
                "[project] failed to roll back renamed asset {} -> {}: {error}",
                transaction.new_abs.display(),
                transaction.old_abs.display()
            );
        }
    }
    cleanup_paths(staged_paths);
}

// ── Storyboard file I/O (.sb) ─────────────────────────────────────

/// Write a storyboard to a `.sb` file, whatever is on disk.
#[cfg(test)]
pub fn write_storyboard(
    sb: &Storyboard,
    path: &Path,
    project_root: &Path,
) -> Result<(), ProjectError> {
    document_writer::replace_storyboard(project_root, path, sb)?;
    Ok(())
}

pub fn ensure_storyboard_unlocked(storyboard: &Storyboard) -> Result<(), ProjectError> {
    if storyboard.locked {
        return Err(ProjectError::Locked(
            "This storyboard is locked. Unlock it before editing.".into(),
        ));
    }
    Ok(())
}

/// Read a storyboard from a `.sb` file.
pub fn read_storyboard(path: &Path) -> Result<Storyboard, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(path.to_string_lossy().into_owned()));
    }
    let data = std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    let (storyboard, upgraded) = document::storyboard_from_json(&data)?;
    if upgraded {
        save_upgraded_storyboard(&storyboard, path, &data);
    }
    Ok(storyboard)
}

/// Persist a storyboard whose older on-disk shape (`data`) was just upgraded
/// on read. Best effort: a failed write, or a file that changed since the
/// read, leaves the file, which upgrades again next read.
fn save_upgraded_storyboard(storyboard: &Storyboard, path: &Path, data: &str) {
    // Only inside a project this process has open: never invent a state dir.
    let Some(root) = document_writer::project_root_for(path) else {
        log::debug!("not upgrading {} outside an open project", path.display());
        return;
    };
    let expected = Expected::Version(edit_ops::document_version(data.as_bytes()));
    if let Err(err) = document_writer::write_storyboard(&root, path, storyboard, expected) {
        log::warn!(
            "could not save upgraded storyboard {}: {err}",
            path.display()
        );
    }
}

/// Delete a storyboard file and auto-commit.
pub fn delete_storyboard(path: &Path, project_root: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        let storyboard = read_storyboard(path)?;
        ensure_storyboard_unlocked(&storyboard)?;
    }
    document_writer::delete(project_root, path)?;
    Ok(())
}

// ── Folder scanning ────────────────────────────────────────────────

/// Recursively scan a project folder for all `.sk` files.
/// Returns summaries with relative paths from project root.
pub fn scan_sketches(project_root: &Path) -> Result<Vec<SketchSummary>, ProjectError> {
    let mut summaries = Vec::new();
    scan_files_recursive(
        project_root,
        project_root,
        "sk",
        &mut |rel_path, abs_path| {
            if let Ok(data) = std::fs::read_to_string(abs_path) {
                if let Ok(sketch) = document::sketch_from_json(&data) {
                    summaries.push(SketchSummary::from_sketch(&sketch, rel_path));
                }
            }
        },
    )?;
    summaries.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(summaries)
}

/// Recursively scan a project folder for all `.sb` files.
/// Returns summaries with relative paths from project root.
pub fn scan_storyboards(project_root: &Path) -> Result<Vec<StoryboardSummary>, ProjectError> {
    let mut summaries = Vec::new();
    scan_files_recursive(
        project_root,
        project_root,
        "sb",
        &mut |rel_path, abs_path| {
            if let Ok(data) = std::fs::read_to_string(abs_path) {
                if let Ok((sb, upgraded)) = document::storyboard_from_json(&data) {
                    if upgraded {
                        save_upgraded_storyboard(&sb, abs_path, &data);
                    }
                    summaries.push(StoryboardSummary::from_storyboard(&sb, rel_path));
                }
            }
        },
    )?;
    summaries.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(summaries)
}

/// Return titles of storyboards that reference the given sketch path.
pub fn storyboards_referencing_sketch(
    project_root: &Path,
    sketch_rel_path: &str,
) -> Result<Vec<String>, ProjectError> {
    let mut titles = Vec::new();
    scan_files_recursive(
        project_root,
        project_root,
        "sb",
        &mut |_rel_path, abs_path| {
            if let Ok(data) = std::fs::read_to_string(abs_path) {
                if let Ok((sb, _)) = document::storyboard_from_json(&data) {
                    if sb.references_sketch(sketch_rel_path) {
                        titles.push(sb.title.clone());
                    }
                }
            }
        },
    )?;
    Ok(titles)
}
//
// Notes are plain markdown files anywhere in the project tree.

/// Recursively scan a project folder for all `.md` files.
pub fn scan_notes(project_root: &Path) -> Result<Vec<NoteSummary>, ProjectError> {
    scan_document_summaries(project_root, "md")
}

/// Recursively scan a project folder for all promoted chat `.cv` files.
pub fn scan_chat_artifacts(project_root: &Path) -> Result<Vec<NoteSummary>, ProjectError> {
    scan_document_summaries(project_root, "cv")
}

fn scan_document_summaries(
    project_root: &Path,
    extension: &str,
) -> Result<Vec<NoteSummary>, ProjectError> {
    let mut summaries = Vec::new();
    scan_files_recursive(
        project_root,
        project_root,
        extension,
        &mut |rel_path, abs_path| {
            if let Ok(meta) = std::fs::metadata(abs_path) {
                let updated_at = meta
                    .modified()
                    .ok()
                    .and_then(|t| {
                        let duration = t.duration_since(std::time::UNIX_EPOCH).ok()?;
                        chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                    })
                    .unwrap_or_else(chrono::Utc::now);
                let title = Path::new(rel_path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| rel_path.to_string());
                let turn_count = if extension == "cv" {
                    chat_artifact_turn_count(abs_path)
                } else {
                    None
                };
                summaries.push(NoteSummary {
                    path: rel_path.to_string(),
                    title,
                    size: meta.len(),
                    updated_at,
                    turn_count,
                });
            }
        },
    )?;
    summaries.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
    Ok(summaries)
}

fn chat_artifact_turn_count(path: &Path) -> Option<usize> {
    let content = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value.get("turns")?.as_array().map(Vec::len)
}

/// Entry for the flat file listing returned by `scan_all_files`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileEntry {
    /// Relative path using forward slashes.
    pub path: String,
    /// File extension (lowercase, without dot) or empty for extensionless files.
    pub ext: String,
    /// File size in bytes.
    pub size: u64,
    /// Whether this is a directory.
    pub is_dir: bool,
}

/// List all files and directories in the project, recursively.
/// Skips hidden entries (dotfiles/dotdirs) and the `.cutready` internal folder.
pub fn scan_all_files(project_root: &Path) -> Result<Vec<FileEntry>, ProjectError> {
    let mut entries = Vec::new();
    scan_all_recursive(project_root, project_root, &mut entries)?;
    entries.sort_by(|a, b| {
        // Directories first, then alphabetical
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.path.to_lowercase().cmp(&b.path.to_lowercase()),
        }
    });
    Ok(entries)
}

fn scan_all_recursive(
    dir: &Path,
    project_root: &Path,
    entries: &mut Vec<FileEntry>,
) -> Result<(), ProjectError> {
    if !dir.exists() {
        return Ok(());
    }

    let read_dir = std::fs::read_dir(dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // Skip VCS internals entirely; Draftline owns versioning metadata.
        if name == ".git" {
            continue;
        }

        let rel = match path.strip_prefix(project_root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let meta = std::fs::metadata(&path).map_err(|e| ProjectError::Io(e.to_string()))?;
        let is_dir = meta.is_dir();

        entries.push(FileEntry {
            path: rel.clone(),
            ext: if is_dir {
                String::new()
            } else {
                path.extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default()
            },
            size: meta.len(),
            is_dir,
        });

        if is_dir {
            scan_all_recursive(&path, project_root, entries)?;
        }
    }

    Ok(())
}

/// Read a note file as plain text.
pub fn read_note(path: &Path) -> Result<String, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(path.to_string_lossy().into_owned()));
    }
    std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))
}

pub fn get_note_lock(
    project_root: &Path,
    relative_path: &str,
) -> Result<NoteLockState, ProjectError> {
    let rel = normalize_lock_path(relative_path);
    let manifest = read_lock_manifest(project_root)?;
    Ok(manifest.note_lock(&rel))
}

pub fn set_note_lock(
    project_root: &Path,
    relative_path: &str,
    locked: bool,
) -> Result<NoteLockState, ProjectError> {
    let rel = normalize_lock_path(relative_path);
    let mut manifest = read_lock_manifest(project_root)?;
    let state = manifest.set_note_lock(&rel, locked);
    write_lock_manifest(project_root, &manifest)?;
    Ok(state)
}

pub fn ensure_note_unlocked(project_root: &Path, relative_path: &str) -> Result<(), ProjectError> {
    if get_note_lock(project_root, relative_path)?.locked {
        return Err(ProjectError::Locked(notes::NOTE_LOCKED_MESSAGE.into()));
    }
    Ok(())
}

fn read_lock_manifest(project_root: &Path) -> Result<LockManifest, ProjectError> {
    let path = project_root.join(LOCKS_PATH);
    if !path.exists() {
        return Ok(LockManifest::default());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| ProjectError::Io(e.to_string()))?;
    Ok(notes::lock_manifest_from_json(&data)?)
}

fn write_lock_manifest(project_root: &Path, manifest: &LockManifest) -> Result<(), ProjectError> {
    let path = project_root.join(LOCKS_PATH);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    let data = notes::lock_manifest_to_json(manifest)?;
    std::fs::write(path, data).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Delete a note file. Images it referenced are kept: one no longer referenced
/// anywhere shows up as Unused in the Media library, where the user removes it
/// explicitly. Media is never deleted as a side effect of deleting a document.
pub fn delete_note(path: &Path, project_root: &Path) -> Result<(), ProjectError> {
    if !path.exists() {
        return Ok(());
    }
    let rel = relative_project_path(path, project_root)?;
    ensure_note_unlocked(project_root, &rel)?;
    document_writer::delete(project_root, path)?;
    let _ = set_note_lock(project_root, &rel, false);
    Ok(())
}

/// Count how many files in `project_root` still reference `asset_rel`.
/// Used after a move to decide whether to delete the source asset.
pub fn count_asset_refs(project_root: &Path, asset_rel: &str) -> usize {
    let mut count = 0;
    let _ = scan_files_recursive(project_root, project_root, "sk", &mut |_, abs_path| {
        if let Ok(content) = std::fs::read_to_string(abs_path) {
            for r in extract_sketch_screenshot_refs(&content)
                .into_iter()
                .chain(extract_sketch_visual_refs(&content))
            {
                if r == asset_rel {
                    count += 1;
                }
            }
        }
    });
    let _ = scan_files_recursive(project_root, project_root, "md", &mut |_, abs_path| {
        if let Ok(content) = std::fs::read_to_string(abs_path) {
            for r in extract_screenshot_refs(&content) {
                if r == asset_rel {
                    count += 1;
                }
            }
        }
    });
    count
}

/// with their reference info.
///
/// For each asset, scans all .md notes and .sk sketches to find which ones reference it.
pub fn list_images_with_refs(project_root: &Path) -> Result<Vec<ImageRefInfo>, ProjectError> {
    let ss_dir = project_root.join(".cutready").join("screenshots");
    let vis_dir = project_root.join(".cutready").join("visuals");

    // Collect all screenshot files
    let mut assets: Vec<(String, u64, &'static str, u64)> = Vec::new();
    if ss_dir.exists() {
        for entry in std::fs::read_dir(&ss_dir).map_err(|e| ProjectError::Io(e.to_string()))? {
            let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
            let path = entry.path();
            if path.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                let rel = format!(".cutready/screenshots/{name}");
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                assets.push((rel, size, "screenshot", modified));
            }
        }
    }

    // Collect all visual files
    if vis_dir.exists() {
        for entry in std::fs::read_dir(&vis_dir).map_err(|e| ProjectError::Io(e.to_string()))? {
            let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
            let path = entry.path();
            if path.is_file() && path.extension().is_some_and(|ext| ext == "json") {
                let name = entry.file_name().to_string_lossy().to_string();
                let rel = format!(".cutready/visuals/{name}");
                let meta = entry.metadata().ok();
                let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                assets.push((rel, size, "visual", modified));
            }
        }
    }

    if assets.is_empty() {
        return Ok(Vec::new());
    }

    // Build a map of asset path → list of files that reference it
    let mut ref_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for (path, _, _, _) in &assets {
        ref_map.insert(path.clone(), Vec::new());
    }

    // Scan markdown notes for screenshot references
    scan_files_recursive(
        project_root,
        project_root,
        "md",
        &mut |rel_path, abs_path| {
            if let Ok(content) = std::fs::read_to_string(abs_path) {
                let refs = extract_screenshot_refs(&content);
                for img_ref in refs {
                    if let Some(referrers) = ref_map.get_mut(&img_ref) {
                        referrers.push(rel_path.to_string());
                    }
                }
            }
        },
    )?;

    // Scan sketch files for screenshot and visual field references
    scan_files_recursive(
        project_root,
        project_root,
        "sk",
        &mut |rel_path, abs_path| {
            if let Ok(content) = std::fs::read_to_string(abs_path) {
                for img_ref in extract_sketch_screenshot_refs(&content) {
                    if let Some(referrers) = ref_map.get_mut(&img_ref) {
                        referrers.push(rel_path.to_string());
                    }
                }
                for vis_ref in extract_sketch_visual_refs(&content) {
                    if let Some(referrers) = ref_map.get_mut(&vis_ref) {
                        referrers.push(rel_path.to_string());
                    }
                }
            }
        },
    )?;

    let mut result: Vec<ImageRefInfo> = assets
        .into_iter()
        .map(|(path, size, asset_type, modified_at)| {
            let referenced_by = ref_map.remove(&path).unwrap_or_default();
            ImageRefInfo {
                path,
                size,
                referenced_by,
                asset_type,
                modified_at,
            }
        })
        .collect();

    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

/// Image reference info returned by list_images_with_refs.
pub struct ImageRefInfo {
    pub path: String,
    pub size: u64,
    pub referenced_by: Vec<String>,
    /// "screenshot" or "visual"
    pub asset_type: &'static str,
    /// File modification time as milliseconds since UNIX epoch.
    pub modified_at: u64,
}

/// Check if a sketch file exists given a relative path from project root.
pub fn sketch_file_exists(relative_path: &str, project_root: &Path) -> bool {
    project_root.join(relative_path).exists()
}

// ── Chat sessions (.chat JSON files) ────────────────────────────────

/// A persisted chat session.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatSession {
    pub title: String,
    pub messages: Vec<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub author_email: Option<String>,
}

/// Import legacy `.chats/*.chat` files into the local agent-state database.
///
/// Files are removed only after the database import verifies their transcript.
/// Malformed files remain in place and their failure is recorded in the database.
pub fn migrate_legacy_chat_sessions(
    repo_root: &Path,
    project_root: &Path,
) -> Result<(), ProjectError> {
    crate::engine::agent_state::AgentStateStore::ensure_database_for_project(
        repo_root,
        project_root,
    )
    .map(|_| ())
    .map_err(ProjectError::Io)
}

// ── Sidebar order manifest ──────────────────────────────────────────

use cutready_desktop_io::state_dir::enclosing_git_dir;
pub use cutready_desktop_io::state_dir::{git_state_dir, git_state_location, hybrid_git_root};

pub const REPO_SETTINGS_FILE: &str = ".cutready/settings.json";

/// Relocate a project's local runtime state when its path-based identity changes
/// via rename or single→multi conversion.
///
/// The per-project state directory (`git_state_dir`) doubles as the project's
/// identity and holds untracked runtime state: the agent-state SQLite database
/// (runs, chat history), the memory store, workspace tabs (`workspace.json`),
/// sidebar ordering (`order.json`), and imported legacy chats. A path change
/// moves the working-tree content but, without this, orphans that runtime state
/// under the old path so the reopened project silently loses its history.
///
/// Safety:
/// - No-op when the resolved directories are equal or the source is missing.
/// - Refuses to overwrite any colliding destination artifact, so a collision can
///   never destroy either side's data (the caller can surface the error and the
///   original remains intact).
/// - Moves entries with `rename` (atomic within a single `.git` volume), keeping
///   the SQLite database together with any journal/WAL sidecars — the database is
///   moved, never copied away from its journal. A run writing mid-relocation
///   holds an OS lock on the database, so the rename fails and relocation is
///   rejected rather than corrupting a live database.
/// - On partial failure, entries already moved are rolled back to the source
///   before the error is returned.
///
/// When the destination is nested inside the source (single→multi conversion),
/// the destination subdirectory is skipped and the source directory is retained;
/// otherwise the emptied source directory is removed.
///
/// Known limitation: this does not take a process-wide lock shared with the
/// agent-state, workspace, and sidebar readers/writers. It relies on runtime
/// stores using short-lived per-operation connections plus the OS refusing to
/// rename a database a live run holds open. A concurrent old-path writer racing
/// the relocation is therefore still possible; callers should quiesce active
/// runs first. A shared project-state lock is tracked as follow-up work.
pub fn relocate_project_state(
    repo_root: &Path,
    old_project_root: &Path,
    new_project_root: &Path,
) -> Result<(), ProjectError> {
    let old_dir = git_state_dir(repo_root, old_project_root);
    let new_dir = git_state_dir(repo_root, new_project_root);
    if old_dir == new_dir || !old_dir.exists() {
        return Ok(());
    }

    // Everything under the old state dir except the destination itself (which is
    // nested inside the source during single→multi conversion) and the
    // repository write lock, which stays put and may be held. Directory-entry
    // read errors are propagated rather than silently skipped, so a partially
    // readable source is never mistaken for a fully relocated one.
    let mut entries: Vec<std::path::PathBuf> = Vec::new();
    for entry in std::fs::read_dir(&old_dir).map_err(|e| ProjectError::Io(e.to_string()))? {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();
        if path != new_dir
            && entry.file_name() != std::ffi::OsStr::new(crate::engine::write_lock::LOCK_FILENAME)
        {
            entries.push(path);
        }
    }

    // Collision guard: never overwrite an existing destination artifact.
    if new_dir.exists() {
        for src in &entries {
            if let Some(name) = src.file_name() {
                let dest = new_dir.join(name);
                if dest.exists() {
                    return Err(ProjectError::Io(format!(
                        "Refusing to relocate project state: destination already contains {}",
                        dest.display()
                    )));
                }
            }
        }
    }

    std::fs::create_dir_all(&new_dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    let mut moved: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for src in entries {
        let Some(name) = src.file_name() else {
            continue;
        };
        let dest = new_dir.join(name);
        if let Err(err) = std::fs::rename(&src, &dest) {
            // Roll back every entry moved so far so the original stays recoverable.
            // Any reverse move that itself fails is reported so a layout split
            // across both paths is never silently left behind.
            let mut stranded: Vec<String> = Vec::new();
            for (orig, moved_dest) in moved.iter().rev() {
                if std::fs::rename(moved_dest, orig).is_err() {
                    stranded.push(moved_dest.display().to_string());
                }
            }
            if stranded.is_empty() {
                return Err(ProjectError::Io(format!(
                    "Could not relocate project state entry {}: {err}",
                    src.display()
                )));
            }
            return Err(ProjectError::Io(format!(
                "Could not relocate project state entry {} ({err}); rollback incomplete, artifacts stranded at: {}",
                src.display(),
                stranded.join(", ")
            )));
        }
        moved.push((src, dest));
    }

    // Disjoint move: drop the now-empty source directory. Nested move: keep it,
    // since the destination lives inside it.
    if !new_dir.starts_with(&old_dir) {
        let _ = std::fs::remove_dir(&old_dir);
    }

    Ok(())
}

/// The git dir holding a CutReady folder and the folder's path relative to
/// the work tree (empty at the root). Works for standalone, hybrid, and
/// linked-worktree folders alike.
pub fn folder_git_location(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let dot_git = root.join(".git");
    if cutready_desktop_io::state_dir::is_git_dir(&dot_git) {
        return Some((std::fs::canonicalize(dot_git).ok()?, PathBuf::new()));
    }
    enclosing_git_dir(root)
}

/// Repair a folder inside a repository that an old bug left holding a stray
/// `.git` directory (no `HEAD`, only CutReady state). Git treats a folder with
/// a `.git` as a nested repository and stops reporting its files, so the stray
/// directory hides every change. Its state moves to where it belongs inside
/// the enclosing git dir; an entry whose target already exists is kept beside
/// it as `<name>.recovered-<timestamp>`, so nothing is lost. Returns whether
/// the folder was repaired. Leaves anything it does not recognize untouched.
pub fn recover_stray_git_dir(root: &Path) -> Result<bool, ProjectError> {
    let stray = root.join(".git");
    if !stray.is_dir() || cutready_desktop_io::state_dir::is_git_dir(&stray) {
        return Ok(false);
    }
    let Some((git_dir, folder)) = enclosing_git_dir(root) else {
        return Ok(false);
    };
    let io = |e: std::io::Error| ProjectError::Io(e.to_string());
    let only_state = std::fs::read_dir(&stray)
        .map_err(io)?
        .filter_map(Result::ok)
        .all(|entry| entry.file_name() == "cutready");
    if !only_state {
        return Ok(false);
    }

    let source = stray.join("cutready");
    let target = folder_state_dir(&git_dir, &folder);
    if source.is_dir() {
        let created_target = !target.exists();
        std::fs::create_dir_all(&target).map_err(io)?;
        let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
        let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
        let result = (|| -> std::io::Result<()> {
            for entry in std::fs::read_dir(&source)? {
                let entry = entry?;
                let name = entry.file_name();
                let mut dest = target.join(&name);
                if dest.exists() {
                    dest = target.join(format!("{}.recovered-{stamp}", name.to_string_lossy()));
                }
                std::fs::rename(entry.path(), &dest)?;
                moved.push((entry.path(), dest));
            }
            std::fs::remove_dir(&source)
        })();
        if let Err(err) = result {
            // All or nothing: a half-moved state would leave history split.
            for (src, dest) in moved.into_iter().rev() {
                let _ = std::fs::rename(dest, src);
            }
            if created_target {
                remove_empty_dirs(Some(&target), Some(&git_dir));
            }
            return Err(io(err));
        }
    }
    std::fs::remove_dir(&stray).map_err(io)?;
    Ok(true)
}

/// The local runtime state directory for the CutReady folder at `folder`
/// (relative to the work tree) of the repository whose git dir is `git_dir`.
/// Matches [`git_state_dir`] without requiring the folder to exist yet.
pub fn folder_state_dir(git_dir: &Path, folder: &Path) -> PathBuf {
    git_dir.join("cutready").join(folder)
}

/// Move a whole CutReady folder's local runtime state directory (every
/// project's agent DB, memory, tabs, and sidebar order) from `from` to `to`,
/// which may be nested in either direction. The directory moves with one
/// `rename`, so a database a live run holds open refuses the move up front.
/// The repository write lock at the state root (held during the move) stays
/// put, so a move to or from the root goes entry by entry around it.
/// Refuses, without changing anything, when `to` already holds other state.
/// On failure every completed step is undone.
pub fn move_folder_state(from: &Path, to: &Path) -> Result<(), ProjectError> {
    if from == to || !from.exists() {
        return Ok(());
    }
    let io = |e: std::io::Error| ProjectError::Io(e.to_string());
    let occupied = || {
        ProjectError::Io(format!(
            "Refusing to move project state: {} already holds other state",
            to.display()
        ))
    };
    let staging = |anchor: &Path| {
        let name = anchor
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "cutready".into());
        anchor.with_file_name(format!("{name}.moving-{}", uuid::Uuid::new_v4().simple()))
    };

    if to.starts_with(from) {
        // Deeper (root → subfolder): park the state beside itself, then nest it.
        if to.exists() {
            return Err(occupied());
        }
        let keep_lock = from.join(WRITE_LOCK).exists();
        let parked = staging(from);
        if keep_lock {
            std::fs::create_dir(&parked).map_err(io)?;
            if let Err(err) = move_entries(from, &parked) {
                let _ = std::fs::remove_dir(&parked);
                return Err(io(err));
            }
        } else {
            std::fs::rename(from, &parked).map_err(io)?;
        }
        let placed = to
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::rename(&parked, to));
        if let Err(err) = placed {
            let restored = if keep_lock {
                remove_empty_dirs(to.parent(), Some(from));
                move_entries(&parked, from).and_then(|()| std::fs::remove_dir(&parked))
            } else {
                remove_empty_dirs(to.parent(), from.parent());
                std::fs::rename(&parked, from)
            };
            return Err(match restored {
                Ok(()) => io(err),
                Err(_) => ProjectError::Io(format!(
                    "Could not move project state ({err}); it is parked at {}",
                    parked.display()
                )),
            });
        }
        return Ok(());
    }

    if from.starts_with(to) {
        // Shallower (subfolder → root): `to` may only hold the path to `from`.
        if !only_holds(to, from) {
            return Err(occupied());
        }
        let keep_lock = to.join(WRITE_LOCK).exists();
        let parked = staging(to);
        std::fs::rename(from, &parked).map_err(io)?;
        remove_empty_dirs(
            from.parent(),
            if keep_lock { Some(to) } else { to.parent() },
        );
        let placed = if keep_lock {
            move_entries(&parked, to).map(|()| {
                let _ = std::fs::remove_dir(&parked);
            })
        } else if to.exists() {
            Err(std::io::Error::other(format!(
                "{} is not empty",
                to.display()
            )))
        } else {
            std::fs::rename(&parked, to)
        };
        if let Err(err) = placed {
            let restored = from
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|()| std::fs::rename(&parked, from));
            return Err(match restored {
                Ok(()) => io(err),
                Err(_) => ProjectError::Io(format!(
                    "Could not move project state ({err}); it is parked at {}",
                    parked.display()
                )),
            });
        }
        return Ok(());
    }

    // Disjoint (subfolder → subfolder).
    if to.exists() {
        if std::fs::read_dir(to).map_err(io)?.next().is_some() {
            return Err(occupied());
        }
        std::fs::remove_dir(to).map_err(io)?;
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    std::fs::rename(from, to).map_err(io)?;
    Ok(())
}

const WRITE_LOCK: &str = crate::engine::write_lock::LOCK_FILENAME;

/// Move every entry of `from` except the write lock into the existing `to`.
/// On failure the entries already moved go back.
fn move_entries(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut moved = Vec::new();
    for entry in std::fs::read_dir(from)? {
        let name = entry?.file_name();
        if name == WRITE_LOCK {
            continue;
        }
        if let Err(err) = std::fs::rename(from.join(&name), to.join(&name)) {
            for name in moved.iter().rev() {
                let _ = std::fs::rename(to.join(name), from.join(name));
            }
            return Err(err);
        }
        moved.push(name);
    }
    Ok(())
}

/// True when `dir` holds nothing but the write lock and the directories
/// leading to `keep`.
fn only_holds(dir: &Path, keep: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.into_iter().all(|entry| {
        let Ok(entry) = entry else {
            return false;
        };
        let path = entry.path();
        entry.file_name() == WRITE_LOCK
            || path == keep
            || (keep.starts_with(&path) && path.is_dir() && only_holds(&path, keep))
    })
}

/// Remove `dir` and its ancestors while they are empty, stopping before `stop`.
fn remove_empty_dirs(dir: Option<&Path>, stop: Option<&Path>) {
    let mut current = dir;
    while let Some(path) = current {
        if Some(path) == stop || std::fs::remove_dir(path).is_err() {
            break;
        }
        current = path.parent();
    }
}

/// After the root's content moved into `new_root`, bring along CutReady's own
/// untracked metadata (`.cutready/` settings, recordings, and legacy `.chats/`)
/// that Git leaves at the root. Files Git tracks and files the destination
/// already has stay put and are returned, relative to `old_root`.
pub fn carry_root_metadata(old_root: &Path, new_root: &Path) -> Vec<PathBuf> {
    let index = git2::Repository::open(old_root)
        .and_then(|repo| repo.index())
        .ok();
    let tracked = |relative: &Path| {
        let key = relative.to_string_lossy().replace('\\', "/");
        index
            .as_ref()
            .is_some_and(|index| index.get_path(Path::new(&key), 0).is_some())
    };
    let mut left_behind = Vec::new();
    for folder in [".cutready", ".chats"] {
        let source = old_root.join(folder);
        if !source.is_dir() {
            continue;
        }
        let mut stack = vec![source.clone()];
        let mut dirs = Vec::new();
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            dirs.push(dir);
            for entry in entries.flatten() {
                let path = entry.path();
                let Ok(relative) = path.strip_prefix(old_root) else {
                    continue;
                };
                let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
                if is_dir {
                    stack.push(path);
                    continue;
                }
                let target = new_root.join(relative);
                let moved = !tracked(relative)
                    && target.symlink_metadata().is_err()
                    && target
                        .parent()
                        .is_none_or(|parent| std::fs::create_dir_all(parent).is_ok())
                    && std::fs::rename(&path, &target).is_ok();
                if !moved {
                    left_behind.push(relative.to_path_buf());
                }
            }
        }
        for dir in dirs.iter().rev() {
            let _ = std::fs::remove_dir(dir);
        }
    }
    left_behind
}

/// Workspace state persisted across app restarts.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct WorkspaceState {
    #[serde(default)]
    pub open_tabs: Vec<WorkspaceTab>,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub chat_session_path: Option<String>,
}

/// A persisted editor tab.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceTab {
    pub id: String,
    #[serde(rename = "type")]
    pub tab_type: String,
    pub path: String,
    pub title: String,
}

/// Read workspace state. Returns default (empty) if missing.
/// Checks .git/cutready/ first (new location), falls back to .cutready/ (legacy).
pub fn read_workspace_state(repo_root: &Path, project_root: &Path) -> WorkspaceState {
    let state_dir = git_state_dir(repo_root, project_root);
    let new_path = state_dir.join("workspace.json");
    if let Ok(data) = std::fs::read_to_string(&new_path) {
        if let Ok(mut ws) = serde_json::from_str(&data) {
            if let Err(err) = migrate_legacy_chat_sessions(repo_root, project_root) {
                log::warn!("[workspace] could not import archived chat sessions: {err}");
            }
            sanitize_workspace_chat_session(repo_root, project_root, &mut ws);
            return ws;
        }
    }
    // Legacy fallback: read from .cutready/workspace.json
    let legacy_path = project_root.join(".cutready/workspace.json");
    if let Ok(data) = std::fs::read_to_string(&legacy_path) {
        if let Ok(mut ws) = serde_json::from_str::<WorkspaceState>(&data) {
            if let Err(err) = migrate_legacy_chat_sessions(repo_root, project_root) {
                log::warn!("[workspace] could not import archived chat sessions: {err}");
            }
            sanitize_workspace_chat_session(repo_root, project_root, &mut ws);
            // Migrate by copying into local state. Preserve the versioned legacy file so opening
            // older projects never dirties history by deleting tracked compatibility data.
            log::info!(
                "[workspace] migrating workspace.json from {:?} → {:?}",
                legacy_path,
                new_path
            );
            let _ = std::fs::create_dir_all(&state_dir);
            let _ = serde_json::to_string_pretty(&ws).map(|json| std::fs::write(&new_path, json));
            return ws;
        }
    }
    WorkspaceState::default()
}

fn sanitize_workspace_chat_session(repo_root: &Path, project_root: &Path, ws: &mut WorkspaceState) {
    let _ = (repo_root, project_root);
    // Chat history is database-backed. Older workspace state may still carry a
    // file-session pointer, but it must never reactivate the removed file flow.
    ws.chat_session_path = None;
}

/// Write workspace state to .git/cutready/ (untracked by snapshots).
pub fn write_workspace_state(
    repo_root: &Path,
    project_root: &Path,
    ws: &WorkspaceState,
) -> Result<(), ProjectError> {
    let state_dir = git_state_dir(repo_root, project_root);
    std::fs::create_dir_all(&state_dir).map_err(|e| ProjectError::Io(e.to_string()))?;
    let path = state_dir.join("workspace.json");
    let data =
        serde_json::to_string_pretty(ws).map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(&path, data).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Read the sidebar ordering manifest. Returns default (empty) if missing.
/// Checks .git/cutready/ first (new location), falls back to legacy locations.
pub fn read_sidebar_order(repo_root: &Path, project_root: &Path) -> SidebarOrder {
    let state_dir = git_state_dir(repo_root, project_root);
    let new_path = state_dir.join("order.json");
    if let Ok(data) = std::fs::read_to_string(&new_path) {
        if let Ok(order) = serde_json::from_str(&data) {
            return order;
        }
    }
    // Legacy fallback: read from .cutready-order.json in project root
    let legacy_path = project_root.join(".cutready-order.json");
    if let Ok(data) = std::fs::read_to_string(&legacy_path) {
        if let Ok(order) = serde_json::from_str::<SidebarOrder>(&data) {
            // Migrate by copying into local state. Preserve the versioned legacy file so opening
            // older projects never dirties history by deleting tracked compatibility data.
            log::info!(
                "[workspace] migrating sidebar order from {:?} → {:?}",
                legacy_path,
                new_path
            );
            let _ = std::fs::create_dir_all(&state_dir);
            let _ =
                serde_json::to_string_pretty(&order).map(|json| std::fs::write(&new_path, json));
            return order;
        }
    }
    SidebarOrder::default()
}

/// Write the sidebar ordering manifest to .git/cutready/ (untracked by snapshots).
pub fn write_sidebar_order(
    repo_root: &Path,
    project_root: &Path,
    order: &SidebarOrder,
) -> Result<(), ProjectError> {
    let state_dir = git_state_dir(repo_root, project_root);
    std::fs::create_dir_all(&state_dir).map_err(|e| ProjectError::Io(e.to_string()))?;
    let path = state_dir.join("order.json");
    let data =
        serde_json::to_string_pretty(order).map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(&path, data).map_err(|e| ProjectError::Io(e.to_string()))
}

// ── Per-repo (workspace) settings ─────────────────────────────────

/// Read workspace settings from the repo root. Returns the raw JSON value.
/// The frontend owns the schema — the backend just stores/retrieves the blob.
pub fn read_repo_settings(repo_root: &Path) -> serde_json::Value {
    let path = repo_root.join(REPO_SETTINGS_FILE);
    if let Ok(data) = std::fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or(serde_json::Value::Object(Default::default()))
    } else {
        serde_json::Value::Object(Default::default())
    }
}

/// Write workspace settings to the repo root.
pub fn write_repo_settings(
    repo_root: &Path,
    settings: &serde_json::Value,
) -> Result<(), ProjectError> {
    let path = repo_root.join(REPO_SETTINGS_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    let data = serde_json::to_string_pretty(settings)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(&path, data).map_err(|e| ProjectError::Io(e.to_string()))
}

// ── Internal helpers ────────────────────────────────────────────────

/// Recursively find files with a given extension, skipping `.git` and hidden dirs.
fn scan_files_recursive(
    dir: &Path,
    project_root: &Path,
    extension: &str,
    callback: &mut dyn FnMut(&str, &Path),
) -> Result<(), ProjectError> {
    if !dir.exists() {
        return Ok(());
    }

    let entries = std::fs::read_dir(dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    for entry in entries {
        let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
        let path = entry.path();
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // Skip hidden directories and .git
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            scan_files_recursive(&path, project_root, extension, callback)?;
        } else if path.extension().is_some_and(|ext| ext == extension) {
            // Compute relative path using forward slashes for portability
            if let Ok(rel) = path.strip_prefix(project_root) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                callback(&rel_str, &path);
            }
        }
    }

    Ok(())
}

/// Errors that can occur during project operations.
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("I/O error: {0}")]
    Io(String),
    #[error("Serialization error: {0}")]
    Serialize(String),
    #[error("Deserialization error: {0}")]
    Deserialize(String),
    #[error("Project not found: {0}")]
    NotFound(String),
    #[error("Path traversal rejected: {0}")]
    PathTraversal(String),
    #[error("{0}")]
    Locked(String),
    /// A Draftline refusal serialized as its Tauri command error JSON.
    #[error("{0}")]
    Draftline(String),
    /// The document breaks an invariant (e.g. duplicate row ids).
    #[error("{0}")]
    Invalid(String),
}

impl From<document_writer::WriteError> for ProjectError {
    fn from(err: document_writer::WriteError) -> Self {
        use cutready_core::edit_ops::ContentEditError;
        match err {
            document_writer::WriteError::Project(err) => err,
            document_writer::WriteError::Edit(ContentEditError::Document(err)) => err.into(),
            document_writer::WriteError::Edit(err) => ProjectError::Invalid(err.to_string()),
        }
    }
}

impl From<document::DocumentError> for ProjectError {
    fn from(err: document::DocumentError) -> Self {
        match err {
            document::DocumentError::Port(e) => ProjectError::Io(e.to_string()),
            document::DocumentError::Parse(e) => ProjectError::Deserialize(e),
            document::DocumentError::Serialize(e) => ProjectError::Serialize(e),
            document::DocumentError::Locked(e) => ProjectError::Locked(e),
            document::DocumentError::DuplicateRowId(e) => ProjectError::Invalid(e.to_string()),
        }
    }
}

impl From<sketch_edits::SketchEditError> for ProjectError {
    fn from(err: sketch_edits::SketchEditError) -> Self {
        ProjectError::Locked(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn init_project_folder_creates_draftline_workspace() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("My Demo");

        let view = init_project_folder(&root).unwrap();
        assert_eq!(view.name, "My Demo");
        assert!(root.join(".git").exists());
    }

    /// The committed root `.draftline` marker that names the managed folder.
    fn folder_marker(repo_root: &Path) -> serde_json::Value {
        let marker = std::fs::read_to_string(repo_root.join(".draftline"))
            .expect("Draftline writes the folder marker on first open");
        serde_json::from_str(&marker).unwrap()
    }

    #[test]
    fn multi_project_workspace_always_opens_draftline_at_repo_root() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("workspace");
        init_project_folder(&root).unwrap();
        let alpha = create_project_in_repo(&root, "Alpha", None).unwrap();
        let beta = create_project_in_repo(&root, "Beta", None).unwrap();

        for entry in [&alpha, &beta, &alpha, &beta] {
            let (repo, projects) = open_repo(&root).unwrap();
            assert_eq!(projects.len(), 2);
            let view = ProjectView::in_repo(repo.root.clone(), &entry.path, entry.name.clone());
            assert!(!view.hybrid);
            assert_eq!(view.repo_root, root);

            let adapter = CutReadyDraftlineAdapter::open_project(&view.repo_root).unwrap();
            adapter.changed_files().unwrap();
            let change = crate::engine::draftline_adapter::StructureChange::begin(
                &view.repo_root,
                &crate::engine::write_lock::RepoLock::for_path(&view.repo_root),
                "Edit project",
                [view.root.clone()],
            )
            .unwrap();
            std::fs::write(view.root.join("notes").join("plan.md"), "# Plan\n").unwrap();
            change
                .finish(&view.repo_root, Err("no profile".into()))
                .unwrap();
        }

        assert_eq!(folder_marker(&root)["folder"], ".");
    }

    #[test]
    fn second_hybrid_folder_in_same_checkout_is_refused_with_claimed_folder() {
        let tmp = TempDir::new().unwrap();
        let code = tmp.path().join("contoso-app");
        let repo = git2::Repository::init(&code).unwrap();
        std::fs::write(code.join("README.md"), "# Contoso\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("README.md")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let signature = git2::Signature::now("Dev", "dev@example.com").unwrap();
            repo.commit(Some("HEAD"), &signature, &signature, "Init", &tree, &[])
                .unwrap();
        }
        let first = code.join("cutready");
        let second = code.join("marketing");
        for folder in [&first, &second] {
            std::fs::create_dir_all(folder).unwrap();
            std::fs::write(folder.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
        }

        open_repo(&first).unwrap();
        assert_eq!(folder_marker(&code)["folder"], "cutready");

        let refused = |error: ProjectError| match error {
            ProjectError::Draftline(json) => {
                let error: serde_json::Value = serde_json::from_str(&json).unwrap();
                assert_eq!(error["code"], "folder_is_elsewhere");
                assert_eq!(error["details"]["folder"], "cutready");
            }
            other => panic!("expected a folder-is-elsewhere refusal, got {other:?}"),
        };
        refused(open_repo(&second).unwrap_err());
        let new_folder = code.join("new-demo");
        refused(init_project_folder(&new_folder).unwrap_err());
        assert!(!new_folder.exists(), "refused new project leaves no folder");

        // The claimed folder keeps working.
        open_repo(&first).unwrap();
    }

    #[test]
    fn root_content_moved_into_a_subfolder_names_and_adopts_it() {
        let tmp = TempDir::new().unwrap();
        let code = tmp.path().join("demo");
        let repo = git2::Repository::init(&code).unwrap();
        let commit_all = |message: &str| {
            let mut index = repo.index().unwrap();
            index
                .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
                .unwrap();
            index.update_all(["*"], None).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let signature = git2::Signature::now("Dev", "dev@example.com").unwrap();
            let parents = repo
                .head()
                .ok()
                .and_then(|head| head.peel_to_commit().ok())
                .into_iter()
                .collect::<Vec<_>>();
            let parents = parents.iter().collect::<Vec<_>>();
            repo.commit(
                Some("HEAD"),
                &signature,
                &signature,
                message,
                &tree,
                &parents,
            )
            .unwrap();
        };
        std::fs::write(code.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
        std::fs::write(code.join("notes.md"), "# Notes\n").unwrap();
        open_repo(&code).unwrap();
        commit_all("Demo");
        assert_eq!(folder_marker(&code)["folder"], ".");

        let sub = code.join("cutready");
        std::fs::create_dir_all(&sub).unwrap();
        for name in ["intro.sk", "notes.md"] {
            std::fs::rename(code.join(name), sub.join(name)).unwrap();
        }
        std::fs::create_dir_all(code.join("src")).unwrap();
        std::fs::write(code.join("src").join("app.rs"), "fn main() {}\n").unwrap();
        commit_all("Move demo into cutready/ and add code");

        match open_repo(&code).unwrap_err() {
            ProjectError::Draftline(json) => {
                let error: serde_json::Value = serde_json::from_str(&json).unwrap();
                assert_eq!(error["code"], PROJECT_FOLDER_RENAMED);
                assert_eq!(error["details"]["moved_root"], true);
                assert_eq!(error["details"]["to"], "cutready");
                assert_eq!(
                    error["details"]["suggested"],
                    sub.to_string_lossy().as_ref()
                );
            }
            other => panic!("expected a moved-root prompt, got {other:?}"),
        }
        // Keeping the root is the user's call; it opens without moving anything.
        open_repo_with(&code, true).unwrap();
        assert_eq!(folder_marker(&code)["folder"], ".");

        open_repo(&sub).unwrap();
        assert_eq!(folder_marker(&code)["folder"], "cutready");
        assert_eq!(
            std::fs::read_to_string(code.join("src").join("app.rs")).unwrap(),
            "fn main() {}\n"
        );
    }

    #[test]
    fn renamed_hybrid_folder_names_its_new_location() {
        let tmp = TempDir::new().unwrap();
        let code = tmp.path().join("contoso-app");
        let repo = git2::Repository::init(&code).unwrap();
        std::fs::write(code.join("README.md"), "# Contoso\n").unwrap();
        let commit_all = |message: &str| {
            let mut index = repo.index().unwrap();
            index
                .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
                .unwrap();
            index.update_all(["*"], None).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let signature = git2::Signature::now("Dev", "dev@example.com").unwrap();
            let parents = repo
                .head()
                .ok()
                .and_then(|head| head.peel_to_commit().ok())
                .into_iter()
                .collect::<Vec<_>>();
            let parents = parents.iter().collect::<Vec<_>>();
            repo.commit(
                Some("HEAD"),
                &signature,
                &signature,
                message,
                &tree,
                &parents,
            )
            .unwrap();
        };
        commit_all("Init");
        let old = code.join("cutready");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
        std::fs::write(old.join("outro.sk"), r#"{"title":"Outro"}"#).unwrap();
        open_repo(&old).unwrap();
        commit_all("Add demo");

        let new = code.join("showcase");
        std::fs::rename(&old, &new).unwrap();
        commit_all("Rename demo folder");

        match open_repo(&old).unwrap_err() {
            ProjectError::Draftline(json) => {
                let error: serde_json::Value = serde_json::from_str(&json).unwrap();
                assert_eq!(error["code"], PROJECT_FOLDER_RENAMED);
                assert_eq!(error["details"]["folder"], "cutready");
                assert_eq!(error["details"]["to"], "showcase");
            }
            other => panic!("expected a renamed-folder refusal, got {other:?}"),
        }
        assert!(!old.exists(), "probing must not recreate the old folder");

        let typo = code.join("cutreddy");
        assert!(matches!(
            open_repo(&typo).unwrap_err(),
            ProjectError::NotFound(_)
        ));
        let other = code.join("docs");
        std::fs::create_dir_all(&other).unwrap();
        assert!(open_repo(&other).is_err(), "another folder is not adopted");
        assert_eq!(folder_marker(&code)["folder"], "cutready");

        open_repo(&new).unwrap();
        assert_eq!(folder_marker(&code)["folder"], "showcase");
    }

    fn code_repo(tmp: &TempDir) -> PathBuf {
        let code = tmp.path().join("contoso-app");
        let repo = git2::Repository::init(&code).unwrap();
        std::fs::create_dir_all(code.join("src")).unwrap();
        std::fs::write(code.join("src").join("main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(code.join("Cargo.toml"), "[package]\nname = \"contoso\"\n").unwrap();
        std::fs::write(code.join("README.md"), "# Contoso\n").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Dev", "dev@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "Init", &tree, &[])
            .unwrap();
        code
    }

    fn not_a_project(error: ProjectError) -> serde_json::Value {
        match error {
            ProjectError::Draftline(json) => {
                let error: serde_json::Value = serde_json::from_str(&json).unwrap();
                assert_eq!(error["code"], NOT_A_CUTREADY_PROJECT);
                error["details"].clone()
            }
            other => panic!("expected a not-a-CutReady-project refusal, got {other:?}"),
        }
    }

    #[test]
    fn code_repository_root_is_not_adopted_without_confirmation() {
        let tmp = TempDir::new().unwrap();
        let code = code_repo(&tmp);
        let head = git2::Repository::open(&code)
            .unwrap()
            .head()
            .unwrap()
            .target();

        let details = not_a_project(open_repo(&code).unwrap_err());
        assert_eq!(
            PathBuf::from(details["suggested"].as_str().unwrap()),
            code.join("cutready")
        );
        assert_eq!(details["suggested_exists"], false);
        assert!(!code.join(".draftline").exists(), "refusal writes nothing");
        assert!(!code.join(".cutready").exists(), "refusal writes nothing");
        let after = git2::Repository::open(&code)
            .unwrap()
            .head()
            .unwrap()
            .target();
        assert_eq!(head, after, "refusal commits nothing");

        // A source folder inside the repository is refused too, pointing at the root.
        let details = not_a_project(open_repo(&code.join("src")).unwrap_err());
        assert_eq!(PathBuf::from(details["repository"].as_str().unwrap()), code);
        assert_eq!(
            PathBuf::from(details["suggested"].as_str().unwrap()),
            code.join("cutready")
        );

        // The suggested subfolder becomes a hybrid project.
        let view = init_project_folder(&code.join("cutready")).unwrap();
        assert_eq!(view.root, code.join("cutready"));
        assert_eq!(folder_marker(&code)["folder"], "cutready");
    }

    #[test]
    fn confirmed_adoption_opens_an_unrecognized_folder() {
        let tmp = TempDir::new().unwrap();
        let code = code_repo(&tmp);
        let (repo, projects) = open_repo_with(&code, true).unwrap();
        assert_eq!(repo.root, code);
        assert_eq!(projects.len(), 1);
        // Once managed, it opens without asking again.
        open_repo(&code).unwrap();
    }

    #[test]
    fn existing_cutready_folders_open_without_confirmation() {
        let tmp = TempDir::new().unwrap();

        // A legacy project with sketches beside other files.
        let legacy = tmp.path().join("legacy");
        std::fs::create_dir_all(legacy.join("assets")).unwrap();
        std::fs::write(legacy.join("intro.sk"), r#"{"title":"Intro"}"#).unwrap();
        std::fs::write(legacy.join("assets").join("logo.ai"), "x").unwrap();
        open_repo(&legacy).unwrap();

        // A notes-only project.
        let notes = tmp.path().join("notes-only");
        std::fs::create_dir_all(notes.join("screenshots")).unwrap();
        std::fs::write(notes.join("plan.md"), "# Plan\n").unwrap();
        open_repo(&notes).unwrap();

        // A project with only CutReady metadata.
        let meta = tmp.path().join("meta");
        std::fs::create_dir_all(meta.join(".cutready")).unwrap();
        std::fs::write(meta.join("budget.xlsx"), "x").unwrap();
        open_repo(&meta).unwrap();

        // An empty folder.
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        open_repo(&empty).unwrap();
    }

    #[test]
    fn write_and_read_sketch() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("My Sketch", chrono::Utc::now());
        let path = root.join("intro.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());

        let loaded = read_sketch(&path).unwrap();
        assert_eq!(loaded.title, "My Sketch");
    }

    #[test]
    fn write_sketch_creates_subdirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Nested", chrono::Utc::now());
        let path = root.join("flows").join("login.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn create_project_rejects_malformed_manifest() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".cutready")).unwrap();
        std::fs::write(root.join(".cutready/projects.json"), "{not valid json").unwrap();

        let err = create_project_in_repo(root, "Broken", None).unwrap_err();

        assert!(matches!(err, ProjectError::Deserialize(_)));
        assert!(!root.join("broken").exists());
    }

    #[test]
    fn inspect_missing_manifest_preserves_legacy_root_fallback() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("intro.sk"), "{}").unwrap();

        let inspection = inspect_workspace_manifest(root).unwrap();

        assert_eq!(inspection.status, WorkspaceManifestStatus::Missing);
        assert!(inspection.legacy_single_project_fallback);
        assert!(inspection.unlisted_projects.is_empty());
        assert!(inspection.proposed_manifest.is_none());
    }

    #[test]
    fn inspect_missing_manifest_proposes_child_projects() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("login-demo/notes")).unwrap();
        std::fs::create_dir_all(root.join("onboarding/sketches")).unwrap();

        let inspection = inspect_workspace_manifest(root).unwrap();

        assert_eq!(inspection.status, WorkspaceManifestStatus::Missing);
        assert!(!inspection.legacy_single_project_fallback);
        assert_eq!(
            inspection
                .unlisted_projects
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["login-demo", "onboarding"]
        );
        assert_eq!(
            inspection
                .proposed_manifest
                .as_ref()
                .unwrap()
                .projects
                .len(),
            2
        );
    }

    #[test]
    fn inspect_missing_manifest_proposes_root_and_child_projects() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::write(root.join("intro.sk"), "{}").unwrap();
        std::fs::create_dir_all(root.join("child-demo/notes")).unwrap();

        let inspection = inspect_workspace_manifest(root).unwrap();

        assert_eq!(inspection.status, WorkspaceManifestStatus::Missing);
        assert!(inspection.legacy_single_project_fallback);
        assert_eq!(
            inspection
                .proposed_manifest
                .as_ref()
                .unwrap()
                .projects
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec![".", "child-demo"]
        );
    }

    #[test]
    fn repair_malformed_manifest_preserves_backup_before_replacement() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".cutready")).unwrap();
        std::fs::create_dir_all(root.join("recovered/notes")).unwrap();
        std::fs::write(root.join(".cutready/projects.json"), "{not valid json").unwrap();

        let inspection = inspect_workspace_manifest(root).unwrap();
        assert_eq!(inspection.status, WorkspaceManifestStatus::Malformed);
        assert!(inspection.parse_error.is_some());

        let repair = repair_workspace_manifest(root).unwrap();
        let backup_path = repair.backup_path.as_deref().unwrap();

        assert!(backup_path.starts_with(".cutready/projects.recovery-"));
        assert_eq!(
            std::fs::read_to_string(root.join(backup_path)).unwrap(),
            "{not valid json"
        );
        let manifest = read_manifest_result(root).unwrap().unwrap();
        assert_eq!(manifest.projects.len(), 1);
        assert_eq!(manifest.projects[0].path, "recovered");
    }

    #[test]
    fn inspect_valid_manifest_reports_stale_entries() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("valid/notes")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        write_manifest(
            root,
            &ProjectManifest {
                projects: vec![
                    ProjectEntry {
                        path: "valid".into(),
                        name: "Valid".into(),
                        description: None,
                    },
                    ProjectEntry {
                        path: "missing".into(),
                        name: "Missing".into(),
                        description: None,
                    },
                    ProjectEntry {
                        path: "empty".into(),
                        name: "Empty".into(),
                        description: None,
                    },
                ],
            },
        )
        .unwrap();

        let inspection = inspect_workspace_manifest(root).unwrap();

        assert_eq!(inspection.status, WorkspaceManifestStatus::Valid);
        assert_eq!(
            inspection
                .stale_entries
                .iter()
                .map(|issue| (issue.entry.path.as_str(), issue.reason.as_str()))
                .collect::<Vec<_>>(),
            vec![("missing", "missing_folder"), ("empty", "not_project_like")]
        );
        assert_eq!(
            inspection
                .proposed_manifest
                .as_ref()
                .unwrap()
                .projects
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["valid"]
        );
    }

    #[test]
    fn inspect_valid_manifest_reports_unlisted_child_projects() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("listed/notes")).unwrap();
        std::fs::create_dir_all(root.join("unlisted/storyboards")).unwrap();
        write_manifest(
            root,
            &ProjectManifest {
                projects: vec![ProjectEntry {
                    path: "listed".into(),
                    name: "Listed".into(),
                    description: None,
                }],
            },
        )
        .unwrap();

        let inspection = inspect_workspace_manifest(root).unwrap();

        assert_eq!(inspection.status, WorkspaceManifestStatus::Valid);
        assert_eq!(inspection.unlisted_projects.len(), 1);
        assert_eq!(inspection.unlisted_projects[0].path, "unlisted");
        assert_eq!(
            inspection
                .proposed_manifest
                .as_ref()
                .unwrap()
                .projects
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["listed", "unlisted"]
        );
    }

    #[test]
    fn delete_sketch_removes_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Delete Me", chrono::Utc::now());
        let path = root.join("temp.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());

        delete_sketch(&path, root).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn delete_sketch_removes_storyboard_references() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Delete Me", chrono::Utc::now());
        let sketch_path = root.join("delete-me.sk");
        write_sketch(&sketch, &sketch_path, root).unwrap();

        let now = chrono::Utc::now();
        let storyboard_path = root.join("demo.sb");
        let storyboard = Storyboard {
            title: "Demo".into(),
            description: String::new(),
            locked: false,
            metadata: cutready_core::models::sketch::DocumentMetadata::default(),
            items: vec![
                cutready_core::models::sketch::StoryboardItem::SketchRef {
                    path: "intro.sk".into(),
                },
                cutready_core::models::sketch::StoryboardItem::SketchRef {
                    path: "delete-me.sk".into(),
                },
                cutready_core::models::sketch::StoryboardItem::Section {
                    title: "Build".into(),
                    description: String::new(),
                    sketches: vec!["delete-me.sk".into(), "keep-me.sk".into()],
                },
            ],
            created_at: now,
            updated_at: now,
            unknown_fields: Default::default(),
        };
        write_storyboard(&storyboard, &storyboard_path, root).unwrap();

        delete_sketch(&sketch_path, root).unwrap();

        let updated_storyboard = read_storyboard(&storyboard_path).unwrap();
        assert!(!sketch_path.exists());
        assert_eq!(
            updated_storyboard.sketch_paths(),
            vec!["intro.sk", "keep-me.sk"]
        );
    }

    #[test]
    fn delete_sketch_rejects_locked_referencing_storyboard() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Delete Me", chrono::Utc::now());
        let sketch_path = root.join("delete-me.sk");
        write_sketch(&sketch, &sketch_path, root).unwrap();

        let mut storyboard = Storyboard::new("Locked Board", chrono::Utc::now());
        storyboard.locked = true;
        storyboard
            .items
            .push(cutready_core::models::sketch::StoryboardItem::SketchRef {
                path: "delete-me.sk".into(),
            });
        let storyboard_path = root.join("locked.sb");
        write_storyboard(&storyboard, &storyboard_path, root).unwrap();

        let err = delete_sketch(&sketch_path, root).unwrap_err();

        assert!(matches!(err, ProjectError::Locked(_)));
        assert!(sketch_path.exists());
        assert!(read_storyboard(&storyboard_path)
            .unwrap()
            .references_sketch("delete-me.sk"));
    }

    #[test]
    fn delete_sketch_rejects_locked_sketch() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut sketch = Sketch::new("Keep Me", chrono::Utc::now());
        sketch.locked = true;
        let path = root.join("locked.sk");

        write_sketch(&sketch, &path, root).unwrap();
        let err = delete_sketch(&path, root).unwrap_err();

        assert!(matches!(err, ProjectError::Locked(_)));
        assert!(path.exists());
    }

    #[test]
    fn delete_sketch_rejects_locked_row_or_cell() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut sketch = Sketch::new("Keep Row", chrono::Utc::now());
        let mut row = cutready_core::models::sketch::PlanningRow::new();
        row.locks.narrative = true;
        sketch.rows.push(row);
        let path = root.join("locked-row.sk");

        write_sketch(&sketch, &path, root).unwrap();
        let err = delete_sketch(&path, root).unwrap_err();

        assert!(matches!(err, ProjectError::Locked(_)));
        assert!(path.exists());
    }

    #[test]
    fn rename_sketch_moves_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Rename Me", chrono::Utc::now());
        let old_path = root.join("old.sk");
        let new_path = root.join("new.sk");

        write_sketch(&sketch, &old_path, root).unwrap();
        rename_sketch(&old_path, &new_path, root).unwrap();

        assert!(!old_path.exists());
        assert!(new_path.exists());
        let loaded = read_sketch(&new_path).unwrap();
        assert_eq!(loaded.title, "Rename Me");
    }

    #[test]
    fn rename_sketch_rejects_locked_sketch() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut sketch = Sketch::new("Keep Name", chrono::Utc::now());
        sketch.locked = true;
        let old_path = root.join("locked.sk");
        let new_path = root.join("renamed.sk");

        write_sketch(&sketch, &old_path, root).unwrap();
        let err = rename_sketch(&old_path, &new_path, root).unwrap_err();

        assert!(matches!(err, ProjectError::Locked(_)));
        assert!(old_path.exists());
        assert!(!new_path.exists());
    }

    #[test]
    fn rename_project_asset_updates_storyboard_sketch_references() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_sketch(
            &Sketch::new("Old", chrono::Utc::now()),
            &root.join("old.sk"),
            root,
        )
        .unwrap();

        let mut storyboard = Storyboard::new("Demo", chrono::Utc::now());
        storyboard
            .items
            .push(cutready_core::models::sketch::StoryboardItem::SketchRef {
                path: "old.sk".into(),
            });
        storyboard
            .items
            .push(cutready_core::models::sketch::StoryboardItem::Section {
                title: "Part".into(),
                description: String::new(),
                sketches: vec!["old.sk".into(), "keep.sk".into()],
            });
        write_storyboard(&storyboard, &root.join("demo.sb"), root).unwrap();

        let result = rename_project_asset(root, "old.sk", "renamed.sk").unwrap();

        assert!(!root.join("old.sk").exists());
        assert!(root.join("renamed.sk").exists());
        assert_eq!(result.updated_references[0].path, "demo.sb");
        assert_eq!(result.updated_references[0].count, 2);
        let updated = read_storyboard(&root.join("demo.sb")).unwrap();
        assert_eq!(
            updated.sketch_paths(),
            vec!["renamed.sk", "renamed.sk", "keep.sk"]
        );
    }

    #[test]
    fn rename_project_asset_rejects_locked_referencing_storyboard() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_sketch(
            &Sketch::new("Old", chrono::Utc::now()),
            &root.join("old.sk"),
            root,
        )
        .unwrap();

        let mut storyboard = Storyboard::new("Locked", chrono::Utc::now());
        storyboard.locked = true;
        storyboard
            .items
            .push(cutready_core::models::sketch::StoryboardItem::SketchRef {
                path: "old.sk".into(),
            });
        write_storyboard(&storyboard, &root.join("locked.sb"), root).unwrap();

        let err = rename_project_asset(root, "old.sk", "renamed.sk").unwrap_err();

        assert!(matches!(err, ProjectError::Locked(_)));
        assert!(root.join("old.sk").exists());
        assert!(!root.join("renamed.sk").exists());
        assert!(read_storyboard(&root.join("locked.sb"))
            .unwrap()
            .references_sketch("old.sk"));
    }

    #[test]
    fn rename_project_asset_renames_chat_artifact() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("chat-artifacts")).unwrap();
        std::fs::write(root.join("chat-artifacts/old.cv"), "{}").unwrap();

        let result =
            rename_project_asset(root, "chat-artifacts/old.cv", "chat-artifacts/renamed.cv")
                .unwrap();

        assert!(!root.join("chat-artifacts/old.cv").exists());
        assert!(root.join("chat-artifacts/renamed.cv").exists());
        assert!(result.updated_references.is_empty());
    }

    #[test]
    fn scan_chat_artifacts_includes_turn_count() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("chat-artifacts")).unwrap();
        std::fs::write(
            root.join("chat-artifacts/demo.cv"),
            r#"{"title":"Demo","turns":[{"role":"user"},{"role":"assistant"}]}"#,
        )
        .unwrap();

        let summaries = scan_chat_artifacts(root).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "demo");
        assert_eq!(summaries[0].turn_count, Some(2));
    }

    #[test]
    fn rename_project_asset_updates_screenshot_references() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".cutready/screenshots")).unwrap();
        std::fs::write(root.join(".cutready/screenshots/old.png"), b"png").unwrap();

        let mut sketch = Sketch::new("Shot", chrono::Utc::now());
        let mut row = cutready_core::models::sketch::PlanningRow::new();
        row.screenshot = Some(".cutready/screenshots/old.png".into());
        sketch.rows.push(row);
        write_sketch(&sketch, &root.join("shot.sk"), root).unwrap();
        document_writer::replace_note(
            root,
            &root.join("notes.md"),
            r#"before ![](.cutready/screenshots/old.png "title") after <img src=".cutready/screenshots/old.png">"#,
        )
        .unwrap();

        let result = rename_project_asset(
            root,
            ".cutready/screenshots/old.png",
            ".cutready/screenshots/new.png",
        )
        .unwrap();

        assert_eq!(result.updated_references.len(), 2);
        assert!(!root.join(".cutready/screenshots/old.png").exists());
        assert!(root.join(".cutready/screenshots/new.png").exists());
        let updated_sketch = read_sketch(&root.join("shot.sk")).unwrap();
        assert_eq!(
            updated_sketch.rows[0].screenshot.as_deref(),
            Some(".cutready/screenshots/new.png")
        );
        let note = read_note(&root.join("notes.md")).unwrap();
        assert!(note.contains(r#"![](.cutready/screenshots/new.png "title")"#));
        assert!(note.contains(r#"<img src=".cutready/screenshots/new.png">"#));
    }

    #[test]
    fn rename_project_asset_rejects_locked_screenshot_cell() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".cutready/screenshots")).unwrap();
        std::fs::write(root.join(".cutready/screenshots/old.png"), b"png").unwrap();

        let mut sketch = Sketch::new("Shot", chrono::Utc::now());
        let mut row = cutready_core::models::sketch::PlanningRow::new();
        row.screenshot = Some(".cutready/screenshots/old.png".into());
        row.locks.screenshot = true;
        sketch.rows.push(row);
        write_sketch(&sketch, &root.join("shot.sk"), root).unwrap();

        let err = rename_project_asset(
            root,
            ".cutready/screenshots/old.png",
            ".cutready/screenshots/new.png",
        )
        .unwrap_err();

        assert!(matches!(err, ProjectError::Locked(_)));
        assert!(root.join(".cutready/screenshots/old.png").exists());
        assert!(!root.join(".cutready/screenshots/new.png").exists());
    }

    #[test]
    fn rename_project_asset_updates_visual_references() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".cutready/visuals")).unwrap();
        std::fs::write(root.join(".cutready/visuals/old.json"), b"{}").unwrap();

        let mut sketch = Sketch::new("Visual", chrono::Utc::now());
        let mut row = cutready_core::models::sketch::PlanningRow::new();
        row.visual = Some(serde_json::Value::String(
            ".cutready/visuals/old.json".into(),
        ));
        sketch.rows.push(row);
        write_sketch(&sketch, &root.join("visual.sk"), root).unwrap();

        rename_project_asset(
            root,
            ".cutready/visuals/old.json",
            ".cutready/visuals/new.json",
        )
        .unwrap();

        let updated = read_sketch(&root.join("visual.sk")).unwrap();
        assert_eq!(
            updated.rows[0]
                .visual
                .as_ref()
                .and_then(|value| value.as_str()),
            Some(".cutready/visuals/new.json")
        );
    }

    #[test]
    fn read_nonexistent_sketch_errors() {
        let result = read_sketch(Path::new("/nonexistent/sketch.sk"));
        assert!(result.is_err());
    }

    #[test]
    fn note_lock_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        assert!(!get_note_lock(root, "notes/a.md").unwrap().locked);
        assert!(set_note_lock(root, "notes/a.md", true).unwrap().locked);
        assert!(get_note_lock(root, "notes/a.md").unwrap().locked);
        assert!(ensure_note_unlocked(root, "notes/a.md").is_err());
        assert!(!set_note_lock(root, "notes/a.md", false).unwrap().locked);
        assert!(!get_note_lock(root, "notes/a.md").unwrap().locked);
    }

    #[test]
    fn delete_note_rejects_locked_note() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let note = root.join("locked.md");

        std::fs::write(&note, "Keep this").unwrap();
        set_note_lock(root, "locked.md", true).unwrap();
        let err = delete_note(&note, root).unwrap_err();

        assert!(matches!(err, ProjectError::Locked(_)));
        assert!(note.exists());
        assert!(get_note_lock(root, "locked.md").unwrap().locked);
    }

    #[test]
    fn rename_note_rejects_locked_note() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let old_path = root.join("locked.md");
        let new_path = root.join("renamed.md");

        std::fs::write(&old_path, "Keep this").unwrap();
        set_note_lock(root, "locked.md", true).unwrap();
        let err = rename_file(&old_path, &new_path, root, "note").unwrap_err();

        assert!(matches!(err, ProjectError::Locked(_)));
        assert!(old_path.exists());
        assert!(!new_path.exists());
    }

    #[test]
    fn row_update_rejects_locked_cell_change() {
        let mut old = cutready_core::models::sketch::PlanningRow::new();
        old.narrative = "Keep this".into();
        old.locks.narrative = true;

        let mut new = old.clone();
        new.narrative = "Changed".into();

        let err = validate_rows_update_allowed(&[old], &[new]).unwrap_err();
        assert!(err.to_string().contains("narrative cell is locked"));
    }

    #[test]
    fn scan_sketches_finds_all() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_sketch(
            &Sketch::new("A", chrono::Utc::now()),
            &root.join("a.sk"),
            root,
        )
        .unwrap();
        write_sketch(
            &Sketch::new("B", chrono::Utc::now()),
            &root.join("b.sk"),
            root,
        )
        .unwrap();
        write_sketch(
            &Sketch::new("C", chrono::Utc::now()),
            &root.join("sub").join("c.sk"),
            root,
        )
        .unwrap();

        let summaries = scan_sketches(root).unwrap();
        assert_eq!(summaries.len(), 3);

        let paths: Vec<&str> = summaries.iter().map(|s| s.path.as_str()).collect();
        assert!(paths.contains(&"a.sk"));
        assert!(paths.contains(&"b.sk"));
        assert!(paths.contains(&"sub/c.sk"));
    }

    #[test]
    fn scan_sketches_skips_hidden_dirs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_sketch(
            &Sketch::new("Visible", chrono::Utc::now()),
            &root.join("visible.sk"),
            root,
        )
        .unwrap();
        // Put a sketch in .git — should be skipped
        let hidden = root.join(".git").join("hidden.sk");
        std::fs::create_dir_all(hidden.parent().unwrap()).unwrap();
        std::fs::write(&hidden, r#"{"title":"Hidden","state":"draft","created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}"#).unwrap();

        let summaries = scan_sketches(root).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "Visible");
    }

    #[test]
    fn scan_sketches_empty_dir() {
        let tmp = TempDir::new().unwrap();
        let summaries = scan_sketches(tmp.path()).unwrap();
        assert!(summaries.is_empty());
    }

    #[test]
    fn write_and_read_storyboard() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sb = Storyboard::new("Full Demo", chrono::Utc::now());
        let path = root.join("demo.sb");

        write_storyboard(&sb, &path, root).unwrap();
        let loaded = read_storyboard(&path).unwrap();
        assert_eq!(loaded.title, "Full Demo");
    }

    #[test]
    fn read_storyboard_upgrades_and_rewrites_legacy_file() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("legacy.sb");
        std::fs::write(
            &path,
            r#"{"title":"Legacy","sketches":["intro.sk"],"created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        document_writer::open_project(tmp.path()).unwrap();

        let storyboard = read_storyboard(&path).unwrap();

        assert_eq!(storyboard.description, "");
        assert_eq!(storyboard.sketch_paths(), vec!["intro.sk"]);
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(saved.get("sketches").is_none());
        assert_eq!(saved["items"][0]["type"], "sketch_ref");
    }

    #[test]
    fn scan_storyboards_upgrades_and_rewrites_legacy_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        document_writer::open_project(root).unwrap();
        let path = root.join("legacy.sb");
        std::fs::write(
            &path,
            r#"{"title":"Legacy","sketches":["intro.sk"],"created_at":"2025-01-01T00:00:00Z","updated_at":"2025-01-01T00:00:00Z"}"#,
        )
        .unwrap();

        let summaries = scan_storyboards(root).unwrap();

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].title, "Legacy");
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(saved.get("sketches").is_none());
        assert_eq!(saved["items"][0]["path"], "intro.sk");
    }

    #[test]
    fn scan_storyboards_finds_all() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_storyboard(
            &Storyboard::new("A", chrono::Utc::now()),
            &root.join("a.sb"),
            root,
        )
        .unwrap();
        write_storyboard(
            &Storyboard::new("B", chrono::Utc::now()),
            &root.join("b.sb"),
            root,
        )
        .unwrap();

        let summaries = scan_storyboards(root).unwrap();
        assert_eq!(summaries.len(), 2);
    }

    #[test]
    fn sketch_file_exists_checks_correctly() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        assert!(!sketch_file_exists("intro.sk", root));
        write_sketch(
            &Sketch::new("Intro", chrono::Utc::now()),
            &root.join("intro.sk"),
            root,
        )
        .unwrap();
        assert!(sketch_file_exists("intro.sk", root));
    }

    // ── safe_resolve tests ─────────────────────────────────

    #[test]
    fn safe_resolve_accepts_normal_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let result = safe_resolve(root, "intro.sk").unwrap();
        assert_eq!(result, root.join("intro.sk"));

        let result = safe_resolve(root, "flows/login.sk").unwrap();
        assert_eq!(result, root.join("flows/login.sk"));
    }

    #[test]
    fn safe_resolve_rejects_parent_traversal() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        assert!(safe_resolve(root, "../escape.sk").is_err());
        assert!(safe_resolve(root, "sub/../../escape.sk").is_err());
        assert!(safe_resolve(root, "..").is_err());
    }

    #[test]
    fn safe_resolve_rejects_absolute_and_root_relative_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        #[cfg(target_os = "windows")]
        assert!(safe_resolve(root, "C:\\Windows\\System32\\cmd.exe").is_err());

        assert!(safe_resolve(root, "/etc/passwd").is_err());

        #[cfg(target_os = "windows")]
        assert!(safe_resolve(root, "\\Windows\\System32\\cmd.exe").is_err());
    }

    #[test]
    fn safe_resolve_rejects_canonicalized_escape_from_nested_root() {
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path();
        let source_root = workspace.join("repo").join("project");
        let sibling_root = workspace.join("repo").join("other");
        std::fs::create_dir_all(&source_root).unwrap();
        std::fs::create_dir_all(&sibling_root).unwrap();
        std::fs::write(sibling_root.join("observable.txt"), "outside").unwrap();

        let err = safe_resolve(&source_root, "../other/observable.txt").unwrap_err();
        assert!(err.to_string().contains("Path traversal"));
    }

    #[test]
    fn safe_resolve_rejects_canonicalized_symlink_escape() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("project");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("observable.txt"), "outside").unwrap();

        let link = root.join("linked-outside");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &link).unwrap();
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(&outside, &link).unwrap();
        }

        let err = safe_resolve(&root, "linked-outside/observable.txt").unwrap_err();
        assert!(err.to_string().contains("Path traversal"));
    }

    // ── delete_note with image cleanup tests ──────────────────

    #[test]
    fn delete_note_keeps_unreferenced_images_for_media_cleanup() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Create screenshots dir and an image
        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        let img = ss_dir.join("pasted-123.png");
        std::fs::write(&img, b"fake image").unwrap();

        // Create a note referencing the image
        let note = root.join("test.md");
        std::fs::write(&note, "![screenshot](.cutready/screenshots/pasted-123.png)").unwrap();

        delete_note(&note, root).unwrap();
        assert!(!note.exists(), "note should be deleted");
        assert!(img.exists(), "media is never deleted as a side effect");
        let listed = list_images_with_refs(root).unwrap();
        assert!(listed[0].referenced_by.is_empty(), "now shows as unused");
    }

    #[test]
    fn delete_note_keeps_shared_images() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Create screenshots dir and an image
        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        let img = ss_dir.join("shared.png");
        std::fs::write(&img, b"fake image").unwrap();

        // Two notes reference the same image
        let note1 = root.join("note1.md");
        let note2 = root.join("note2.md");
        std::fs::write(&note1, "![a](.cutready/screenshots/shared.png)").unwrap();
        std::fs::write(&note2, "![b](.cutready/screenshots/shared.png)").unwrap();

        delete_note(&note1, root).unwrap();
        assert!(!note1.exists(), "note1 should be deleted");
        assert!(
            img.exists(),
            "shared image should be kept (note2 still references it)"
        );
    }

    #[test]
    fn delete_note_no_images_works() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let note = root.join("simple.md");
        std::fs::write(&note, "Just some text").unwrap();

        delete_note(&note, root).unwrap();
        assert!(!note.exists());
    }

    // ── list_images_with_refs tests ─────────────────────────────

    #[test]
    fn list_images_with_refs_finds_references() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Create screenshots dir and images
        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        std::fs::write(ss_dir.join("pasted-001.png"), b"img1").unwrap();
        std::fs::write(ss_dir.join("pasted-002.png"), b"img2").unwrap();

        // Create a note at root level referencing one image
        std::fs::write(
            root.join("my-note.md"),
            "# Hello\n\n![screenshot](.cutready/screenshots/pasted-001.png)\n",
        )
        .unwrap();

        let result = list_images_with_refs(root).unwrap();
        assert_eq!(result.len(), 2);

        let img1 = result
            .iter()
            .find(|i| i.path.contains("pasted-001"))
            .unwrap();
        assert_eq!(
            img1.referenced_by.len(),
            1,
            "pasted-001 should be referenced by my-note.md"
        );
        assert!(img1.referenced_by[0].contains("my-note.md"));

        let img2 = result
            .iter()
            .find(|i| i.path.contains("pasted-002"))
            .unwrap();
        assert_eq!(img2.referenced_by.len(), 0, "pasted-002 should be orphaned");
    }

    #[test]
    fn list_images_with_refs_no_false_orphans() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Create screenshots dir and an image
        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        std::fs::write(ss_dir.join("pasted-100.png"), b"img").unwrap();

        // Create a note referencing the image
        std::fs::write(
            root.join("script-draft.md"),
            "Some text\n\n![pic](.cutready/screenshots/pasted-100.png)\n\nMore text",
        )
        .unwrap();

        let result = list_images_with_refs(root).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].referenced_by.len(),
            1,
            "Image should NOT be reported as orphaned when referenced by a note"
        );
    }

    #[test]
    fn list_images_with_refs_detects_html_img_refs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        std::fs::write(ss_dir.join("pasted-html.png"), b"img").unwrap();

        // Note uses HTML img tag instead of markdown syntax
        std::fs::write(
            root.join("html-note.md"),
            "# Note\n\n<img src=\".cutready/screenshots/pasted-html.png\" alt=\"test\" />\n",
        )
        .unwrap();

        let result = list_images_with_refs(root).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].referenced_by.len(),
            1,
            "HTML img tag references should be detected"
        );
    }

    #[test]
    fn list_images_with_refs_includes_sketch_references() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        std::fs::write(ss_dir.join("step1.png"), b"img").unwrap();

        // Only a sketch references this image (no notes)
        std::fs::write(
            root.join("intro.sk"),
            r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"x","demo_actions":"y","screenshot":".cutready/screenshots/step1.png"}]}"#,
        ).unwrap();

        let result = list_images_with_refs(root).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].referenced_by.len(),
            1,
            "Image referenced by a sketch should NOT be reported as orphaned"
        );
        assert!(result[0].referenced_by[0].contains("intro.sk"));
    }

    #[test]
    fn delete_note_keeps_images_referenced_by_sketches() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        let ss_dir = root.join(".cutready").join("screenshots");
        std::fs::create_dir_all(&ss_dir).unwrap();
        let img = ss_dir.join("shared.png");
        std::fs::write(&img, b"fake image").unwrap();

        // A note references the image
        let note = root.join("test.md");
        std::fs::write(&note, "![pic](.cutready/screenshots/shared.png)").unwrap();

        // A sketch also references it
        std::fs::write(
            root.join("demo.sk"),
            r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"x","demo_actions":"y","screenshot":".cutready/screenshots/shared.png"}]}"#,
        ).unwrap();

        delete_note(&note, root).unwrap();
        assert!(!note.exists(), "note should be deleted");
        assert!(img.exists(), "image referenced by sketch should be kept");
    }

    // ── Workspace state migration tests ──────────────────────────

    #[test]
    fn workspace_state_writes_to_git_dir() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();

        let ws = WorkspaceState {
            open_tabs: vec![],
            active_tab_id: Some("test-tab".to_string()),
            chat_session_path: None,
        };
        write_workspace_state(root, root, &ws).unwrap();

        // Should be in .git/cutready/, not .cutready/
        assert!(
            root.join(".git/cutready/workspace.json").exists(),
            "Workspace state should be in .git/cutready/"
        );
        assert!(
            !root.join(".cutready/workspace.json").exists(),
            "Workspace state should NOT be in .cutready/"
        );
    }

    #[test]
    fn workspace_state_migrates_from_legacy() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();

        // Write state to legacy location
        let legacy_dir = root.join(".cutready");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(
            legacy_dir.join("workspace.json"),
            r#"{"open_tabs":[],"active_tab_id":"legacy-tab"}"#,
        )
        .unwrap();

        // Read should find it and migrate
        let ws = read_workspace_state(root, root);
        assert_eq!(
            ws.active_tab_id.as_deref(),
            Some("legacy-tab"),
            "Should read from legacy location"
        );

        // Legacy file should be preserved, new local-state copy should exist
        assert!(
            legacy_dir.join("workspace.json").exists(),
            "Legacy file should be preserved after migration"
        );
        assert!(
            root.join(".git/cutready/workspace.json").exists(),
            "Migrated file should be in .git/cutready/"
        );

        // Reading again should find it in new location
        let ws2 = read_workspace_state(root, root);
        assert_eq!(ws2.active_tab_id.as_deref(), Some("legacy-tab"));
    }

    #[test]
    fn workspace_state_clears_missing_legacy_chat_session() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();

        let state_dir = root.join(".git/cutready");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(
            state_dir.join("workspace.json"),
            r#"{"open_tabs":[],"active_tab_id":null,"chat_session_path":".chats/missing.chat"}"#,
        )
        .unwrap();

        let ws = read_workspace_state(root, root);

        assert!(ws.chat_session_path.is_none());
    }

    #[test]
    fn workspace_state_clears_existing_legacy_chat_session() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();

        let state_dir = root.join(".git/cutready");
        let chat_dir = state_dir.join("legacy-chats");
        std::fs::create_dir_all(&chat_dir).unwrap();
        let chat_source = chat_dir.join("chat.chat");
        std::fs::write(
            &chat_source,
            serde_json::json!({
                "title": "Saved chat",
                "messages": [{"role": "user", "content": "Keep this conversation"}],
                "created_at": "2025-06-01T10:00:00Z",
                "updated_at": "2025-06-01T10:01:00Z",
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            state_dir.join("workspace.json"),
            r#"{"open_tabs":[],"active_tab_id":null,"chat_session_path":"cutready://legacy-chats/chat.chat"}"#,
        )
        .unwrap();

        let ws = read_workspace_state(root, root);

        assert!(ws.chat_session_path.is_none());
        assert!(
            !chat_source.exists(),
            "The archived chat should import before its workspace pointer is cleared"
        );
        let sessions =
            crate::engine::agent_state::AgentStateStore::list_chat_sessions(root, root, 10, 0)
                .unwrap();
        assert_eq!(sessions.sessions.len(), 1);
        assert_eq!(
            sessions.sessions[0].source_path.as_deref(),
            Some(".git/cutready/legacy-chats/chat.chat")
        );
    }

    #[test]
    fn workspace_state_returns_default_when_missing() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();

        let ws = read_workspace_state(root, root);
        assert!(ws.open_tabs.is_empty(), "Default should have empty tabs");
        assert!(
            ws.active_tab_id.is_none(),
            "Default should have no active tab"
        );
    }

    #[test]
    fn sidebar_order_migrates_from_legacy() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();

        // Write to legacy location (root-level .cutready-order.json)
        let legacy_order = SidebarOrder {
            storyboards: vec![],
            sketches: vec!["b.sk".to_string(), "a.sk".to_string()],
            notes: vec![],
        };
        std::fs::write(
            root.join(".cutready-order.json"),
            serde_json::to_string(&legacy_order).unwrap(),
        )
        .unwrap();

        let order = read_sidebar_order(root, root);
        assert_eq!(order.sketches, vec!["b.sk", "a.sk"]);

        // Legacy file should be preserved
        assert!(
            root.join(".cutready-order.json").exists(),
            "Legacy order file should be preserved after migration"
        );
        assert!(
            root.join(".git/cutready/order.json").exists(),
            "Migrated order should be in .git/cutready/"
        );
    }

    #[test]
    fn git_state_dir_for_hybrid_folder_uses_enclosing_git_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let code = tmp.path().join("contoso-app");
        git2::Repository::init(&code).unwrap();
        let folder = code.join("cutready");
        std::fs::create_dir_all(folder.join("alpha")).unwrap();

        let git_dir = std::fs::canonicalize(code.join(".git")).unwrap();
        assert_eq!(
            git_state_dir(&folder, &folder),
            git_dir.join("cutready").join("cutready")
        );
        assert_eq!(
            git_state_dir(&folder, &folder.join("alpha")),
            git_dir.join("cutready").join("cutready").join("alpha")
        );

        let db = crate::engine::agent_state::AgentStateStore::ensure_database_for_project(
            &folder, &folder,
        )
        .unwrap();
        assert!(db.starts_with(&git_dir));
        assert!(!folder.join(".git").exists());
    }

    /// The old Prompty trace bug wrote `<hybrid folder>/.git/cutready/...`.
    fn hybrid_with_stray_git() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let code = tmp.path().join("alaska");
        git2::Repository::init(&code).unwrap();
        let folder = code.join("cutready");
        std::fs::create_dir_all(folder.join("alaska")).unwrap();
        std::fs::write(folder.join("alaska").join("compass.sk"), "{}").unwrap();
        let stray = folder.join(".git").join("cutready");
        std::fs::create_dir_all(stray.join("prompty-traces")).unwrap();
        std::fs::create_dir_all(stray.join("alaska")).unwrap();
        std::fs::write(stray.join("alaska").join("agent-state.db"), "new").unwrap();
        let git_dir = std::fs::canonicalize(code.join(".git")).unwrap();
        (tmp, folder, git_dir)
    }

    fn untracked_paths(repo: &Path) -> Vec<String> {
        let repo = git2::Repository::open(repo).unwrap();
        let mut options = git2::StatusOptions::new();
        options.include_untracked(true).recurse_untracked_dirs(true);
        let paths = repo
            .statuses(Some(&mut options))
            .unwrap()
            .iter()
            .filter_map(|entry| entry.path().ok().map(str::to_string))
            .collect();
        paths
    }

    #[test]
    fn stray_git_dir_is_not_a_repository() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        assert!(!cutready_desktop_io::state_dir::is_git_dir(&folder.join(".git")));
        assert_eq!(
            folder_git_location(&folder),
            Some((git_dir.clone(), PathBuf::from("cutready")))
        );
        assert_eq!(
            git_state_dir(&folder, &folder.join("alaska")),
            git_dir.join("cutready").join("cutready").join("alaska")
        );
        assert_eq!(git_repository_root(&folder), folder.parent().map(Path::to_path_buf));
    }

    #[test]
    fn stray_git_dir_hides_hybrid_changes_until_recovered() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        let code = git_dir.parent().unwrap().to_path_buf();
        // Git treats a folder holding `.git` as a nested repository and lists
        // only the folder itself, never the files inside it.
        let before = untracked_paths(&code);
        assert!(
            !before.iter().any(|path| path.ends_with("compass.sk")),
            "{before:?}"
        );

        assert!(recover_stray_git_dir(&folder).unwrap());
        assert!(!folder.join(".git").exists());
        let after = untracked_paths(&code);
        assert!(
            after.contains(&"cutready/alaska/compass.sk".to_string()),
            "{after:?}"
        );
        let state = git_dir.join("cutready").join("cutready");
        assert_eq!(
            std::fs::read_to_string(state.join("alaska").join("agent-state.db")).unwrap(),
            "new"
        );
        assert!(state.join("prompty-traces").is_dir());
        assert!(!recover_stray_git_dir(&folder).unwrap(), "idempotent");
    }

    #[test]
    fn stray_git_recovery_keeps_both_copies_on_conflict() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        let state = git_dir.join("cutready").join("cutready");
        std::fs::create_dir_all(state.join("alaska")).unwrap();
        std::fs::write(state.join("alaska").join("agent-state.db"), "old").unwrap();

        assert!(recover_stray_git_dir(&folder).unwrap());
        assert_eq!(
            std::fs::read_to_string(state.join("alaska").join("agent-state.db")).unwrap(),
            "old"
        );
        let recovered: Vec<_> = std::fs::read_dir(&state)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("alaska.recovered-"))
            .collect();
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            std::fs::read_to_string(state.join(&recovered[0]).join("agent-state.db")).unwrap(),
            "new"
        );
    }

    #[cfg(windows)]
    #[test]
    fn stray_git_recovery_rolls_back_when_a_file_is_open() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        let stray = folder.join(".git").join("cutready");
        let _open = std::fs::File::open(stray.join("alaska").join("agent-state.db")).unwrap();

        assert!(recover_stray_git_dir(&folder).is_err());
        assert!(stray.join("alaska").join("agent-state.db").exists());
        assert!(stray.join("prompty-traces").is_dir());
        assert!(!git_dir.join("cutready").join("cutready").exists());
        assert!(open_repo_with(&folder, false).is_err());
    }

    #[test]
    fn stray_git_recovery_leaves_unknown_contents_and_real_repos_alone() {
        let (_tmp, folder, _git_dir) = hybrid_with_stray_git();
        std::fs::write(folder.join(".git").join("config"), "").unwrap();
        assert!(!recover_stray_git_dir(&folder).unwrap());
        assert!(folder.join(".git").join("cutready").exists());

        let tmp = tempfile::tempdir().unwrap();
        let outer = tmp.path().join("outer");
        git2::Repository::init(&outer).unwrap();
        let nested = outer.join("nested");
        git2::Repository::init(&nested).unwrap();
        assert!(!recover_stray_git_dir(&nested).unwrap());
        assert!(nested.join(".git").join("HEAD").exists());
    }

    #[test]
    fn opening_a_hybrid_folder_recovers_a_stray_git_dir() {
        let (_tmp, folder, git_dir) = hybrid_with_stray_git();
        let _ = open_repo_with(&folder, false);
        assert!(!folder.join(".git").exists());
        assert!(git_dir
            .join("cutready")
            .join("cutready")
            .join("alaska")
            .join("agent-state.db")
            .exists());
    }

    #[test]
    fn git_state_dir_keeps_standalone_layout_when_folder_has_git_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("demo");
        git2::Repository::init(&root).unwrap();
        assert_eq!(git_state_dir(&root, &root), root.join(".git/cutready"));
    }

    #[test]
    fn git_state_dir_multi_project() {
        let repo = PathBuf::from("/repo");
        let project = PathBuf::from("/repo/projects/demo");
        let dir = git_state_dir(&repo, &project);
        assert!(
            dir.to_string_lossy().contains("cutready"),
            "Should contain cutready dir"
        );
        assert!(
            dir.to_string_lossy().contains("demo"),
            "Should contain project name for multi-project: {:?}",
            dir
        );
    }

    fn seed_chat_session(repo_root: &Path, project_root: &Path, session_id: &str, title: &str) {
        // The working directory must exist: save_chat_session runs legacy chat
        // migration, which canonicalizes the project root.
        std::fs::create_dir_all(project_root).unwrap();
        crate::engine::agent_state::AgentStateStore::save_chat_session(
            repo_root,
            project_root,
            session_id,
            title,
            &[serde_json::json!({ "role": "user", "content": "remember me" })],
            serde_json::json!({}),
        )
        .unwrap();
    }

    #[test]
    fn relocate_project_state_carries_runtime_state_across_a_rename() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();
        let alpha = root.join("alpha");
        let beta = root.join("beta");

        // Seed agent history, workspace tabs, sidebar order, and an imported chat
        // subdirectory under the original project's state namespace.
        seed_chat_session(root, &alpha, "s1", "Seeded run");
        let ws = WorkspaceState {
            open_tabs: vec![WorkspaceTab {
                id: "tab-1".into(),
                tab_type: "sketch".into(),
                path: "intro.sk".into(),
                title: "Intro".into(),
            }],
            active_tab_id: Some("tab-1".into()),
            chat_session_path: None,
        };
        write_workspace_state(root, &alpha, &ws).unwrap();
        let order = SidebarOrder {
            storyboards: vec![],
            sketches: vec!["b.sk".into(), "a.sk".into()],
            notes: vec![],
        };
        write_sidebar_order(root, &alpha, &order).unwrap();
        let legacy_chats = git_state_dir(root, &alpha).join("legacy-chats");
        std::fs::create_dir_all(&legacy_chats).unwrap();
        std::fs::write(legacy_chats.join("old.chat"), "{}").unwrap();

        relocate_project_state(root, &alpha, &beta).unwrap();

        // The caller also renames the working tree; mirror that so reopening the
        // relocated state resolves against a real project directory.
        std::fs::create_dir_all(&beta).unwrap();

        // Old namespace is gone; the new one carries every artifact.
        assert!(!git_state_dir(root, &alpha).exists());
        let beta_state = git_state_dir(root, &beta);
        assert!(beta_state.join("agent-state.db").exists());
        assert!(beta_state.join("legacy-chats/old.chat").exists());

        // Records reopen intact under the new path.
        let sessions =
            crate::engine::agent_state::AgentStateStore::list_chat_sessions(root, &beta, 10, 0)
                .unwrap();
        assert_eq!(sessions.sessions.len(), 1);
        assert_eq!(sessions.sessions[0].session_id, "s1");
        assert_eq!(
            read_workspace_state(root, &beta).active_tab_id.as_deref(),
            Some("tab-1")
        );
        assert_eq!(
            read_sidebar_order(root, &beta).sketches,
            vec!["b.sk", "a.sk"]
        );
    }

    #[test]
    fn relocate_project_state_refuses_to_overwrite_a_colliding_destination() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();
        let alpha = root.join("alpha");
        let beta = root.join("beta");

        seed_chat_session(root, &alpha, "s1", "Original");
        // A pre-existing artifact in the destination must not be clobbered.
        let beta_state = git_state_dir(root, &beta);
        std::fs::create_dir_all(&beta_state).unwrap();
        std::fs::write(beta_state.join("agent-state.db"), "pre-existing").unwrap();

        let err = relocate_project_state(root, &alpha, &beta).unwrap_err();
        assert!(matches!(err, ProjectError::Io(_)));
        // Source data survives the refusal, fully recoverable.
        assert!(git_state_dir(root, &alpha).join("agent-state.db").exists());
        assert_eq!(
            std::fs::read_to_string(beta_state.join("agent-state.db")).unwrap(),
            "pre-existing"
        );
    }

    #[test]
    fn move_folder_state_refuses_occupied_destinations_in_every_direction() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("cutready");
        let seed = |dir: &Path| {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("agent-state.db"), "live").unwrap();
        };

        // Deeper: another project's state already sits where the root's would nest.
        seed(&base);
        seed(&base.join("cutready"));
        assert!(move_folder_state(&base, &base.join("cutready")).is_err());
        assert_eq!(
            std::fs::read_to_string(base.join("agent-state.db")).unwrap(),
            "live"
        );
        std::fs::remove_dir_all(&base).unwrap();

        // Shallower: the root's state dir holds something besides the path down.
        seed(&base.join("a"));
        std::fs::write(base.join("stray.json"), "{}").unwrap();
        assert!(move_folder_state(&base.join("a"), &base).is_err());
        assert!(base.join("a/agent-state.db").exists());
        std::fs::remove_dir_all(&base).unwrap();

        // Disjoint: the destination already has state.
        seed(&base.join("a"));
        seed(&base.join("b"));
        assert!(move_folder_state(&base.join("a"), &base.join("b")).is_err());
        assert!(base.join("a/agent-state.db").exists());
    }

    #[test]
    fn move_folder_state_leaves_the_held_write_lock_at_the_root() {
        let tmp = TempDir::new().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        let base = crate::engine::write_lock::lock_file(tmp.path())
            .parent()
            .unwrap()
            .to_path_buf();
        let _guard = crate::engine::write_lock::lock(tmp.path()).unwrap();
        std::fs::write(base.join("agent-state.db"), "root").unwrap();

        let nested = base.join("demos");
        move_folder_state(&base, &nested).unwrap();
        assert!(base.join(WRITE_LOCK).exists());
        assert!(!base.join("agent-state.db").exists());
        assert_eq!(
            std::fs::read_to_string(nested.join("agent-state.db")).unwrap(),
            "root"
        );

        move_folder_state(&nested, &base).unwrap();
        assert!(base.join(WRITE_LOCK).exists());
        assert!(!nested.exists());
        assert_eq!(
            std::fs::read_to_string(base.join("agent-state.db")).unwrap(),
            "root"
        );
        let names: Vec<_> = std::fs::read_dir(base.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n.to_string_lossy().starts_with("cutready"))
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("cutready")]);
    }

    #[test]
    fn move_folder_state_round_trips_between_root_and_subfolder() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("cutready");
        std::fs::create_dir_all(base.join("alpha")).unwrap();
        std::fs::write(base.join("agent-state.db"), "root").unwrap();
        std::fs::write(base.join("alpha/order.json"), "[]").unwrap();

        let nested = base.join("demos").join("launch");
        move_folder_state(&base, &nested).unwrap();
        assert_eq!(
            std::fs::read_to_string(nested.join("agent-state.db")).unwrap(),
            "root"
        );
        assert!(nested.join("alpha/order.json").exists());
        assert!(!base.join("agent-state.db").exists());

        move_folder_state(&nested, &base).unwrap();
        assert_eq!(
            std::fs::read_to_string(base.join("agent-state.db")).unwrap(),
            "root"
        );
        assert!(base.join("alpha/order.json").exists());
        assert!(!base.join("demos").exists());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[test]
    fn relocate_project_state_leaves_unrelated_projects_untouched() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();
        let alpha = root.join("alpha");
        let beta = root.join("beta");
        let gamma = root.join("gamma");

        seed_chat_session(root, &alpha, "s-alpha", "Alpha");
        seed_chat_session(root, &gamma, "s-gamma", "Gamma");

        relocate_project_state(root, &alpha, &beta).unwrap();

        // The unrelated project keeps its own state and records.
        assert!(git_state_dir(root, &gamma).join("agent-state.db").exists());
        let gamma_sessions =
            crate::engine::agent_state::AgentStateStore::list_chat_sessions(root, &gamma, 10, 0)
                .unwrap();
        assert_eq!(gamma_sessions.sessions.len(), 1);
        assert_eq!(gamma_sessions.sessions[0].session_id, "s-gamma");
    }

    #[test]
    fn single_to_multi_relocation_leaves_the_held_write_lock_in_place() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        git2::Repository::init(root).unwrap();
        seed_chat_session(root, root, "s1", "Live run");

        let _guard = crate::engine::write_lock::lock(root).unwrap();
        let lock_file = crate::engine::write_lock::lock_file(root);
        assert_eq!(
            lock_file.parent().unwrap(),
            std::fs::canonicalize(git_state_dir(root, root)).unwrap()
        );

        relocate_project_state(root, root, &root.join("demo")).unwrap();

        assert!(lock_file.exists());
        assert!(git_state_dir(root, &root.join("demo"))
            .join("agent-state.db")
            .exists());
    }

    #[test]
    fn migrate_to_multi_project_refuses_to_adopt_a_stale_runtime_namespace() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join("intro.sk"), "{}").unwrap();

        // Seed live single-project runtime state.
        seed_chat_session(root, root, "s1", "Live run");
        // A stale namespace from an aborted prior conversion sits at the target.
        let stale = git_state_dir(root, &root.join("demo"));
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("agent-state.db"), "stale").unwrap();

        let err = migrate_to_multi_project(root, "Demo").unwrap_err();
        assert!(matches!(err, ProjectError::Io(_)));

        // Nothing moved: live state stays put, content untouched, stale left as-is.
        assert!(root.join(".git/cutready/agent-state.db").exists());
        assert!(root.join("intro.sk").exists());
        assert!(!is_multi_project(root));
        assert_eq!(
            std::fs::read_to_string(stale.join("agent-state.db")).unwrap(),
            "stale"
        );
    }

    #[test]
    fn migrate_to_multi_project_relocates_runtime_state_into_the_namespace() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(".git")).unwrap();
        // Working-tree content lives at the single-project root.
        std::fs::write(root.join("intro.sk"), "{}").unwrap();

        // Seed runtime state in the single-project namespace (.git/cutready/).
        seed_chat_session(root, root, "s1", "Pre-conversion run");
        let ws = WorkspaceState {
            open_tabs: vec![WorkspaceTab {
                id: "tab-1".into(),
                tab_type: "sketch".into(),
                path: "intro.sk".into(),
                title: "Intro".into(),
            }],
            active_tab_id: Some("tab-1".into()),
            chat_session_path: None,
        };
        write_workspace_state(root, root, &ws).unwrap();

        let entry = migrate_to_multi_project(root, "My Demo").unwrap();
        let project_root = root.join(&entry.path);

        // Content moved into the subproject.
        assert!(project_root.join("intro.sk").exists());
        assert!(!root.join("intro.sk").exists());

        // Runtime state moved into the project's new namespace, not left behind.
        assert!(git_state_dir(root, &project_root)
            .join("agent-state.db")
            .exists());
        assert!(!root.join(".git/cutready/agent-state.db").exists());

        // Records reopen intact under the converted path.
        let sessions = crate::engine::agent_state::AgentStateStore::list_chat_sessions(
            root,
            &project_root,
            10,
            0,
        )
        .unwrap();
        assert_eq!(sessions.sessions.len(), 1);
        assert_eq!(sessions.sessions[0].session_id, "s1");
        assert_eq!(
            read_workspace_state(root, &project_root)
                .active_tab_id
                .as_deref(),
            Some("tab-1")
        );
    }

    #[test]
    fn legacy_chat_migration_uses_agent_state_without_archiving_chat_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let now = chrono::Utc::now();
        let session = ChatSession {
            title: "Planning chat".into(),
            messages: vec![serde_json::json!({ "role": "user", "content": "hello" })],
            created_at: now,
            updated_at: now,
            author_name: Some("Ada Lovelace".into()),
            author_email: Some("ada@example.com".into()),
        };
        let source = root.join(".chats/chat.chat");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, serde_json::to_string(&session).unwrap()).unwrap();

        migrate_legacy_chat_sessions(root, root).unwrap();
        assert!(!source.exists());
        assert!(!root.join(".git/cutready/legacy-chats/chat.chat").exists());
    }
}
