//! Tauri command for persisting user feedback to the app data directory.

use serde::{Deserialize, Serialize};
use std::{fs, io::Write};
use tauri::Manager;
use tauri_plugin_auditaur::auditaur_command;

use crate::engine::diagnostics_sanitizer::{sanitize_diagnostic_text, sanitize_diagnostic_value};

const GITHUB_COMMENT_CHUNK_BYTES: usize = 52_000;

#[derive(Serialize, Deserialize, Clone)]
pub struct FeedbackEntry {
    pub category: String,
    pub feedback: String,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_log: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_info: Option<FeedbackSystemInfo>,
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
pub fn save_feedback(app: tauri::AppHandle, mut entry: FeedbackEntry) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
    fs::create_dir_all(&data_dir).map_err(|e| format!("Could not create data dir: {e}"))?;

    let path = data_dir.join("feedback.json");
    let mut entries: Vec<FeedbackEntry> = if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_else(|_| "[]".into());
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    if let Some(debug_log) = entry.debug_log.as_mut() {
        *debug_log = redact_auditaur_summary(debug_log);
    }
    entries.push(entry);

    let json =
        serde_json::to_string_pretty(&entries).map_err(|e| format!("Serialization error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Could not write feedback: {e}"))?;

    Ok(())
}

/// Read all feedback entries from `<app_data>/feedback.json`.
#[auditaur_command(skip_all, err)]
pub fn list_feedback(app: tauri::AppHandle) -> Result<Vec<FeedbackEntry>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data dir: {e}"))?;
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
    let path = data_dir.join("feedback.json");
    if path.exists() {
        fs::write(&path, "[]").map_err(|e| format!("Could not clear feedback: {e}"))?;
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
    entries.remove(index);
    let json =
        serde_json::to_string_pretty(&entries).map_err(|e| format!("Serialization error: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("Could not write feedback: {e}"))?;
    Ok(())
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
        chunk_text_by_bytes, is_safe_github_repo, issue_number_from_url, redact_auditaur_summary,
        FeedbackSystemInfo,
    };

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
}
