//! Tauri command for persisting user feedback to the app data directory.

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::Manager;
use tauri_plugin_auditaur::auditaur_command;
use uuid::Uuid;

use crate::engine::diagnostics_sanitizer::{sanitize_diagnostic_text, sanitize_diagnostic_value};

const GITHUB_COMMENT_CHUNK_BYTES: usize = 52_000;
const MAX_FEEDBACK_ATTACHMENTS: usize = 3;
const MAX_FEEDBACK_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;
const MAX_FEEDBACK_ATTACHMENT_BASE64_BYTES: usize = (MAX_FEEDBACK_ATTACHMENT_BYTES * 4 / 3) + 8;

#[derive(Serialize, Deserialize, Clone)]
pub struct FeedbackEntry {
    pub category: String,
    pub feedback: String,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_log: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_info: Option<FeedbackSystemInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<FeedbackAttachment>,
}

#[derive(Deserialize)]
pub struct SaveFeedbackEntry {
    pub category: String,
    pub feedback: String,
    pub date: String,
    #[serde(default)]
    pub debug_log: Option<String>,
    #[serde(default)]
    pub system_info: Option<FeedbackSystemInfo>,
    #[serde(default)]
    pub attachments: Vec<FeedbackAttachmentPayload>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FeedbackAttachment {
    pub id: String,
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: usize,
    pub stored_path: String,
    pub sha256: String,
}

#[derive(Deserialize)]
pub struct FeedbackAttachmentPayload {
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: usize,
    pub data_base64: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FeedbackSystemInfo {
    pub app_version: String,
    pub os: String,
    pub os_family: String,
    pub arch: String,
}

/// Append a feedback entry to `<app_data>/feedback.json`.
#[auditaur_command(skip_all, err)]
pub fn save_feedback(
    app: tauri::AppHandle,
    entry: SaveFeedbackEntry,
) -> Result<FeedbackEntry, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("Could not create data dir: {e}"))?;
    cleanup_feedback_work_files(&data_dir)?;

    let path = data_dir.join("feedback.json");
    let mut entries: Vec<FeedbackEntry> = if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_else(|_| "[]".into());
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    let attachments = persist_feedback_attachments(&data_dir, entry.attachments)?;
    let saved_entry = FeedbackEntry {
        category: entry.category,
        feedback: entry.feedback,
        date: entry.date,
        debug_log: entry
            .debug_log
            .map(|debug_log| redact_auditaur_summary(&debug_log)),
        system_info: entry.system_info,
        attachments,
    };

    entries.push(saved_entry.clone());

    if let Err(error) = write_feedback_entries(&path, &entries) {
        return rollback_feedback_attachments(
            &data_dir,
            &saved_entry.attachments,
            format!("Could not write feedback: {error}"),
        );
    }

    Ok(saved_entry)
}

/// Read all feedback entries from `<app_data>/feedback.json`.
#[auditaur_command(skip_all, err)]
pub fn list_feedback(app: tauri::AppHandle) -> Result<Vec<FeedbackEntry>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    cleanup_feedback_work_files(&data_dir)?;
    let path = data_dir.join("feedback.json");

    if !path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&path).map_err(|e| format!("Read error: {e}"))?;
    let mut entries: Vec<FeedbackEntry> =
        serde_json::from_str(&content).map_err(|e| format!("Parse error: {e}"))?;
    for entry in &mut entries {
        if let Some(debug_log) = entry.debug_log.as_mut() {
            *debug_log = redact_auditaur_summary(debug_log);
        }
    }
    Ok(entries)
}

/// Clear all feedback entries.
#[auditaur_command(skip_all, err)]
pub fn clear_feedback(app: tauri::AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    cleanup_feedback_work_files(&data_dir)?;
    let path = data_dir.join("feedback.json");
    let attachment_dir = data_dir.join("feedback-attachments");
    let trash_dir = if attachment_dir.exists() {
        let trash_dir = feedback_trash_dir(&data_dir, "clear");
        if let Some(parent) = trash_dir.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create feedback cleanup folder: {e}"))?;
        }
        fs::rename(&attachment_dir, &trash_dir)
            .map_err(|e| format!("Could not stage feedback attachments for clearing: {e}"))?;
        Some(trash_dir)
    } else {
        None
    };
    if path.exists() {
        if let Err(error) = write_feedback_entries(&path, &[]) {
            if let Some(trash_dir) = &trash_dir {
                restore_quarantined_path(trash_dir, &attachment_dir)?;
            }
            return Err(format!("Could not clear feedback: {error}"));
        }
    }
    if let Some(trash_dir) = trash_dir {
        remove_quarantined_path(&trash_dir);
    }
    Ok(())
}

/// Delete a single feedback entry by index.
#[auditaur_command(skip_all, err)]
pub fn delete_feedback(app: tauri::AppHandle, index: usize) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    cleanup_feedback_work_files(&data_dir)?;
    let path = data_dir.join("feedback.json");
    if !path.exists() {
        return Err("No feedback file found".into());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Read error: {e}"))?;
    let mut entries: Vec<FeedbackEntry> =
        serde_json::from_str(&content).map_err(|e| format!("Parse error: {e}"))?;
    if index >= entries.len() {
        return Err(format!("Index {} out of bounds ({})", index, entries.len()));
    }
    let removed = entries.remove(index);
    let quarantined = quarantine_feedback_attachment_files(&data_dir, &removed)?;
    if let Err(error) = write_feedback_entries(&path, &entries) {
        if let Err(restore_error) = restore_quarantined_attachments(&quarantined) {
            return Err(format!(
                "Could not write feedback: {error}; also failed to restore screenshots: {restore_error}"
            ));
        }
        return Err(format!("Could not write feedback: {error}"));
    }
    remove_quarantined_attachments(&quarantined);
    Ok(())
}

fn write_feedback_entries(path: &Path, entries: &[FeedbackEntry]) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(entries).map_err(|e| format!("Serialization error: {e}"))?;
    write_text_with_backup(path, &json)
}

fn write_text_with_backup(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Could not resolve parent folder for {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("Could not create feedback folder: {e}"))?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("feedback.json");
    let operation_id = Uuid::new_v4().to_string();
    let temp_path = parent.join(format!(".{file_name}.{operation_id}.tmp"));
    let backup_path = parent.join(format!(".{file_name}.{operation_id}.bak"));

    {
        let mut file = fs::File::create(&temp_path)
            .map_err(|e| format!("Could not create feedback temp file: {e}"))?;
        file.write_all(contents.as_bytes())
            .map_err(|e| format!("Could not write feedback temp file: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("Could not flush feedback temp file: {e}"))?;
    }

    if path.exists() {
        fs::rename(path, &backup_path).map_err(|e| {
            cleanup_temp_after_error(
                &temp_path,
                format!("Could not stage existing feedback file: {e}"),
            )
        })?;
        if let Err(error) = fs::rename(&temp_path, path) {
            let restore_result = fs::rename(&backup_path, path);
            return Err(match restore_result {
                Ok(()) => format!("Could not replace feedback file: {error}"),
                Err(restore_error) => format!(
                    "Could not replace feedback file: {error}; also failed to restore previous feedback file: {restore_error}"
                ),
            });
        }
        if let Err(error) = fs::remove_file(&backup_path) {
            tracing::warn!(
                path = %backup_path.display(),
                error = %error,
                "feedback backup cleanup failed after successful save"
            );
        }
    } else {
        fs::rename(&temp_path, path).map_err(|e| {
            cleanup_temp_after_error(&temp_path, format!("Could not write feedback file: {e}"))
        })?;
    }

    Ok(())
}

fn cleanup_temp_after_error(temp_path: &Path, primary_error: String) -> String {
    match fs::remove_file(temp_path) {
        Ok(()) => primary_error,
        Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => primary_error,
        Err(cleanup_error) => {
            format!("{primary_error}; also failed to remove temp file: {cleanup_error}")
        }
    }
}

fn cleanup_feedback_work_files(data_dir: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(data_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect feedback work files: {error}")),
    };
    let feedback_path = data_dir.join("feedback.json");
    let mut backup_paths = Vec::new();
    let mut temp_paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Could not inspect feedback work file: {e}"))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with(".feedback.json.") && name.ends_with(".bak") {
            backup_paths.push(path);
        } else if name.starts_with(".feedback.json.") && name.ends_with(".tmp") {
            temp_paths.push(path);
        }
    }

    if !feedback_path.exists() {
        if let Some(backup_path) = newest_path(&backup_paths) {
            fs::rename(&backup_path, &feedback_path).map_err(|e| {
                format!(
                    "Could not restore feedback backup {}: {e}",
                    backup_path.display()
                )
            })?;
            backup_paths.retain(|path| path != &backup_path);
        }
    }

    for path in backup_paths.iter().chain(temp_paths.iter()) {
        fs::remove_file(path).map_err(|e| {
            format!(
                "Could not remove stale feedback work file {}: {e}",
                path.display()
            )
        })?;
    }

    let referenced_attachment_ids = referenced_feedback_attachment_ids(&feedback_path)?;
    let attachment_root = data_dir.join("feedback-attachments");
    let trash_root = data_dir.join("feedback-attachments-trash");
    if trash_root.exists() {
        restore_referenced_trash_attachments(
            &attachment_root,
            &trash_root,
            &referenced_attachment_ids,
        )?;
        fs::remove_dir_all(&trash_root).map_err(|e| {
            format!(
                "Could not remove stale feedback attachment cleanup folder {}: {e}",
                trash_root.display()
            )
        })?;
    }
    remove_unreferenced_feedback_attachment_dirs(&attachment_root, &referenced_attachment_ids)?;
    Ok(())
}

fn referenced_feedback_attachment_ids(feedback_path: &Path) -> Result<HashSet<String>, String> {
    if !feedback_path.exists() {
        return Ok(HashSet::new());
    }
    let content =
        fs::read_to_string(feedback_path).map_err(|e| format!("Could not read feedback: {e}"))?;
    let entries: Vec<FeedbackEntry> =
        serde_json::from_str(&content).map_err(|e| format!("Could not parse feedback: {e}"))?;
    Ok(entries
        .iter()
        .flat_map(|entry| {
            entry
                .attachments
                .iter()
                .map(|attachment| attachment.id.clone())
        })
        .collect())
}

fn restore_referenced_trash_attachments(
    attachment_root: &Path,
    trash_root: &Path,
    referenced_ids: &HashSet<String>,
) -> Result<(), String> {
    for operation_entry in
        fs::read_dir(trash_root).map_err(|e| format!("Could not inspect feedback trash: {e}"))?
    {
        let operation_entry =
            operation_entry.map_err(|e| format!("Could not inspect feedback trash entry: {e}"))?;
        if !operation_entry.path().is_dir() {
            continue;
        }
        let attachment_entries = fs::read_dir(operation_entry.path())
            .map_err(|e| format!("Could not inspect feedback trash attachments: {e}"))?;
        for attachment_entry in attachment_entries {
            let attachment_entry = attachment_entry
                .map_err(|e| format!("Could not inspect feedback trash attachment: {e}"))?;
            let trash_path = attachment_entry.path();
            if !trash_path.is_dir() {
                continue;
            }
            let Some(id) = trash_path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !referenced_ids.contains(id) {
                continue;
            }
            let original_path = attachment_root.join(id);
            if original_path.exists() {
                continue;
            }
            fs::create_dir_all(attachment_root)
                .map_err(|e| format!("Could not recreate feedback attachment folder: {e}"))?;
            fs::rename(&trash_path, &original_path).map_err(|e| {
                format!(
                    "Could not restore feedback attachment {} from cleanup folder: {e}",
                    id
                )
            })?;
        }
    }
    Ok(())
}

fn remove_unreferenced_feedback_attachment_dirs(
    attachment_root: &Path,
    referenced_ids: &HashSet<String>,
) -> Result<(), String> {
    if !attachment_root.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(attachment_root)
        .map_err(|e| format!("Could not inspect feedback attachments: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Could not inspect feedback attachment: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if Uuid::parse_str(id).is_ok() && !referenced_ids.contains(id) {
            fs::remove_dir_all(&path).map_err(|e| {
                format!(
                    "Could not remove unreferenced feedback attachment {}: {e}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn newest_path(paths: &[PathBuf]) -> Option<PathBuf> {
    paths
        .iter()
        .max_by_key(|path| {
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
        })
        .cloned()
}

fn feedback_trash_dir(data_dir: &Path, operation: &str) -> PathBuf {
    data_dir
        .join("feedback-attachments-trash")
        .join(format!("{operation}-{}", Uuid::new_v4()))
}

fn persist_feedback_attachments(
    data_dir: &std::path::Path,
    attachments: Vec<FeedbackAttachmentPayload>,
) -> Result<Vec<FeedbackAttachment>, String> {
    if attachments.len() > MAX_FEEDBACK_ATTACHMENTS {
        return Err(format!(
            "Too many screenshots. Attach up to {MAX_FEEDBACK_ATTACHMENTS} PNG/JPEG files."
        ));
    }

    struct PreparedAttachment {
        metadata: FeedbackAttachment,
        bytes: Vec<u8>,
    }

    let mut prepared = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        validate_attachment_type(&attachment.content_type)?;
        if attachment.size_bytes > MAX_FEEDBACK_ATTACHMENT_BYTES {
            return Err(format!(
                "{} is too large. Keep screenshots under 5 MB.",
                attachment.file_name
            ));
        }
        if attachment.data_base64.len() > MAX_FEEDBACK_ATTACHMENT_BASE64_BYTES {
            return Err(format!(
                "{} is too large. Keep screenshots under 5 MB.",
                attachment.file_name
            ));
        }

        let bytes = BASE64_STANDARD
            .decode(attachment.data_base64.as_bytes())
            .map_err(|e| format!("Could not decode {}: {e}", attachment.file_name))?;
        if bytes.len() > MAX_FEEDBACK_ATTACHMENT_BYTES {
            return Err(format!(
                "{} is too large. Keep screenshots under 5 MB.",
                attachment.file_name
            ));
        }
        if bytes.len() != attachment.size_bytes {
            return Err(format!(
                "{} changed while being attached. Please select it again.",
                attachment.file_name
            ));
        }
        validate_attachment_signature(&attachment.content_type, &bytes, &attachment.file_name)?;

        let id = Uuid::new_v4().to_string();
        let file_name = safe_attachment_file_name(&attachment.file_name, &attachment.content_type);
        let sha256 = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();

        let stored_path = format!("feedback-attachments/{id}/{file_name}");
        let metadata = FeedbackAttachment {
            id,
            file_name,
            content_type: attachment.content_type,
            size_bytes: bytes.len(),
            stored_path,
            sha256,
        };
        prepared.push(PreparedAttachment { metadata, bytes });
    }

    let mut saved = Vec::with_capacity(prepared.len());
    let mut written_ids = Vec::with_capacity(prepared.len());
    for attachment in prepared {
        let attachment_dir = data_dir
            .join("feedback-attachments")
            .join(&attachment.metadata.id);
        written_ids.push(attachment.metadata.id.clone());
        if let Err(error) = fs::create_dir_all(&attachment_dir) {
            return rollback_feedback_attachment_ids(
                data_dir,
                &written_ids,
                format!("Could not create feedback attachment folder: {error}"),
            );
        }
        if let Err(error) = fs::write(
            attachment_dir.join(&attachment.metadata.file_name),
            &attachment.bytes,
        ) {
            return rollback_feedback_attachment_ids(
                data_dir,
                &written_ids,
                format!(
                    "Could not write screenshot {}: {error}",
                    attachment.metadata.file_name
                ),
            );
        }
        saved.push(attachment.metadata);
    }

    Ok(saved)
}

fn rollback_feedback_attachments<T>(
    data_dir: &std::path::Path,
    attachments: &[FeedbackAttachment],
    primary_error: String,
) -> Result<T, String> {
    let ids = attachments
        .iter()
        .map(|attachment| attachment.id.clone())
        .collect::<Vec<_>>();
    rollback_feedback_attachment_ids(data_dir, &ids, primary_error)
}

fn rollback_feedback_attachment_ids<T>(
    data_dir: &std::path::Path,
    ids: &[String],
    primary_error: String,
) -> Result<T, String> {
    match remove_feedback_attachment_ids(data_dir, ids) {
        Ok(()) => Err(primary_error),
        Err(cleanup_error) => Err(format!(
            "{primary_error}; also failed to remove copied screenshots: {cleanup_error}"
        )),
    }
}

fn remove_feedback_attachment_ids(
    data_dir: &std::path::Path,
    ids: &[String],
) -> Result<(), String> {
    for id in ids {
        let Ok(id) = Uuid::parse_str(id) else {
            return Err("Stored feedback attachment id is invalid".into());
        };
        let dir = data_dir.join("feedback-attachments").join(id.to_string());
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("Could not remove feedback attachment {id}: {e}"))?;
        }
    }
    Ok(())
}

struct QuarantinedAttachment {
    original: PathBuf,
    trash: PathBuf,
}

fn quarantine_feedback_attachment_files(
    data_dir: &Path,
    entry: &FeedbackEntry,
) -> Result<Vec<QuarantinedAttachment>, String> {
    let trash_root = feedback_trash_dir(data_dir, "delete");
    fs::create_dir_all(&trash_root)
        .map_err(|e| format!("Could not create feedback cleanup folder: {e}"))?;

    let mut quarantined = Vec::new();
    for attachment in &entry.attachments {
        let Ok(id) = Uuid::parse_str(&attachment.id) else {
            restore_quarantined_attachments(&quarantined)?;
            return Err("Stored feedback attachment id is invalid".into());
        };
        let original = data_dir.join("feedback-attachments").join(id.to_string());
        if !original.exists() {
            continue;
        }
        let trash = trash_root.join(id.to_string());
        if let Err(error) = fs::rename(&original, &trash) {
            restore_quarantined_attachments(&quarantined)?;
            return Err(format!(
                "Could not stage feedback attachment {} for deletion: {error}",
                attachment.file_name
            ));
        }
        quarantined.push(QuarantinedAttachment { original, trash });
    }
    Ok(quarantined)
}

fn restore_quarantined_attachments(quarantined: &[QuarantinedAttachment]) -> Result<(), String> {
    for item in quarantined.iter().rev() {
        restore_quarantined_path(&item.trash, &item.original)?;
    }
    Ok(())
}

fn remove_quarantined_attachments(quarantined: &[QuarantinedAttachment]) {
    for item in quarantined {
        remove_quarantined_path(&item.trash);
    }
}

fn restore_quarantined_path(trash: &Path, original: &Path) -> Result<(), String> {
    if !trash.exists() {
        return Ok(());
    }
    if let Some(parent) = original.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not recreate feedback attachment folder: {e}"))?;
    }
    fs::rename(trash, original).map_err(|e| {
        format!(
            "Could not restore quarantined feedback attachment {} to {}: {e}",
            trash.display(),
            original.display()
        )
    })
}

fn remove_quarantined_path(path: &Path) {
    if !path.exists() {
        return;
    }
    let result = if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    if let Err(error) = result {
        tracing::warn!(
            path = %path.display(),
            error = %error,
            "feedback attachment cleanup failed after metadata update"
        );
    }
}

fn validate_attachment_type(content_type: &str) -> Result<(), String> {
    match content_type {
        "image/png" | "image/jpeg" => Ok(()),
        _ => Err("Screenshots must be PNG or JPEG images.".into()),
    }
}

fn validate_attachment_signature(
    content_type: &str,
    bytes: &[u8],
    file_name: &str,
) -> Result<(), String> {
    let valid = match content_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "{file_name} does not look like a valid screenshot image."
        ))
    }
}

fn safe_attachment_file_name(original: &str, content_type: &str) -> String {
    let fallback = match content_type {
        "image/png" => "screenshot.png",
        "image/jpeg" => "screenshot.jpg",
        _ => "screenshot",
    };
    let basename = original
        .rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(fallback);
    let mut safe = basename
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .chars()
        .take(96)
        .collect::<String>();
    if safe.is_empty() {
        safe = fallback.to_string();
    }

    let lower = safe.to_ascii_lowercase();
    match content_type {
        "image/png" if !lower.ends_with(".png") => safe.push_str(".png"),
        "image/jpeg" if !lower.ends_with(".jpg") && !lower.ends_with(".jpeg") => {
            safe.push_str(".jpg")
        }
        _ => {}
    }
    safe
}

#[auditaur_command(skip_all, err)]
pub fn get_feedback_system_info(app: tauri::AppHandle) -> Result<FeedbackSystemInfo, String> {
    Ok(FeedbackSystemInfo {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        os_family: std::env::consts::FAMILY.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

/// Create a GitHub issue via the `gh` CLI. Returns the issue URL on success.
/// Uses `--body-file -` to pipe the body via stdin (avoids shell escaping and length limits).
#[derive(Debug, Serialize)]
pub struct CreateGithubIssueResult {
    pub url: String,
    pub diagnostics_comments_posted: usize,
    pub diagnostics_comment_error: Option<String>,
}

#[auditaur_command(skip_all, err)]
pub async fn create_github_issue(
    repo: String,
    title: String,
    body: String,
    labels: Option<Vec<String>>,
    diagnostics_attachment: Option<String>,
) -> Result<CreateGithubIssueResult, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    if !is_safe_github_repo(&repo) {
        return Err("Invalid GitHub repository. Expected owner/repo.".into());
    }
    let body = sanitize_diagnostic_text(&body);
    tracing::info!(
        body_bytes = body.len(),
        has_diagnostics_attachment = diagnostics_attachment.is_some(),
        "creating feedback issue with sanitized body"
    );

    let mut cmd = tokio::process::Command::new("gh");
    cmd.args([
        "issue",
        "create",
        "--repo",
        &repo,
        "--title",
        &title,
        "--body-file",
        "-",
    ]);

    if let Some(lbls) = &labels {
        for label in lbls {
            cmd.args(["--label", label]);
        }
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com and restart CutReady.".to_string()
        } else {
            format!("Failed to start gh CLI: {e}")
        }
    })?;

    // Write body to stdin
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(body.as_bytes())
            .await
            .map_err(|e| format!("Failed to write issue body: {e}"))?;
        // drop stdin to close the pipe
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("gh process error: {e}"))?;

    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let (diagnostics_comments_posted, diagnostics_comment_error) =
            match post_diagnostics_comments(&repo, &url, diagnostics_attachment).await {
                Ok(count) => (count, None),
                Err(error) => (0, Some(error)),
            };
        Ok(CreateGithubIssueResult {
            url,
            diagnostics_comments_posted,
            diagnostics_comment_error,
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.contains("401") || stderr.contains("authentication") {
            Err(format!("GitHub authentication failed. Run `gh auth login` in a terminal and restart CutReady.\n\nDetails: {stderr}"))
        } else {
            Err(format!("gh issue create failed: {stderr}"))
        }
    }
}

async fn post_diagnostics_comments(
    repo: &str,
    issue_url: &str,
    diagnostics_attachment: Option<String>,
) -> Result<usize, String> {
    let Some(diagnostics_attachment) = diagnostics_attachment else {
        return Ok(0);
    };
    let redacted = redact_auditaur_summary(&diagnostics_attachment);
    let redacted = redacted.trim();
    if redacted.is_empty() {
        return Ok(0);
    }
    let issue_number = issue_number_from_url(issue_url).ok_or_else(|| {
        format!("Issue created, but could not parse issue number from {issue_url}")
    })?;
    let chunks = chunk_text_by_bytes(redacted, GITHUB_COMMENT_CHUNK_BYTES);
    let chunk_count = chunks.len();
    tracing::info!(
        diagnostics_bytes = redacted.len(),
        chunk_count,
        "posting sanitized diagnostics comments"
    );
    for (index, chunk) in chunks.iter().enumerate() {
        let body = if chunk_count == 1 {
            format!("## Sanitized debug diagnostics\n\n```json\n{}\n```", chunk)
        } else {
            format!(
                "## Sanitized debug diagnostics ({}/{})\n\n```text\n{}\n```",
                index + 1,
                chunk_count,
                chunk
            )
        };
        post_issue_comment(repo, &issue_number, &body).await?;
    }
    Ok(chunk_count)
}

async fn post_issue_comment(repo: &str, issue_number: &str, body: &str) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;

    let mut cmd = tokio::process::Command::new("gh");
    cmd.args([
        "issue",
        "comment",
        issue_number,
        "--repo",
        repo,
        "--body-file",
        "-",
    ]);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start gh CLI for diagnostics comment: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(body.as_bytes())
            .await
            .map_err(|e| format!("Failed to write diagnostics comment: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("gh issue comment process error: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "Issue was created, but posting diagnostics failed: {stderr}"
        ))
    }
}

fn issue_number_from_url(url: &str) -> Option<String> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|value| value.chars().all(|ch| ch.is_ascii_digit()))
        .map(ToString::to_string)
}

fn chunk_text_by_bytes(text: &str, max_bytes: usize) -> Vec<String> {
    if text.len() <= max_bytes {
        return vec![text.to_string()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if !current.is_empty() && current.len() + ch.len_utf8() > max_bytes {
            chunks.push(current);
            current = String::new();
        }
        current.push(ch);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn is_safe_github_repo(repo: &str) -> bool {
    let Some((owner, name)) = repo.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && !name.is_empty()
        && !name.contains('/')
        && [owner, name].iter().all(|part| {
            part.chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
        })
}

/// Collect local diagnostic files into a zip archive at the given destination path.
#[auditaur_command(skip_all, err)]
pub fn export_logs(
    app: tauri::AppHandle,
    dest: String,
    debug_log: Option<String>,
) -> Result<(), String> {
    use zip::write::SimpleFileOptions;

    let log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.cutready.app")
        .join("logs");

    let dest_path = std::path::PathBuf::from(&dest);
    let file = fs::File::create(&dest_path).map_err(|e| format!("Could not create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // Collect legacy backend log files if they exist from older builds.
    if log_dir.exists() {
        add_dir_to_zip(&mut zip, &log_dir, "legacy-logs", options)?;
    }

    // Include a compact, redacted diagnostics summary rather than the raw SQLite
    // session directory so exported reports stay shareable by default.
    if let Some(log_text) = debug_log {
        zip.start_file("auditaur-redacted-summary.json", options)
            .map_err(|e| format!("Zip error: {e}"))?;
        let redacted = redact_auditaur_summary(&log_text);
        tracing::info!(
            diagnostics_bytes = redacted.len(),
            "writing sanitized diagnostics summary to exported logs"
        );
        zip.write_all(redacted.as_bytes())
            .map_err(|e| format!("Write error: {e}"))?;
    }

    // Include basic system info
    let info = format!(
        "app_version: {}\nos: {}\narch: {}\ntimestamp: {}",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        chrono::Utc::now().to_rfc3339(),
    );
    zip.start_file("system-info.txt", options)
        .map_err(|e| format!("Zip error: {e}"))?;
    zip.write_all(info.as_bytes())
        .map_err(|e| format!("Write error: {e}"))?;

    zip.finish()
        .map_err(|e| format!("Zip finalize error: {e}"))?;
    Ok(())
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    dir: &std::path::Path,
    zip_prefix: &str,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    add_dir_entries_to_zip(zip, dir, dir, zip_prefix, options)
}

fn add_dir_entries_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    root: &std::path::Path,
    dir: &std::path::Path,
    zip_prefix: &str,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let entries =
        fs::read_dir(dir).map_err(|e| format!("Could not read {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            add_dir_entries_to_zip(zip, root, &path, zip_prefix, options)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }

        let relative = path
            .strip_prefix(root)
            .ok()
            .and_then(|path| path.to_str())
            .unwrap_or("diagnostic-file")
            .replace('\\', "/");
        let name = format!("{zip_prefix}/{relative}");
        let data =
            fs::read(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        zip.start_file(name, options)
            .map_err(|e| format!("Zip error: {e}"))?;
        zip.write_all(&data)
            .map_err(|e| format!("Write error: {e}"))?;
    }
    Ok(())
}

fn redact_auditaur_summary(summary: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(summary) else {
        return sanitize_diagnostic_text(summary);
    };
    sanitize_diagnostic_value(&mut value);
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| sanitize_diagnostic_text(summary))
}

#[cfg(test)]
mod tests {
    use super::{
        chunk_text_by_bytes, is_safe_github_repo, issue_number_from_url,
        persist_feedback_attachments, redact_auditaur_summary, safe_attachment_file_name,
        validate_attachment_signature, FeedbackAttachmentPayload, FeedbackSystemInfo,
        BASE64_STANDARD,
    };
    use base64::Engine as _;

    #[test]
    fn github_repo_validation_accepts_owner_repo() {
        assert!(is_safe_github_repo("sethjuarez/cutready"));
        assert!(is_safe_github_repo("my-org/repo.name"));
    }

    #[test]
    fn github_repo_validation_rejects_unsafe_values() {
        assert!(!is_safe_github_repo("sethjuarez"));
        assert!(!is_safe_github_repo("sethjuarez/cutready/extra"));
        assert!(!is_safe_github_repo("sethjuarez/$(bad)"));
    }

    #[test]
    fn redacted_auditaur_summary_removes_local_paths() {
        let summary = r#"{
          "session": {
            "database_path": "C:\\Users\\person\\AppData\\Local\\auditaur\\sessions\\id\\telemetry.sqlite"
          },
          "policy": {
            "settings_path": "C:\\Users\\person\\AppData\\Roaming\\com.cutready.app\\settings.json"
          }
        }"#;

        let redacted = redact_auditaur_summary(summary);

        assert!(!redacted.contains("Users\\\\person"));
        assert!(redacted.contains("<redacted local path>"));
    }

    #[test]
    fn redacted_auditaur_summary_removes_secret_and_raw_detail_values() {
        let summary = r#"{
          "failed_ipc": [{
            "kind": "create_visual",
            "detail": "Authorization: Bearer secret-token failed at C:\\Users\\person\\project\\file.ts"
          }],
          "warning_logs": [{
            "api_key": "sk-secret",
            "title": "request token=secret-token"
          }]
        }"#;

        let redacted = redact_auditaur_summary(summary);

        assert!(!redacted.contains("secret-token"));
        assert!(!redacted.contains("sk-secret"));
        assert!(!redacted.contains("Users\\\\person"));
        assert!(redacted.contains("<redacted secret>"));
        assert!(redacted.contains("<redacted local path>"));
    }

    #[test]
    fn feedback_system_info_omits_machine_name() {
        let info = FeedbackSystemInfo {
            app_version: "1.0.0".to_string(),
            os: "windows".to_string(),
            os_family: "windows".to_string(),
            arch: "x86_64".to_string(),
        };
        let value = serde_json::to_value(info).unwrap();

        assert!(value.get("machine_name").is_none());
    }

    #[test]
    fn issue_number_from_url_accepts_issue_urls() {
        assert_eq!(
            issue_number_from_url("https://github.com/sethjuarez/cutready/issues/125"),
            Some("125".to_string())
        );
        assert_eq!(
            issue_number_from_url("https://github.com/sethjuarez/cutready/issues/125/"),
            Some("125".to_string())
        );
        assert_eq!(issue_number_from_url("not-a-url"), None);
    }

    #[test]
    fn chunk_text_by_bytes_preserves_utf8_boundaries() {
        let chunks = chunk_text_by_bytes("aé😊b", 3);
        assert_eq!(chunks.concat(), "aé😊b");
        assert!(chunks.iter().all(|chunk| chunk.len() <= 4));
    }

    #[test]
    fn safe_attachment_file_name_removes_path_and_unsafe_chars() {
        assert_eq!(
            safe_attachment_file_name(r"C:\Users\person\Desktop\bad name?.png", "image/png"),
            "bad_name_.png"
        );
        assert_eq!(
            safe_attachment_file_name("../../demo", "image/jpeg"),
            "demo.jpg"
        );
    }

    #[test]
    fn attachment_signature_validation_rejects_mismatched_content() {
        assert!(
            validate_attachment_signature("image/png", b"\x89PNG\r\n\x1a\nmore", "screen.png")
                .is_ok()
        );
        assert!(validate_attachment_signature(
            "image/jpeg",
            &[0xff, 0xd8, 0xff, 0x00],
            "screen.jpg"
        )
        .is_ok());
        assert!(validate_attachment_signature("image/png", b"not a png", "screen.png").is_err());
    }

    #[test]
    fn attachment_persistence_validates_all_files_before_writing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let valid_png = b"\x89PNG\r\n\x1a\nvalid";
        let invalid_png = b"not a png";

        let result = persist_feedback_attachments(
            dir.path(),
            vec![
                FeedbackAttachmentPayload {
                    file_name: "valid.png".to_string(),
                    content_type: "image/png".to_string(),
                    size_bytes: valid_png.len(),
                    data_base64: BASE64_STANDARD.encode(valid_png),
                },
                FeedbackAttachmentPayload {
                    file_name: "invalid.png".to_string(),
                    content_type: "image/png".to_string(),
                    size_bytes: invalid_png.len(),
                    data_base64: BASE64_STANDARD.encode(invalid_png),
                },
            ],
        );

        assert!(result.is_err());
        assert!(!dir.path().join("feedback-attachments").exists());
    }
}
