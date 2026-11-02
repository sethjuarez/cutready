//! Tauri commands for note CRUD operations.
//!
//! Notes are `.md` files in the project folder, identified by relative path.

use tauri::State;
use tauri_plugin_auditaur::auditaur_command;

use serde_json::json;

use super::CmdError;
use crate::engine::document_writer::{self, Expected, Versioned, WriteError};
use crate::engine::{document_reads, project};
use crate::models::script::ProjectView;
use crate::AppState;
use cutready_core::edit_ops::ContentEditError;
use cutready_core::models::sketch::NoteSummary;

/// Helper: get the project root from current state.
fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(document_root_from_project_view(view))
}

fn document_root_from_project_view(view: &ProjectView) -> std::path::PathBuf {
    view.root.clone()
}

#[tauri::command]
pub async fn create_note(relative_path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    if abs_path.exists() {
        return Err(format!("File already exists: {relative_path}"));
    }

    create_note_at(&root, &relative_path)
}

fn create_note_at(root: &std::path::Path, rel: &str) -> Result<(), String> {
    let op = json!({ "kind": "replace_note", "content": "" });
    match document_writer::edit(root, rel, Expected::Absent, &[op]) {
        Ok(_) => Ok(()),
        Err(WriteError::Edit(ContentEditError::Stale(_))) => {
            Err(format!("File already exists: {rel}"))
        }
        Err(err) => Err(err.to_string()),
    }
}

#[auditaur_command(skip_all, err)]
pub async fn get_note(relative_path: String, state: State<'_, AppState>) -> Result<String, String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    project::read_note(&abs_path).map_err(|e| e.to_string())
}

/// [`get_note`] with the version an editor saves against.
#[auditaur_command(skip_all, err)]
pub async fn get_note_versioned(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<Versioned<String>, CmdError> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path)?;
    Ok(document_reads::read_note_versioned(&abs_path, &root)?)
}

#[auditaur_command(skip_all, err)]
pub async fn get_note_lock(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<project::NoteLockState, String> {
    let root = project_root(&state)?;
    let _ = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    project::get_note_lock(&root, &relative_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_note_lock(
    relative_path: String,
    locked: bool,
    state: State<'_, AppState>,
) -> Result<project::NoteLockState, String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    set_note_lock_at(&root, &relative_path, &abs_path, locked)
}

/// The lock lives in the lock manifest. A note that isn't on disk can still
/// be locked by path, as before.
fn set_note_lock_at(
    root: &std::path::Path,
    rel: &str,
    abs_path: &std::path::Path,
    locked: bool,
) -> Result<project::NoteLockState, String> {
    if !abs_path.exists() {
        return project::set_note_lock(root, rel, locked).map_err(|e| e.to_string());
    }
    let op = json!({ "kind": "set_lock", "locked": locked });
    let expected = document_writer::expected_on_disk(abs_path)?;
    let written = document_writer::edit(root, rel, expected, &[op])?;
    let locked = written.note_lock.map_or(locked, |lock| lock.locked);
    Ok(project::NoteLockState { locked })
}

/// An app save of a note against `base`, the text the editor last loaded or
/// saved (see `document_writer::save`). Without a base the note is new.
#[auditaur_command(skip_all, err)]
pub async fn update_note(
    relative_path: String,
    expected_version: Option<String>,
    base: Option<String>,
    content: String,
    state: State<'_, AppState>,
) -> Result<Versioned<String>, CmdError> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    project::safe_resolve(&root, &relative_path)?;

    update_note_at(&root, &relative_path, expected_version.zip(base), content)
}

/// Saving a note with no base creates it; the lock still applies because
/// `write_note` follows it.
fn update_note_at(
    root: &std::path::Path,
    rel: &str,
    base: Option<(String, String)>,
    content: String,
) -> Result<Versioned<String>, CmdError> {
    let write = json!({ "kind": "write_note", "content": content });
    match base {
        Some((version, base)) => Ok(document_writer::save(root, rel, &version, &base, &[write])?),
        None => {
            let ops = [json!({ "kind": "replace_note", "content": "" }), write];
            let created = document_writer::edit(root, rel, Expected::Absent, &ops).map_err(
                |err| match err {
                    WriteError::Edit(ContentEditError::Stale(stale)) => CmdError::from(&stale),
                    other => other.into(),
                },
            )?;
            Ok(created.into())
        }
    }
}

#[tauri::command]
pub async fn delete_note(relative_path: String, state: State<'_, AppState>) -> Result<(), String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    project::delete_note(&abs_path, &root).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn rename_note(
    old_path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    project::rename_project_asset(&root, &old_path, &new_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[auditaur_command(skip_all, err)]
pub async fn list_notes(state: State<'_, AppState>) -> Result<Vec<NoteSummary>, String> {
    let root = project_root(&state)?;
    project::scan_notes(&root).map_err(|e| e.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn list_chat_artifacts(state: State<'_, AppState>) -> Result<Vec<NoteSummary>, String> {
    let root = project_root(&state)?;
    project::scan_chat_artifacts(&root).map_err(|e| e.to_string())
}

/// Save a base64-encoded image to the project's screenshots directory.
/// Returns the relative path (e.g. ".cutready/screenshots/pasted-1234.png").
#[tauri::command]
pub async fn save_pasted_image(
    base64_data: String,
    extension: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let dir = root.join(".cutready").join("screenshots");
    // asset write: screenshot image, not a document
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create screenshots dir: {e}"))?;

    let data = base64_decode(&base64_data)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let ext = match extension.as_str() {
        "jpeg" | "jpg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        _ => "png",
    };
    let filename = format!("pasted-{ts}.{ext}");
    let abs_path = dir.join(&filename);
    // asset write: screenshot image, not a document
    std::fs::write(&abs_path, &data).map_err(|e| format!("Failed to write image: {e}"))?;
    Ok(format!(".cutready/screenshots/{filename}"))
}

/// Image/visual info returned by the image manager.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    /// Relative path (e.g. ".cutready/screenshots/pasted-123.png" or ".cutready/visuals/abc123.json")
    pub path: String,
    /// File size in bytes
    pub size: u64,
    /// Which files reference this asset (relative paths)
    pub referenced_by: Vec<String>,
    /// "screenshot" or "visual"
    pub asset_type: String,
    /// File modification time as milliseconds since UNIX epoch
    pub modified_at: u64,
}

/// List all images and visuals in the project with reference info.
#[auditaur_command(skip_all, err)]
pub async fn list_project_images(state: State<'_, AppState>) -> Result<Vec<ImageInfo>, String> {
    let root = project_root(&state)?;
    let refs = project::list_images_with_refs(&root).map_err(|e| e.to_string())?;
    Ok(refs
        .into_iter()
        .map(|r| ImageInfo {
            path: r.path,
            size: r.size,
            referenced_by: r.referenced_by,
            asset_type: r.asset_type.to_string(),
            modified_at: r.modified_at,
        })
        .collect())
}

/// Delete a specific image or visual file from the project.
#[auditaur_command(skip_all, err)]
pub async fn delete_project_image(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    if !abs_path.exists() {
        return Err(format!("Asset not found: {relative_path}"));
    }
    // Only allow deleting from .cutready/screenshots or .cutready/visuals
    if !relative_path.starts_with(".cutready/screenshots/")
        && !relative_path.starts_with(".cutready/visuals/")
    {
        return Err(
            "Can only delete assets from .cutready/screenshots/ or .cutready/visuals/".into(),
        );
    }
    // asset write: image cleanup, not a document
    std::fs::remove_file(&abs_path).map_err(|e| format!("Failed to delete asset: {e}"))?;
    Ok(())
}

/// Delete all orphaned images and visuals (re-verified server-side).
/// Returns the count of deleted assets.
#[auditaur_command(skip_all, err)]
pub async fn delete_orphaned_images(state: State<'_, AppState>) -> Result<u32, String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let refs = project::list_images_with_refs(&root).map_err(|e| e.to_string())?;
    let mut deleted = 0u32;
    for asset in &refs {
        if asset.referenced_by.is_empty() {
            let abs = root.join(&asset.path);
            if abs.exists() {
                // asset write: image cleanup, not a document
                std::fs::remove_file(&abs)
                    .map_err(|e| format!("Failed to delete {}: {e}", asset.path))?;
                deleted += 1;
            }
        }
    }
    Ok(deleted)
}

/// Import an external image file into the project's screenshots directory.
/// Copies the file and returns the relative path.
#[tauri::command]
pub async fn import_image(
    source_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let _write_guard = crate::engine::write_lock::lock(&root)?;
    let dir = root.join(".cutready").join("screenshots");
    // asset write: screenshot image, not a document
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create screenshots dir: {e}"))?;

    let source = std::path::Path::new(&source_path);
    if !source.exists() {
        return Err(format!("Source file not found: {source_path}"));
    }

    // Preserve original filename but prefix with timestamp to avoid collisions
    let original_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("imported.png");
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("{ts}_{original_name}");
    let dest = dir.join(&filename);

    // asset write: screenshot image, not a document
    std::fs::copy(source, &dest).map_err(|e| format!("Failed to copy image: {e}"))?;
    Ok(format!(".cutready/screenshots/{filename}"))
}

/// Read a project-relative image file and return it as a data URL.
/// Works cross-platform without relying on asset protocol.
#[auditaur_command(skip_all, err)]
pub async fn read_project_image(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    let abs_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;

    if !abs_path.exists() {
        return Err(format!("Image not found: {relative_path}"));
    }

    let data = std::fs::read(&abs_path).map_err(|e| format!("Failed to read image: {e}"))?;

    let mime = match abs_path.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:{mime};base64,{b64}"))
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| format!("Invalid base64: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_document_io_scopes_to_project_root_for_nested_projects() {
        let view = ProjectView::in_repo(
            std::path::PathBuf::from("D:/workspace"),
            "demos/product-tour",
            "Product tour".to_string(),
        );

        assert_eq!(
            document_root_from_project_view(&view),
            std::path::PathBuf::from("D:/workspace/demos/product-tour")
        );
        assert_ne!(document_root_from_project_view(&view), view.repo_root);
    }

    fn note(root: &std::path::Path) -> String {
        std::fs::read_to_string(root.join("plan.md")).unwrap()
    }

    #[test]
    fn creating_over_an_existing_note_reports_it_exists() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        create_note_at(root, "plan.md").unwrap();
        assert_eq!(note(root), "");

        assert_eq!(
            create_note_at(root, "plan.md").unwrap_err(),
            "File already exists: plan.md"
        );
    }

    /// An app save against the note on disk now, or a create when missing.
    fn save(root: &std::path::Path, content: &str) -> Result<Versioned<String>, String> {
        let base = std::fs::read_to_string(root.join("plan.md"))
            .ok()
            .map(|base| {
                let version = cutready_core::edit_ops::document_version(base.as_bytes());
                (version, base)
            });
        update_note_at(root, "plan.md", base, content.into()).map_err(|err| err.message)
    }

    #[test]
    fn saving_writes_the_note_and_creates_a_missing_one() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();

        save(root, "# Draft").unwrap();
        assert_eq!(note(root), "# Draft");
        save(root, "# Final").unwrap();
        assert_eq!(note(root), "# Final");
    }

    #[test]
    fn a_locked_note_rejects_saves_even_when_missing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let abs = root.join("plan.md");
        create_note_at(root, "plan.md").unwrap();

        assert!(
            set_note_lock_at(root, "plan.md", &abs, true)
                .unwrap()
                .locked
        );
        assert!(project::get_note_lock(root, "plan.md").unwrap().locked);
        let locked = project::ensure_note_unlocked(root, "plan.md")
            .unwrap_err()
            .to_string();
        assert_eq!(save(root, "x").unwrap_err(), locked);
        assert_eq!(note(root), "");

        std::fs::remove_file(&abs).unwrap();
        assert_eq!(save(root, "x").unwrap_err(), locked);
        assert!(!abs.exists());

        assert!(
            !set_note_lock_at(root, "plan.md", &abs, false)
                .unwrap()
                .locked
        );
        save(root, "x").unwrap();
        assert_eq!(note(root), "x");
    }

    #[test]
    fn delete_removes_the_note() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        create_note_at(root, "plan.md").unwrap();

        project::delete_note(&root.join("plan.md"), root).unwrap();

        assert!(!root.join("plan.md").exists());
    }
}
