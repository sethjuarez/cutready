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

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::engine::versioning;
use crate::models::script::{ProjectEntry, ProjectManifest, ProjectView, RepoView};
use crate::models::sketch::{NoteSummary, Sketch, SketchSummary, Storyboard, StoryboardSummary};

const LOCKS_PATH: &str = ".cutready/locks.json";

/// Lock metadata for plain Markdown notes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct NoteLockState {
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct LockManifest {
    #[serde(default)]
    notes: BTreeMap<String, NoteLockState>,
}

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
/// Rejects absolute paths, `..` traversal, and any result that escapes root.
pub fn safe_resolve(root: &Path, relative_path: &str) -> Result<PathBuf, ProjectError> {
    let rel = Path::new(relative_path);

    // Reject absolute paths
    if rel.is_absolute() {
        return Err(ProjectError::PathTraversal(relative_path.to_string()));
    }

    // Reject any component that is ".." or has a prefix (e.g., C:)
    for component in rel.components() {
        match component {
            std::path::Component::ParentDir | std::path::Component::Prefix(_) => {
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
/// Creates the folder if it doesn't exist, inits git, and returns a ProjectView.
pub fn init_project_folder(root: &Path) -> Result<ProjectView, ProjectError> {
    std::fs::create_dir_all(root).map_err(|e| ProjectError::Io(e.to_string()))?;

    // Init git if not already a repo
    if !root.join(".git").exists() {
        versioning::init_project_repo(root).map_err(|e| ProjectError::Io(e.to_string()))?;
        let _ = versioning::commit_snapshot(root, "Initialize workspace", None);
    }

    Ok(ProjectView::new(root.to_path_buf()))
}

// ── Multi-project manifest ────────────────────────────────────────

const MANIFEST_PATH: &str = ".cutready/projects.json";

/// Read the project manifest from a repo root. Returns None if no manifest
/// exists (single-project / legacy mode).
pub fn read_manifest(repo_root: &Path) -> Option<ProjectManifest> {
    let path = repo_root.join(MANIFEST_PATH);
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
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

/// Open a repo folder, detecting single vs multi-project mode.
/// Returns the repo view and list of projects.
pub fn open_repo(root: &Path) -> Result<(RepoView, Vec<ProjectEntry>), ProjectError> {
    if !root.exists() || !root.is_dir() {
        return Err(ProjectError::NotFound(root.to_string_lossy().into_owned()));
    }

    // Init git if not already a repo so snapshots work
    if !root.join(".git").exists() {
        versioning::init_project_repo(root).map_err(|e| ProjectError::Io(e.to_string()))?;
        let _ = versioning::commit_snapshot(root, "Initialize workspace", None);
    }

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
        let _ = std::fs::create_dir_all(&dest_dir);

        // Move each file (don't overwrite existing)
        if let Ok(entries) = std::fs::read_dir(&src) {
            for entry in entries.flatten() {
                let dest_file = dest_dir.join(entry.file_name());
                if !dest_file.exists() {
                    let _ = std::fs::rename(entry.path(), &dest_file);
                }
            }
        }

        // Remove the now-empty source dir
        let _ = std::fs::remove_dir(&src);
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
    let mut manifest = read_manifest(repo_root).unwrap_or(ProjectManifest {
        projects: Vec::new(),
    });
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
        let dest = target.join(&name);
        std::fs::rename(entry.path(), &dest).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    // Move asset directories (.cutready/screenshots, .cutready/visuals) into the project.
    // The repo-level .cutready/ is kept for the manifest; only asset subdirs move.
    let cutready_dir = repo_root.join(".cutready");
    for subdir in &["screenshots", "visuals"] {
        let src = cutready_dir.join(subdir);
        if src.exists() {
            let dest_cutready = target.join(".cutready");
            std::fs::create_dir_all(&dest_cutready).map_err(|e| ProjectError::Io(e.to_string()))?;
            let dest = dest_cutready.join(subdir);
            std::fs::rename(&src, &dest).map_err(|e| ProjectError::Io(e.to_string()))?;
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
    use sha2::{Digest, Sha256};

    let json =
        serde_json::to_string_pretty(visual).map_err(|e| ProjectError::Serialize(e.to_string()))?;

    let digest = Sha256::digest(json.as_bytes());
    let short_hash: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    let rel_path = format!(".cutready/visuals/{short_hash}.json");
    let abs_path = project_root.join(&rel_path);

    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    std::fs::write(&abs_path, &json).map_err(|e| ProjectError::Io(e.to_string()))?;
    Ok(rel_path)
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

/// Write a sketch to a `.sk` file.
pub fn write_sketch(
    sketch: &Sketch,
    path: &Path,
    _project_root: &Path,
) -> Result<(), ProjectError> {
    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    let json =
        serde_json::to_string_pretty(sketch).map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| ProjectError::Io(e.to_string()))?;

    Ok(())
}

pub fn ensure_sketch_unlocked(sketch: &Sketch) -> Result<(), ProjectError> {
    if sketch.locked {
        return Err(ProjectError::Locked(
            "This sketch is locked. Unlock it before editing.".into(),
        ));
    }
    Ok(())
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

pub fn apply_locked_row_metadata(
    existing: &[crate::models::sketch::PlanningRow],
    updated: &mut [crate::models::sketch::PlanningRow],
) {
    for (old, new) in existing.iter().zip(updated.iter_mut()) {
        new.locked = old.locked;
        new.locks = old.locks.clone();
    }
}

pub fn validate_rows_update_allowed(
    existing: &[crate::models::sketch::PlanningRow],
    updated: &[crate::models::sketch::PlanningRow],
) -> Result<(), ProjectError> {
    let has_locks = existing.iter().any(|row| row.locked || row.locks.any());
    if has_locks && existing.len() != updated.len() {
        return Err(ProjectError::Locked(
            "Cannot add, remove, or reorder planning rows while a row or cell is locked.".into(),
        ));
    }

    for (idx, (old, new)) in existing.iter().zip(updated.iter()).enumerate() {
        if old.locked && !row_content_matches(old, new) {
            return Err(ProjectError::Locked(format!(
                "Planning row {} is locked. Unlock it before editing.",
                idx + 1
            )));
        }
        for field in locked_fields(old) {
            if !field_matches(old, new, field) {
                return Err(ProjectError::Locked(format!(
                    "Planning row {} {} cell is locked. Unlock it before editing.",
                    idx + 1,
                    field.replace('_', " ")
                )));
            }
        }
    }

    Ok(())
}

fn locked_fields(row: &crate::models::sketch::PlanningRow) -> Vec<&'static str> {
    let mut fields = Vec::new();
    for field in [
        "time",
        "narrative",
        "demo_actions",
        "screenshot",
        "visual",
        "design_plan",
    ] {
        if row.locks.is_locked(field) {
            fields.push(field);
        }
    }
    fields
}

fn row_content_matches(
    old: &crate::models::sketch::PlanningRow,
    new: &crate::models::sketch::PlanningRow,
) -> bool {
    old.time == new.time
        && old.narrative == new.narrative
        && old.demo_actions == new.demo_actions
        && old.screenshot == new.screenshot
        && old.visual == new.visual
        && old.design_plan == new.design_plan
}

fn field_matches(
    old: &crate::models::sketch::PlanningRow,
    new: &crate::models::sketch::PlanningRow,
    field: &str,
) -> bool {
    match field {
        "time" => old.time == new.time,
        "narrative" => old.narrative == new.narrative,
        "demo_actions" => old.demo_actions == new.demo_actions,
        "screenshot" | "visual" => old.screenshot == new.screenshot && old.visual == new.visual,
        "design_plan" => old.design_plan == new.design_plan,
        _ => true,
    }
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
    let mut sketch: Sketch =
        serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))?;

    // Migrate inline visuals to external files when project root is available
    if let Some(root) = project_root {
        let mut migrated = false;
        for row in &mut sketch.rows {
            if let Some(ref visual) = row.visual {
                if visual.is_object() {
                    match write_visual(root, visual) {
                        Ok(rel_path) => {
                            row.visual = Some(serde_json::Value::String(rel_path));
                            migrated = true;
                        }
                        Err(e) => {
                            eprintln!("[read_sketch] Failed to migrate inline visual: {e}");
                        }
                    }
                }
            }
        }
        if migrated {
            // Rewrite .sk file with path references instead of inline blobs
            if let Err(e) = write_sketch(&sketch, path, root) {
                eprintln!("[read_sketch] Failed to rewrite migrated sketch: {e}");
            }
        }
    }

    Ok(sketch)
}

/// Delete an unlocked sketch file and auto-commit.
pub fn delete_sketch(path: &Path, _project_root: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        let sketch = read_sketch(path)?;
        ensure_sketch_has_no_locked_content(&sketch)?;
        std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    Ok(())
}

fn relative_project_path(path: &Path, project_root: &Path) -> Result<String, ProjectError> {
    let rel = path
        .strip_prefix(project_root)
        .map_err(|_| ProjectError::PathTraversal(path.to_string_lossy().into_owned()))?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

/// Rename/move an unlocked project file and auto-commit.
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

    if project_root.join(".git").exists() {
        let msg = format!("Rename {label}");
        let _ = versioning::commit_snapshot(project_root, &msg, None);
    }
    Ok(())
}

/// Rename/move a sketch file and auto-commit.
pub fn rename_sketch(
    old_path: &Path,
    new_path: &Path,
    project_root: &Path,
) -> Result<(), ProjectError> {
    rename_file(old_path, new_path, project_root, "sketch")
}

// ── Storyboard file I/O (.sb) ─────────────────────────────────────

/// Write a storyboard to a `.sb` file.
pub fn write_storyboard(
    sb: &Storyboard,
    path: &Path,
    _project_root: &Path,
) -> Result<(), ProjectError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }

    let json =
        serde_json::to_string_pretty(sb).map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| ProjectError::Io(e.to_string()))?;

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
    serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))
}

/// Delete a storyboard file and auto-commit.
pub fn delete_storyboard(path: &Path, _project_root: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        let storyboard = read_storyboard(path)?;
        ensure_storyboard_unlocked(&storyboard)?;
    }
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
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
                if let Ok(sketch) = serde_json::from_str::<Sketch>(&data) {
                    summaries.push(SketchSummary::from_sketch(&sketch, rel_path));
                }
            }
        },
    )?;
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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
                if let Ok(sb) = serde_json::from_str::<Storyboard>(&data) {
                    summaries.push(StoryboardSummary::from_storyboard(&sb, rel_path));
                }
            }
        },
    )?;
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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
                if let Ok(sb) = serde_json::from_str::<Storyboard>(&data) {
                    let refs_sketch = sb.items.iter().any(|item| match item {
                        crate::models::sketch::StoryboardItem::SketchRef { path } => {
                            path == sketch_rel_path
                        }
                        crate::models::sketch::StoryboardItem::Section { sketches, .. } => {
                            sketches.iter().any(|s| s == sketch_rel_path)
                        }
                    });
                    if refs_sketch {
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
    let mut summaries = Vec::new();
    scan_files_recursive(
        project_root,
        project_root,
        "md",
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
                summaries.push(NoteSummary {
                    path: rel_path.to_string(),
                    title,
                    size: meta.len(),
                    updated_at,
                });
            }
        },
    )?;
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
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

        // Skip .git internals (huge pack files, not useful to browse)
        if name == ".git" {
            // Still show the .git folder itself, just don't recurse into it
            if let Ok(rel) = path.strip_prefix(project_root) {
                entries.push(FileEntry {
                    path: rel.to_string_lossy().replace('\\', "/"),
                    ext: String::new(),
                    size: 0,
                    is_dir: true,
                });
            }
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

/// Write a note file (plain text).
pub fn write_note(path: &Path, content: &str) -> Result<(), ProjectError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    std::fs::write(path, content).map_err(|e| ProjectError::Io(e.to_string()))
}

pub fn get_note_lock(
    project_root: &Path,
    relative_path: &str,
) -> Result<NoteLockState, ProjectError> {
    let rel = normalize_lock_path(relative_path);
    let manifest = read_lock_manifest(project_root)?;
    Ok(manifest.notes.get(&rel).cloned().unwrap_or_default())
}

pub fn set_note_lock(
    project_root: &Path,
    relative_path: &str,
    locked: bool,
) -> Result<NoteLockState, ProjectError> {
    let rel = normalize_lock_path(relative_path);
    let mut manifest = read_lock_manifest(project_root)?;
    if locked {
        manifest.notes.insert(rel, NoteLockState { locked: true });
    } else {
        manifest.notes.remove(&rel);
    }
    write_lock_manifest(project_root, &manifest)?;
    Ok(NoteLockState { locked })
}

pub fn ensure_note_unlocked(project_root: &Path, relative_path: &str) -> Result<(), ProjectError> {
    if get_note_lock(project_root, relative_path)?.locked {
        return Err(ProjectError::Locked(
            "This note is locked. Unlock it before editing.".into(),
        ));
    }
    Ok(())
}

fn read_lock_manifest(project_root: &Path) -> Result<LockManifest, ProjectError> {
    let path = project_root.join(LOCKS_PATH);
    if !path.exists() {
        return Ok(LockManifest::default());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data).map_err(|e| ProjectError::Deserialize(e.to_string()))
}

fn write_lock_manifest(project_root: &Path, manifest: &LockManifest) -> Result<(), ProjectError> {
    let path = project_root.join(LOCKS_PATH);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    let data = serde_json::to_string_pretty(manifest)
        .map_err(|e| ProjectError::Serialize(e.to_string()))?;
    std::fs::write(path, data).map_err(|e| ProjectError::Io(e.to_string()))
}

fn normalize_lock_path(relative_path: &str) -> String {
    relative_path.trim().replace('\\', "/")
}

/// Delete a note file and clean up any images that become orphaned.
///
/// Parses the note's markdown for `![...](path)` image references in
/// `.cutready/screenshots/`. If no other note references the same image,
/// the image file is deleted to prevent orphaned files accumulating.
pub fn delete_note(path: &Path, project_root: &Path) -> Result<(), ProjectError> {
    if !path.exists() {
        return Ok(());
    }
    let rel = relative_project_path(path, project_root)?;
    ensure_note_unlocked(project_root, &rel)?;

    // Read the note to find image references before deleting
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let images_in_note = extract_screenshot_refs(&content);

    // Delete the note file
    std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    let _ = set_note_lock(project_root, &rel, false);

    // If the note had no screenshot references, we're done
    if images_in_note.is_empty() {
        return Ok(());
    }

    // Scan all remaining notes for image references
    let mut all_referenced = std::collections::HashSet::new();
    let _ = scan_files_recursive(project_root, project_root, "md", &mut |_rel, abs| {
        if abs != path {
            if let Ok(other_content) = std::fs::read_to_string(abs) {
                for img in extract_screenshot_refs(&other_content) {
                    all_referenced.insert(img);
                }
            }
        }
    });
    // Also check sketch files for screenshot references
    let _ = scan_files_recursive(project_root, project_root, "sk", &mut |_rel, abs| {
        if let Ok(other_content) = std::fs::read_to_string(abs) {
            for img in extract_sketch_screenshot_refs(&other_content) {
                all_referenced.insert(img);
            }
        }
    });

    // Delete images only referenced by the deleted note
    for img_path in &images_in_note {
        if !all_referenced.contains(img_path) {
            let abs_img = project_root.join(img_path);
            if abs_img.exists() {
                let _ = std::fs::remove_file(&abs_img);
            }
        }
    }

    Ok(())
}

/// Extract `.cutready/screenshots/...` image paths from markdown content.
/// Matches both markdown `![...](path)` and HTML `<img src="path">` syntax.
fn extract_screenshot_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();

    // Match markdown image/link syntax: [...](.cutready/screenshots/...)
    let mut rest = content;
    while let Some(pos) = rest.find("](") {
        let after = &rest[pos + 2..];
        if let Some(end) = after.find(')') {
            let img_path = after[..end].trim();
            if img_path.contains(".cutready/screenshots/") {
                refs.push(img_path.replace('\\', "/"));
            }
        }
        rest = &rest[pos + 2..];
    }

    // Match HTML img tags: <img ... src="path" ...>
    rest = content;
    while let Some(pos) = rest.find("<img ") {
        let tag_rest = &rest[pos..];
        if let Some(tag_end) = tag_rest.find('>') {
            let tag = &tag_rest[..tag_end];
            // Extract src attribute value (single or double quotes)
            for prefix in &["src=\"", "src='"] {
                if let Some(src_start) = tag.find(prefix) {
                    let val_start = src_start + prefix.len();
                    let quote = prefix.as_bytes()[prefix.len() - 1] as char;
                    if let Some(val_end) = tag[val_start..].find(quote) {
                        let src = tag[val_start..val_start + val_end].trim();
                        if src.contains(".cutready/screenshots/") {
                            refs.push(src.replace('\\', "/"));
                        }
                    }
                    break;
                }
            }
        }
        rest = &rest[pos + 5..];
    }

    refs
}

/// Extract `.cutready/screenshots/...` image paths from sketch JSON content.
///
/// Parses the `"screenshot"` field from each planning row in the sketch.
fn extract_sketch_screenshot_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(rows) = val.get("rows").and_then(|r| r.as_array()) {
            for row in rows {
                if let Some(ss) = row.get("screenshot").and_then(|s| s.as_str()) {
                    let ss = ss.replace('\\', "/");
                    if ss.contains(".cutready/screenshots/") {
                        refs.push(ss);
                    }
                }
            }
        }
    }
    refs
}

/// Extract `.cutready/visuals/...` visual paths from sketch JSON content.
///
/// Parses the `"visual"` field from each planning row in the sketch.
fn extract_sketch_visual_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(rows) = val.get("rows").and_then(|r| r.as_array()) {
            for row in rows {
                if let Some(vis) = row.get("visual").and_then(|v| v.as_str()) {
                    let vis = vis.replace('\\', "/");
                    if vis.contains(".cutready/visuals/") {
                        refs.push(vis);
                    }
                }
            }
        }
    }
    refs
}

/// Collect all `.cutready/` asset paths referenced by a file's content.
/// - `.sk` files: screenshot fields + visual fields from planning rows
/// - `.md` files: screenshot paths from markdown/HTML image syntax
/// - `.sb` files: no direct asset references
pub fn collect_asset_refs(content: &str, file_ext: &str) -> Vec<String> {
    match file_ext {
        "sk" => {
            let mut refs = extract_sketch_screenshot_refs(content);
            refs.extend(extract_sketch_visual_refs(content));
            refs
        }
        "md" => extract_screenshot_refs(content),
        _ => Vec::new(),
    }
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

/// Summary of a saved chat session.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatSessionSummary {
    pub path: String,
    pub title: String,
    pub message_count: usize,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub author_email: Option<String>,
}

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

/// Scan for .chat files in the project.
pub fn scan_chat_sessions(project_root: &Path) -> Result<Vec<ChatSessionSummary>, ProjectError> {
    let mut summaries = Vec::new();
    let chats_dir = project_root.join(".chats");
    if chats_dir.exists() {
        let entries = std::fs::read_dir(&chats_dir).map_err(|e| ProjectError::Io(e.to_string()))?;
        for entry in entries {
            let entry = entry.map_err(|e| ProjectError::Io(e.to_string()))?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "chat") {
                if let Ok(data) = std::fs::read_to_string(&path) {
                    if let Ok(session) = serde_json::from_str::<ChatSession>(&data) {
                        if let Ok(rel) = path.strip_prefix(project_root) {
                            let rel_path = rel.to_string_lossy().replace('\\', "/");
                            let committed_author =
                                last_committed_file_author(project_root, &path).unwrap_or(None);
                            summaries.push(ChatSessionSummary {
                                path: rel_path,
                                title: session.title,
                                message_count: session.messages.len(),
                                updated_at: session.updated_at,
                                author_name: session
                                    .author_name
                                    .or_else(|| committed_author.clone().map(|author| author.0)),
                                author_email: session
                                    .author_email
                                    .or_else(|| committed_author.map(|author| author.1)),
                            });
                        }
                    }
                }
            }
        }
    }
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

fn last_committed_file_author(
    project_root: &Path,
    file_path: &Path,
) -> Result<Option<(String, String)>, git2::Error> {
    let repo = git2::Repository::discover(project_root)?;
    let workdir = match repo.workdir() {
        Some(path) => path,
        None => return Ok(None),
    };
    let relative_path = match file_path.strip_prefix(workdir) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };

    let mut revwalk = repo.revwalk()?;
    revwalk.push_head()?;

    for oid in revwalk {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;
        let changed = if commit.parent_count() == 0 {
            tree.get_path(relative_path).is_ok()
        } else {
            let mut touched = false;
            for parent in commit.parents() {
                let parent_tree = parent.tree()?;
                let mut options = git2::DiffOptions::new();
                options.pathspec(relative_path);
                let diff =
                    repo.diff_tree_to_tree(Some(&parent_tree), Some(&tree), Some(&mut options))?;
                if diff.deltas().len() > 0 {
                    touched = true;
                    break;
                }
            }
            touched
        };

        if changed {
            let author = commit.author();
            let name = author.name().unwrap_or("Unknown").to_string();
            let email = author.email().unwrap_or("").to_string();
            return Ok(Some((name, email)));
        }
    }

    Ok(None)
}

/// Read a chat session file.
pub fn read_chat_session(path: &Path) -> Result<ChatSession, ProjectError> {
    if !path.exists() {
        return Err(ProjectError::NotFound(path.to_string_lossy().into_owned()));
    }
    let data = std::fs::read_to_string(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    serde_json::from_str(&data).map_err(|e| ProjectError::Io(format!("Invalid chat session: {e}")))
}

/// Write a chat session file.
pub fn write_chat_session(path: &Path, session: &ChatSession) -> Result<(), ProjectError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    let json =
        serde_json::to_string_pretty(session).map_err(|e| ProjectError::Io(e.to_string()))?;
    std::fs::write(path, json).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Delete a chat session file.
pub fn delete_chat_session(path: &Path) -> Result<(), ProjectError> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    Ok(())
}

// ── Sidebar order manifest ──────────────────────────────────────────

// Ephemeral UI state lives in .git/cutready/ (never tracked by snapshots).
// Only user content (sketches, visuals, screenshots, etc.) stays in the working tree.
const GIT_STATE_DIR: &str = ".git/cutready";

const REPO_SETTINGS_FILE: &str = ".cutready/settings.json";

/// Resolve the per-project state directory inside .git/cutready/.
/// For single-project repos: `.git/cutready/`
/// For multi-project repos: `.git/cutready/<project-name>/`
fn git_state_dir(repo_root: &Path, project_root: &Path) -> std::path::PathBuf {
    let base = repo_root.join(GIT_STATE_DIR);
    if repo_root == project_root {
        base
    } else if let Ok(rel) = project_root.strip_prefix(repo_root) {
        base.join(rel)
    } else {
        base
    }
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
        if let Ok(ws) = serde_json::from_str(&data) {
            return ws;
        }
    }
    // Legacy fallback: read from .cutready/workspace.json
    let legacy_path = project_root.join(".cutready/workspace.json");
    if let Ok(data) = std::fs::read_to_string(&legacy_path) {
        if let Ok(ws) = serde_json::from_str::<WorkspaceState>(&data) {
            // Migrate: write to new location, remove legacy file
            log::info!(
                "[workspace] migrating workspace.json from {:?} → {:?}",
                legacy_path,
                new_path
            );
            let _ = std::fs::create_dir_all(&state_dir);
            let _ = serde_json::to_string_pretty(&ws).map(|json| std::fs::write(&new_path, json));
            let _ = std::fs::remove_file(&legacy_path);
            return ws;
        }
    }
    WorkspaceState::default()
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
            // Migrate: write to new location, remove legacy file
            log::info!(
                "[workspace] migrating sidebar order from {:?} → {:?}",
                legacy_path,
                new_path
            );
            let _ = std::fs::create_dir_all(&state_dir);
            let _ =
                serde_json::to_string_pretty(&order).map(|json| std::fs::write(&new_path, json));
            let _ = std::fs::remove_file(&legacy_path);
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

// ── Versioning helpers ─────────────────────────────────────────────

/// Save with a user-provided label (for named versions).
pub fn save_with_label(
    project_root: &Path,
    label: &str,
    fork_label: Option<&str>,
) -> Result<String, ProjectError> {
    // Auto-init git if missing so snapshots always work
    if !project_root.join(".git").exists() {
        versioning::init_project_repo(project_root).map_err(|e| ProjectError::Io(e.to_string()))?;
    }
    versioning::commit_snapshot(project_root, label, fork_label)
        .map_err(|e| ProjectError::Io(e.to_string()))
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn init_project_folder_creates_git() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("My Demo");

        let view = init_project_folder(&root).unwrap();
        assert_eq!(view.name, "My Demo");
        assert!(root.join(".git").exists());
        let versions = versioning::list_versions(&root).unwrap();
        assert!(versions.iter().any(|v| v.message == "Initialize workspace"));
    }

    #[test]
    fn write_and_read_sketch() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("My Sketch");
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
        let sketch = Sketch::new("Nested");
        let path = root.join("flows").join("login.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn delete_sketch_removes_file() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let sketch = Sketch::new("Delete Me");
        let path = root.join("temp.sk");

        write_sketch(&sketch, &path, root).unwrap();
        assert!(path.exists());

        delete_sketch(&path, root).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn delete_sketch_rejects_locked_sketch() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let mut sketch = Sketch::new("Keep Me");
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
        let mut sketch = Sketch::new("Keep Row");
        let mut row = crate::models::sketch::PlanningRow::new();
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
        let sketch = Sketch::new("Rename Me");
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
        let mut sketch = Sketch::new("Keep Name");
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
        let mut old = crate::models::sketch::PlanningRow::new();
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

        write_sketch(&Sketch::new("A"), &root.join("a.sk"), root).unwrap();
        write_sketch(&Sketch::new("B"), &root.join("b.sk"), root).unwrap();
        write_sketch(&Sketch::new("C"), &root.join("sub").join("c.sk"), root).unwrap();

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

        write_sketch(&Sketch::new("Visible"), &root.join("visible.sk"), root).unwrap();
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
        let sb = Storyboard::new("Full Demo");
        let path = root.join("demo.sb");

        write_storyboard(&sb, &path, root).unwrap();
        let loaded = read_storyboard(&path).unwrap();
        assert_eq!(loaded.title, "Full Demo");
    }

    #[test]
    fn scan_storyboards_finds_all() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        write_storyboard(&Storyboard::new("A"), &root.join("a.sb"), root).unwrap();
        write_storyboard(&Storyboard::new("B"), &root.join("b.sb"), root).unwrap();

        let summaries = scan_storyboards(root).unwrap();
        assert_eq!(summaries.len(), 2);
    }

    #[test]
    fn sketch_file_exists_checks_correctly() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        assert!(!sketch_file_exists("intro.sk", root));
        write_sketch(&Sketch::new("Intro"), &root.join("intro.sk"), root).unwrap();
        assert!(sketch_file_exists("intro.sk", root));
    }

    #[test]
    fn save_with_label_creates_named_version() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        init_project_folder(root).unwrap();
        write_sketch(&Sketch::new("Test"), &root.join("test.sk"), root).unwrap();

        let commit_id = save_with_label(root, "v1.0 release", None).unwrap();
        assert!(!commit_id.is_empty());

        let versions = versioning::list_versions(root).unwrap();
        assert!(versions.iter().any(|v| v.message == "v1.0 release"));
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
    fn safe_resolve_rejects_absolute_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        #[cfg(target_os = "windows")]
        assert!(safe_resolve(root, "C:\\Windows\\System32\\cmd.exe").is_err());

        #[cfg(not(target_os = "windows"))]
        assert!(safe_resolve(root, "/etc/passwd").is_err());
    }

    // ── extract_screenshot_refs tests ─────────────────────────

    #[test]
    fn extract_refs_finds_screenshot_paths() {
        let md = "Some text\n![screenshot](.cutready/screenshots/pasted-123.png)\nMore text";
        let refs = extract_screenshot_refs(md);
        assert_eq!(refs, vec![".cutready/screenshots/pasted-123.png"]);
    }

    #[test]
    fn extract_refs_finds_multiple() {
        let md = "![a](.cutready/screenshots/a.png) and ![b](.cutready/screenshots/b.jpg)";
        let refs = extract_screenshot_refs(md);
        assert_eq!(refs.len(), 2);
    }

    #[test]
    fn extract_refs_ignores_non_screenshot_images() {
        let md = "![logo](assets/logo.png)";
        let refs = extract_screenshot_refs(md);
        assert!(refs.is_empty());
    }

    #[test]
    fn extract_refs_empty_content() {
        assert!(extract_screenshot_refs("").is_empty());
        assert!(extract_screenshot_refs("no images here").is_empty());
    }

    // ── delete_note with image cleanup tests ──────────────────

    #[test]
    fn delete_note_removes_orphaned_images() {
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
        assert!(!img.exists(), "orphaned image should be deleted");
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
    fn extract_refs_finds_html_img_tags() {
        let content = r#"Some text
<img src=".cutready/screenshots/pasted-500.png" alt="test" />
More text"#;
        let refs = extract_screenshot_refs(content);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0], ".cutready/screenshots/pasted-500.png");
    }

    #[test]
    fn extract_refs_finds_both_markdown_and_html() {
        let content = r#"# Doc
![pic](.cutready/screenshots/pasted-001.png)
Some text
<img src=".cutready/screenshots/pasted-002.png" />
"#;
        let refs = extract_screenshot_refs(content);
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|r| r.contains("pasted-001")));
        assert!(refs.iter().any(|r| r.contains("pasted-002")));
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

    // ── extract_sketch_screenshot_refs tests ─────────────────

    #[test]
    fn extract_sketch_refs_finds_screenshot_paths() {
        let sk = r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"intro","demo_actions":"click","screenshot":".cutready/screenshots/step1.png"}]}"#;
        let refs = extract_sketch_screenshot_refs(sk);
        assert_eq!(refs, vec![".cutready/screenshots/step1.png"]);
    }

    #[test]
    fn extract_sketch_refs_skips_null_screenshots() {
        let sk = r#"{"title":"Demo","rows":[{"time":"~30s","narrative":"intro","demo_actions":"click","screenshot":null}]}"#;
        let refs = extract_sketch_screenshot_refs(sk);
        assert!(refs.is_empty());
    }

    #[test]
    fn extract_sketch_refs_multiple_rows() {
        let sk = r#"{"title":"Demo","rows":[
            {"time":"~10s","narrative":"a","demo_actions":"a","screenshot":".cutready/screenshots/a.png"},
            {"time":"~10s","narrative":"b","demo_actions":"b","screenshot":null},
            {"time":"~10s","narrative":"c","demo_actions":"c","screenshot":".cutready/screenshots/c.png"}
        ]}"#;
        let refs = extract_sketch_screenshot_refs(sk);
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|r| r.contains("a.png")));
        assert!(refs.iter().any(|r| r.contains("c.png")));
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
        git2::Repository::init(root).unwrap();

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
        git2::Repository::init(root).unwrap();

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

        // Legacy file should be deleted, new file should exist
        assert!(
            !legacy_dir.join("workspace.json").exists(),
            "Legacy file should be deleted after migration"
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
    fn workspace_state_returns_default_when_missing() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        git2::Repository::init(root).unwrap();

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
        git2::Repository::init(root).unwrap();

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

        // Legacy file should be deleted
        assert!(
            !root.join(".cutready-order.json").exists(),
            "Legacy order file should be deleted after migration"
        );
        assert!(
            root.join(".git/cutready/order.json").exists(),
            "Migrated order should be in .git/cutready/"
        );
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

    #[test]
    fn scan_chat_sessions_includes_saved_author_metadata() {
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
        write_chat_session(&root.join(".chats/chat.chat"), &session).unwrap();

        let sessions = scan_chat_sessions(root).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].author_name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(sessions[0].author_email.as_deref(), Some("ada@example.com"));
    }

    #[test]
    fn scan_chat_sessions_falls_back_to_committed_author() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let repo = git2::Repository::init(root).unwrap();
        let now = chrono::Utc::now();
        let session = ChatSession {
            title: "Imported teammate chat".into(),
            messages: vec![serde_json::json!({ "role": "user", "content": "hello" })],
            created_at: now,
            updated_at: now,
            author_name: None,
            author_email: None,
        };
        let chat_path = root.join(".chats/chat.chat");
        write_chat_session(&chat_path, &session).unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(Path::new(".chats/chat.chat")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Grace Hopper", "grace@example.com").unwrap();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "add teammate chat",
            &tree,
            &[],
        )
        .unwrap();
        drop(tree);

        let sessions = scan_chat_sessions(root).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].author_name.as_deref(), Some("Grace Hopper"));
        assert_eq!(
            sessions[0].author_email.as_deref(),
            Some("grace@example.com")
        );
    }
}
