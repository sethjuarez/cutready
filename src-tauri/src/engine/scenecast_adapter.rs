use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use anyhow::Context;
use serde::Serialize;

use crate::models::resolved_demo::cutready_row_scene_id;
use cutready_core::models::sketch::{DemoStep, PlanningRow, Sketch};

use super::project::safe_resolve;

pub const SCENECAST_BUNDLE_SCHEMA_VERSION: &str = "scenecast.bundle.v1";
const SCENECAST_CLI_ENV: &str = "CUTREADY_SCENECAST_CLI";
const SCENECAST_CLI_NAME: &str = "scenecast-cli";
const RESOLVED_DEMO_FILE: &str = "resolved-demo.json";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenecastBundleBuild {
    pub manifest: ScenecastBundleManifest,
    pub asset_copies: Vec<ScenecastAssetCopy>,
    pub diagnostics: Vec<ScenecastAdapterDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenecastAssetCopy {
    pub source_project_path: String,
    pub bundle_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenecastAdapterDiagnostic {
    pub severity: ScenecastAdapterSeverity,
    pub row_number: usize,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScenecastAdapterSeverity {
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenecastBundleManifest {
    pub schema_version: &'static str,
    pub title: String,
    pub sections: Vec<ScenecastSection>,
    pub graph: ScenecastGraph,
    pub assets: Vec<ScenecastBundleAsset>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScenecastSection {
    pub id: String,
    pub title: String,
    pub scenes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenecastGraph {
    pub start_scene: String,
    pub scenes: Vec<ScenecastScene>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenecastScene {
    pub id: String,
    pub title: String,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub assets: ScenecastSceneAssets,
    pub guide_marks: Vec<ScenecastGuideMark>,
    pub hotspots: Vec<ScenecastHotspot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScenecastSceneAssets {
    pub screenshot: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScenecastGuideMark {}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenecastHotspot {
    pub id: String,
    pub label: String,
    pub target: String,
    pub bounds: ScenecastRect,
    pub trigger: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScenecastRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScenecastBundleAsset {}

pub fn build_scenecast_bundle(sketch: &Sketch) -> anyhow::Result<ScenecastBundleBuild> {
    let rows_with_screenshots = sketch
        .rows
        .iter()
        .enumerate()
        .filter_map(|(row_index, row)| {
            let screenshot = row.screenshot.as_deref()?;
            (!screenshot.trim().is_empty()).then_some((row_index, row, screenshot))
        })
        .collect::<Vec<_>>();

    if rows_with_screenshots.is_empty() {
        anyhow::bail!("Scenecast bundle requires at least one row with a screenshot");
    }

    let mut scenes = Vec::new();
    let mut scene_ids = Vec::new();
    let mut asset_copies = Vec::new();
    let mut diagnostics = Vec::new();

    for (sequence_index, &(row_index, row, screenshot)) in rows_with_screenshots.iter().enumerate()
    {
        let row_number = row_index + 1;
        let scene_id = row_scene_id(row_number, row);
        let bundle_screenshot_path = bundle_capture_path(row_number, screenshot)?;
        let next_scene_id = rows_with_screenshots
            .get(sequence_index + 1)
            .map(|&(next_row_index, next_row, _)| row_scene_id(next_row_index + 1, next_row));

        asset_copies.push(ScenecastAssetCopy {
            source_project_path: screenshot.to_string(),
            bundle_path: bundle_screenshot_path.clone(),
        });
        scene_ids.push(scene_id.clone());
        scenes.push(ScenecastScene {
            id: scene_id,
            title: row_title(row_number, row),
            kind: "screenshot",
            description: non_empty(row.narrative.as_str()),
            notes: non_empty(row.demo_actions.as_str()),
            assets: ScenecastSceneAssets {
                screenshot: bundle_screenshot_path,
            },
            guide_marks: Vec::new(),
            hotspots: build_hotspots(row_number, row, next_scene_id.as_deref(), &mut diagnostics),
        });
    }

    let start_scene = scene_ids
        .first()
        .cloned()
        .context("Scenecast bundle requires a start scene")?;

    Ok(ScenecastBundleBuild {
        manifest: ScenecastBundleManifest {
            schema_version: SCENECAST_BUNDLE_SCHEMA_VERSION,
            title: non_empty(sketch.title.as_str()).unwrap_or_else(|| "Untitled demo".to_string()),
            sections: vec![ScenecastSection {
                id: "main".to_string(),
                title: "Main".to_string(),
                scenes: scene_ids,
            }],
            graph: ScenecastGraph {
                start_scene,
                scenes,
            },
            assets: Vec::new(),
        },
        asset_copies,
        diagnostics,
    })
}

pub fn write_scenecast_bundle(
    project_root: &Path,
    sketch: &Sketch,
    bundle_dir: &Path,
) -> anyhow::Result<ScenecastBundleBuild> {
    let build = build_scenecast_bundle(sketch)?;
    let temp_dir = temporary_bundle_dir(bundle_dir)?;
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir).with_context(|| {
            format!(
                "Failed to remove stale temporary Scenecast bundle directory `{}`",
                temp_dir.display()
            )
        })?;
    }

    let result = write_scenecast_bundle_to(project_root, bundle_dir, &temp_dir, build);
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp_dir);
    }
    result
}

pub fn export_resolved_demo_with_scenecast_cli(
    bundle_dir: &Path,
    output_dir: &Path,
) -> anyhow::Result<PathBuf> {
    export_resolved_demo_with_scenecast_cli_path(resolve_scenecast_cli()?, bundle_dir, output_dir)
}

pub fn resolve_scenecast_cli() -> anyhow::Result<PathBuf> {
    if let Some(explicit) = env::var_os(SCENECAST_CLI_ENV).filter(|value| !value.is_empty()) {
        let explicit = PathBuf::from(explicit);
        if explicit.is_file() {
            return Ok(explicit);
        }
        anyhow::bail!(
            "{SCENECAST_CLI_ENV} points at `{}` which does not exist or is not a file",
            explicit.display()
        );
    }

    let candidates = scenecast_cli_candidates();
    candidates
        .iter()
        .find(|candidate| command_exists(candidate))
        .cloned()
        .with_context(|| {
            let searched = candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "Scenecast CLI was not found. Set {SCENECAST_CLI_ENV} or add {SCENECAST_CLI_NAME} to PATH. Searched: {searched}"
            )
        })
}

fn export_resolved_demo_with_scenecast_cli_path(
    cli_path: PathBuf,
    bundle_dir: &Path,
    output_dir: &Path,
) -> anyhow::Result<PathBuf> {
    fs::create_dir_all(output_dir).with_context(|| {
        format!(
            "Failed to create Scenecast resolved-demo output directory `{}`",
            output_dir.display()
        )
    })?;

    let output = command_for_path(cli_path.clone())
        .arg("export-resolved-demo")
        .arg(bundle_dir)
        .arg(output_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("Failed to start Scenecast CLI `{}`", cli_path.display()))?;

    if !output.status.success() {
        anyhow::bail!(
            "Scenecast CLI failed with status {}: {}",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "terminated by signal".to_string()),
            command_output_excerpt(&output.stderr, &output.stdout)
        );
    }

    let resolved_demo_path = output_dir.join(RESOLVED_DEMO_FILE);
    if !resolved_demo_path.is_file() {
        anyhow::bail!(
            "Scenecast CLI completed but did not write `{}`",
            resolved_demo_path.display()
        );
    }

    Ok(resolved_demo_path)
}

fn write_scenecast_bundle_to(
    project_root: &Path,
    bundle_dir: &Path,
    temp_dir: &Path,
    build: ScenecastBundleBuild,
) -> anyhow::Result<ScenecastBundleBuild> {
    fs::create_dir_all(temp_dir).with_context(|| {
        format!(
            "Failed to create Scenecast bundle directory `{}`",
            temp_dir.display()
        )
    })?;

    for asset in &build.asset_copies {
        let source = safe_resolve(project_root, &asset.source_project_path).with_context(|| {
            format!(
                "Invalid Scenecast source asset path `{}`",
                asset.source_project_path
            )
        })?;
        if !source.is_file() {
            anyhow::bail!(
                "Scenecast source asset `{}` does not exist or is not a file",
                asset.source_project_path
            );
        }
        let destination = resolve_bundle_path(temp_dir, &asset.bundle_path)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "Failed to create Scenecast asset directory `{}`",
                    parent.display()
                )
            })?;
        }
        fs::copy(&source, &destination).with_context(|| {
            format!(
                "Failed to copy Scenecast asset `{}` to `{}`",
                source.display(),
                destination.display()
            )
        })?;
    }

    let manifest_path = temp_dir.join("manifest.json");
    let manifest_json = serde_json::to_string_pretty(&build.manifest).with_context(|| {
        format!(
            "Failed to serialize Scenecast manifest for `{}`",
            bundle_dir.display()
        )
    })?;
    fs::write(&manifest_path, manifest_json).with_context(|| {
        format!(
            "Failed to write Scenecast manifest `{}`",
            manifest_path.display()
        )
    })?;

    if bundle_dir.exists() {
        fs::remove_dir_all(bundle_dir).with_context(|| {
            format!(
                "Failed to replace existing Scenecast bundle directory `{}`",
                bundle_dir.display()
            )
        })?;
    }
    fs::rename(temp_dir, bundle_dir).with_context(|| {
        format!(
            "Failed to move Scenecast bundle `{}` to `{}`",
            temp_dir.display(),
            bundle_dir.display()
        )
    })?;

    Ok(build)
}

fn temporary_bundle_dir(bundle_dir: &Path) -> anyhow::Result<PathBuf> {
    let parent = bundle_dir.parent().unwrap_or_else(|| Path::new("."));
    let name = bundle_dir
        .file_name()
        .and_then(|name| name.to_str())
        .context("Scenecast bundle directory must have a valid file name")?;
    Ok(parent.join(format!(".{name}.tmp-{}", std::process::id())))
}

fn scenecast_cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            candidates.extend(executable_candidates_in_dir(&dir, SCENECAST_CLI_NAME));
        }
    }
    candidates.push(PathBuf::from(SCENECAST_CLI_NAME));
    dedupe_paths(candidates)
}

fn executable_candidates_in_dir(dir: &Path, executable_name: &str) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        vec![
            dir.join(format!("{executable_name}.exe")),
            dir.join(format!("{executable_name}.cmd")),
            dir.join(executable_name),
        ]
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![dir.join(executable_name)]
    }
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn command_exists(candidate: &Path) -> bool {
    if !candidate.is_file() {
        return false;
    }
    command_for_path(candidate.to_path_buf())
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn command_for_path(program: PathBuf) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn command_output_excerpt(stderr: &[u8], stdout: &[u8]) -> String {
    let raw = if stderr.is_empty() { stdout } else { stderr };
    let text = String::from_utf8_lossy(raw);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "<no output>".to_string();
    }
    const MAX_OUTPUT_CHARS: usize = 800;
    trimmed.chars().take(MAX_OUTPUT_CHARS).collect()
}

fn build_hotspots(
    row_number: usize,
    row: &PlanningRow,
    next_scene_id: Option<&str>,
    diagnostics: &mut Vec<ScenecastAdapterDiagnostic>,
) -> Vec<ScenecastHotspot> {
    let mut hotspots = Vec::new();
    for (step_index, step) in row.demo_steps.iter().enumerate() {
        let Some((label, rect)) = step_hotspot_target(step) else {
            if step_requires_bounds(step) {
                diagnostics.push(ScenecastAdapterDiagnostic {
                    severity: ScenecastAdapterSeverity::Warning,
                    row_number,
                    code: "missing_hotspot_bounds",
                    message: "Skipped Scenecast hotspot because CutReady demo_steps do not carry target_bounds geometry yet.".to_string(),
                });
            }
            continue;
        };

        let Some(next_scene_id) = next_scene_id else {
            diagnostics.push(ScenecastAdapterDiagnostic {
                severity: ScenecastAdapterSeverity::Warning,
                row_number,
                code: "missing_hotspot_target",
                message: "Skipped Scenecast hotspot because the row has no following screenshot scene target.".to_string(),
            });
            continue;
        };

        if !is_valid_hotspot_bounds(rect) {
            diagnostics.push(ScenecastAdapterDiagnostic {
                severity: ScenecastAdapterSeverity::Warning,
                row_number,
                code: "invalid_hotspot_bounds",
                message: "Skipped Scenecast hotspot because demo_steps target_bounds must use finite screenshot-pixel bounds with positive size.".to_string(),
            });
            continue;
        }

        hotspots.push(ScenecastHotspot {
            id: format!("row-{row_number:03}-step-{:03}", step_index + 1),
            label: label.to_string(),
            target: next_scene_id.to_string(),
            bounds: ScenecastRect {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            },
            trigger: "click",
        });
    }

    hotspots
}

fn step_requires_bounds(step: &DemoStep) -> bool {
    matches!(
        step,
        DemoStep::Click { .. } | DemoStep::Select { .. } | DemoStep::Highlight { .. }
    )
}

fn step_hotspot_target(
    step: &DemoStep,
) -> Option<(&str, &cutready_core::models::sketch::InteractionBounds)> {
    match step {
        DemoStep::Click {
            target,
            target_bounds: Some(rect),
            ..
        }
        | DemoStep::Select {
            target,
            target_bounds: Some(rect),
            ..
        }
        | DemoStep::Highlight {
            target,
            target_bounds: Some(rect),
        } => Some((target.as_str(), rect)),
        _ => None,
    }
}

fn is_valid_hotspot_bounds(rect: &cutready_core::models::sketch::InteractionBounds) -> bool {
    rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.x >= 0.0
        && rect.y >= 0.0
        && rect.width > 0.0
        && rect.height > 0.0
}

fn row_scene_id(row_number: usize, row: &PlanningRow) -> String {
    if row.id.trim().is_empty() {
        format!("row-{row_number:03}")
    } else {
        cutready_row_scene_id(&row.id)
    }
}

fn row_title(row_number: usize, row: &PlanningRow) -> String {
    non_empty(row.narrative.as_str()).unwrap_or_else(|| format!("Row {row_number}"))
}

fn bundle_capture_path(row_number: usize, source_path: &str) -> anyhow::Result<String> {
    let extension = Path::new(source_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.trim().to_ascii_lowercase())
        .filter(|extension| matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif"))
        .unwrap_or_else(|| "png".to_string());
    Ok(format!("captures/row-{row_number:03}.{extension}"))
}

fn resolve_bundle_path(bundle_dir: &Path, relative_path: &str) -> anyhow::Result<PathBuf> {
    let rel = Path::new(relative_path);
    if relative_path.contains('\\')
        || rel.is_absolute()
        || relative_path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "..")
    {
        anyhow::bail!("Scenecast bundle path `{relative_path}` must be portable and relative");
    }
    for component in rel.components() {
        match component {
            std::path::Component::Normal(segment) if !segment.to_string_lossy().contains(':') => {}
            _ => {
                anyhow::bail!(
                    "Scenecast bundle path `{relative_path}` must be portable and relative"
                );
            }
        }
    }
    Ok(bundle_dir.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR)))
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
#[path = "scenecast_adapter_tests.rs"]
mod tests;
