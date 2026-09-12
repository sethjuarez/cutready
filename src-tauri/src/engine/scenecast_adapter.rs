use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::Context;
use serde::Serialize;

use crate::models::sketch::{DemoStep, PlanningRow, Sketch};

use super::project::safe_resolve;

pub const SCENECAST_BUNDLE_SCHEMA_VERSION: &str = "scenecast.bundle.v1";

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
        .filter(|(_, row)| {
            row.screenshot
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty())
        })
        .collect::<Vec<_>>();

    if rows_with_screenshots.is_empty() {
        anyhow::bail!("Scenecast bundle requires at least one row with a screenshot");
    }

    let mut scenes = Vec::new();
    let mut scene_ids = Vec::new();
    let mut asset_copies = Vec::new();
    let mut diagnostics = Vec::new();

    for (sequence_index, (row_index, row)) in rows_with_screenshots.iter().enumerate() {
        let row_number = row_index + 1;
        let scene_id = row_scene_id(row_number);
        let bundle_screenshot_path =
            bundle_capture_path(row_number, row.screenshot.as_deref().unwrap())?;
        let next_scene_id = rows_with_screenshots
            .get(sequence_index + 1)
            .map(|(next_row_index, _)| row_scene_id(next_row_index + 1));

        asset_copies.push(ScenecastAssetCopy {
            source_project_path: row.screenshot.as_ref().unwrap().clone(),
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

fn build_hotspots(
    row_number: usize,
    row: &PlanningRow,
    _next_scene_id: Option<&str>,
    diagnostics: &mut Vec<ScenecastAdapterDiagnostic>,
) -> Vec<ScenecastHotspot> {
    for step in &row.demo_steps {
        if step_requires_bounds(step) {
            diagnostics.push(ScenecastAdapterDiagnostic {
                severity: ScenecastAdapterSeverity::Warning,
                row_number,
                code: "missing_hotspot_bounds",
                message: "Skipped Scenecast hotspot because CutReady demo_steps do not carry capture-pixel bounds yet.".to_string(),
            });
        }
    }

    Vec::new()
}

fn step_requires_bounds(step: &DemoStep) -> bool {
    matches!(
        step,
        DemoStep::Click { .. } | DemoStep::Select { .. } | DemoStep::Highlight { .. }
    )
}

fn row_scene_id(row_number: usize) -> String {
    format!("row-{row_number:03}")
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
mod tests {
    use chrono::Utc;

    use super::*;
    use crate::models::sketch::{InteractionCapturePolicy, SketchState};

    fn sketch(rows: Vec<PlanningRow>) -> Sketch {
        Sketch {
            title: "Product tour".to_string(),
            description: serde_json::Value::Null,
            rows,
            state: SketchState::Draft,
            metadata: Default::default(),
            locked: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn row(screenshot: &str) -> PlanningRow {
        PlanningRow {
            time: "~10s".to_string(),
            narrative: "Show the dashboard.".to_string(),
            demo_actions: "Click Continue.".to_string(),
            screenshot: Some(screenshot.to_string()),
            ..PlanningRow::new()
        }
    }

    #[test]
    fn builds_portable_bundle_manifest_from_sketch_rows() {
        let mut first = row("screenshots/dashboard.PNG");
        first.demo_steps = vec![DemoStep::Click {
            target: "Continue".to_string(),
            capture: Some(InteractionCapturePolicy::BeforeAfterAndMotion),
        }];
        let build =
            build_scenecast_bundle(&sketch(vec![first, row("screenshots/pricing.png")])).unwrap();

        assert_eq!(
            build.manifest.schema_version,
            SCENECAST_BUNDLE_SCHEMA_VERSION
        );
        assert_eq!(build.manifest.graph.start_scene, "row-001");
        assert_eq!(
            build.manifest.sections[0].scenes,
            vec!["row-001", "row-002"]
        );
        assert_eq!(
            build.manifest.graph.scenes[0].assets.screenshot,
            "captures/row-001.png"
        );
        assert_eq!(build.manifest.graph.scenes[0].title, "Show the dashboard.");
        assert_eq!(
            build.manifest.graph.scenes[1].assets.screenshot,
            "captures/row-002.png"
        );
        assert_eq!(
            build.asset_copies[0],
            ScenecastAssetCopy {
                source_project_path: "screenshots/dashboard.PNG".to_string(),
                bundle_path: "captures/row-001.png".to_string(),
            }
        );
        assert_eq!(build.manifest.graph.scenes[0].hotspots, Vec::new());
        assert_eq!(build.diagnostics.len(), 1);
        assert_eq!(build.diagnostics[0].code, "missing_hotspot_bounds");
    }

    #[test]
    fn warns_when_terminal_row_steps_cannot_become_hotspots() {
        let mut only = row("screenshots/dashboard.png");
        only.demo_steps = vec![DemoStep::Click {
            target: "Continue".to_string(),
            capture: None,
        }];

        let build = build_scenecast_bundle(&sketch(vec![only])).unwrap();

        assert_eq!(build.manifest.graph.scenes[0].hotspots, Vec::new());
        assert_eq!(build.diagnostics.len(), 1);
        assert_eq!(build.diagnostics[0].row_number, 1);
        assert_eq!(build.diagnostics[0].code, "missing_hotspot_bounds");
    }

    #[test]
    fn skips_rows_without_screenshots_until_visual_scenes_are_supported() {
        let build = build_scenecast_bundle(&sketch(vec![
            PlanningRow::new(),
            row(".cutready/screenshots/second.jpg"),
        ]))
        .unwrap();

        assert_eq!(build.manifest.graph.start_scene, "row-002");
        assert_eq!(build.manifest.sections[0].scenes, vec!["row-002"]);
        assert_eq!(build.asset_copies[0].bundle_path, "captures/row-002.jpg");
    }

    #[test]
    fn rejects_sketches_without_screenshot_scenes() {
        let err = build_scenecast_bundle(&sketch(vec![PlanningRow::new()])).unwrap_err();

        assert!(err
            .to_string()
            .contains("at least one row with a screenshot"));
    }

    #[test]
    fn writes_manifest_and_copied_captures_to_bundle_directory() {
        let project = tempfile::tempdir().unwrap();
        let screenshots = project.path().join("screenshots");
        std::fs::create_dir_all(&screenshots).unwrap();
        std::fs::write(screenshots.join("dashboard.png"), b"capture").unwrap();
        let bundle_dir = project
            .path()
            .join(".cutready")
            .join("scenecast")
            .join("demo.scenecast");

        let build = write_scenecast_bundle(
            project.path(),
            &sketch(vec![row("screenshots/dashboard.png")]),
            &bundle_dir,
        )
        .unwrap();

        assert_eq!(build.asset_copies[0].bundle_path, "captures/row-001.png");
        assert_eq!(
            std::fs::read(bundle_dir.join("captures").join("row-001.png")).unwrap(),
            b"capture"
        );
        let manifest = std::fs::read_to_string(bundle_dir.join("manifest.json")).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(manifest["schema_version"], SCENECAST_BUNDLE_SCHEMA_VERSION);
        assert_eq!(manifest["graph"]["start_scene"], "row-001");
    }

    #[test]
    fn writer_rejects_unsafe_or_missing_source_assets() {
        let project = tempfile::tempdir().unwrap();
        let bundle_dir = project.path().join("demo.scenecast");
        let err = write_scenecast_bundle(
            project.path(),
            &sketch(vec![row("../outside.png")]),
            &bundle_dir,
        )
        .unwrap_err();
        assert!(err
            .to_string()
            .contains("Invalid Scenecast source asset path"));
        assert!(!bundle_dir.exists());

        let bundle_dir = project.path().join("missing.scenecast");
        let err = write_scenecast_bundle(
            project.path(),
            &sketch(vec![row("screenshots/missing.png")]),
            &bundle_dir,
        )
        .unwrap_err();
        assert!(err.to_string().contains("does not exist or is not a file"));
        assert!(!bundle_dir.exists());
    }

    #[test]
    fn writer_replaces_stale_bundle_contents() {
        let project = tempfile::tempdir().unwrap();
        let screenshots = project.path().join("screenshots");
        std::fs::create_dir_all(&screenshots).unwrap();
        std::fs::write(screenshots.join("first.png"), b"first").unwrap();
        std::fs::write(screenshots.join("second.jpg"), b"second").unwrap();
        let bundle_dir = project.path().join("demo.scenecast");

        write_scenecast_bundle(
            project.path(),
            &sketch(vec![
                row("screenshots/first.png"),
                row("screenshots/second.jpg"),
            ]),
            &bundle_dir,
        )
        .unwrap();
        assert!(bundle_dir.join("captures").join("row-002.jpg").exists());

        write_scenecast_bundle(
            project.path(),
            &sketch(vec![row("screenshots/first.png")]),
            &bundle_dir,
        )
        .unwrap();

        assert!(bundle_dir.join("captures").join("row-001.png").exists());
        assert!(!bundle_dir.join("captures").join("row-002.jpg").exists());
    }

    #[test]
    fn capture_bundle_paths_use_known_image_extensions_only() {
        assert_eq!(
            bundle_capture_path(1, "screenshots/dashboard.PNG").unwrap(),
            "captures/row-001.png"
        );
        assert_eq!(
            bundle_capture_path(2, "screenshots/dashboard.exe").unwrap(),
            "captures/row-002.png"
        );
        assert_eq!(
            bundle_capture_path(3, "screenshots/dashboard").unwrap(),
            "captures/row-003.png"
        );
        assert!(resolve_bundle_path(Path::new("bundle"), "captures\\row.png").is_err());
        assert!(resolve_bundle_path(Path::new("bundle"), "C:/row.png").is_err());
    }
}
