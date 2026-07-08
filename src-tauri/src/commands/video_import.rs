//! Tauri commands for transcript-first video import.

use std::path::Path;

use tauri::State;
use tauri_plugin_auditaur::auditaur_command;

use crate::commands::agent::ProviderConfig;
use crate::engine::agent::llm::LlmConfig;
use crate::engine::video_import;
use crate::AppState;

fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

#[auditaur_command(skip_all, err)]
pub async fn import_video(
    file_path: String,
    conflict: Option<String>,
    llm_config: Option<ProviderConfig>,
    state: State<'_, AppState>,
) -> Result<video_import::VideoImportResult, String> {
    import_video_inner(file_path, conflict, llm_config, None, &state).await
}

#[auditaur_command(skip_all, err)]
pub async fn import_video_with_progress(
    file_path: String,
    conflict: Option<String>,
    llm_config: Option<ProviderConfig>,
    on_progress: tauri::ipc::Channel<video_import::VideoImportProgress>,
    state: State<'_, AppState>,
) -> Result<video_import::VideoImportResult, String> {
    import_video_inner(file_path, conflict, llm_config, Some(on_progress), &state).await
}

async fn import_video_inner(
    file_path: String,
    conflict: Option<String>,
    llm_config: Option<ProviderConfig>,
    on_progress: Option<tauri::ipc::Channel<video_import::VideoImportProgress>>,
    state: &State<'_, AppState>,
) -> Result<video_import::VideoImportResult, String> {
    let root = project_root(state)?;
    let video_path = Path::new(&file_path);
    let title = video_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(humanize_title)
        .unwrap_or_else(|| "Imported Video".to_string());
    let slug = slugify(
        video_path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("imported-video"),
    );
    let natural_path = format!(
        "{}.sk",
        if slug.is_empty() {
            "imported-video".to_string()
        } else {
            slug
        }
    );
    let final_path =
        resolve_import_path(&root, &natural_path, conflict.as_deref().unwrap_or("check"))?;

    let llm_options = llm_config.map(|config| {
        let provider_label = config
            .provider_name
            .clone()
            .unwrap_or(config.provider.clone());
        let model = config.model.clone();
        let reported_context_length = config.context_length;
        let llm_config: LlmConfig = config.into();
        video_import::VideoImportLlmOptions {
            config: llm_config,
            reported_context_length,
            provider_label,
            model,
        }
    });

    let result = video_import::import_video_from_sidecar_with_progress(
        &root,
        video_path,
        &final_path,
        &title,
        llm_options,
        |event| {
            if let Some(channel) = &on_progress {
                if let Err(error) = channel.send(event) {
                    tracing::warn!(
                        target: "cutready::video_import",
                        error = %error,
                        "could not send video import progress"
                    );
                }
            }
        },
    )
    .await;

    if let Err(error) = &result {
        if let Some(channel) = &on_progress {
            let _ = channel.send(video_import::VideoImportProgress {
                phase: "failed".to_string(),
                current: 0,
                total: 1,
                message: error.to_string(),
            });
        }
    }

    result.map_err(|err| err.to_string())
}

fn resolve_import_path(root: &Path, relative_path: &str, conflict: &str) -> Result<String, String> {
    let exists = root.join(relative_path).exists();
    match conflict {
        "overwrite" => Ok(relative_path.to_string()),
        "rename" => Ok(find_available_path(root, relative_path)),
        _ if exists => Err(format!("FILE_EXISTS:{relative_path}")),
        _ => Ok(relative_path.to_string()),
    }
}

fn find_available_path(root: &Path, relative_path: &str) -> String {
    let base = relative_path.trim_end_matches(".sk");
    if !root.join(relative_path).exists() {
        return relative_path.to_string();
    }
    for index in 2..100 {
        let candidate = format!("{base}-{index}.sk");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}.sk", chrono::Utc::now().timestamp())
}

fn slugify(name: &str) -> String {
    name.to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string()
}

fn humanize_title(name: &str) -> String {
    name.replace(['-', '_'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_import_path_reports_existing_file_by_default() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("demo.sk"), "{}").unwrap();

        let err = resolve_import_path(root.path(), "demo.sk", "check").unwrap_err();

        assert_eq!(err, "FILE_EXISTS:demo.sk");
    }

    #[test]
    fn resolve_import_path_can_rename_conflicts() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("demo.sk"), "{}").unwrap();

        let path = resolve_import_path(root.path(), "demo.sk", "rename").unwrap();

        assert_eq!(path, "demo-2.sk");
    }
}
