//! Resolved-demo (Scenecast) loading, validation, and inspection for video export.

use super::*;

#[derive(Debug)]
pub(super) struct LoadedResolvedDemo {
    pub(super) demo: ResolvedDemo,
    pub(super) asset_base_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDemoInspection {
    pub schema_version: String,
    pub title: String,
    pub can_export: bool,
    pub blocking_error: Option<String>,
    pub diagnostic_count: usize,
    pub row_count: usize,
    pub rows: Vec<ResolvedDemoRowInspection>,
    pub diagnostics: Vec<ResolvedDemoDiagnostic>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDemoRowInspection {
    pub row_number: usize,
    pub step_count: usize,
    pub segment_count: usize,
    pub duration_seconds: Option<f64>,
    pub media_asset_count: usize,
    pub missing_asset_count: usize,
    pub invalid_asset_count: usize,
    pub steps: Vec<ResolvedDemoStepInspection>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDemoStepInspection {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub target_labels: Vec<String>,
    pub guide_mark_labels: Vec<String>,
    pub segment_kinds: Vec<String>,
}

pub fn inspect_resolved_demo(
    project_root: &Path,
    path: &str,
    row_count: usize,
    source_row_ids: Option<&[String]>,
) -> anyhow::Result<ResolvedDemoInspection> {
    let path = project::safe_resolve(project_root, path)?;
    let value: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&path)
            .with_context(|| format!("Could not read resolved demo file {}", path.display()))?,
    )
    .with_context(|| format!("Could not parse resolved demo JSON {}", path.display()))?;
    let schema_version = value
        .get("schemaVersion")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow::anyhow!("Resolved demo is missing schemaVersion"))?;
    if schema_version != RESOLVED_DEMO_SCHEMA_VERSION {
        anyhow::bail!(
            "Unsupported resolved demo schemaVersion `{schema_version}`; expected `{RESOLVED_DEMO_SCHEMA_VERSION}`"
        );
    }

    let demo: ResolvedDemo = serde_json::from_value(value)
        .with_context(|| format!("Could not parse resolved demo schema {}", path.display()))?;
    let blocking_error = validate_resolved_demo(&demo, row_count, source_row_ids)
        .err()
        .map(|error| error.to_string());
    let loaded = LoadedResolvedDemo {
        demo: demo.clone(),
        asset_base_dir: path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| project_root.to_path_buf()),
    };
    let rows = (1..=row_count)
        .map(|row_number| inspect_resolved_demo_row(&loaded, row_number))
        .collect();

    Ok(ResolvedDemoInspection {
        schema_version: demo.schema_version,
        title: demo.title,
        can_export: blocking_error.is_none(),
        blocking_error,
        diagnostic_count: demo.diagnostics.len(),
        row_count,
        rows,
        diagnostics: demo.diagnostics,
    })
}

#[cfg(test)]
pub(super) fn load_resolved_demo(
    project_root: &Path,
    relative_path: &str,
    row_count: usize,
) -> anyhow::Result<LoadedResolvedDemo> {
    load_resolved_demo_for_source_rows(project_root, relative_path, row_count, None)
}

pub(super) fn load_resolved_demo_for_sketch(
    project_root: &Path,
    relative_path: &str,
    sketch: &Sketch,
) -> anyhow::Result<LoadedResolvedDemo> {
    let source_row_ids = sketch_source_row_ids(sketch);
    load_resolved_demo_for_source_rows(
        project_root,
        relative_path,
        sketch.rows.len(),
        Some(source_row_ids.as_slice()),
    )
}

pub(super) fn load_resolved_demo_for_source_rows(
    project_root: &Path,
    relative_path: &str,
    row_count: usize,
    source_row_ids: Option<&[String]>,
) -> anyhow::Result<LoadedResolvedDemo> {
    let path = project::safe_resolve(project_root, relative_path)?;
    if !path.is_file() {
        anyhow::bail!("Resolved demo schema file does not exist: {relative_path}");
    }
    let asset_base_dir = path.parent().unwrap_or(project_root).to_path_buf();
    let demo = load_resolved_demo_file(&path, row_count, source_row_ids)?;
    Ok(LoadedResolvedDemo {
        demo,
        asset_base_dir,
    })
}

pub(super) fn load_or_generate_resolved_demo(
    project_root: &Path,
    export_work_dir: &Path,
    sketch_path: &str,
    sketch: &Sketch,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<Option<LoadedResolvedDemo>> {
    if let Some(path) = settings.resolved_demo_path.as_deref() {
        return load_resolved_demo_for_sketch(project_root, path, sketch).map(Some);
    }
    if !settings.generate_resolved_demo {
        return Ok(None);
    }
    let missing_screenshot_rows = rows_missing_screenshots(sketch);
    if !missing_screenshot_rows.is_empty() {
        anyhow::bail!(
            "Generating a Scenecast resolved demo requires every row to have a screenshot; rows {} have none",
            missing_screenshot_rows
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    let sketch_stem = Path::new(sketch_path)
        .file_stem()
        .and_then(OsStr::to_str)
        .map(slugify)
        .unwrap_or_else(|| "sketch".to_string());
    let work_dir = export_work_dir.join(format!(
        "scenecast-{}-{}",
        sketch_stem,
        Utc::now().format("%Y%m%d-%H%M%S-%3f")
    ));
    let bundle_dir = work_dir.join("bundle.scenecast");
    let output_dir = work_dir.join("resolved");

    scenecast_adapter::write_scenecast_bundle(project_root, sketch, &bundle_dir)?;
    let resolved_demo_path =
        scenecast_adapter::export_resolved_demo_with_scenecast_cli(&bundle_dir, &output_dir)?;
    let source_row_ids = sketch_source_row_ids(sketch);
    load_resolved_demo_file(
        &resolved_demo_path,
        sketch.rows.len(),
        Some(source_row_ids.as_slice()),
    )
    .map(|demo| {
        Some(LoadedResolvedDemo {
            demo,
            asset_base_dir: bundle_dir,
        })
    })
}

pub(super) fn rows_missing_screenshots(sketch: &Sketch) -> Vec<usize> {
    sketch
        .rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            row.screenshot
                .as_deref()
                .is_none_or(|path| path.trim().is_empty())
                .then_some(index + 1)
        })
        .collect()
}

pub(super) fn load_resolved_demo_file(
    path: &Path,
    row_count: usize,
    source_row_ids: Option<&[String]>,
) -> anyhow::Result<ResolvedDemo> {
    let value: serde_json::Value = serde_json::from_reader(fs::File::open(path)?)
        .map_err(|error| anyhow::anyhow!("Could not parse resolved demo schema: {error}"))?;
    let schema_version = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Resolved demo schema is missing schemaVersion"))?;
    if schema_version != RESOLVED_DEMO_SCHEMA_VERSION {
        anyhow::bail!(
            "Unsupported resolved demo schemaVersion `{schema_version}`; expected `{RESOLVED_DEMO_SCHEMA_VERSION}`"
        );
    }
    let demo: ResolvedDemo = serde_json::from_value(value)
        .map_err(|error| anyhow::anyhow!("Could not parse resolved demo schema: {error}"))?;
    validate_resolved_demo(&demo, row_count, source_row_ids)?;
    Ok(demo)
}

pub(super) fn validate_resolved_demo(
    demo: &ResolvedDemo,
    row_count: usize,
    source_row_ids: Option<&[String]>,
) -> anyhow::Result<()> {
    match source_row_ids {
        Some(source_row_ids) if source_row_ids.len() == row_count => {
            demo.validate_for_source_rows(source_row_ids)
        }
        _ => demo.validate_for_row_count(row_count),
    }
}

pub(super) fn sketch_source_row_ids(sketch: &Sketch) -> Vec<String> {
    sketch.rows.iter().map(|row| row.id.clone()).collect()
}

pub(super) fn is_missing_resolved_demo_asset_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .to_string()
            .contains("Resolved demo asset does not exist")
    })
}

pub(super) fn inspect_resolved_demo_row(
    loaded: &LoadedResolvedDemo,
    row_number: usize,
) -> ResolvedDemoRowInspection {
    let row_order = row_number.saturating_sub(1) as u32;
    let step_ids = loaded
        .demo
        .steps
        .iter()
        .filter(|step| step.order == row_order)
        .map(|step| step.id.as_str())
        .collect::<HashSet<_>>();
    let steps = loaded
        .demo
        .steps
        .iter()
        .filter(|step| step.order == row_order)
        .map(|step| ResolvedDemoStepInspection {
            id: step.id.clone(),
            title: step.title.clone(),
            description: step.description.clone(),
            target_labels: step
                .targets
                .iter()
                .map(|target| target.label.clone())
                .collect(),
            guide_mark_labels: step
                .guide_marks
                .iter()
                .map(|mark| mark.label.clone())
                .collect(),
            segment_kinds: loaded
                .demo
                .segments
                .iter()
                .filter(|segment| segment.step_id == step.id)
                .map(|segment| segment.kind.clone())
                .collect(),
        })
        .collect::<Vec<_>>();
    let mut media_asset_count = 0usize;
    let mut missing_asset_count = 0usize;
    let mut invalid_asset_count = 0usize;
    let mut segment_count = 0usize;
    for segment in loaded
        .demo
        .segments
        .iter()
        .filter(|segment| step_ids.contains(segment.step_id.as_str()))
    {
        segment_count += 1;
        if segment.frames.is_empty() {
            if let Some(capture) = segment.capture.as_ref() {
                inspect_resolved_demo_asset(
                    &loaded.asset_base_dir,
                    &capture.path,
                    &mut media_asset_count,
                    &mut missing_asset_count,
                    &mut invalid_asset_count,
                );
            }
        } else {
            for frame in &segment.frames {
                inspect_resolved_demo_asset(
                    &loaded.asset_base_dir,
                    &frame.path,
                    &mut media_asset_count,
                    &mut missing_asset_count,
                    &mut invalid_asset_count,
                );
            }
        }
    }

    ResolvedDemoRowInspection {
        row_number,
        step_count: step_ids.len(),
        segment_count,
        duration_seconds: loaded.demo.row_playback_duration_seconds(row_number),
        media_asset_count,
        missing_asset_count,
        invalid_asset_count,
        steps,
    }
}

pub(super) fn inspect_resolved_demo_asset(
    asset_base_dir: &Path,
    asset_path: &str,
    media_asset_count: &mut usize,
    missing_asset_count: &mut usize,
    invalid_asset_count: &mut usize,
) {
    match resolve_resolved_demo_asset_path(asset_base_dir, asset_path) {
        Ok(_) => *media_asset_count += 1,
        Err(error) if is_missing_resolved_demo_asset_error(&error) => *missing_asset_count += 1,
        Err(_) => *invalid_asset_count += 1,
    }
}

pub(super) fn resolved_demo_frame_sequence_for_row(
    loaded: &LoadedResolvedDemo,
    row_number: usize,
    row_duration_seconds: f64,
    fps: u32,
) -> anyhow::Result<Option<FrameSequencePlan>> {
    let row_order = match row_number.checked_sub(1) {
        Some(value) => value as u32,
        None => return Ok(None),
    };
    let row_step_ids = loaded
        .demo
        .steps
        .iter()
        .filter(|step| step.order == row_order)
        .map(|step| step.id.as_str())
        .collect::<HashSet<_>>();
    if row_step_ids.is_empty() {
        return Ok(None);
    }

    let mut row_segments = loaded
        .demo
        .segments
        .iter()
        .filter(|segment| row_step_ids.contains(segment.step_id.as_str()))
        .collect::<Vec<_>>();
    row_segments.sort_by_key(|segment| segment.start_ms);

    let mut entries = Vec::new();
    for segment in row_segments {
        if segment.frames.is_empty() {
            if let Some(capture) = &segment.capture {
                entries.push(FrameManifestEntry {
                    path: resolve_resolved_demo_asset_path(
                        &loaded.asset_base_dir,
                        capture.path.as_str(),
                    )?,
                    duration_ms: segment.duration_ms as i64,
                    terminal: false,
                });
            }
            continue;
        }

        for frame in &segment.frames {
            entries.push(FrameManifestEntry {
                path: resolve_resolved_demo_asset_path(
                    &loaded.asset_base_dir,
                    frame.path.as_str(),
                )?,
                duration_ms: i64::from(frame.duration_ms),
                terminal: false,
            });
        }
    }

    if entries.is_empty() {
        return Ok(None);
    }
    if let Some(last) = entries.last_mut() {
        last.terminal = true;
    }
    Ok(Some(plan_frame_sequence(
        &entries,
        row_duration_seconds,
        fps,
    )?))
}

pub(super) fn resolve_resolved_demo_asset_path(
    asset_base_dir: &Path,
    asset_path: &str,
) -> anyhow::Result<PathBuf> {
    let trimmed = asset_path.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Resolved demo asset path must not be empty");
    }
    let relative = Path::new(trimmed);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        anyhow::bail!("Resolved demo asset path must be bundle-relative: {trimmed}");
    }
    let resolved = asset_base_dir.join(relative);
    if !resolved.is_file() {
        anyhow::bail!("Resolved demo asset does not exist: {trimmed}");
    }
    Ok(resolved)
}
