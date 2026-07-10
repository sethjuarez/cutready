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
    planning_context: Option<video_import::VideoImportPlanningContext>,
    state: State<'_, AppState>,
) -> Result<video_import::VideoImportResult, String> {
    import_video_inner(
        file_path,
        conflict,
        llm_config,
        planning_context,
        None,
        &state,
    )
    .await
}

#[auditaur_command(skip_all, err)]
pub async fn import_video_with_progress(
    file_path: String,
    conflict: Option<String>,
    llm_config: Option<ProviderConfig>,
    planning_context: Option<video_import::VideoImportPlanningContext>,
    on_progress: tauri::ipc::Channel<video_import::VideoImportProgress>,
    state: State<'_, AppState>,
) -> Result<video_import::VideoImportResult, String> {
    import_video_inner(
        file_path,
        conflict,
        llm_config,
        planning_context,
        Some(on_progress),
        &state,
    )
    .await
}

async fn import_video_inner(
    file_path: String,
    conflict: Option<String>,
    llm_config: Option<ProviderConfig>,
    planning_context: Option<video_import::VideoImportPlanningContext>,
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
    let base_slug = if slug.is_empty() {
        "imported-video".to_string()
    } else {
        slug
    };
    let final_paths =
        resolve_video_import_paths(&root, &base_slug, conflict.as_deref().unwrap_or("check"))?;

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
        &final_paths.sketch_path,
        &final_paths.note_path,
        &title,
        llm_options,
        planning_context,
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

#[derive(Debug)]
struct VideoImportPaths {
    sketch_path: String,
    note_path: String,
}

fn resolve_video_import_paths(
    root: &Path,
    base_slug: &str,
    conflict: &str,
) -> Result<VideoImportPaths, String> {
    let natural = import_paths_for_base(base_slug);
    match conflict {
        "overwrite" => Ok(natural),
        "rename" => Ok(find_available_video_import_paths(root, base_slug)),
        _ => {
            let existing = [natural.sketch_path.as_str(), natural.note_path.as_str()]
                .into_iter()
                .filter(|path| root.join(path).exists())
                .collect::<Vec<_>>();
            if existing.is_empty() {
                Ok(natural)
            } else {
                Err(format!("FILE_EXISTS:{}", existing.join(" and ")))
            }
        }
    }
}

fn import_paths_for_base(base_slug: &str) -> VideoImportPaths {
    VideoImportPaths {
        sketch_path: format!("{base_slug}.sk"),
        note_path: format!("{base_slug}-summary.md"),
    }
}

fn find_available_video_import_paths(root: &Path, base_slug: &str) -> VideoImportPaths {
    let natural = import_paths_for_base(base_slug);
    if !root.join(&natural.sketch_path).exists() && !root.join(&natural.note_path).exists() {
        return natural;
    }
    for index in 2..100 {
        let candidate = import_paths_for_base(&format!("{base_slug}-{index}"));
        if !root.join(&candidate.sketch_path).exists() && !root.join(&candidate.note_path).exists()
        {
            return candidate;
        }
    }
    import_paths_for_base(&format!("{base_slug}-{}", chrono::Utc::now().timestamp()))
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
    fn resolve_video_import_paths_checks_sketch_and_note_conflicts() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("demo-summary.md"), "# Existing").unwrap();

        let err = resolve_video_import_paths(root.path(), "demo", "check").unwrap_err();

        assert_eq!(err, "FILE_EXISTS:demo-summary.md");
    }

    #[test]
    fn resolve_video_import_paths_renames_pair_together() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("demo.sk"), "{}").unwrap();
        std::fs::write(root.path().join("demo-2-summary.md"), "# Existing").unwrap();

        let paths = resolve_video_import_paths(root.path(), "demo", "rename").unwrap();

        assert_eq!(paths.sketch_path, "demo-3.sk");
        assert_eq!(paths.note_path, "demo-3-summary.md");
    }
}
