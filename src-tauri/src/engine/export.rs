//! Export engine — rendered media and output folder assembly.

use std::{
    collections::HashSet,
    ffi::OsStr,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
};

use anyhow::Context;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    engine::{
        animation, ffmpeg,
        frame_sequence::{
            plan_frame_sequence, FrameManifestEntry, FrameSequenceFit, FrameSequencePlan,
        },
        narration_preview, project, scenecast_adapter,
    },
    models::{
        resolved_demo::{ResolvedDemo, ResolvedDemoDiagnostic, RESOLVED_DEMO_SCHEMA_VERSION},
        sketch::{MotionPlan, MotionPlanKeyframe, Sketch, TypingSpot},
    },
};

const EXPORTS_DIR: &str = "exports";
const TEMP_DIR: &str = ".cutready/exports/tmp";
const BACKGROUND_MUSIC_DIR: &str = "background-music";
const BACKGROUND_MUSIC_PREVIEW_MIN_SECONDS: f64 = 10.0;
const BACKGROUND_MUSIC_PREVIEW_MAX_SECONDS: f64 = 20.0;
const DEFAULT_VIDEO_WIDTH: u32 = 1920;
const DEFAULT_VIDEO_HEIGHT: u32 = 1080;
const DEFAULT_VIDEO_FPS: u32 = 30;
const MIN_ROW_DURATION_SECONDS: f64 = 0.1;
const DEFAULT_TITLE_CARD_DURATION_SECONDS: f64 = 3.0;
const DEFAULT_TITLE_TO_FIRST_ROW_HOLD_DURATION_SECONDS: f64 = 0.5;
const DEFAULT_ROW_TRANSITION_HOLD_SECONDS: f64 = 1.0;
const DEFAULT_FINAL_HOLD_DURATION_SECONDS: f64 = 3.0;
const DEFAULT_NARRATION_TAIL_HOLD_SECONDS: f64 = 0.35;
const DEFAULT_ROW_TRANSITION_DIP_SECONDS: f64 = 0.35;
const DEFAULT_MOTION_MAX_SCALE: f64 = 1.65;
const DEFAULT_BACKGROUND_MUSIC_VOLUME_DB: f64 = -24.0;
const DEFAULT_BACKGROUND_MUSIC_FADE_SECONDS: f64 = 0.5;
const DEFAULT_VIDEO_ENCODER: &str = "libx264rgb";
const DEFAULT_VIDEO_PIXEL_FORMAT: &str = "rgb24";
const DEFAULT_VIDEO_CRF: &str = "0";
const TYPING_TEXT_PADDING_X: f64 = 12.0;
const TYPING_TEXT_PADDING_Y: f64 = 8.0;
const MAX_TYPING_ANIMATION_CHARACTERS: usize = 160;
const FFMPEG_FILTER_SCRIPT_THRESHOLD_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct SketchVideoExport {
    pub path: String,
    pub duration_seconds: f64,
    pub row_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SketchVideoExportProgress {
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundMusicTrack {
    pub id: String,
    pub name: String,
    pub path: String,
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundMusicPreviewSettings {
    pub background_music_path: String,
    pub narration_voice_name: String,
    pub narration_voice_output_format: String,
    #[serde(default = "default_background_music_volume_db")]
    pub background_music_volume_db: f64,
    #[serde(default = "default_background_music_duck_narration")]
    pub background_music_duck_narration: bool,
    #[serde(default = "default_background_music_fade_seconds")]
    pub background_music_fade_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundMusicPreview {
    pub path: String,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchVideoExportSettings {
    #[serde(default = "default_include_title_card")]
    pub include_title_card: bool,
    #[serde(default = "default_title_card_duration_seconds")]
    pub title_card_duration_seconds: f64,
    #[serde(default = "default_title_to_first_row_hold_seconds")]
    pub title_to_first_row_hold_seconds: f64,
    #[serde(default = "default_row_transition_hold_seconds")]
    pub row_transition_hold_seconds: f64,
    #[serde(default = "default_final_hold_seconds")]
    pub final_hold_seconds: f64,
    #[serde(default = "default_row_transition_dip_seconds")]
    pub row_transition_dip_seconds: f64,
    #[serde(default = "default_narration_tail_hold_seconds")]
    pub narration_tail_hold_seconds: f64,
    #[serde(default)]
    pub resolved_demo_path: Option<String>,
    #[serde(default)]
    pub generate_resolved_demo: bool,
    #[serde(default)]
    pub visual_frame_manifest_paths: Vec<Option<String>>,
    #[serde(default = "default_motion_max_scale")]
    pub motion_max_scale: f64,
    #[serde(default = "default_video_width")]
    pub video_width: u32,
    #[serde(default = "default_video_height")]
    pub video_height: u32,
    #[serde(default = "default_video_fps")]
    pub video_fps: u32,
    #[serde(default = "default_video_encoder")]
    pub video_encoder: String,
    #[serde(default = "default_video_pixel_format")]
    pub video_pixel_format: String,
    #[serde(default = "default_video_crf")]
    pub video_crf: String,
    #[serde(default)]
    pub background_music_path: Option<String>,
    #[serde(default = "default_background_music_volume_db")]
    pub background_music_volume_db: f64,
    #[serde(default = "default_background_music_duck_narration")]
    pub background_music_duck_narration: bool,
    #[serde(default = "default_background_music_fade_seconds")]
    pub background_music_fade_seconds: f64,
}

impl Default for SketchVideoExportSettings {
    fn default() -> Self {
        Self {
            include_title_card: true,
            title_card_duration_seconds: DEFAULT_TITLE_CARD_DURATION_SECONDS,
            title_to_first_row_hold_seconds: DEFAULT_TITLE_TO_FIRST_ROW_HOLD_DURATION_SECONDS,
            row_transition_hold_seconds: DEFAULT_ROW_TRANSITION_HOLD_SECONDS,
            final_hold_seconds: DEFAULT_FINAL_HOLD_DURATION_SECONDS,
            row_transition_dip_seconds: DEFAULT_ROW_TRANSITION_DIP_SECONDS,
            narration_tail_hold_seconds: DEFAULT_NARRATION_TAIL_HOLD_SECONDS,
            resolved_demo_path: None,
            generate_resolved_demo: false,
            visual_frame_manifest_paths: Vec::new(),
            motion_max_scale: DEFAULT_MOTION_MAX_SCALE,
            video_width: DEFAULT_VIDEO_WIDTH,
            video_height: DEFAULT_VIDEO_HEIGHT,
            video_fps: DEFAULT_VIDEO_FPS,
            video_encoder: DEFAULT_VIDEO_ENCODER.to_string(),
            video_pixel_format: DEFAULT_VIDEO_PIXEL_FORMAT.to_string(),
            video_crf: DEFAULT_VIDEO_CRF.to_string(),
            background_music_path: None,
            background_music_volume_db: DEFAULT_BACKGROUND_MUSIC_VOLUME_DB,
            background_music_duck_narration: true,
            background_music_fade_seconds: DEFAULT_BACKGROUND_MUSIC_FADE_SECONDS,
        }
    }
}

impl SketchVideoExportSettings {
    fn normalized(&self) -> Self {
        Self {
            include_title_card: self.include_title_card,
            title_card_duration_seconds: sanitize_duration(
                self.title_card_duration_seconds,
                DEFAULT_TITLE_CARD_DURATION_SECONDS,
            ),
            title_to_first_row_hold_seconds: sanitize_duration(
                self.title_to_first_row_hold_seconds,
                DEFAULT_TITLE_TO_FIRST_ROW_HOLD_DURATION_SECONDS,
            ),
            row_transition_hold_seconds: sanitize_duration(
                self.row_transition_hold_seconds,
                DEFAULT_ROW_TRANSITION_HOLD_SECONDS,
            ),
            final_hold_seconds: sanitize_duration(
                self.final_hold_seconds,
                DEFAULT_FINAL_HOLD_DURATION_SECONDS,
            ),
            row_transition_dip_seconds: sanitize_non_negative_duration(
                self.row_transition_dip_seconds,
                DEFAULT_ROW_TRANSITION_DIP_SECONDS,
            ),
            narration_tail_hold_seconds: sanitize_non_negative_duration(
                self.narration_tail_hold_seconds,
                DEFAULT_NARRATION_TAIL_HOLD_SECONDS,
            ),
            resolved_demo_path: self
                .resolved_demo_path
                .as_ref()
                .map(|path| path.trim().to_string())
                .filter(|path| !path.is_empty()),
            generate_resolved_demo: self.generate_resolved_demo,
            visual_frame_manifest_paths: self
                .visual_frame_manifest_paths
                .iter()
                .map(|path| {
                    path.as_ref()
                        .map(|path| path.trim().to_string())
                        .filter(|path| !path.is_empty())
                })
                .collect(),
            motion_max_scale: sanitize_motion_max_scale(self.motion_max_scale),
            video_width: sanitize_video_dimension(self.video_width, DEFAULT_VIDEO_WIDTH),
            video_height: sanitize_video_dimension(self.video_height, DEFAULT_VIDEO_HEIGHT),
            video_fps: sanitize_video_fps(self.video_fps),
            video_encoder: sanitize_ffmpeg_token(&self.video_encoder, DEFAULT_VIDEO_ENCODER),
            video_pixel_format: sanitize_ffmpeg_token(
                &self.video_pixel_format,
                DEFAULT_VIDEO_PIXEL_FORMAT,
            ),
            video_crf: sanitize_ffmpeg_token(&self.video_crf, DEFAULT_VIDEO_CRF),
            background_music_path: self
                .background_music_path
                .as_ref()
                .map(|path| path.trim().to_string())
                .filter(|path| !path.is_empty()),
            background_music_volume_db: sanitize_background_music_volume_db(
                self.background_music_volume_db,
            ),
            background_music_duck_narration: self.background_music_duck_narration,
            background_music_fade_seconds: sanitize_non_negative_duration(
                self.background_music_fade_seconds,
                DEFAULT_BACKGROUND_MUSIC_FADE_SECONDS,
            ),
        }
    }
}

struct RowSegment {
    row_number: usize,
    image_path: PathBuf,
    narration_path: PathBuf,
    audio_start_seconds: f64,
    audio_duration_seconds: f64,
    duration_seconds: f64,
    frame_sequence: Option<FrameSequencePlan>,
    motion_plan: Option<MotionPlan>,
    typing_spots: Vec<TypingSpot>,
}

#[derive(Debug)]
struct LoadedResolvedDemo {
    demo: ResolvedDemo,
    asset_base_dir: PathBuf,
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
}

/// Planned timeline buckets before ffmpeg frame quantization and media probing.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ExportTimelineTiming {
    title_card_seconds: f64,
    lead_in_seconds: f64,
    row_content_seconds: f64,
    interior_transition_seconds: f64,
    final_hold_seconds: f64,
}

impl ExportTimelineTiming {
    fn total_seconds(self) -> f64 {
        self.title_card_seconds
            + self.lead_in_seconds
            + self.row_content_seconds
            + self.interior_transition_seconds
            + self.final_hold_seconds
    }
}

#[allow(dead_code)]
pub fn export_sketch_video(
    project_root: &Path,
    sketch_path: &str,
    output_path: Option<&Path>,
) -> anyhow::Result<SketchVideoExport> {
    export_sketch_video_with_progress(
        project_root,
        project_root,
        sketch_path,
        output_path,
        SketchVideoExportSettings::default(),
        |_| {},
    )
}

pub fn import_background_music(
    app_data_dir: &Path,
    source_path: impl AsRef<Path>,
) -> anyhow::Result<BackgroundMusicTrack> {
    let source_path = source_path.as_ref();
    if !source_path.is_absolute() {
        anyhow::bail!("Background music source path must be absolute");
    }
    if source_path
        .extension()
        .and_then(OsStr::to_str)
        .map(|extension| !extension.eq_ignore_ascii_case("wav"))
        .unwrap_or(true)
    {
        anyhow::bail!("Background music must be a WAV file");
    }

    let mut file = fs::File::open(source_path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;
    if data.is_empty() {
        anyhow::bail!("Background music file is empty");
    }

    let hash = Sha256::digest(&data);
    let id = format!("{hash:x}")[..12].to_string();
    let stem = source_path
        .file_stem()
        .and_then(OsStr::to_str)
        .map(slugify)
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "background-music".to_string());
    let relative_path = format!("{BACKGROUND_MUSIC_DIR}/{stem}-{id}.wav");
    let destination = project::safe_resolve(app_data_dir, &relative_path)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&destination, data)?;

    let duration_seconds = probe_media_duration_seconds(&destination).ok();
    Ok(BackgroundMusicTrack {
        id,
        name: source_path
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or("Background music")
            .to_string(),
        path: relative_path,
        duration_seconds,
    })
}

pub fn delete_background_music(app_data_dir: &Path, relative_path: &str) -> anyhow::Result<()> {
    let path = resolve_background_music_path(app_data_dir, relative_path)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn resolve_background_music_path(
    app_data_dir: &Path,
    relative_path: &str,
) -> anyhow::Result<PathBuf> {
    if !relative_path
        .strip_prefix(BACKGROUND_MUSIC_DIR)
        .is_some_and(|suffix| suffix.starts_with('/'))
    {
        anyhow::bail!("Background music path must be under {BACKGROUND_MUSIC_DIR}");
    }
    if relative_path
        .rsplit_once('.')
        .map(|(_, extension)| !extension.eq_ignore_ascii_case("wav"))
        .unwrap_or(true)
    {
        anyhow::bail!("Background music path must point to a WAV file");
    }
    Ok(project::safe_resolve(app_data_dir, relative_path)?)
}

pub fn render_background_music_preview(
    app_data_dir: &Path,
    settings: BackgroundMusicPreviewSettings,
) -> anyhow::Result<BackgroundMusicPreview> {
    ensure_ffmpeg_available()?;
    let music_path = resolve_background_music_path(app_data_dir, &settings.background_music_path)?;
    if !music_path.is_file() {
        anyhow::bail!("Background music file was not found");
    }
    let narration_path = resolve_preview_narration_path(app_data_dir, &settings)?;
    let narration_duration = Some(probe_media_duration_seconds(&narration_path)?);
    let music_duration = probe_media_duration_seconds(&music_path).ok();
    let duration_seconds = background_music_preview_duration(narration_duration, music_duration);
    let work_relative = format!(
        "{BACKGROUND_MUSIC_DIR}/previews/music-preview-{}.wav",
        Utc::now().format("%Y%m%d-%H%M%S-%3f")
    );
    let output_path = project::safe_resolve(app_data_dir, &work_relative)?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let preview_settings = SketchVideoExportSettings {
        background_music_volume_db: sanitize_background_music_volume_db(
            settings.background_music_volume_db,
        ),
        background_music_duck_narration: settings.background_music_duck_narration,
        background_music_fade_seconds: sanitize_non_negative_duration(
            settings.background_music_fade_seconds,
            DEFAULT_BACKGROUND_MUSIC_FADE_SECONDS,
        ),
        ..SketchVideoExportSettings::default()
    };
    render_background_music_preview_audio(
        Some(&narration_path),
        &music_path,
        &output_path,
        duration_seconds,
        &preview_settings,
    )?;

    Ok(BackgroundMusicPreview {
        path: output_path.to_string_lossy().to_string(),
        duration_seconds,
    })
}

pub fn inspect_resolved_demo(
    project_root: &Path,
    path: &str,
    row_count: usize,
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
    let blocking_error = demo
        .validate_for_row_count(row_count)
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

fn resolve_preview_narration_path(
    app_data_dir: &Path,
    settings: &BackgroundMusicPreviewSettings,
) -> anyhow::Result<PathBuf> {
    narration_preview::cached_voice_preview(
        app_data_dir,
        &settings.narration_voice_name,
        &settings.narration_voice_output_format,
    )?
    .map(PathBuf::from)
    .ok_or_else(|| {
        anyhow::anyhow!(
            "Generate a voice sample for the selected narration voice before previewing the mix"
        )
    })
}

pub fn export_sketch_video_with_progress<F>(
    project_root: &Path,
    app_data_dir: &Path,
    sketch_path: &str,
    output_path: Option<&Path>,
    settings: SketchVideoExportSettings,
    mut on_progress: F,
) -> anyhow::Result<SketchVideoExport>
where
    F: FnMut(SketchVideoExportProgress),
{
    let settings = settings.normalized();
    emit_progress(
        &mut on_progress,
        "preparing",
        0,
        1,
        "Preparing sketch video export",
    );
    let sketch_abs = project::safe_resolve(project_root, sketch_path)?;
    let sketch = project::read_sketch(&sketch_abs)?;
    let output_path = resolve_export_output_path(project_root, &sketch, output_path)?;
    let output_dir = output_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Export output path has no parent directory"))?;
    fs::create_dir_all(output_dir)?;

    let work_relative = format!("{TEMP_DIR}/{}", Utc::now().format("%Y%m%d-%H%M%S-%3f"));
    let work_dir = project::safe_resolve(project_root, &work_relative)?;
    fs::create_dir_all(&work_dir)?;

    let result = (|| {
        ensure_ffmpeg_available()?;
        let segments =
            collect_row_segments(project_root, &work_dir, sketch_path, &sketch, &settings)?;

        let gap_count = segments.len().saturating_sub(1);
        let title_step_count = usize::from(settings.include_title_card);
        let background_music_step_count = usize::from(settings.background_music_path.is_some());
        let total_steps =
            title_step_count + 1 + segments.len() + gap_count + 1 + 1 + background_music_step_count;
        let timeline_timing = export_timeline_timing(&segments, &settings);
        let duration_seconds = timeline_timing.total_seconds();
        let mut segment_files = Vec::with_capacity(segments.len() + (gap_count * 2) + 3);
        let mut current_step = 0;
        if settings.include_title_card {
            current_step += 1;
            let title_card_output = work_dir.join("title-card.mp4");
            emit_progress(
                &mut on_progress,
                "title",
                current_step,
                total_steps,
                "Rendering sketch title card",
            );
            render_title_card(
                &sketch,
                settings.title_card_duration_seconds,
                &title_card_output,
                &settings,
            )?;
            segment_files.push(title_card_output);
        }
        let first_segment = segments
            .first()
            .ok_or_else(|| anyhow::anyhow!("Sketch has no rows to export"))?;
        current_step += 1;
        emit_progress(
            &mut on_progress,
            "lead-in",
            current_step,
            total_steps,
            format!(
                "Holding the first screen for {} seconds",
                format_seconds(settings.title_to_first_row_hold_seconds)
            ),
        );
        let title_lead_in_output = work_dir.join("title-to-first-row-hold.mp4");
        render_image_hold_segment(
            &first_segment.image_path,
            settings.title_to_first_row_hold_seconds,
            &title_lead_in_output,
            &settings,
        )?;
        segment_files.push(title_lead_in_output);

        for (index, segment) in segments.iter().enumerate() {
            current_step += 1;
            emit_progress(
                &mut on_progress,
                "row",
                current_step,
                total_steps,
                format!("Rendering row {} of {}", segment.row_number, segments.len()),
            );
            let segment_output = work_dir.join(format!("row-{:03}.mp4", segment.row_number));
            render_segment(segment, &segment_output, &work_dir, &settings)?;
            segment_files.push(segment_output);
            if index + 1 < segments.len() {
                let next_segment = &segments[index + 1];
                current_step += 1;
                emit_progress(
                    &mut on_progress,
                    "gap",
                    current_step,
                    total_steps,
                    format!(
                        "Holding row {} for {}s, then row {} for {}s",
                        segment.row_number,
                        format_seconds(settings.row_transition_hold_seconds / 2.0),
                        next_segment.row_number,
                        format_seconds(settings.row_transition_hold_seconds / 2.0)
                    ),
                );
                let outgoing_gap_output =
                    work_dir.join(format!("gap-after-row-{:03}-out.mp4", segment.row_number));
                render_segment_hold(
                    segment,
                    settings.row_transition_hold_seconds / 2.0,
                    &outgoing_gap_output,
                    true,
                    HoldTransition::FadeOutToBlack,
                    &settings,
                )?;
                segment_files.push(outgoing_gap_output);

                let incoming_gap_output = work_dir.join(format!(
                    "gap-before-row-{:03}-in.mp4",
                    next_segment.row_number
                ));
                render_segment_hold(
                    next_segment,
                    settings.row_transition_hold_seconds / 2.0,
                    &incoming_gap_output,
                    false,
                    HoldTransition::FadeInFromBlack,
                    &settings,
                )?;
                segment_files.push(incoming_gap_output);
            }
        }
        current_step += 1;
        emit_progress(
            &mut on_progress,
            "hold",
            current_step,
            total_steps,
            format!(
                "Holding the final screen for {} seconds",
                format_seconds(settings.final_hold_seconds)
            ),
        );
        let final_segment = segments
            .last()
            .ok_or_else(|| anyhow::anyhow!("Sketch has no rows to export"))?;
        let final_hold_output = work_dir.join("final-hold.mp4");
        render_segment_hold(
            final_segment,
            settings.final_hold_seconds,
            &final_hold_output,
            true,
            HoldTransition::None,
            &settings,
        )?;
        segment_files.push(final_hold_output);

        current_step += 1;
        emit_progress(
            &mut on_progress,
            "assembling",
            current_step,
            total_steps,
            "Assembling the MP4",
        );
        concatenate_segments(
            app_data_dir,
            &work_dir,
            &segment_files,
            &output_path,
            duration_seconds,
            &settings,
        )?;
        if settings.background_music_path.is_some() {
            current_step += 1;
            emit_progress(
                &mut on_progress,
                "music",
                current_step,
                total_steps,
                "Mixing background music",
            );
        }
        Ok::<_, anyhow::Error>((segments.len(), duration_seconds, total_steps))
    })();

    if let Err(cleanup_error) = fs::remove_dir_all(&work_dir) {
        tracing::warn!(
            target: "cutready::export",
            path = %work_dir.display(),
            error = %cleanup_error,
            "could not remove temporary sketch video export directory"
        );
    }

    let (row_count, duration_seconds, total_steps) = result?;

    emit_progress(
        &mut on_progress,
        "complete",
        total_steps,
        total_steps,
        "Video export complete",
    );
    tracing::info!(
        target: "cutready::export",
        sketch_path = %sketch_path,
        output_path = %output_path.display(),
        row_count,
        duration_seconds,
        "exported sketch video"
    );

    Ok(SketchVideoExport {
        path: output_path.to_string_lossy().to_string(),
        duration_seconds,
        row_count,
    })
}

fn emit_progress<F>(
    on_progress: &mut F,
    phase: impl Into<String>,
    current: usize,
    total: usize,
    message: impl Into<String>,
) where
    F: FnMut(SketchVideoExportProgress),
{
    on_progress(SketchVideoExportProgress {
        phase: phase.into(),
        current,
        total,
        message: message.into(),
    });
}

fn resolve_export_output_path(
    project_root: &Path,
    sketch: &Sketch,
    output_path: Option<&Path>,
) -> anyhow::Result<PathBuf> {
    match output_path {
        Some(path) => {
            if !path.is_absolute() {
                anyhow::bail!("Video export output path must be absolute");
            }
            Ok(path.to_path_buf())
        }
        None => {
            let relative = default_output_relative_path(&sketch.title);
            Ok(project::safe_resolve(project_root, &relative)?)
        }
    }
}

fn render_title_card(
    sketch: &Sketch,
    duration_seconds: f64,
    output_path: &Path,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    let duration = format_duration(duration_seconds);
    let title_filter = title_card_filter(sketch, settings);

    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        FfmpegFilterGraph::chain([FfmpegFilter::new("color")
            .named("c", "#faf9f7")
            .named(
                "s",
                FfmpegValue::raw(format!(
                    "{}x{}",
                    settings.video_width, settings.video_height
                )),
            )
            .named("r", settings.video_fps.to_string())
            .named("d", duration.clone())])
        .render(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-t".to_string(),
        duration,
        "-i".to_string(),
        FfmpegFilterGraph::chain([FfmpegFilter::new("anullsrc")
            .named("channel_layout", "stereo")
            .named("sample_rate", "48000")])
        .render(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "1:a:0".to_string(),
        "-vf".to_string(),
        title_filter,
        "-c:v".to_string(),
        settings.video_encoder.clone(),
        "-preset".to_string(),
        "medium".to_string(),
        "-crf".to_string(),
        settings.video_crf.clone(),
        "-pix_fmt".to_string(),
        settings.video_pixel_format.clone(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().to_string(),
    ])
}

fn collect_row_segments(
    project_root: &Path,
    work_dir: &Path,
    sketch_path: &str,
    sketch: &Sketch,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<Vec<RowSegment>> {
    if sketch.rows.is_empty() {
        anyhow::bail!("Sketch has no rows to export");
    }

    let resolved_demo =
        load_or_generate_resolved_demo(project_root, work_dir, sketch_path, sketch, settings)?;

    sketch
        .rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let narration = row
                .narration
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Row {} has no narration", index + 1))?;
            let narration_path = project::safe_resolve(project_root, &narration.path)?;
            if !narration_path.is_file() {
                anyhow::bail!(
                    "Row {} narration does not exist: {}",
                    index + 1,
                    narration.path
                );
            }

            let metadata_duration_seconds = narration
                .duration_ms
                .map(|duration_ms| duration_ms as f64 / 1000.0);
            let probed_duration_seconds = probe_media_duration_seconds(&narration_path)
                .map_err(|error| {
                    tracing::warn!(
                        row = index + 1,
                        path = %narration_path.display(),
                        error = %error,
                        "Could not probe narration duration; falling back to saved metadata"
                    );
                    error
                })
                .ok();
            let source_duration_seconds = effective_source_duration_seconds(
                metadata_duration_seconds,
                probed_duration_seconds,
            )
            .ok_or_else(|| {
                anyhow::anyhow!("Could not determine row {} narration duration", index + 1)
            })?;
            let (audio_start_seconds, audio_duration_seconds) = effective_narration_timing(
                source_duration_seconds,
                narration.leading_silence_ms,
                narration.trailing_silence_ms,
            );
            let row_number = index + 1;
            let resolved_demo_seconds = resolved_demo
                .as_ref()
                .and_then(|loaded| loaded.demo.row_playback_duration_seconds(row_number))
                .unwrap_or(0.0);
            let duration_seconds = row_content_duration_seconds(
                audio_duration_seconds,
                resolved_demo_seconds,
                settings,
            );
            let visual_path = row
                .visual
                .as_ref()
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if visual_path.is_some() && (!row.typing_spots.is_empty() || row.motion_plan.is_some())
            {
                anyhow::bail!(
                    "Row {} cannot combine visual frame rendering with typing spots or a motion plan",
                    row_number
                );
            }
            let frame_sequence = settings
                .visual_frame_manifest_paths
                .get(index)
                .and_then(Option::as_deref)
                .map(|path| {
                    load_visual_frame_sequence(
                        project_root,
                        path,
                        duration_seconds,
                        settings.video_fps,
                    )
                })
                .transpose()?;
            let frame_sequence = if frame_sequence.is_none() {
                visual_path
                    .map(|visual_path| {
                        let output_dir =
                            work_dir.join(format!("row-{row_number:03}-elucim-frames"));
                        let manifest = animation::render_visual_frame_manifest(
                            project_root,
                            visual_path,
                            &output_dir,
                            settings.video_fps,
                        )?;
                        tracing::info!(
                            target: "cutready::export",
                            row = row_number,
                            visual = %visual_path,
                            frame_count = manifest.frame_count,
                            "generated Elucim frame manifest"
                        );
                        load_visual_frame_sequence_from_manifest(
                            &manifest.manifest_path,
                            output_dir.as_path(),
                            duration_seconds,
                            settings.video_fps,
                        )
                    })
                    .transpose()?
            } else {
                frame_sequence
            };
            let has_screenshot = row
                .screenshot
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty());
            let frame_sequence = if frame_sequence.is_none() {
                if row.typing_spots.is_empty() && row.motion_plan.is_none() {
                    match resolved_demo.as_ref().map(|loaded| {
                        resolved_demo_frame_sequence_for_row(
                            loaded,
                            row_number,
                            duration_seconds,
                            settings.video_fps,
                        )
                    }) {
                        Some(Ok(sequence)) => sequence,
                        Some(Err(error))
                            if has_screenshot && is_missing_resolved_demo_asset_error(&error) =>
                        {
                            tracing::warn!(
                                target: "cutready::export",
                                row = row_number,
                                error = %error,
                                "could not load resolved-demo media; falling back to row screenshot"
                            );
                            None
                        }
                        Some(Err(error)) => return Err(error),
                        None => None,
                    }
                } else {
                    None
                }
            } else {
                frame_sequence
            };
            if frame_sequence.is_some() && (!row.typing_spots.is_empty() || row.motion_plan.is_some()) {
                anyhow::bail!(
                    "Row {} cannot combine visual frame rendering with typing spots or a motion plan",
                    row_number
                );
            }
            let image_path = if let Some(frame) = frame_sequence
                .as_ref()
                .and_then(|sequence| sequence.frames.first())
            {
                frame.path.clone()
            } else {
                let screenshot = row
                    .screenshot
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("Row {} has no screenshot", index + 1))?;
                let image_path = project::safe_resolve(project_root, screenshot)?;
                if !image_path.is_file() {
                    anyhow::bail!("Row {} screenshot does not exist: {screenshot}", index + 1);
                }
                image_path
            };

            Ok(RowSegment {
                row_number,
                image_path,
                narration_path,
                audio_start_seconds,
                audio_duration_seconds,
                duration_seconds,
                frame_sequence,
                motion_plan: row.motion_plan.clone(),
                typing_spots: row.typing_spots.clone(),
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum VisualFrameManifestFile {
    Wrapped {
        frames: Vec<VisualFrameManifestEntry>,
    },
    Entries(Vec<VisualFrameManifestEntry>),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisualFrameManifestEntry {
    path: String,
    #[serde(alias = "duration_ms")]
    duration_ms: i64,
    #[serde(default)]
    terminal: bool,
}

fn load_visual_frame_sequence(
    project_root: &Path,
    manifest_relative_path: &str,
    row_duration_seconds: f64,
    fps: u32,
) -> anyhow::Result<FrameSequencePlan> {
    let manifest_path = project::safe_resolve(project_root, manifest_relative_path)?;
    if !manifest_path.is_file() {
        anyhow::bail!("Visual frame manifest does not exist: {manifest_relative_path}");
    }
    let manifest_parent = Path::new(manifest_relative_path)
        .parent()
        .and_then(Path::to_str)
        .filter(|path| !path.is_empty());
    let entries = load_visual_frame_manifest_entries(&manifest_path, |frame_path| {
        resolve_visual_frame_path(project_root, manifest_parent, frame_path)
    })?;

    plan_frame_sequence(&entries, row_duration_seconds, fps)
}

fn load_visual_frame_sequence_from_manifest(
    manifest_path: &Path,
    manifest_dir: &Path,
    row_duration_seconds: f64,
    fps: u32,
) -> anyhow::Result<FrameSequencePlan> {
    let entries = load_visual_frame_manifest_entries(manifest_path, |frame_path| {
        resolve_generated_visual_frame_path(manifest_dir, frame_path)
    })?;

    plan_frame_sequence(&entries, row_duration_seconds, fps)
}

fn load_visual_frame_manifest_entries(
    manifest_path: &Path,
    resolve_path: impl Fn(&str) -> anyhow::Result<PathBuf>,
) -> anyhow::Result<Vec<FrameManifestEntry>> {
    let manifest: VisualFrameManifestFile = serde_json::from_reader(fs::File::open(manifest_path)?)
        .map_err(|error| anyhow::anyhow!("Could not parse visual frame manifest: {error}"))?;
    let entries = match manifest {
        VisualFrameManifestFile::Wrapped { frames } | VisualFrameManifestFile::Entries(frames) => {
            frames
        }
    };

    entries
        .into_iter()
        .map(|entry| {
            let path = resolve_path(&entry.path)?;
            if !path.is_file() {
                anyhow::bail!("Visual frame image does not exist: {}", entry.path);
            }
            Ok(FrameManifestEntry {
                path,
                duration_ms: entry.duration_ms,
                terminal: entry.terminal,
            })
        })
        .collect()
}

fn resolve_visual_frame_path(
    project_root: &Path,
    manifest_parent: Option<&str>,
    frame_path: &str,
) -> anyhow::Result<PathBuf> {
    let trimmed = frame_path.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Visual frame path must not be empty");
    }
    if let Some(manifest_parent) = manifest_parent {
        let manifest_relative = Path::new(manifest_parent).join(trimmed);
        let manifest_relative =
            project::safe_resolve(project_root, manifest_relative.to_string_lossy().as_ref())?;
        if manifest_relative.is_file() {
            return Ok(manifest_relative);
        }
    }
    project::safe_resolve(project_root, trimmed).map_err(Into::into)
}

fn resolve_generated_visual_frame_path(
    manifest_dir: &Path,
    frame_path: &str,
) -> anyhow::Result<PathBuf> {
    let trimmed = frame_path.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Visual frame path must not be empty");
    }
    let path = Path::new(trimmed);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        anyhow::bail!("Generated visual frame path must be relative: {trimmed}");
    }
    Ok(manifest_dir.join(path))
}

fn row_content_duration_seconds(
    audio_duration_seconds: f64,
    resolved_demo_seconds: f64,
    settings: &SketchVideoExportSettings,
) -> f64 {
    audio_duration_seconds.max(resolved_demo_seconds) + settings.narration_tail_hold_seconds
}

fn load_resolved_demo(
    project_root: &Path,
    relative_path: &str,
    row_count: usize,
) -> anyhow::Result<LoadedResolvedDemo> {
    let path = project::safe_resolve(project_root, relative_path)?;
    if !path.is_file() {
        anyhow::bail!("Resolved demo schema file does not exist: {relative_path}");
    }
    let asset_base_dir = path.parent().unwrap_or(project_root).to_path_buf();
    let demo = load_resolved_demo_file(&path, row_count)?;
    Ok(LoadedResolvedDemo {
        demo,
        asset_base_dir,
    })
}

fn load_or_generate_resolved_demo(
    project_root: &Path,
    export_work_dir: &Path,
    sketch_path: &str,
    sketch: &Sketch,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<Option<LoadedResolvedDemo>> {
    if let Some(path) = settings.resolved_demo_path.as_deref() {
        return load_resolved_demo(project_root, path, sketch.rows.len()).map(Some);
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
    load_resolved_demo_file(&resolved_demo_path, sketch.rows.len()).map(|demo| {
        Some(LoadedResolvedDemo {
            demo,
            asset_base_dir: bundle_dir,
        })
    })
}

fn rows_missing_screenshots(sketch: &Sketch) -> Vec<usize> {
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

fn load_resolved_demo_file(path: &Path, row_count: usize) -> anyhow::Result<ResolvedDemo> {
    let value: serde_json::Value = serde_json::from_reader(fs::File::open(&path)?)
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
    demo.validate_for_row_count(row_count)?;
    Ok(demo)
}

fn is_missing_resolved_demo_asset_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .to_string()
            .contains("Resolved demo asset does not exist")
    })
}

fn inspect_resolved_demo_row(
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
    }
}

fn inspect_resolved_demo_asset(
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

fn resolved_demo_frame_sequence_for_row(
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

fn resolve_resolved_demo_asset_path(
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

fn export_timeline_timing(
    segments: &[RowSegment],
    settings: &SketchVideoExportSettings,
) -> ExportTimelineTiming {
    let gap_count = segments.len().saturating_sub(1);
    ExportTimelineTiming {
        title_card_seconds: if settings.include_title_card {
            settings.title_card_duration_seconds
        } else {
            0.0
        },
        lead_in_seconds: settings.title_to_first_row_hold_seconds,
        row_content_seconds: segments
            .iter()
            .map(|segment| segment.duration_seconds)
            .sum(),
        interior_transition_seconds: gap_count as f64 * settings.row_transition_hold_seconds,
        final_hold_seconds: settings.final_hold_seconds,
    }
}

fn render_segment(
    segment: &RowSegment,
    output_path: &Path,
    work_dir: &Path,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    if segment.frame_sequence.is_some() {
        return render_frame_sequence_segment(segment, output_path, work_dir, settings);
    }

    let duration = format_duration(segment.duration_seconds);
    let audio_duration = format_duration(segment.audio_duration_seconds);
    let audio_start = format_seconds(segment.audio_start_seconds);
    let use_looped_image_input = segment.motion_plan.is_none() || !segment.typing_spots.is_empty();
    let vf = if let Some(plan) = segment.motion_plan.as_ref() {
        motion_image_video_filter(
            plan,
            &segment.typing_spots,
            segment.duration_seconds,
            settings,
        )
    } else {
        still_image_video_filter(&segment.typing_spots, segment.duration_seconds, settings)
    }?;
    let af = narration_audio_filter(&audio_start, &audio_duration, &duration);
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
    ];
    if use_looped_image_input {
        args.extend([
            "-loop".to_string(),
            "1".to_string(),
            "-framerate".to_string(),
            settings.video_fps.to_string(),
            "-t".to_string(),
            duration.clone(),
        ]);
    }

    args.extend([
        "-i".to_string(),
        segment.image_path.to_string_lossy().to_string(),
    ]);

    args.extend([
        "-i".to_string(),
        segment.narration_path.to_string_lossy().to_string(),
        "-t".to_string(),
        duration,
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "1:a:0".to_string(),
        "-vf".to_string(),
        vf,
        "-af".to_string(),
        af,
        "-c:v".to_string(),
        settings.video_encoder.clone(),
        "-preset".to_string(),
        "medium".to_string(),
    ]);
    if use_looped_image_input {
        args.extend(["-tune".to_string(), "stillimage".to_string()]);
    }
    args.extend([
        "-crf".to_string(),
        settings.video_crf.clone(),
        "-pix_fmt".to_string(),
        settings.video_pixel_format.clone(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().to_string(),
    ]);
    run_ffmpeg(args)
}

fn render_frame_sequence_segment(
    segment: &RowSegment,
    output_path: &Path,
    work_dir: &Path,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    let sequence = segment
        .frame_sequence
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Row {} has no frame sequence", segment.row_number))?;
    if let FrameSequenceFit::Truncated {
        dropped_frames,
        lost_seconds,
    } = sequence.fit
    {
        tracing::warn!(
            row = segment.row_number,
            dropped_frames,
            lost_seconds,
            "Elucim frame sequence is longer than the row and will be truncated"
        );
    }

    let frame_dir = work_dir.join(format!("row-{:03}-frames", segment.row_number));
    fs::create_dir_all(&frame_dir)?;
    let frame_counts = planned_frame_counts(sequence, settings.video_fps)?;
    let mut frame_segments = Vec::with_capacity(frame_counts.len());
    for (index, (frame, frame_count)) in sequence.frames.iter().zip(frame_counts).enumerate() {
        if frame_count == 0 {
            continue;
        }
        let frame_output = frame_dir.join(format!("frame-{index:04}.mp4"));
        render_frame_image_segment(&frame.path, frame_count, &frame_output, settings)?;
        frame_segments.push(frame_output);
    }

    let visual_output = work_dir.join(format!("row-{:03}-visual.mp4", segment.row_number));
    concatenate_plain_segments(&frame_dir, &frame_segments, &visual_output, settings)?;

    let duration = format_duration(segment.duration_seconds);
    let audio_duration = format_duration(segment.audio_duration_seconds);
    let audio_start = format_seconds(segment.audio_start_seconds);
    let af = narration_audio_filter(&audio_start, &audio_duration, &duration);
    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-i".to_string(),
        visual_output.to_string_lossy().to_string(),
        "-i".to_string(),
        segment.narration_path.to_string_lossy().to_string(),
        "-t".to_string(),
        duration,
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "1:a:0".to_string(),
        "-af".to_string(),
        af,
        "-c:v".to_string(),
        "copy".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().to_string(),
    ])
}

fn planned_frame_counts(sequence: &FrameSequencePlan, fps: u32) -> anyhow::Result<Vec<u32>> {
    if fps == 0 {
        anyhow::bail!("Video FPS must be greater than zero");
    }
    let total_frames = ((sequence.total_seconds * f64::from(fps)).round() as i64).max(1);
    let positive_indices = sequence
        .frames
        .iter()
        .enumerate()
        .filter(|(_, frame)| frame.duration_seconds > f64::EPSILON)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if positive_indices.is_empty() {
        anyhow::bail!("Frame sequence has no positive-duration frames");
    }

    let mut counts = vec![0; sequence.frames.len()];
    let mut allocated = 0i64;
    for (ordinal, index) in positive_indices.iter().enumerate() {
        let remaining_positive = positive_indices.len() - ordinal - 1;
        let frame = &sequence.frames[*index];
        let count = if remaining_positive == 0 {
            total_frames - allocated
        } else {
            let remaining_floor = remaining_positive as i64;
            let rounded = (frame.duration_seconds * f64::from(fps)).round() as i64;
            rounded
                .max(1)
                .min((total_frames - allocated - remaining_floor).max(1))
        };
        counts[*index] = count.max(0) as u32;
        allocated += count.max(0);
    }
    Ok(counts)
}

fn render_frame_image_segment(
    image_path: &Path,
    frame_count: u32,
    output_path: &Path,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    if frame_count == 0 {
        anyhow::bail!("Frame segment must contain at least one frame");
    }
    let duration = format_seconds(f64::from(frame_count) / f64::from(settings.video_fps));
    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-loop".to_string(),
        "1".to_string(),
        "-framerate".to_string(),
        settings.video_fps.to_string(),
        "-i".to_string(),
        image_path.to_string_lossy().to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-t".to_string(),
        duration,
        "-i".to_string(),
        FfmpegFilterGraph::chain([FfmpegFilter::new("anullsrc")
            .named("channel_layout", "stereo")
            .named("sample_rate", "48000")])
        .render(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "1:a:0".to_string(),
        "-frames:v".to_string(),
        frame_count.to_string(),
        "-vf".to_string(),
        FfmpegFilterGraph::chain(still_image_video_filters(&[], 0.0, true, settings)?).render(),
        "-c:v".to_string(),
        settings.video_encoder.clone(),
        "-preset".to_string(),
        "medium".to_string(),
        "-tune".to_string(),
        "stillimage".to_string(),
        "-crf".to_string(),
        settings.video_crf.clone(),
        "-pix_fmt".to_string(),
        settings.video_pixel_format.clone(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().to_string(),
    ])
}

fn still_image_video_filter(
    typing_spots: &[TypingSpot],
    duration_seconds: f64,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<String> {
    Ok(FfmpegFilterGraph::chain(still_image_video_filters(
        typing_spots,
        duration_seconds,
        false,
        settings,
    )?)
    .render())
}

fn motion_image_video_filter(
    plan: &MotionPlan,
    typing_spots: &[TypingSpot],
    duration_seconds: f64,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<String> {
    Ok(FfmpegFilterGraph::chain(motion_image_video_filters(
        plan,
        typing_spots,
        duration_seconds,
        settings,
    )?)
    .render())
}

fn motion_image_video_filters(
    plan: &MotionPlan,
    typing_spots: &[TypingSpot],
    duration_seconds: f64,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<Vec<FfmpegFilter>> {
    let mut keyframes = valid_motion_keyframes(plan);
    if keyframes.len() < 2 {
        anyhow::bail!("Motion plan needs at least two valid keyframes");
    }
    keyframes.sort_by_key(|keyframe| keyframe.time_ms);
    let frames = ((duration_seconds.max(MIN_ROW_DURATION_SECONDS) * settings.video_fps as f64)
        .ceil() as u32)
        .max(1);
    let zoompan_frames = if typing_spots.is_empty() { frames } else { 1 };
    let crop_keyframes = motion_crop_keyframes(&keyframes, frames, settings)?;
    let crop_width = piecewise_crop_expression(&crop_keyframes, |crop| crop.width);
    let crop_x = piecewise_crop_expression(&crop_keyframes, |crop| crop.x);
    let crop_y = piecewise_crop_expression(&crop_keyframes, |crop| crop.y);
    let mut filters = image_layout_filters(settings, "lanczos");
    filters.extend(typing_spot_filters(
        typing_spots,
        duration_seconds,
        false,
        settings,
    )?);
    filters.push(
        FfmpegFilter::new("zoompan")
            .named("z", FfmpegExpression::raw(format!("1/({crop_width})")))
            .named("x", FfmpegExpression::raw(format!("iw*({crop_x})")))
            .named("y", FfmpegExpression::raw(format!("ih*({crop_y})")))
            .named("d", zoompan_frames.to_string())
            .named(
                "s",
                FfmpegValue::raw(format!(
                    "{}x{}",
                    settings.video_width, settings.video_height
                )),
            )
            .named("fps", settings.video_fps.to_string()),
    );
    filters.extend(video_output_filters(settings));
    Ok(filters)
}

#[allow(dead_code)]
fn motion_final_frame_video_filter(
    plan: &MotionPlan,
    typing_spots: &[TypingSpot],
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<String> {
    Ok(FfmpegFilterGraph::chain(motion_final_frame_video_filters(
        plan,
        typing_spots,
        settings,
    )?)
    .render())
}

fn motion_final_frame_video_filters(
    plan: &MotionPlan,
    typing_spots: &[TypingSpot],
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<Vec<FfmpegFilter>> {
    let mut keyframes = valid_motion_keyframes(plan);
    if keyframes.is_empty() {
        anyhow::bail!("Motion plan needs at least one valid keyframe");
    }
    keyframes.sort_by_key(|keyframe| keyframe.time_ms);
    let crop = motion_crop_rect(keyframes[keyframes.len() - 1], settings.motion_max_scale);
    let mut filters = image_layout_filters(settings, "lanczos");
    filters.extend(typing_spot_filters(typing_spots, 0.0, true, settings)?);
    filters.push(
        FfmpegFilter::new("zoompan")
            .named("z", FfmpegExpression::raw(format!("1/{:.6}", crop.width)))
            .named("x", FfmpegExpression::raw(format!("iw*({:.6})", crop.x)))
            .named("y", FfmpegExpression::raw(format!("ih*({:.6})", crop.y)))
            .named("d", "1")
            .named(
                "s",
                FfmpegValue::raw(format!(
                    "{}x{}",
                    settings.video_width, settings.video_height
                )),
            )
            .named("fps", settings.video_fps.to_string()),
    );
    filters.extend(video_output_filters(settings));
    Ok(filters)
}

fn image_layout_filters(
    settings: &SketchVideoExportSettings,
    scale_flags: &str,
) -> Vec<FfmpegFilter> {
    vec![
        FfmpegFilter::new("scale")
            .positional(settings.video_width.to_string())
            .positional(settings.video_height.to_string())
            .named("force_original_aspect_ratio", "decrease")
            .named("flags", scale_flags),
        FfmpegFilter::new("pad")
            .positional(settings.video_width.to_string())
            .positional(settings.video_height.to_string())
            .positional(FfmpegExpression::raw("(ow-iw)/2"))
            .positional(FfmpegExpression::raw("(oh-ih)/2")),
    ]
}

fn video_output_filters(settings: &SketchVideoExportSettings) -> Vec<FfmpegFilter> {
    vec![
        FfmpegFilter::new("fps").positional(settings.video_fps.to_string()),
        FfmpegFilter::new("setsar").positional("1"),
        FfmpegFilter::new("format").positional(settings.video_pixel_format.clone()),
    ]
}

fn still_image_video_filters(
    typing_spots: &[TypingSpot],
    duration_seconds: f64,
    completed: bool,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<Vec<FfmpegFilter>> {
    let mut filters = image_layout_filters(settings, "neighbor");
    filters.extend(typing_spot_filters(
        typing_spots,
        duration_seconds,
        completed,
        settings,
    )?);
    filters.extend(video_output_filters(settings));
    Ok(filters)
}

fn typing_spot_filters(
    typing_spots: &[TypingSpot],
    duration_seconds: f64,
    completed: bool,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<Vec<FfmpegFilter>> {
    let mut filters = Vec::new();
    for spot in typing_spots {
        let text = spot.text.trim();
        if text.is_empty()
            || !spot.x.is_finite()
            || !spot.y.is_finite()
            || !spot.width.is_finite()
            || !spot.height.is_finite()
        {
            continue;
        }
        let character_count = text.chars().count();
        if character_count > MAX_TYPING_ANIMATION_CHARACTERS {
            anyhow::bail!(
                "Typing overlays support up to {MAX_TYPING_ANIMATION_CHARACTERS} characters"
            );
        }

        let x = f64::from(spot.x).clamp(0.0, 1.0);
        let y = f64::from(spot.y).clamp(0.0, 1.0);
        let width = f64::from(spot.width).clamp(0.02, 1.0 - x);
        let height = f64::from(spot.height).clamp(0.02, 1.0 - y);
        let padding_x = TYPING_TEXT_PADDING_X.min(width * f64::from(settings.video_width) / 4.0);
        let padding_y = TYPING_TEXT_PADDING_Y.min(height * f64::from(settings.video_height) / 4.0);
        let content_x = x + padding_x / f64::from(settings.video_width);
        let content_y = y + padding_y / f64::from(settings.video_height);
        let content_width = (width * f64::from(settings.video_width) - 2.0 * padding_x).max(1.0);
        let content_height = (height * f64::from(settings.video_height) - 2.0 * padding_y).max(1.0);
        let requested_start = f64::from(spot.start_offset_ms.unwrap_or(0)) / 1_000.0;
        let configured_characters_per_second =
            f64::from(spot.characters_per_second.unwrap_or(18.0)).clamp(1.0, 80.0);
        let configured_reveal_duration = spot
            .duration_ms
            .map(|duration_ms| f64::from(duration_ms) / 1_000.0);
        let (start, characters_per_second, end) = if completed {
            (
                requested_start,
                configured_characters_per_second,
                duration_seconds,
            )
        } else {
            constrained_typing_timing(
                character_count,
                requested_start,
                configured_reveal_duration,
                configured_characters_per_second,
                duration_seconds,
                settings.video_fps,
            )
        };
        let max_font_size_for_width = content_width / (character_count.max(1) as f64 * 0.65);
        let font_size = ((content_height * 0.68).min(max_font_size_for_width)
            * typing_spot_font_scale(spot.font_scale))
        .clamp(18.0, 96.0);
        let text_color = typing_spot_text_color(spot.text_color.as_deref());
        let prefixes = if completed {
            vec![text.to_string()]
        } else {
            text.chars()
                .take(MAX_TYPING_ANIMATION_CHARACTERS)
                .scan(String::new(), |prefix, character| {
                    prefix.push(character);
                    Some(prefix.clone())
                })
                .collect::<Vec<_>>()
        };
        let fontfile = typing_spot_fontfile(spot.font_family.as_deref());
        for (index, prefix) in prefixes.iter().enumerate() {
            let reveal_at = start + index as f64 / characters_per_second;
            let visible_until = if index + 1 == prefixes.len() {
                end
            } else {
                start + (index + 1) as f64 / characters_per_second
            };
            let visible_text = if !completed && spot.show_cursor.unwrap_or(true) {
                format!("{prefix}|")
            } else {
                prefix.clone()
            };
            let visible_text = safe_drawtext_text(&visible_text);
            let mut filter = FfmpegFilter::new("drawtext");
            if let Some(fontfile) = &fontfile {
                filter = filter.named("fontfile", FfmpegValue::font_path(fontfile));
            }
            filter = filter
                .named("fontcolor", text_color.clone())
                .named("fontsize", format!("{font_size:.1}"))
                .named("x", FfmpegExpression::raw(format!("w*{content_x:.6}")))
                .named(
                    "y",
                    FfmpegExpression::raw(format!("h*{content_y:.6}+ascent")),
                )
                .named("text", FfmpegValue::text(visible_text));
            if !completed {
                filter = filter.named(
                    "enable",
                    FfmpegExpression::call(
                        "between",
                        [
                            FfmpegExpression::raw("t"),
                            FfmpegExpression::raw(format!("{reveal_at:.3}")),
                            FfmpegExpression::raw(format!("{visible_until:.3}")),
                        ],
                    ),
                );
            }
            filters.push(filter);
        }
    }
    Ok(filters)
}

fn constrained_typing_timing(
    character_count: usize,
    requested_start: f64,
    configured_reveal_duration: Option<f64>,
    configured_characters_per_second: f64,
    duration_seconds: f64,
    video_fps: u32,
) -> (f64, f64, f64) {
    let frame_duration = 1.0 / f64::from(video_fps.max(1));
    let end = duration_seconds.max(MIN_ROW_DURATION_SECONDS);
    let start = requested_start.clamp(0.0, (end - frame_duration).max(0.0));
    let available_reveal_duration = (end - start).max(frame_duration);
    let desired_reveal_duration = configured_reveal_duration
        .unwrap_or(character_count as f64 / configured_characters_per_second)
        .max(frame_duration);
    let reveal_duration = desired_reveal_duration.min(available_reveal_duration);
    let characters_per_second = character_count as f64 / reveal_duration;
    (start, characters_per_second, end)
}

fn safe_drawtext_text(value: &str) -> String {
    value.replace('\'', "\u{2019}")
}

struct FfmpegFilterGraph {
    chains: Vec<FfmpegFilterChain>,
}

impl FfmpegFilterGraph {
    fn new() -> Self {
        Self { chains: Vec::new() }
    }

    fn chain(filters: impl IntoIterator<Item = FfmpegFilter>) -> Self {
        let mut graph = Self::new();
        graph.push_chain(FfmpegFilterChain::new(filters));
        graph
    }

    fn push_chain(&mut self, chain: FfmpegFilterChain) {
        self.chains.push(chain);
    }

    fn render(self) -> String {
        self.chains
            .into_iter()
            .map(FfmpegFilterChain::render)
            .filter(|chain| !chain.is_empty())
            .collect::<Vec<_>>()
            .join(";")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FfmpegExpression(String);

impl FfmpegExpression {
    fn raw(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    fn call(name: &str, arguments: impl IntoIterator<Item = FfmpegExpression>) -> Self {
        let arguments = arguments
            .into_iter()
            .map(|argument| argument.0)
            .collect::<Vec<_>>()
            .join(r"\,");
        Self(format!("{name}({arguments})"))
    }
}

impl std::fmt::Display for FfmpegExpression {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<FfmpegExpression> for FfmpegValue {
    fn from(value: FfmpegExpression) -> Self {
        Self::Expression(value)
    }
}

enum FfmpegValue {
    Raw(String),
    Expression(FfmpegExpression),
    Text(String),
    #[allow(dead_code)]
    FilePath(PathBuf),
    FontPath(PathBuf),
}

impl FfmpegValue {
    fn raw(value: impl Into<String>) -> Self {
        Self::Raw(value.into())
    }

    fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    #[allow(dead_code)]
    fn file_path(path: impl AsRef<Path>) -> Self {
        Self::FilePath(path.as_ref().to_path_buf())
    }

    fn font_path(path: impl AsRef<Path>) -> Self {
        Self::FontPath(path.as_ref().to_path_buf())
    }

    fn render(self) -> String {
        match self {
            Self::Raw(value) => value,
            Self::Expression(expression) => format!("'{}'", expression.0),
            Self::Text(value) => format!("'{}'", escape_filter_text(&value)),
            Self::FilePath(path) => format!("'{}'", escape_filter_path(&path, false)),
            Self::FontPath(path) => format!("'{}'", escape_filter_path(&path, true)),
        }
    }
}

impl From<&str> for FfmpegValue {
    fn from(value: &str) -> Self {
        Self::raw(value)
    }
}

impl From<String> for FfmpegValue {
    fn from(value: String) -> Self {
        Self::raw(value)
    }
}

struct FfmpegFilter {
    inputs: Vec<FfmpegLabel>,
    name: String,
    options: Vec<(Option<String>, FfmpegValue)>,
    outputs: Vec<FfmpegLabel>,
}

impl FfmpegFilter {
    fn new(name: impl Into<String>) -> Self {
        Self {
            inputs: Vec::new(),
            name: name.into(),
            options: Vec::new(),
            outputs: Vec::new(),
        }
    }

    fn input(mut self, label: impl Into<FfmpegLabel>) -> Self {
        self.inputs.push(label.into());
        self
    }

    fn output(mut self, label: impl Into<FfmpegLabel>) -> Self {
        self.outputs.push(label.into());
        self
    }

    fn named(mut self, name: impl Into<String>, value: impl Into<FfmpegValue>) -> Self {
        self.options.push((Some(name.into()), value.into()));
        self
    }

    fn positional(mut self, value: impl Into<FfmpegValue>) -> Self {
        self.options.push((None, value.into()));
        self
    }

    fn render(self) -> String {
        let inputs = self
            .inputs
            .into_iter()
            .map(|label| format!("[{}]", label.0))
            .collect::<String>();
        let options = self
            .options
            .into_iter()
            .map(|(name, value)| match name {
                Some(name) => format!("{name}={}", value.render()),
                None => value.render(),
            })
            .collect::<Vec<_>>()
            .join(":");
        let outputs = self
            .outputs
            .into_iter()
            .map(|label| format!("[{}]", label.0))
            .collect::<String>();
        if options.is_empty() {
            format!("{inputs}{}{outputs}", self.name)
        } else {
            format!("{inputs}{}={options}{outputs}", self.name)
        }
    }
}

#[derive(Clone)]
struct FfmpegLabel(String);

impl From<&str> for FfmpegLabel {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for FfmpegLabel {
    fn from(value: String) -> Self {
        Self(value)
    }
}

struct FfmpegFilterChain {
    filters: Vec<FfmpegFilter>,
}

impl FfmpegFilterChain {
    fn new(filters: impl IntoIterator<Item = FfmpegFilter>) -> Self {
        Self {
            filters: filters.into_iter().collect(),
        }
    }

    fn render(self) -> String {
        self.filters
            .into_iter()
            .map(FfmpegFilter::render)
            .collect::<Vec<_>>()
            .join(",")
    }
}

fn typing_spot_text_color(value: Option<&str>) -> String {
    let value = value.unwrap_or("#ffffff").trim();
    let hex = value.strip_prefix('#').unwrap_or(value);
    if hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        format!("0x{hex}")
    } else {
        "white".to_string()
    }
}

fn typing_spot_font_scale(value: Option<f32>) -> f64 {
    f64::from(value.unwrap_or(1.0)).clamp(0.4, 1.8)
}

fn typing_spot_fontfile(family: Option<&str>) -> Option<PathBuf> {
    let candidates = match family.unwrap_or("sans") {
        "serif" => [
            #[cfg(target_os = "windows")]
            PathBuf::from(r"C:\Windows\Fonts\georgia.ttf"),
            #[cfg(target_os = "macos")]
            PathBuf::from("/System/Library/Fonts/Supplemental/Georgia.ttf"),
            #[cfg(target_os = "linux")]
            PathBuf::from("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"),
        ],
        "mono" => [
            #[cfg(target_os = "windows")]
            PathBuf::from(r"C:\Windows\Fonts\consola.ttf"),
            #[cfg(target_os = "macos")]
            PathBuf::from("/System/Library/Fonts/Supplemental/Courier New.ttf"),
            #[cfg(target_os = "linux")]
            PathBuf::from("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
        ],
        _ => return title_card_fontfile(),
    };
    candidates.into_iter().find(|path| path.is_file())
}

fn escape_filter_text(value: &str) -> String {
    value
        .replace('\\', r"\\")
        .replace('\'', r"\\'")
        .replace(':', r"\:")
        .replace('%', r"\%")
        .replace(',', r"\,")
        .replace('[', r"\[")
        .replace(']', r"\]")
        .replace('\n', r"\n")
}

fn escape_filter_path(path: &Path, strip_windows_drive_prefix: bool) -> String {
    let mut normalized = path
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    #[cfg(target_os = "windows")]
    if strip_windows_drive_prefix
        && normalized.len() >= 3
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[2] == b'/'
    {
        normalized.replace_range(..2, "");
    }
    escape_filter_text(&normalized)
}

#[derive(Clone, Copy)]
struct MotionCropRect {
    x: f64,
    y: f64,
    width: f64,
}

fn valid_motion_keyframes(plan: &MotionPlan) -> Vec<&MotionPlanKeyframe> {
    plan.keyframes
        .iter()
        .filter(|keyframe| {
            keyframe.scale.is_finite() && keyframe.x.is_finite() && keyframe.y.is_finite()
        })
        .collect()
}

fn motion_crop_rect(keyframe: &MotionPlanKeyframe, max_scale: f64) -> MotionCropRect {
    let scale = f64::from(keyframe.scale).clamp(1.0, max_scale);
    let width = 1.0 / scale;
    let max_offset = 1.0 - width;
    let x = (f64::from(keyframe.x.clamp(0.0, 1.0)) - width / 2.0).clamp(0.0, max_offset);
    let y = (f64::from(keyframe.y.clamp(0.0, 1.0)) - width / 2.0).clamp(0.0, max_offset);
    MotionCropRect { x, y, width }
}

fn motion_crop_keyframes(
    keyframes: &[&MotionPlanKeyframe],
    frames: u32,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<Vec<(u32, MotionCropRect)>> {
    let last_frame = frames.saturating_sub(1);
    let mut crop_keyframes = Vec::with_capacity(keyframes.len());
    for keyframe in keyframes {
        let frame = ((keyframe.time_ms as f64 / 1000.0) * settings.video_fps as f64).round() as u32;
        let frame = frame.min(last_frame);
        let crop = motion_crop_rect(keyframe, settings.motion_max_scale);
        if let Some((last_frame, last_crop)) = crop_keyframes.last_mut() {
            if *last_frame == frame {
                *last_crop = crop;
                continue;
            }
        }
        crop_keyframes.push((frame, crop));
    }
    if crop_keyframes.len() < 2 {
        anyhow::bail!("Motion plan needs at least two distinct keyframe times");
    }
    Ok(crop_keyframes)
}

fn piecewise_crop_expression(
    crop_keyframes: &[(u32, MotionCropRect)],
    value: impl Fn(MotionCropRect) -> f64,
) -> String {
    let (_, last_crop) = crop_keyframes[crop_keyframes.len() - 1];
    let mut expression = FfmpegExpression::raw(format!("{:.6}", value(last_crop)));
    for window in crop_keyframes.windows(2).rev() {
        let (start_frame, start_crop) = window[0];
        let (end_frame, end_crop) = window[1];
        let span = end_frame.saturating_sub(start_frame).max(1);
        let start_value = value(start_crop);
        let end_value = value(end_crop);
        let clamped_frame = FfmpegExpression::call(
            "max",
            [
                FfmpegExpression::raw(format!("on-{start_frame}")),
                FfmpegExpression::raw("0"),
            ],
        );
        let progress = FfmpegExpression::call(
            "min",
            [
                FfmpegExpression::raw(format!("{clamped_frame}/{span}")),
                FfmpegExpression::raw("1"),
            ],
        );
        let segment = FfmpegExpression::raw(format!(
            "{start_value:.6}+(({end_value:.6}-{start_value:.6})*({progress}))"
        ));
        expression = FfmpegExpression::call(
            "if",
            [
                FfmpegExpression::call(
                    "lte",
                    [
                        FfmpegExpression::raw("on"),
                        FfmpegExpression::raw(end_frame.to_string()),
                    ],
                ),
                segment,
                expression,
            ],
        );
    }
    expression.0
}

fn narration_audio_filter(
    audio_start: &str,
    audio_duration: &str,
    output_duration: &str,
) -> String {
    FfmpegFilterGraph::chain([
        FfmpegFilter::new("atrim")
            .named("start", audio_start)
            .named("duration", audio_duration),
        FfmpegFilter::new("asetpts").positional("PTS-STARTPTS"),
        FfmpegFilter::new("apad"),
        FfmpegFilter::new("atrim").named("duration", output_duration),
        FfmpegFilter::new("aresample").positional("48000"),
        FfmpegFilter::new("aformat").named("channel_layouts", "stereo"),
    ])
    .render()
}

fn render_image_hold_segment(
    image_path: &Path,
    duration_seconds: f64,
    output_path: &Path,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    render_image_hold_segment_with_filter(
        image_path,
        duration_seconds,
        output_path,
        still_image_video_filters(&[], duration_seconds, true, settings)?,
        settings,
    )
}

fn render_segment_hold(
    segment: &RowSegment,
    duration_seconds: f64,
    output_path: &Path,
    hold_final_motion_frame: bool,
    transition: HoldTransition,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    let image_path = segment_hold_image_path(segment);
    let base_filters = if hold_final_motion_frame {
        if segment.frame_sequence.is_some() {
            still_image_video_filters(&[], duration_seconds, true, settings)?
        } else if let Some(plan) = segment.motion_plan.as_ref() {
            motion_final_frame_video_filters(plan, &segment.typing_spots, settings)?
        } else {
            still_image_video_filters(&segment.typing_spots, duration_seconds, true, settings)?
        }
    } else {
        still_image_video_filters(&segment.typing_spots, duration_seconds, true, settings)?
    };
    let filters = hold_video_filters(base_filters, duration_seconds, transition, settings);
    render_image_hold_segment_with_filter(
        image_path,
        duration_seconds,
        output_path,
        filters,
        settings,
    )
}

fn segment_hold_image_path(segment: &RowSegment) -> &Path {
    segment
        .frame_sequence
        .as_ref()
        .and_then(|sequence| sequence.frames.last())
        .map(|frame| frame.path.as_path())
        .unwrap_or(segment.image_path.as_path())
}

#[derive(Clone, Copy)]
enum HoldTransition {
    None,
    FadeOutToBlack,
    FadeInFromBlack,
}

fn hold_video_filters(
    mut filters: Vec<FfmpegFilter>,
    duration_seconds: f64,
    transition: HoldTransition,
    settings: &SketchVideoExportSettings,
) -> Vec<FfmpegFilter> {
    let fade_duration = duration_seconds
        .min(settings.row_transition_dip_seconds)
        .max(MIN_ROW_DURATION_SECONDS);
    match transition {
        HoldTransition::None => filters,
        HoldTransition::FadeOutToBlack => {
            let start = (duration_seconds - fade_duration).max(0.0);
            filters.push(
                FfmpegFilter::new("fade")
                    .named("t", "out")
                    .named("st", format_seconds(start))
                    .named("d", format_seconds(fade_duration))
                    .named("color", "black"),
            );
            filters
        }
        HoldTransition::FadeInFromBlack => {
            filters.push(
                FfmpegFilter::new("fade")
                    .named("t", "in")
                    .named("st", "0")
                    .named("d", format_seconds(fade_duration))
                    .named("color", "black"),
            );
            filters
        }
    }
}

fn render_image_hold_segment_with_filter(
    image_path: &Path,
    duration_seconds: f64,
    output_path: &Path,
    video_filters: Vec<FfmpegFilter>,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    let duration = format_duration(duration_seconds);
    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-loop".to_string(),
        "1".to_string(),
        "-framerate".to_string(),
        settings.video_fps.to_string(),
        "-t".to_string(),
        duration.clone(),
        "-i".to_string(),
        image_path.to_string_lossy().to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-t".to_string(),
        duration,
        "-i".to_string(),
        FfmpegFilterGraph::chain([FfmpegFilter::new("anullsrc")
            .named("channel_layout", "stereo")
            .named("sample_rate", "48000")])
        .render(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "1:a:0".to_string(),
        "-vf".to_string(),
        FfmpegFilterGraph::chain(video_filters).render(),
        "-c:v".to_string(),
        settings.video_encoder.clone(),
        "-preset".to_string(),
        "medium".to_string(),
        "-tune".to_string(),
        "stillimage".to_string(),
        "-crf".to_string(),
        settings.video_crf.clone(),
        "-pix_fmt".to_string(),
        settings.video_pixel_format.clone(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().to_string(),
    ])
}

fn concatenate_segments(
    app_data_dir: &Path,
    work_dir: &Path,
    segment_files: &[PathBuf],
    output_path: &Path,
    duration_seconds: f64,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    let list_path = work_dir.join("concat.txt");
    let list = segment_files
        .iter()
        .map(|path| {
            let name = path
                .file_name()
                .and_then(OsStr::to_str)
                .ok_or_else(|| anyhow::anyhow!("Segment path has no valid file name"))?;
            Ok(format!("file '{}'\n", name.replace('\'', "'\\''")))
        })
        .collect::<anyhow::Result<String>>()?;
    fs::write(&list_path, list)?;

    let concatenated_output_path = if settings.background_music_path.is_some() {
        work_dir.join("assembled-without-music.mp4")
    } else {
        output_path.to_path_buf()
    };

    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-fflags".to_string(),
        "+genpts".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().to_string(),
        "-c:v".to_string(),
        settings.video_encoder.clone(),
        "-preset".to_string(),
        "medium".to_string(),
        "-crf".to_string(),
        settings.video_crf.clone(),
        "-pix_fmt".to_string(),
        settings.video_pixel_format.clone(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-ar".to_string(),
        "48000".to_string(),
        "-af".to_string(),
        FfmpegFilterGraph::chain([FfmpegFilter::new("aresample")
            .named("async", "1")
            .named("first_pts", "0")])
        .render(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        concatenated_output_path.to_string_lossy().to_string(),
    ])?;

    if let Some(background_music_path) = &settings.background_music_path {
        let music_path = resolve_background_music_path(app_data_dir, background_music_path)?;
        let actual_duration_seconds =
            probe_media_duration_seconds(&concatenated_output_path).unwrap_or(duration_seconds);
        mix_background_music(
            &concatenated_output_path,
            &music_path,
            output_path,
            actual_duration_seconds,
            settings,
        )?;
    }

    Ok(())
}

fn concatenate_plain_segments(
    work_dir: &Path,
    segment_files: &[PathBuf],
    output_path: &Path,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    let list_path = work_dir.join("concat.txt");
    let list = segment_files
        .iter()
        .map(|path| {
            let name = path
                .file_name()
                .and_then(OsStr::to_str)
                .ok_or_else(|| anyhow::anyhow!("Segment path has no valid file name"))?;
            Ok(format!("file '{}'\n", name.replace('\'', "'\\''")))
        })
        .collect::<anyhow::Result<String>>()?;
    fs::write(&list_path, list)?;

    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-fflags".to_string(),
        "+genpts".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().to_string(),
        "-c:v".to_string(),
        settings.video_encoder.clone(),
        "-preset".to_string(),
        "medium".to_string(),
        "-crf".to_string(),
        settings.video_crf.clone(),
        "-pix_fmt".to_string(),
        settings.video_pixel_format.clone(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-ar".to_string(),
        "48000".to_string(),
        "-af".to_string(),
        FfmpegFilterGraph::chain([FfmpegFilter::new("aresample")
            .named("async", "1")
            .named("first_pts", "0")])
        .render(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().to_string(),
    ])
}

fn mix_background_music(
    video_path: &Path,
    music_path: &Path,
    output_path: &Path,
    duration_seconds: f64,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    if !music_path.is_file() {
        anyhow::bail!("Background music file was not found");
    }

    let duration = format_duration(duration_seconds);
    let fade_duration = settings
        .background_music_fade_seconds
        .min(duration_seconds / 2.0)
        .max(0.0);
    let fade_out_start = (duration_seconds - fade_duration).max(0.0);
    let filter = background_music_filter(duration, fade_duration, fade_out_start, settings);

    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-i".to_string(),
        video_path.to_string_lossy().to_string(),
        "-stream_loop".to_string(),
        "-1".to_string(),
        "-i".to_string(),
        music_path.to_string_lossy().to_string(),
        "-filter_complex".to_string(),
        filter,
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "[a]".to_string(),
        "-c:v".to_string(),
        "copy".to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-shortest".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().to_string(),
    ])
}

fn render_background_music_preview_audio(
    narration_path: Option<&Path>,
    music_path: &Path,
    output_path: &Path,
    duration_seconds: f64,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
    if !music_path.is_file() {
        anyhow::bail!("Background music file was not found");
    }
    let duration = format_duration(duration_seconds);
    let fade_duration = settings
        .background_music_fade_seconds
        .min(duration_seconds / 2.0)
        .max(0.0);
    let fade_out_start = (duration_seconds - fade_duration).max(0.0);
    let filter =
        background_music_preview_filter(duration.clone(), fade_duration, fade_out_start, settings);
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
    ];
    if let Some(narration_path) = narration_path {
        args.extend([
            "-t".to_string(),
            duration,
            "-i".to_string(),
            narration_path.to_string_lossy().to_string(),
        ]);
    } else {
        args.extend([
            "-f".to_string(),
            "lavfi".to_string(),
            "-t".to_string(),
            duration,
            "-i".to_string(),
            FfmpegFilterGraph::chain([FfmpegFilter::new("anullsrc")
                .named("r", "48000")
                .named("cl", "stereo")])
            .render(),
        ]);
    }
    args.extend([
        "-stream_loop".to_string(),
        "-1".to_string(),
        "-i".to_string(),
        music_path.to_string_lossy().to_string(),
        "-filter_complex".to_string(),
        filter,
        "-map".to_string(),
        "[a]".to_string(),
        "-vn".to_string(),
        "-ar".to_string(),
        "48000".to_string(),
        "-ac".to_string(),
        "2".to_string(),
        "-c:a".to_string(),
        "pcm_s16le".to_string(),
        output_path.to_string_lossy().to_string(),
    ]);
    run_ffmpeg(args)
}

fn background_music_filter(
    duration: String,
    fade_duration: f64,
    fade_out_start: f64,
    settings: &SketchVideoExportSettings,
) -> String {
    background_music_filter_with_narration_label(
        duration,
        fade_duration,
        fade_out_start,
        settings,
        "0:a",
    )
}

fn background_music_preview_filter(
    duration: String,
    fade_duration: f64,
    fade_out_start: f64,
    settings: &SketchVideoExportSettings,
) -> String {
    let mut graph = FfmpegFilterGraph::new();
    graph.push_chain(FfmpegFilterChain::new([
        FfmpegFilter::new("apad").input("0:a"),
        FfmpegFilter::new("atrim")
            .positional("0")
            .positional(duration.clone()),
        FfmpegFilter::new("asetpts").positional("PTS-STARTPTS"),
        FfmpegFilter::new("aformat")
            .named("channel_layouts", "stereo")
            .output("previewNarration"),
    ]));
    graph.push_chain(background_music_filter_chain(
        duration,
        fade_duration,
        fade_out_start,
        settings,
    ));
    graph.push_chain(background_music_mix_chain(
        "previewNarration",
        settings.background_music_duck_narration,
    ));
    graph.render()
}

fn background_music_filter_with_narration_label(
    duration: String,
    fade_duration: f64,
    fade_out_start: f64,
    settings: &SketchVideoExportSettings,
    narration_label: &str,
) -> String {
    let mut graph = FfmpegFilterGraph::new();
    graph.push_chain(background_music_filter_chain(
        duration,
        fade_duration,
        fade_out_start,
        settings,
    ));
    graph.push_chain(background_music_mix_chain(
        narration_label,
        settings.background_music_duck_narration,
    ));
    graph.render()
}

fn background_music_filter_chain(
    duration: String,
    fade_duration: f64,
    fade_out_start: f64,
    settings: &SketchVideoExportSettings,
) -> FfmpegFilterChain {
    let mut music_filters = vec![
        FfmpegFilter::new("atrim")
            .input("1:a")
            .positional("0")
            .positional(duration),
        FfmpegFilter::new("asetpts").positional("PTS-STARTPTS"),
        FfmpegFilter::new("volume").positional(FfmpegValue::raw(format!(
            "{}dB",
            settings.background_music_volume_db
        ))),
    ];
    if fade_duration > 0.0 {
        music_filters.extend([
            FfmpegFilter::new("afade")
                .named("t", "in")
                .named("st", "0")
                .named("d", format_duration(fade_duration)),
            FfmpegFilter::new("afade")
                .named("t", "out")
                .named("st", format_duration(fade_out_start))
                .named("d", format_duration(fade_duration)),
        ]);
    }
    music_filters
        .last_mut()
        .unwrap()
        .outputs
        .push("music".into());
    FfmpegFilterChain::new(music_filters)
}

fn background_music_mix_chain(narration_label: &str, duck_narration: bool) -> FfmpegFilterChain {
    if duck_narration {
        FfmpegFilterChain::new([
            FfmpegFilter::new("sidechaincompress")
                .input("music")
                .input(narration_label)
                .named("threshold", "0.035")
                .named("ratio", "8")
                .named("attack", "20")
                .named("release", "350")
                .output("ducked"),
            FfmpegFilter::new("amix")
                .input(narration_label)
                .input("ducked")
                .named("inputs", "2")
                .named("duration", "first")
                .named("dropout_transition", "0")
                .output("a"),
        ])
    } else {
        FfmpegFilterChain::new([FfmpegFilter::new("amix")
            .input(narration_label)
            .input("music")
            .named("inputs", "2")
            .named("duration", "first")
            .named("dropout_transition", "0")
            .output("a")])
    }
}

fn title_card_filter(sketch: &Sketch, settings: &SketchVideoExportSettings) -> String {
    let title = if sketch.title.trim().is_empty() {
        "Untitled Sketch"
    } else {
        sketch.title.trim()
    };
    let description = description_text(&sketch.description);
    let title_lines = wrap_text(title, 24, 3);
    let description_lines = wrap_text(&description, 54, 4);
    let title_line_height = 82;
    let description_line_height = 44;
    let title_description_gap = if description_lines.is_empty() { 0 } else { 36 };
    let content_height = (title_lines.len() as i32 * title_line_height)
        + title_description_gap
        + (description_lines.len() as i32 * description_line_height);
    let title_start_y = ((settings.video_height as i32 - content_height) / 2).max(160);
    let description_start_y = if description_lines.is_empty() {
        title_start_y
    } else {
        title_start_y + (title_lines.len() as i32 * title_line_height) + title_description_gap
    };

    let font_path = title_card_fontfile();
    tracing::debug!(
        target: "cutready::export",
        font_path = font_path.as_ref().map(|path| path.display().to_string()),
        "resolved title card font"
    );

    let mut filters = Vec::new();
    for (index, line) in title_lines.iter().enumerate() {
        filters.push(drawtext_filter(
            font_path.as_deref(),
            line,
            72,
            "#2b2926",
            title_start_y + (index as i32 * title_line_height),
        ));
    }
    for (index, line) in description_lines.iter().enumerate() {
        filters.push(drawtext_filter(
            font_path.as_deref(),
            line,
            30,
            "#6f6760",
            description_start_y + (index as i32 * description_line_height),
        ));
    }
    filters.extend(video_output_filters(settings));
    FfmpegFilterGraph::chain(filters).render()
}

fn description_text(value: &serde_json::Value) -> String {
    let mut parts = Vec::new();
    collect_text_values(value, &mut parts);
    parts
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn collect_text_values(value: &serde_json::Value, parts: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_text_values(item, parts);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(text)) = map.get("text") {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    parts.push(trimmed.to_string());
                }
                return;
            }
            for (key, item) in map {
                if key != "type" {
                    collect_text_values(item, parts);
                }
            }
        }
        _ => {}
    }
}

fn wrap_text(value: &str, max_chars: usize, max_lines: usize) -> Vec<String> {
    let words = value.split_whitespace().collect::<Vec<_>>();
    if words.is_empty() {
        return Vec::new();
    }

    let mut lines = Vec::new();
    let mut current = String::new();
    for word in words {
        let next_len = if current.is_empty() {
            word.len()
        } else {
            current.len() + 1 + word.len()
        };
        if next_len > max_chars && !current.is_empty() {
            lines.push(current);
            current = String::new();
            if lines.len() == max_lines {
                break;
            }
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() && lines.len() < max_lines {
        lines.push(current);
    }
    if lines.len() == max_lines
        && value.split_whitespace().count() > lines.join(" ").split_whitespace().count()
    {
        if let Some(last) = lines.last_mut() {
            while last.len() > max_chars.saturating_sub(1) {
                last.pop();
            }
            last.push_str("...");
        }
    }
    lines
}

fn drawtext_filter(
    font_path: Option<&Path>,
    text: &str,
    font_size: u32,
    color: &str,
    y: i32,
) -> FfmpegFilter {
    let mut filter =
        FfmpegFilter::new("drawtext").named("text", FfmpegValue::text(safe_drawtext_text(text)));
    if let Some(font_path) = font_path {
        filter = filter.named("fontfile", FfmpegValue::font_path(font_path));
    }
    filter
        .named("fontcolor", color)
        .named("fontsize", font_size.to_string())
        .named("x", FfmpegExpression::raw("(w-text_w)/2"))
        .named("y", y.to_string())
}

fn title_card_fontfile() -> Option<PathBuf> {
    [
        #[cfg(target_os = "windows")]
        PathBuf::from(r"C:\Windows\Fonts\segoeui.ttf"),
        #[cfg(target_os = "macos")]
        PathBuf::from("/System/Library/Fonts/Supplemental/Arial.ttf"),
        #[cfg(target_os = "linux")]
        PathBuf::from("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn ensure_ffmpeg_available() -> anyhow::Result<()> {
    let output = ffmpeg::run_ffmpeg(["-version"])?;
    if output.status.success() {
        return Ok(());
    }
    anyhow::bail!("FFmpeg is not available");
}

fn probe_media_duration_seconds(path: &Path) -> anyhow::Result<f64> {
    let output = ffmpeg::run_ffprobe([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path.to_string_lossy().as_ref(),
    ])?;
    if !output.status.success() {
        anyhow::bail!("FFprobe could not read media duration");
    }
    let duration = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()?;
    if duration.is_finite() && duration > 0.0 {
        Ok(duration)
    } else {
        anyhow::bail!("Media duration was not positive");
    }
}

fn background_music_preview_duration(
    narration_duration: Option<f64>,
    music_duration: Option<f64>,
) -> f64 {
    narration_duration.or(music_duration).unwrap_or(12.0).clamp(
        BACKGROUND_MUSIC_PREVIEW_MIN_SECONDS,
        BACKGROUND_MUSIC_PREVIEW_MAX_SECONDS,
    )
}

fn effective_source_duration_seconds(
    metadata_duration_seconds: Option<f64>,
    probed_duration_seconds: Option<f64>,
) -> Option<f64> {
    [metadata_duration_seconds, probed_duration_seconds]
        .into_iter()
        .flatten()
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .reduce(f64::max)
}

fn run_ffmpeg(args: Vec<String>) -> anyhow::Result<()> {
    let diagnostics = FfmpegFilterDiagnostics::from_args(&args);
    let mut args = args;
    let _filter_scripts =
        match offload_large_filter_arguments(&mut args, FilterFileSyntax::detect()) {
            Ok(scripts) => scripts,
            Err(error) => {
                log_ffmpeg_failure(
                    None,
                    &error.to_string(),
                    "",
                    "",
                    &diagnostics,
                    "FFmpeg filter script preparation failed",
                );
                return Err(error);
            }
        };
    let output = match ffmpeg::run_ffmpeg(&args) {
        Ok(output) => output,
        Err(error) => {
            log_ffmpeg_failure(
                None,
                &error.to_string(),
                "",
                "",
                &diagnostics,
                "FFmpeg export command could not start",
            );
            return Err(error);
        }
    };
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let message = ffmpeg_failure_message(&lines);
    log_ffmpeg_failure(
        output.status.code(),
        message,
        stderr.trim(),
        stdout.trim(),
        &diagnostics,
        "FFmpeg export command failed",
    );
    anyhow::bail!("{message}");
}

struct FfmpegFilterDiagnostics {
    video_filter: Option<String>,
    audio_filter: Option<String>,
    complex_filter: Option<String>,
}

impl FfmpegFilterDiagnostics {
    fn from_args(args: &[String]) -> Self {
        Self {
            video_filter: ffmpeg_filter_argument(args, "-vf").map(str::to_string),
            audio_filter: ffmpeg_filter_argument(args, "-af").map(str::to_string),
            complex_filter: ffmpeg_filter_argument(args, "-filter_complex").map(str::to_string),
        }
    }
}

fn log_ffmpeg_failure(
    status: Option<i32>,
    message: &str,
    stderr: &str,
    stdout: &str,
    diagnostics: &FfmpegFilterDiagnostics,
    event: &'static str,
) {
    tracing::error!(
        ffmpeg_status = ?status,
        ffmpeg_message = %message,
        ffmpeg_stderr = %stderr,
        ffmpeg_stdout = %stdout,
        ffmpeg_video_filter = ?diagnostics.video_filter,
        ffmpeg_audio_filter = ?diagnostics.audio_filter,
        ffmpeg_filter_complex = ?diagnostics.complex_filter,
        "{event}"
    );
}

fn ffmpeg_filter_argument<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.windows(2)
        .find_map(|arguments| (arguments[0] == flag).then_some(arguments[1].as_str()))
}

fn offload_large_filter_arguments(
    args: &mut [String],
    syntax: FilterFileSyntax,
) -> anyhow::Result<Vec<tempfile::TempPath>> {
    let mut scripts = Vec::new();
    for index in 0..args.len().saturating_sub(1) {
        let Some(script_flag) = syntax.flag_for(&args[index]) else {
            continue;
        };
        if args[index + 1].len() <= FFMPEG_FILTER_SCRIPT_THRESHOLD_BYTES {
            continue;
        }

        let mut script = tempfile::Builder::new()
            .prefix("cutready-ffmpeg-")
            .suffix(".filter")
            .tempfile()
            .map_err(|error| anyhow::anyhow!("Could not create FFmpeg filter script: {error}"))?;
        script
            .write_all(args[index + 1].as_bytes())
            .map_err(|error| anyhow::anyhow!("Could not write FFmpeg filter script: {error}"))?;
        let path = script.into_temp_path();
        args[index] = script_flag.to_string();
        args[index + 1] = path.to_string_lossy().to_string();
        scripts.push(path);
    }
    Ok(scripts)
}

/// Which flag family FFmpeg understands for reading a filtergraph from a file.
///
/// FFmpeg 9.0 removed the long-deprecated `-filter_script` /
/// `-filter_complex_script` options in favor of the generic "read this option's
/// value from a file" syntax (`-/vf <path>`). Older FFmpeg builds still accept
/// the legacy flags they have always used, so we only switch syntax on the
/// versions that actually dropped it — leaving every existing working install
/// untouched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FilterFileSyntax {
    /// `-filter_script:v` / `-filter_script:a` / `-filter_complex_script`.
    Legacy,
    /// `-/vf` / `-/af` / `-/filter_complex`.
    Generic,
}

impl FilterFileSyntax {
    /// Detect the syntax the resolved FFmpeg understands (cached per process).
    fn detect() -> Self {
        static CHOICE: OnceLock<FilterFileSyntax> = OnceLock::new();
        *CHOICE.get_or_init(|| {
            if ffmpeg_major_version().is_some_and(|major| major >= 9) {
                Self::Generic
            } else {
                // Unknown/unparseable versions fall back to legacy, which every
                // FFmpeg predating the 9.0 removal accepts.
                Self::Legacy
            }
        })
    }

    /// Map an inline filter flag to its file-reading equivalent, or `None` when
    /// the flag is not a filtergraph flag we offload.
    fn flag_for(self, inline_flag: &str) -> Option<&'static str> {
        match (self, inline_flag) {
            (Self::Legacy, "-vf") => Some("-filter_script:v"),
            (Self::Legacy, "-af") => Some("-filter_script:a"),
            (Self::Legacy, "-filter_complex") => Some("-filter_complex_script"),
            (Self::Generic, "-vf") => Some("-/vf"),
            (Self::Generic, "-af") => Some("-/af"),
            (Self::Generic, "-filter_complex") => Some("-/filter_complex"),
            _ => None,
        }
    }
}

/// Run `ffmpeg -version` and parse the major version number, if available.
fn ffmpeg_major_version() -> Option<u32> {
    let output = ffmpeg::run_ffmpeg(["-version"]).ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    parse_ffmpeg_major_version(&text)
}

/// Parse the major version from `ffmpeg -version` output.
///
/// The first line looks like `ffmpeg version 9.0.1-full_build-www.gyan.dev ...`
/// or a distro form like `ffmpeg version n6.1.1`. We only accept a dotted
/// numeric version so that non-numeric git builds (`N-119000-g...`) fall
/// through to the conservative legacy default rather than being misread.
fn parse_ffmpeg_major_version(version_output: &str) -> Option<u32> {
    let first_line = version_output.lines().next()?;
    let after = first_line.split("version ").nth(1)?.trim_start();
    // Skip an optional distro `n`/`N` prefix (e.g. `n6.1.1`).
    let after = after.strip_prefix(['n', 'N']).unwrap_or(after);
    let (major, rest) = after.split_once('.')?;
    // Require the character after the major to keep parsing a version (a digit
    // or another separator), guarding against stray non-version tokens.
    if !rest.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    major.parse::<u32>().ok()
}

fn ffmpeg_failure_message<'a>(lines: &'a [&'a str]) -> &'a str {
    lines
        .iter()
        .copied()
        .find(|line| {
            line.contains("Error initializing output stream")
                || line.contains("Error while opening encoder")
                || line.contains("Could not write header")
                || line.contains("Unknown encoder")
                || line.contains("Unable to find a suitable output format")
                || line.contains("No such file or directory")
        })
        .or_else(|| {
            lines
                .iter()
                .copied()
                .find(|line| line.contains("Invalid argument"))
        })
        .or_else(|| {
            lines.iter().copied().find(|line| {
                (line.contains("Error") || line.contains("error") || line.contains("Failed"))
                    && !line.starts_with("Error opening output file")
            })
        })
        .or_else(|| {
            lines
                .iter()
                .copied()
                .find(|line| line.starts_with("Error opening output file"))
        })
        .or_else(|| {
            lines
                .iter()
                .rev()
                .copied()
                .find(|line| !line.starts_with("Fontconfig error:"))
        })
        .or_else(|| lines.first().copied())
        .unwrap_or("FFmpeg failed")
}

fn default_output_relative_path(title: &str) -> String {
    let slug = slugify(title);
    format!(
        "{EXPORTS_DIR}/{slug}-{}.mp4",
        Utc::now().format("%Y%m%d-%H%M%S")
    )
}

fn default_title_card_duration_seconds() -> f64 {
    DEFAULT_TITLE_CARD_DURATION_SECONDS
}

fn default_include_title_card() -> bool {
    true
}

fn default_title_to_first_row_hold_seconds() -> f64 {
    DEFAULT_TITLE_TO_FIRST_ROW_HOLD_DURATION_SECONDS
}

fn default_row_transition_hold_seconds() -> f64 {
    DEFAULT_ROW_TRANSITION_HOLD_SECONDS
}

fn default_final_hold_seconds() -> f64 {
    DEFAULT_FINAL_HOLD_DURATION_SECONDS
}

fn default_row_transition_dip_seconds() -> f64 {
    DEFAULT_ROW_TRANSITION_DIP_SECONDS
}

fn default_narration_tail_hold_seconds() -> f64 {
    DEFAULT_NARRATION_TAIL_HOLD_SECONDS
}

fn default_motion_max_scale() -> f64 {
    DEFAULT_MOTION_MAX_SCALE
}

fn default_video_width() -> u32 {
    DEFAULT_VIDEO_WIDTH
}

fn default_video_height() -> u32 {
    DEFAULT_VIDEO_HEIGHT
}

fn default_video_fps() -> u32 {
    DEFAULT_VIDEO_FPS
}

fn default_video_encoder() -> String {
    DEFAULT_VIDEO_ENCODER.to_string()
}

fn default_video_pixel_format() -> String {
    DEFAULT_VIDEO_PIXEL_FORMAT.to_string()
}

fn default_video_crf() -> String {
    DEFAULT_VIDEO_CRF.to_string()
}

fn default_background_music_volume_db() -> f64 {
    DEFAULT_BACKGROUND_MUSIC_VOLUME_DB
}

fn default_background_music_duck_narration() -> bool {
    true
}

fn default_background_music_fade_seconds() -> f64 {
    DEFAULT_BACKGROUND_MUSIC_FADE_SECONDS
}

fn sanitize_duration(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.max(MIN_ROW_DURATION_SECONDS)
    } else {
        fallback
    }
}

fn sanitize_non_negative_duration(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        fallback
    }
}

fn sanitize_motion_max_scale(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(1.0, 3.0)
    } else {
        DEFAULT_MOTION_MAX_SCALE
    }
}

fn sanitize_video_dimension(value: u32, fallback: u32) -> u32 {
    let even_value = value - (value % 2);
    if (240..=7680).contains(&even_value) {
        even_value
    } else {
        fallback
    }
}

fn sanitize_video_fps(value: u32) -> u32 {
    if (12..=120).contains(&value) {
        value
    } else {
        DEFAULT_VIDEO_FPS
    }
}

fn sanitize_background_music_volume_db(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(-60.0, 0.0)
    } else {
        DEFAULT_BACKGROUND_MUSIC_VOLUME_DB
    }
}

fn sanitize_ffmpeg_token(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if !trimmed.is_empty()
        && trimmed.len() <= 64
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        trimmed.to_string()
    } else {
        fallback.to_string()
    }
}

fn effective_narration_timing(
    source_duration_seconds: f64,
    leading_silence_ms: Option<u32>,
    trailing_silence_ms: Option<u32>,
) -> (f64, f64) {
    let source_duration = source_duration_seconds.max(MIN_ROW_DURATION_SECONDS);
    let leading = leading_silence_ms
        .map(|value| value as f64 / 1000.0)
        .unwrap_or_default()
        .clamp(0.0, source_duration);
    let trailing = trailing_silence_ms
        .map(|value| value as f64 / 1000.0)
        .unwrap_or_default()
        .clamp(0.0, source_duration);
    let trimmed_duration = (source_duration - leading - trailing).max(MIN_ROW_DURATION_SECONDS);

    if leading + trimmed_duration > source_duration {
        (
            (source_duration - trimmed_duration).max(0.0),
            trimmed_duration,
        )
    } else {
        (leading, trimmed_duration)
    }
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "sketch".to_string()
    } else {
        slug.to_string()
    }
}

fn format_duration(seconds: f64) -> String {
    format!("{:.3}", seconds.max(MIN_ROW_DURATION_SECONDS))
}

fn format_seconds(seconds: f64) -> String {
    format!("{:.3}", seconds.max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::sketch::{
        MotionPlan, MotionPlanEasing, MotionPlanKeyframe, MotionPlanKind, NarrationAsset,
        PlanningRow, Sketch, TypingSpot,
    };
    use image::{Rgb, RgbImage};
    use tempfile::TempDir;

    #[test]
    fn slugify_returns_stable_file_safe_name() {
        assert_eq!(slugify("Demo: Login Flow!"), "demo-login-flow");
        assert_eq!(slugify("   "), "sketch");
    }

    #[test]
    fn ffmpeg_failure_message_prefers_the_actionable_encoder_error() {
        let lines = [
            "Error opening output file C:\\demo\\row-001.mp4.",
            "Error initializing output stream 0:0 -- Error while opening encoder for output stream #0:0",
        ];

        assert_eq!(
            ffmpeg_failure_message(&lines),
            "Error initializing output stream 0:0 -- Error while opening encoder for output stream #0:0"
        );
    }

    #[test]
    fn ffmpeg_filter_argument_finds_each_filter_form() {
        let args = vec![
            "-vf".to_string(),
            "scale=1920:1080".to_string(),
            "-af".to_string(),
            "aresample=48000".to_string(),
            "-filter_complex".to_string(),
            "[0:a]anull[a]".to_string(),
        ];

        assert_eq!(
            ffmpeg_filter_argument(&args, "-vf"),
            Some("scale=1920:1080")
        );
        assert_eq!(
            ffmpeg_filter_argument(&args, "-af"),
            Some("aresample=48000")
        );
        assert_eq!(
            ffmpeg_filter_argument(&args, "-filter_complex"),
            Some("[0:a]anull[a]")
        );
        assert_eq!(ffmpeg_filter_argument(&args, "-filter_script"), None);
    }

    #[test]
    fn large_filter_arguments_are_written_to_temporary_scripts() {
        let filter = "null,".repeat(FFMPEG_FILTER_SCRIPT_THRESHOLD_BYTES / 4 + 1);
        let mut args = vec!["-vf".to_string(), filter.clone()];

        let scripts = offload_large_filter_arguments(&mut args, FilterFileSyntax::Legacy).unwrap();

        assert_eq!(args[0], "-filter_script:v");
        assert_eq!(scripts.len(), 1);
        assert_eq!(fs::read_to_string(&scripts[0]).unwrap(), filter);
    }

    #[test]
    fn large_filter_arguments_use_generic_syntax_on_modern_ffmpeg() {
        let filter = "null,".repeat(FFMPEG_FILTER_SCRIPT_THRESHOLD_BYTES / 4 + 1);
        let mut args = vec!["-vf".to_string(), filter.clone()];

        let scripts = offload_large_filter_arguments(&mut args, FilterFileSyntax::Generic).unwrap();

        // FFmpeg 9.0 removed `-filter_script`, so modern builds must receive the
        // generic read-option-from-file flag instead.
        assert_eq!(args[0], "-/vf");
        assert_eq!(scripts.len(), 1);
        assert_eq!(fs::read_to_string(&scripts[0]).unwrap(), filter);
    }

    #[test]
    fn ffmpeg_major_version_parses_release_and_distro_forms() {
        assert_eq!(
            parse_ffmpeg_major_version("ffmpeg version 9.0.1-full_build-www.gyan.dev\n"),
            Some(9)
        );
        assert_eq!(
            parse_ffmpeg_major_version("ffmpeg version 6.1.1 Copyright (c) 2000-2023\n"),
            Some(6)
        );
        assert_eq!(parse_ffmpeg_major_version("ffmpeg version n7.0\n"), Some(7));
        // Non-dotted git builds are unparseable and fall back to legacy.
        assert_eq!(
            parse_ffmpeg_major_version("ffmpeg version N-119000-gabc123\n"),
            None
        );
        assert_eq!(parse_ffmpeg_major_version("not ffmpeg output"), None);
    }

    #[test]
    fn large_video_filter_script_runs_with_ffmpeg() {
        if ensure_ffmpeg_available().is_err() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let output_path = directory.path().join("filter-script.mkv");
        let filter = std::iter::repeat_n("null", FFMPEG_FILTER_SCRIPT_THRESHOLD_BYTES / 4 + 1)
            .collect::<Vec<_>>()
            .join(",");

        run_ffmpeg(vec![
            "-y".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "color=black:s=16x16:r=1".to_string(),
            "-vf".to_string(),
            filter,
            "-frames:v".to_string(),
            "1".to_string(),
            "-c:v".to_string(),
            DEFAULT_VIDEO_ENCODER.to_string(),
            "-crf".to_string(),
            DEFAULT_VIDEO_CRF.to_string(),
            "-pix_fmt".to_string(),
            DEFAULT_VIDEO_PIXEL_FORMAT.to_string(),
            output_path.to_string_lossy().to_string(),
        ])
        .unwrap();

        assert!(output_path.is_file());
    }

    #[test]
    fn typing_reveal_is_compressed_to_finish_within_the_row() {
        let (start, characters_per_second, end) =
            constrained_typing_timing(160, 7.0, None, 18.0, 3.0, 30);

        assert!(start < 3.0);
        assert!(characters_per_second > 18.0);
        assert!((start + 160.0 / characters_per_second - end).abs() < 0.000_001);
        assert_eq!(end, 3.0);
    }

    #[test]
    fn typing_filters_reject_text_beyond_the_animation_limit() {
        let spot = TypingSpot {
            x: 0.2,
            y: 0.3,
            width: 0.4,
            height: 0.1,
            text: "x".repeat(MAX_TYPING_ANIMATION_CHARACTERS + 1),
            start_offset_ms: None,
            duration_ms: None,
            characters_per_second: None,
            show_cursor: None,
            text_color: None,
            font_family: None,
            font_scale: None,
        };

        let error = typing_spot_filters(&[spot], 3.0, false, &SketchVideoExportSettings::default())
            .err()
            .expect("typing text over the limit must be rejected");

        assert!(error.to_string().contains("up to 160 characters"));
    }

    #[test]
    fn ffmpeg_expression_escapes_function_argument_delimiters() {
        let expression = FfmpegExpression::call(
            "if",
            [
                FfmpegExpression::call(
                    "lte",
                    [FfmpegExpression::raw("on"), FfmpegExpression::raw("60")],
                ),
                FfmpegExpression::call(
                    "min",
                    [
                        FfmpegExpression::call(
                            "max",
                            [FfmpegExpression::raw("on-0"), FfmpegExpression::raw("0")],
                        ),
                        FfmpegExpression::raw("1"),
                    ],
                ),
                FfmpegExpression::raw("0.862069"),
            ],
        );

        assert_eq!(
            expression.to_string(),
            r"if(lte(on\,60)\,min(max(on-0\,0)\,1)\,0.862069)"
        );
    }

    #[test]
    fn ffmpeg_filter_builder_serializes_labels_values_and_chains() {
        let text_path = ["font root", "demo's:font.txt"].iter().collect::<PathBuf>();
        let mut graph = FfmpegFilterGraph::new();
        graph.push_chain(FfmpegFilterChain::new([FfmpegFilter::new("drawtext")
            .input("0:v")
            .named("textfile", FfmpegValue::file_path(&text_path))
            .named(
                "enable",
                FfmpegExpression::call(
                    "between",
                    [
                        FfmpegExpression::raw("t"),
                        FfmpegExpression::raw("0"),
                        FfmpegExpression::call(
                            "min",
                            [FfmpegExpression::raw("3"), FfmpegExpression::raw("5")],
                        ),
                    ],
                ),
            )
            .output("caption")]));
        graph.push_chain(FfmpegFilterChain::new([FfmpegFilter::new("anullsrc")
            .named("r", "48000")
            .named("cl", "stereo")
            .output("audio")]));

        assert_eq!(
            graph.render(),
            r"[0:v]drawtext=textfile='font root/demo\\'s\:font.txt':enable='between(t\,0\,min(3\,5))'[caption];anullsrc=r=48000:cl=stereo[audio]"
        );
    }

    #[test]
    fn ffmpeg_filter_builder_escapes_apostrophes_through_the_filter_parser() {
        let filter = FfmpegFilterGraph::chain([
            FfmpegFilter::new("drawtext")
                .named("text", FfmpegValue::text("What's next?"))
                .named(
                    "enable",
                    FfmpegExpression::call(
                        "between",
                        [
                            FfmpegExpression::raw("t"),
                            FfmpegExpression::raw("0"),
                            FfmpegExpression::raw("1"),
                        ],
                    ),
                ),
            FfmpegFilter::new("null"),
        ])
        .render();

        assert!(filter.contains(r"text='What\\'s next?'"));
        assert!(filter.contains(r"enable='between(t\,0\,1)',null"));
    }

    #[test]
    fn typing_text_uses_a_safe_apostrophe_glyph() {
        assert_eq!(safe_drawtext_text("What's next?"), "What\u{2019}s next?");
    }

    #[test]
    fn duration_is_clamped_and_formatted_for_ffmpeg() {
        assert_eq!(format_duration(2.5), "2.500");
        assert_eq!(format_duration(0.0), "0.100");
        assert_eq!(format_seconds(0.0), "0.000");
    }

    #[test]
    fn video_export_settings_default_to_including_title_card() {
        let settings: SketchVideoExportSettings = serde_json::from_str("{}").unwrap();
        assert!(settings.include_title_card);

        let settings: SketchVideoExportSettings =
            serde_json::from_str(r#"{"includeTitleCard":false}"#).unwrap();
        assert!(!settings.normalized().include_title_card);
    }

    #[test]
    fn background_music_filter_loops_ducks_and_fades_music() {
        let settings = SketchVideoExportSettings {
            background_music_volume_db: -18.0,
            background_music_duck_narration: true,
            background_music_fade_seconds: 0.75,
            ..SketchVideoExportSettings::default()
        }
        .normalized();
        let filter = background_music_filter("12.000".to_string(), 0.75, 11.25, &settings);

        assert!(filter.contains("atrim=0:12.000"));
        assert!(filter.contains("volume=-18dB"));
        assert!(filter.contains("afade=t=in:st=0:d=0.750"));
        assert!(filter.contains("afade=t=out:st=11.250:d=0.750"));
        assert!(filter.contains("sidechaincompress"));
        assert!(filter.contains("amix=inputs=2:duration=first"));
    }

    #[test]
    fn background_music_preview_duration_is_at_least_ten_seconds() {
        assert_eq!(background_music_preview_duration(Some(3.5), None), 10.0);
        assert_eq!(background_music_preview_duration(None, Some(8.0)), 10.0);
        assert_eq!(
            background_music_preview_duration(Some(12.25), Some(4.0)),
            12.25
        );
        assert_eq!(background_music_preview_duration(Some(90.0), None), 20.0);
    }

    #[test]
    fn background_music_preview_uses_the_selected_cached_voice_sample() {
        let directory = tempfile::tempdir().unwrap();
        let voice_name = "en-US-Harper:MAI-Voice-2";
        let output_format = "riff-24khz-16bit-mono-pcm";
        let saved = narration_preview::save_voice_preview(
            directory.path(),
            voice_name,
            output_format,
            &[1, 2, 3],
        )
        .unwrap();
        let settings = BackgroundMusicPreviewSettings {
            background_music_path: "background-music/demo.wav".to_string(),
            narration_voice_name: voice_name.to_string(),
            narration_voice_output_format: output_format.to_string(),
            background_music_volume_db: -24.0,
            background_music_duck_narration: true,
            background_music_fade_seconds: 0.5,
        };

        let resolved = resolve_preview_narration_path(directory.path(), &settings).unwrap();

        assert_eq!(resolved.to_string_lossy(), saved);
    }

    #[test]
    fn background_music_preview_filter_pads_short_narration() {
        let settings = SketchVideoExportSettings {
            background_music_duck_narration: true,
            ..SketchVideoExportSettings::default()
        }
        .normalized();
        let filter = background_music_preview_filter("10.000".to_string(), 1.0, 9.0, &settings);

        assert!(filter.contains("[0:a]apad,atrim=0:10.000"));
        assert!(filter.contains("[previewNarration]"));
        assert!(filter.contains("[music][previewNarration]sidechaincompress"));
        assert!(filter.contains("[previewNarration][ducked]amix=inputs=2:duration=first"));
    }

    #[test]
    fn narration_audio_filter_uses_recorded_audio_without_loudness_treatment() {
        let unchanged = narration_audio_filter("0.500", "3.000", "3.350");
        assert!(!unchanged.contains("loudnorm"));
        assert_eq!(
            unchanged,
            "atrim=start=0.500:duration=3.000,asetpts=PTS-STARTPTS,apad,atrim=duration=3.350,aresample=48000,aformat=channel_layouts=stereo"
        );
    }

    #[test]
    fn export_timeline_timing_keeps_row_content_and_transitions_separate() {
        let settings = SketchVideoExportSettings {
            title_card_duration_seconds: 3.0,
            title_to_first_row_hold_seconds: 0.5,
            row_transition_hold_seconds: 2.0,
            final_hold_seconds: 4.0,
            narration_tail_hold_seconds: 0.35,
            ..SketchVideoExportSettings::default()
        };
        let segments = vec![
            test_row_segment(1, 1.0, settings.narration_tail_hold_seconds),
            test_row_segment(2, 1.5, settings.narration_tail_hold_seconds),
        ];

        let timing = export_timeline_timing(&segments, &settings);

        assert_seconds(timing.title_card_seconds, 3.0);
        assert_seconds(timing.lead_in_seconds, 0.5);
        assert_seconds(timing.row_content_seconds, 3.2);
        assert_seconds(timing.interior_transition_seconds, 2.0);
        assert_seconds(timing.final_hold_seconds, 4.0);
        assert_seconds(timing.total_seconds(), 12.7);
    }

    #[test]
    fn export_timeline_timing_preserves_terminal_narration_tail_without_terminal_transition() {
        let settings = SketchVideoExportSettings {
            include_title_card: false,
            title_to_first_row_hold_seconds: 0.5,
            row_transition_hold_seconds: 9.0,
            final_hold_seconds: 3.0,
            narration_tail_hold_seconds: 0.4,
            ..SketchVideoExportSettings::default()
        };
        let segments = vec![test_row_segment(
            1,
            2.0,
            settings.narration_tail_hold_seconds,
        )];

        let timing = export_timeline_timing(&segments, &settings);

        assert_seconds(row_content_duration_seconds(2.0, 0.0, &settings), 2.4);
        assert_seconds(segments[0].duration_seconds, 2.4);
        assert_seconds(timing.title_card_seconds, 0.0);
        assert_seconds(timing.lead_in_seconds, 0.5);
        assert_seconds(timing.row_content_seconds, 2.4);
        assert_seconds(timing.interior_transition_seconds, 0.0);
        assert_seconds(timing.final_hold_seconds, 3.0);
        assert_seconds(timing.total_seconds(), 5.9);
    }

    #[test]
    fn row_content_duration_extends_to_resolved_demo_playback() {
        let settings = SketchVideoExportSettings {
            narration_tail_hold_seconds: 0.4,
            ..SketchVideoExportSettings::default()
        };

        assert_seconds(row_content_duration_seconds(2.0, 5.0, &settings), 5.4);
        assert_seconds(row_content_duration_seconds(5.0, 2.0, &settings), 5.4);
    }

    #[test]
    fn generated_resolved_demo_requires_screenshots_for_every_row() {
        let mut sketch = Sketch::new("Generated demo");
        let mut first = PlanningRow::new();
        first.screenshot = Some("screenshots/first.png".to_string());
        let mut second = PlanningRow::new();
        second.screenshot = Some("  ".to_string());
        sketch.rows = vec![first, second, PlanningRow::new()];

        assert_eq!(rows_missing_screenshots(&sketch), vec![2, 3]);
    }

    #[test]
    fn load_resolved_demo_reads_project_relative_schema() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let schema_dir = root.join(".cutready").join("scenecast");
        std::fs::create_dir_all(&schema_dir).unwrap();
        std::fs::write(
            schema_dir.join("resolved-demo.json"),
            include_str!("../../fixtures/scenecast/resolved-demo.json"),
        )
        .unwrap();

        let demo = load_resolved_demo(root, ".cutready/scenecast/resolved-demo.json", 2).unwrap();

        assert_eq!(demo.demo.schema_version, "scenecast.resolved-demo.v1");
        assert_eq!(demo.demo.row_playback_duration_seconds(1), Some(1.25));
        assert_eq!(demo.demo.row_playback_duration_seconds(2), Some(1.0));
        assert_eq!(demo.asset_base_dir, schema_dir);
        assert!(load_resolved_demo(root, "../resolved-demo.json", 1).is_err());
    }

    #[test]
    fn load_resolved_demo_rejects_unsupported_schema_version_before_typed_parse() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        std::fs::write(
            root.join("resolved-demo.json"),
            serde_json::json!({
                "schemaVersion": "scenecast.resolved-demo.v2",
                "title": "Future shape"
            })
            .to_string(),
        )
        .unwrap();

        assert!(load_resolved_demo(root, "resolved-demo.json", 1)
            .unwrap_err()
            .to_string()
            .contains("Unsupported resolved demo schemaVersion"));
    }

    #[test]
    fn inspect_resolved_demo_reports_row_coverage_and_assets() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let schema_dir = root.join(".cutready").join("scenecast");
        let captures_dir = schema_dir.join("captures");
        let frames_dir = schema_dir.join("frames");
        fs::create_dir_all(&captures_dir).unwrap();
        fs::create_dir_all(&frames_dir).unwrap();
        fs::write(captures_dir.join("row-1.png"), b"capture").unwrap();
        fs::write(frames_dir.join("row-1.png"), b"frame").unwrap();
        fs::write(
            schema_dir.join("resolved-demo.json"),
            serde_json::json!({
                "schemaVersion": "scenecast.resolved-demo.v1",
                "title": "Demo",
                "startSceneId": "start",
                "capturePolicy": {
                    "kind": "reference-existing-assets",
                    "assetBase": "bundle-relative",
                    "missingCaptureBehavior": "diagnostic"
                },
                "steps": [
                    {
                        "id": "step-start",
                        "order": 0,
                        "sceneId": "start",
                        "title": "Start",
                        "targets": [],
                        "guideMarks": []
                    },
                    {
                        "id": "step-empty",
                        "order": 1,
                        "sceneId": "empty",
                        "title": "Empty",
                        "targets": [],
                        "guideMarks": []
                    }
                ],
                "segments": [{
                    "id": "segment-start",
                    "kind": "scene",
                    "stepId": "step-start",
                    "startMs": 0,
                    "durationMs": 250,
                    "endMs": 250,
                    "capture": { "path": "captures/stale.png" },
                    "interaction": null,
                    "frames": [{ "path": "frames/row-1.png", "durationMs": 250 }],
                    "waitMs": 0
                }],
                "diagnostics": [{
                    "severity": "warning",
                    "code": "demo_note",
                    "message": "Informational warning"
                }]
            })
            .to_string(),
        )
        .unwrap();

        let inspection =
            inspect_resolved_demo(root, ".cutready/scenecast/resolved-demo.json", 2).unwrap();

        assert!(inspection.can_export);
        assert_eq!(inspection.title, "Demo");
        assert_eq!(inspection.diagnostic_count, 1);
        assert_eq!(inspection.rows.len(), 2);
        assert_eq!(inspection.rows[0].step_count, 1);
        assert_eq!(inspection.rows[0].segment_count, 1);
        assert_eq!(inspection.rows[0].media_asset_count, 1);
        assert_eq!(inspection.rows[0].missing_asset_count, 0);
        assert_seconds(inspection.rows[0].duration_seconds.unwrap(), 0.25);
        assert_eq!(inspection.rows[1].step_count, 1);
        assert_eq!(inspection.rows[1].segment_count, 0);
        assert_eq!(inspection.rows[1].duration_seconds, None);
        assert_eq!(inspection.rows[1].media_asset_count, 0);
    }

    #[test]
    fn inspect_resolved_demo_returns_blocking_diagnostic_as_data() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        fs::write(
            root.join("resolved-demo.json"),
            serde_json::json!({
                "schemaVersion": "scenecast.resolved-demo.v1",
                "title": "Demo",
                "startSceneId": "start",
                "capturePolicy": {
                    "kind": "reference-existing-assets",
                    "assetBase": "bundle-relative",
                    "missingCaptureBehavior": "diagnostic"
                },
                "steps": [],
                "segments": [],
                "diagnostics": [{
                    "severity": "error",
                    "code": "missing_scene",
                    "message": "Scene could not be resolved"
                }]
            })
            .to_string(),
        )
        .unwrap();

        let inspection = inspect_resolved_demo(root, "resolved-demo.json", 1).unwrap();

        assert!(!inspection.can_export);
        assert!(inspection
            .blocking_error
            .as_deref()
            .unwrap()
            .contains("missing_scene"));
        assert_eq!(inspection.diagnostics[0].severity, "error");
    }

    #[test]
    fn resolved_demo_media_becomes_manifest_relative_frame_sequence() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let schema_dir = root.join(".cutready").join("scenecast");
        let frames_dir = schema_dir.join("frames");
        let captures_dir = schema_dir.join("captures");
        fs::create_dir_all(&frames_dir).unwrap();
        fs::create_dir_all(&captures_dir).unwrap();
        fs::write(frames_dir.join("open.png"), b"frame").unwrap();
        fs::write(frames_dir.join("settled.png"), b"frame").unwrap();
        fs::write(captures_dir.join("terminal.png"), b"frame").unwrap();
        fs::write(
            schema_dir.join("resolved-demo.json"),
            serde_json::json!({
                "schemaVersion": "scenecast.resolved-demo.v1",
                "title": "Demo",
                "startSceneId": "start",
                "capturePolicy": {
                    "kind": "reference-existing-assets",
                    "assetBase": "bundle-relative",
                    "missingCaptureBehavior": "diagnostic"
                },
                "steps": [{
                    "id": "step-start",
                    "order": 0,
                    "sceneId": "start",
                    "title": "Start",
                    "targets": [],
                    "guideMarks": []
                }],
                "segments": [
                    {
                        "id": "segment-open",
                        "kind": "scene",
                        "stepId": "step-start",
                        "startMs": 0,
                        "durationMs": 100,
                        "endMs": 100,
                        "capture": null,
                        "interaction": null,
                        "frames": [
                            { "path": "frames/open.png", "durationMs": 100 },
                            { "path": "frames/settled.png", "durationMs": 200 }
                        ],
                        "waitMs": 0
                    },
                    {
                        "id": "segment-terminal",
                        "kind": "scene",
                        "stepId": "step-start",
                        "startMs": 100,
                        "durationMs": 300,
                        "endMs": 400,
                        "capture": { "path": "captures/terminal.png" },
                        "interaction": null,
                        "frames": [],
                        "waitMs": 0
                    }
                ],
                "diagnostics": []
            })
            .to_string(),
        )
        .unwrap();

        let loaded = load_resolved_demo(root, ".cutready/scenecast/resolved-demo.json", 1).unwrap();
        let sequence = resolved_demo_frame_sequence_for_row(&loaded, 1, 1.2, 10)
            .unwrap()
            .expect("resolved demo row media should create a frame sequence");

        assert_eq!(sequence.frames.len(), 3);
        assert_eq!(sequence.frames[0].path, frames_dir.join("open.png"));
        assert_seconds(sequence.frames[0].duration_seconds, 0.1);
        assert_eq!(sequence.frames[1].path, frames_dir.join("settled.png"));
        assert_seconds(sequence.frames[1].duration_seconds, 0.2);
        assert_eq!(sequence.frames[2].path, captures_dir.join("terminal.png"));
        assert_seconds(sequence.frames[2].duration_seconds, 0.9);
        match sequence.fit {
            FrameSequenceFit::Held { hold_seconds } => assert_seconds(hold_seconds, 0.9),
            fit => panic!("expected held frame sequence, got {fit:?}"),
        }
    }

    #[test]
    fn resolved_demo_media_requires_existing_safe_assets() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let schema_dir = root.join(".cutready").join("scenecast");
        fs::create_dir_all(&schema_dir).unwrap();
        fs::write(
            schema_dir.join("resolved-demo.json"),
            serde_json::json!({
                "schemaVersion": "scenecast.resolved-demo.v1",
                "title": "Demo",
                "startSceneId": "start",
                "capturePolicy": {
                    "kind": "reference-existing-assets",
                    "assetBase": "bundle-relative",
                    "missingCaptureBehavior": "diagnostic"
                },
                "steps": [{
                    "id": "step-start",
                    "order": 0,
                    "sceneId": "start",
                    "title": "Start",
                    "targets": [],
                    "guideMarks": []
                }],
                "segments": [{
                    "id": "segment-start",
                    "kind": "scene",
                    "stepId": "step-start",
                    "startMs": 0,
                    "durationMs": 100,
                    "endMs": 100,
                    "capture": { "path": "captures/missing.png" },
                    "interaction": null,
                    "frames": [],
                    "waitMs": 0
                }],
                "diagnostics": []
            })
            .to_string(),
        )
        .unwrap();

        let loaded = load_resolved_demo(root, ".cutready/scenecast/resolved-demo.json", 1).unwrap();
        assert!(resolved_demo_frame_sequence_for_row(&loaded, 1, 1.0, 10)
            .unwrap_err()
            .to_string()
            .contains("Resolved demo asset does not exist"));
    }

    #[test]
    fn load_visual_frame_sequence_accepts_manifest_relative_sparse_paths() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let export_dir = root.join(".cutready").join("visuals").join("hero-export");
        let frames_dir = export_dir.join("frames");
        std::fs::create_dir_all(&frames_dir).unwrap();
        std::fs::write(frames_dir.join("open-state.png"), b"not decoded by loader").unwrap();
        std::fs::write(frames_dir.join("zoomed-end.png"), b"not decoded by loader").unwrap();
        std::fs::write(
            export_dir.join("manifest.json"),
            serde_json::json!({
                "frames": [
                    { "path": "frames/open-state.png", "duration_ms": 100, "terminal": false },
                    { "path": "frames/zoomed-end.png", "duration_ms": 0, "terminal": true }
                ]
            })
            .to_string(),
        )
        .unwrap();

        let plan = load_visual_frame_sequence(
            root,
            ".cutready/visuals/hero-export/manifest.json",
            0.3,
            10,
        )
        .unwrap();

        assert_eq!(plan.frames.len(), 2);
        assert_seconds(plan.frames[0].duration_seconds, 0.1);
        assert_seconds(plan.frames[1].duration_seconds, 0.2);
        assert!(plan.frames[0].path.ends_with("frames/open-state.png"));
        assert!(load_visual_frame_sequence(root, "../manifest.json", 0.3, 10).is_err());
    }

    #[test]
    fn planned_frame_counts_preserve_total_for_sub_100ms_frames() {
        let plan = FrameSequencePlan {
            frames: vec![
                crate::engine::frame_sequence::PlannedFrame {
                    path: PathBuf::from("intro.png"),
                    duration_seconds: 0.017,
                },
                crate::engine::frame_sequence::PlannedFrame {
                    path: PathBuf::from("open.png"),
                    duration_seconds: 0.017,
                },
                crate::engine::frame_sequence::PlannedFrame {
                    path: PathBuf::from("rest.png"),
                    duration_seconds: 0.066,
                },
            ],
            total_seconds: 0.1,
            fit: FrameSequenceFit::Held {
                hold_seconds: 0.066,
            },
        };

        let counts = planned_frame_counts(&plan, 60).unwrap();

        assert_eq!(counts, vec![1, 1, 4]);
        assert_eq!(counts.iter().sum::<u32>(), 6);
    }

    #[test]
    fn hold_video_filter_adds_dip_to_black_for_row_transitions() {
        let settings = SketchVideoExportSettings::default();
        let fade_out = FfmpegFilterGraph::chain(hold_video_filters(
            vec![FfmpegFilter::new("base")],
            0.5,
            HoldTransition::FadeOutToBlack,
            &settings,
        ))
        .render();
        assert_eq!(fade_out, "base,fade=t=out:st=0.150:d=0.350:color=black");

        let fade_in = FfmpegFilterGraph::chain(hold_video_filters(
            vec![FfmpegFilter::new("base")],
            0.5,
            HoldTransition::FadeInFromBlack,
            &settings,
        ))
        .render();
        assert_eq!(fade_in, "base,fade=t=in:st=0:d=0.350:color=black");

        let unchanged = FfmpegFilterGraph::chain(hold_video_filters(
            vec![FfmpegFilter::new("base")],
            3.0,
            HoldTransition::None,
            &settings,
        ))
        .render();
        assert_eq!(unchanged, "base");
    }

    #[test]
    fn motion_image_video_filter_renders_zoompan_from_keyframes() {
        let plan = MotionPlan {
            kind: MotionPlanKind::SubtlePush,
            keyframes: vec![
                MotionPlanKeyframe {
                    time_ms: 0,
                    scale: 1.0,
                    x: 0.5,
                    y: 0.5,
                    easing: Some(MotionPlanEasing::EaseOut),
                },
                MotionPlanKeyframe {
                    time_ms: 2_000,
                    scale: 1.16,
                    x: 0.62,
                    y: 0.41,
                    easing: Some(MotionPlanEasing::EaseOut),
                },
            ],
            rationale: None,
        };

        let settings = SketchVideoExportSettings::default();
        let end_crop = motion_crop_rect(&plan.keyframes[1], settings.motion_max_scale);
        assert!((end_crop.width - 0.862069).abs() < 0.000001);
        assert!((end_crop.x - 0.137931).abs() < 0.000001);
        assert_eq!(end_crop.y, 0.0);

        let filter = motion_image_video_filter(&plan, &[], 3.0, &settings).unwrap();
        assert!(filter.contains("zoompan=z='1/(if(lte(on\\,60)\\,1.000000+((0.862069-1.000000)*(min(max(on-0\\,0)/60\\,1)))\\,0.862069))'"));
        assert!(filter.contains(":x='iw*(if(lte(on\\,60)\\,"));
        assert!(filter.contains(":y='ih*(if(lte(on\\,60)\\,"));
        assert!(filter.contains("d=90"));
    }

    #[test]
    fn typing_spots_render_before_zoompan_with_incremental_text() {
        let plan = MotionPlan {
            kind: MotionPlanKind::SubtlePush,
            keyframes: vec![
                MotionPlanKeyframe {
                    time_ms: 0,
                    scale: 1.0,
                    x: 0.5,
                    y: 0.5,
                    easing: Some(MotionPlanEasing::Linear),
                },
                MotionPlanKeyframe {
                    time_ms: 1_000,
                    scale: 1.2,
                    x: 0.6,
                    y: 0.4,
                    easing: Some(MotionPlanEasing::Linear),
                },
            ],
            rationale: None,
        };
        let spots = [TypingSpot {
            x: 0.2,
            y: 0.3,
            width: 0.4,
            height: 0.1,
            text: "Go".into(),
            start_offset_ms: Some(500),
            duration_ms: None,
            characters_per_second: Some(10.0),
            show_cursor: Some(true),
            text_color: Some("#ffcc00".into()),
            font_family: Some("mono".into()),
            font_scale: Some(1.2),
        }];

        let filter =
            motion_image_video_filter(&plan, &spots, 2.0, &SketchVideoExportSettings::default())
                .unwrap();

        assert!(filter.contains("text='G|'"));
        assert!(filter.contains("text='Go|'"));
        assert!(filter.contains("fontcolor=0xffcc00"));
        assert!(filter.contains("fontfile='/Windows/Fonts/consola.ttf'"));
        assert!(filter.contains("between(t\\,0.500\\,0.600)"));
        assert!(filter.contains("between(t\\,0.600\\,2.000)"));
        assert!(filter.contains("x='w*0.206250'"));
        assert!(filter.contains("y='h*0.307407+ascent'"));
        assert!(!filter.contains("box="));
        assert!(!filter.contains("boxcolor="));
        assert!(filter.find("drawtext=").unwrap() < filter.find("zoompan=").unwrap());

        let completed = FfmpegFilterGraph::chain(
            still_image_video_filters(&spots, 2.0, true, &SketchVideoExportSettings::default())
                .unwrap(),
        )
        .render();
        assert!(completed.contains("text='Go'"));
        assert!(!completed.contains("text='G|'"));
        assert!(!completed.contains("enable="));
    }

    #[test]
    fn motion_image_video_filter_preserves_intermediate_keyframes() {
        let plan = MotionPlan {
            kind: MotionPlanKind::WideHoldThenPush,
            keyframes: vec![
                MotionPlanKeyframe {
                    time_ms: 0,
                    scale: 1.0,
                    x: 0.5,
                    y: 0.5,
                    easing: Some(MotionPlanEasing::Linear),
                },
                MotionPlanKeyframe {
                    time_ms: 1_000,
                    scale: 1.0,
                    x: 0.5,
                    y: 0.5,
                    easing: Some(MotionPlanEasing::Linear),
                },
                MotionPlanKeyframe {
                    time_ms: 2_000,
                    scale: 1.16,
                    x: 0.62,
                    y: 0.41,
                    easing: Some(MotionPlanEasing::Linear),
                },
            ],
            rationale: None,
        };

        let settings = SketchVideoExportSettings::default();
        let filter = motion_image_video_filter(&plan, &[], 3.0, &settings).unwrap();
        assert!(filter.contains("if(lte(on\\,30)\\,"));
        assert!(filter.contains("if(lte(on\\,60)\\,"));
        assert!(filter.contains("min(max(on-30\\,0)/30\\,1)"));
    }

    #[test]
    fn motion_final_frame_filter_holds_last_camera_position() {
        let plan = MotionPlan {
            kind: MotionPlanKind::SubtlePush,
            keyframes: vec![
                MotionPlanKeyframe {
                    time_ms: 0,
                    scale: 1.0,
                    x: 0.5,
                    y: 0.5,
                    easing: Some(MotionPlanEasing::Linear),
                },
                MotionPlanKeyframe {
                    time_ms: 2_000,
                    scale: 1.16,
                    x: 0.62,
                    y: 0.41,
                    easing: Some(MotionPlanEasing::Linear),
                },
            ],
            rationale: None,
        };

        let settings = SketchVideoExportSettings::default();
        let end_crop = motion_crop_rect(&plan.keyframes[1], settings.motion_max_scale);
        assert!((end_crop.width - 0.862069).abs() < 0.000001);
        assert!((end_crop.x - 0.137931).abs() < 0.000001);
        assert_eq!(end_crop.y, 0.0);

        let filter = motion_final_frame_video_filter(&plan, &[], &settings).unwrap();
        assert!(filter.contains("zoompan=z='1/0.862069'"));
        assert!(filter.contains(":x='iw*("));
        assert!(filter.contains(":y='ih*(0.000000)'"));
    }

    #[test]
    fn motion_crop_rect_allows_deeper_pushes() {
        let keyframe = MotionPlanKeyframe {
            time_ms: 1_000,
            scale: 1.65,
            x: 0.5,
            y: 0.5,
            easing: Some(MotionPlanEasing::Linear),
        };

        let settings = SketchVideoExportSettings::default();
        let crop = motion_crop_rect(&keyframe, settings.motion_max_scale);
        assert!((crop.width - 0.606061).abs() < 0.000001);
        assert!((crop.x - 0.196970).abs() < 0.000001);
        assert!((crop.y - 0.196970).abs() < 0.000001);
    }

    #[test]
    fn effective_source_duration_uses_longer_probe_result() {
        assert_eq!(
            effective_source_duration_seconds(Some(2.0), Some(2.4)),
            Some(2.4)
        );
        assert_eq!(
            effective_source_duration_seconds(Some(2.4), Some(2.0)),
            Some(2.4)
        );
        assert_eq!(
            effective_source_duration_seconds(Some(2.0), None),
            Some(2.0)
        );
        assert_eq!(
            effective_source_duration_seconds(Some(0.0), Some(f64::NAN)),
            None
        );
    }

    #[test]
    fn effective_narration_timing_trims_silence_metadata() {
        let (start, duration) = effective_narration_timing(5.0, Some(700), Some(1200));
        assert_eq!(format_seconds(start), "0.700");
        assert_eq!(format_duration(duration), "3.100");
    }

    #[test]
    fn effective_narration_timing_preserves_full_audio_with_zero_silence_metadata() {
        let (start, duration) = effective_narration_timing(5.0, Some(0), Some(0));
        assert_eq!(format_seconds(start), "0.000");
        assert_eq!(format_duration(duration), "5.000");
    }

    #[test]
    fn effective_narration_timing_keeps_a_minimum_span_when_silence_overlaps() {
        let (start, duration) = effective_narration_timing(1.0, Some(900), Some(900));
        assert_eq!(format_seconds(start), "0.900");
        assert_eq!(format_duration(duration), "0.100");
    }

    #[test]
    fn description_text_extracts_rich_text_without_node_type_names() {
        let value = serde_json::json!([
            {
                "type": "paragraph",
                "children": [
                    { "text": "A crisp product demo" },
                    { "text": " from sketch rows." }
                ]
            }
        ]);

        assert_eq!(
            description_text(&value),
            "A crisp product demo from sketch rows."
        );
    }

    #[test]
    fn title_card_filter_includes_escaped_title_and_description() {
        let mut sketch = Sketch::new("Demo: Export, Now 100%");
        sketch.description = serde_json::json!([{ "type": "paragraph", "children": [{ "text": "Direction's script, A [B]" }] }]);

        let settings = SketchVideoExportSettings::default();
        let filter = title_card_filter(&sketch, &settings);
        assert!(filter.contains("drawtext=text='Demo\\: Export\\, Now 100\\%'"));
        assert!(filter.contains("text='Direction’s script\\, A \\[B\\]'"));
        assert!(!filter.contains("paragraph"));
    }

    #[test]
    fn ffmpeg_filter_builder_escapes_filter_safe_paths() {
        let path = ["font root", "demo's:font.ttf"].iter().collect::<PathBuf>();
        assert_eq!(
            FfmpegValue::file_path(&path).render(),
            r"'font root/demo\\'s\:font.ttf'"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ffmpeg_filter_builder_keeps_windows_drive_prefix() {
        assert_eq!(
            FfmpegValue::file_path(Path::new(r"C:\cutready\rko\title-card.txt")).render(),
            r"'C\:/cutready/rko/title-card.txt'"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ffmpeg_filter_builder_strips_windows_font_drive_prefix() {
        assert_eq!(
            FfmpegValue::font_path(Path::new(r"C:\Windows\Fonts\segoeui.ttf")).render(),
            r"'/Windows/Fonts/segoeui.ttf'"
        );
    }

    #[test]
    fn export_sketch_video_combines_typing_camera_motion_and_audio_when_ffmpeg_is_available() {
        if ensure_ffmpeg_available().is_err() {
            eprintln!("Skipping sketch video export smoke test because FFmpeg is unavailable");
            return;
        }

        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        fs::create_dir_all(root.join(".cutready/screenshots")).unwrap();
        fs::create_dir_all(root.join(".cutready/narration")).unwrap();

        let screenshot_path = root.join(".cutready/screenshots/row-1.png");
        RgbImage::from_pixel(320, 180, Rgb([120, 90, 200]))
            .save(&screenshot_path)
            .unwrap();

        let narration_path = root.join(".cutready/narration/row-1.wav");
        run_ffmpeg(vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "sine=frequency=440:duration=0.25".to_string(),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            narration_path.to_string_lossy().to_string(),
        ])
        .unwrap();

        let mut sketch = Sketch::new("Tiny Export");
        let mut row = PlanningRow::new();
        row.screenshot = Some(".cutready/screenshots/row-1.png".to_string());
        row.typing_spots = vec![TypingSpot {
            x: 0.2,
            y: 0.25,
            width: 0.5,
            height: 0.12,
            text: "What's next?".to_string(),
            start_offset_ms: Some(0),
            duration_ms: None,
            characters_per_second: Some(24.0),
            show_cursor: Some(true),
            text_color: Some("#ffffff".to_string()),
            font_family: Some("sans".to_string()),
            font_scale: Some(1.0),
        }];
        row.motion_plan = Some(MotionPlan {
            kind: MotionPlanKind::SubtlePush,
            keyframes: vec![
                MotionPlanKeyframe {
                    time_ms: 0,
                    scale: 1.0,
                    x: 0.5,
                    y: 0.5,
                    easing: Some(MotionPlanEasing::Linear),
                },
                MotionPlanKeyframe {
                    time_ms: 250,
                    scale: 1.1,
                    x: 0.55,
                    y: 0.45,
                    easing: Some(MotionPlanEasing::Linear),
                },
            ],
            rationale: None,
        });
        row.narration = Some(NarrationAsset {
            path: ".cutready/narration/row-1.wav".to_string(),
            source_text: "Hello".to_string(),
            source_text_hash: "hash".to_string(),
            mime_type: "audio/wav".to_string(),
            duration_ms: Some(250),
            leading_silence_ms: None,
            trailing_silence_ms: None,
            silence_threshold_db: None,
            byte_size: narration_path.metadata().unwrap().len(),
            recorded_at: Utc::now(),
        });
        sketch.rows = vec![row];
        project::write_sketch(&sketch, &root.join("tiny.sk"), root).unwrap();

        let export = export_sketch_video(root, "tiny.sk", None).unwrap();
        assert_eq!(export.row_count, 1);
        let output = PathBuf::from(&export.path);
        assert!(output.starts_with(root.join("exports")));
        assert!(output
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with("tiny-export-") && name.ends_with(".mp4")));
        assert!(output.is_file());
        assert!(output.metadata().unwrap().len() > 0);
    }

    #[test]
    fn export_sketch_video_uses_requested_absolute_output_when_ffmpeg_is_available() {
        if ensure_ffmpeg_available().is_err() {
            eprintln!("Skipping sketch video export smoke test because FFmpeg is unavailable");
            return;
        }

        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        fs::create_dir_all(root.join(".cutready/screenshots")).unwrap();
        fs::create_dir_all(root.join(".cutready/narration")).unwrap();

        let screenshot_path = root.join(".cutready/screenshots/row-1.png");
        RgbImage::from_pixel(320, 180, Rgb([90, 120, 200]))
            .save(&screenshot_path)
            .unwrap();

        let narration_path = root.join(".cutready/narration/row-1.wav");
        run_ffmpeg(vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "sine=frequency=330:duration=0.25".to_string(),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            narration_path.to_string_lossy().to_string(),
        ])
        .unwrap();

        let mut sketch = Sketch::new("Custom Export");
        let mut row = PlanningRow::new();
        row.screenshot = Some(".cutready/screenshots/row-1.png".to_string());
        row.narration = Some(NarrationAsset {
            path: ".cutready/narration/row-1.wav".to_string(),
            source_text: "Hello".to_string(),
            source_text_hash: "hash".to_string(),
            mime_type: "audio/wav".to_string(),
            duration_ms: Some(250),
            leading_silence_ms: None,
            trailing_silence_ms: None,
            silence_threshold_db: None,
            byte_size: narration_path.metadata().unwrap().len(),
            recorded_at: Utc::now(),
        });
        sketch.rows = vec![row];
        project::write_sketch(&sketch, &root.join("custom.sk"), root).unwrap();

        let output_path = temp_dir.path().join("outside-project-custom-name.mp4");
        let export = export_sketch_video(root, "custom.sk", Some(output_path.as_path())).unwrap();
        assert_eq!(export.path, output_path.to_string_lossy().to_string());
        assert!(output_path.is_file());
    }

    #[test]
    fn export_sketch_video_renders_visual_frame_manifest_duration() {
        if ensure_ffmpeg_available().is_err() {
            eprintln!("Skipping visual frame manifest export test because FFmpeg is unavailable");
            return;
        }

        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let frame_dir = root.join(".cutready").join("visuals").join("hero-export");
        fs::create_dir_all(&frame_dir).unwrap();
        let frames = [
            ("intro-frame.png", Rgb([200, 60, 60])),
            ("dropdown-open-frame.png", Rgb([60, 200, 60])),
            ("zoomed-rest-frame.png", Rgb([60, 60, 200])),
        ];
        for (name, color) in frames {
            RgbImage::from_pixel(32, 18, color)
                .save(frame_dir.join(name))
                .unwrap();
        }
        fs::write(
            frame_dir.join("manifest.json"),
            serde_json::json!({
                "frames": [
                    { "path": "intro-frame.png", "duration_ms": 17, "terminal": false },
                    { "path": "dropdown-open-frame.png", "duration_ms": 17, "terminal": false },
                    { "path": "zoomed-rest-frame.png", "duration_ms": 0, "terminal": true }
                ]
            })
            .to_string(),
        )
        .unwrap();

        let narration_path = root.join("row-1.wav");
        run_ffmpeg(vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "sine=frequency=440:duration=0.1".to_string(),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            narration_path.to_string_lossy().to_string(),
        ])
        .unwrap();

        let mut sketch = Sketch::new("Frame Manifest Export");
        let mut row = PlanningRow::new();
        row.screenshot = None;
        row.narration = Some(NarrationAsset {
            path: "row-1.wav".to_string(),
            source_text: "Hello".to_string(),
            source_text_hash: "hash".to_string(),
            mime_type: "audio/wav".to_string(),
            duration_ms: Some(100),
            leading_silence_ms: None,
            trailing_silence_ms: None,
            silence_threshold_db: None,
            byte_size: narration_path.metadata().unwrap().len(),
            recorded_at: Utc::now(),
        });
        sketch.rows = vec![row];
        project::write_sketch(&sketch, &root.join("frame-manifest.sk"), root).unwrap();

        let output = root.join("frame-manifest.mp4");
        let settings = SketchVideoExportSettings {
            include_title_card: false,
            title_to_first_row_hold_seconds: 0.0,
            final_hold_seconds: 0.0,
            narration_tail_hold_seconds: 0.0,
            video_width: 32,
            video_height: 18,
            video_fps: 60,
            visual_frame_manifest_paths: vec![Some(
                ".cutready/visuals/hero-export/manifest.json".to_string(),
            )],
            ..SketchVideoExportSettings::default()
        };
        let export = export_sketch_video_with_progress(
            root,
            root,
            "frame-manifest.sk",
            Some(&output),
            settings,
            |_| {},
        )
        .unwrap();

        assert_seconds(export.duration_seconds, 0.3);
        let actual_duration = probe_media_duration_seconds(&output).unwrap();
        assert!(
            (actual_duration - 0.3).abs() < 0.08,
            "expected rendered duration near 0.3s, got {actual_duration}s"
        );
    }

    #[test]
    fn export_sketch_video_generates_elucim_frame_manifest_for_visual_row() {
        if ensure_ffmpeg_available().is_err() {
            eprintln!("Skipping Elucim visual export test because FFmpeg is unavailable");
            return;
        }

        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        fs::create_dir_all(root.join(".cutready/visuals")).unwrap();
        fs::write(
            root.join(".cutready/visuals/intro.json"),
            serde_json::json!({
                "version": "2.0",
                "scene": {
                    "type": "player",
                    "fps": 30,
                    "width": 160,
                    "height": 90,
                    "background": "transparent",
                    "children": ["title"]
                },
                "elements": {
                    "title": {
                        "id": "title",
                        "type": "text",
                        "props": {
                            "type": "text",
                            "x": 24,
                            "y": 48,
                            "content": "CutReady",
                            "fill": "$foreground",
                            "fontSize": 18
                        }
                    }
                },
                "timelines": {
                    "intro": {
                        "id": "intro",
                        "duration": 3,
                        "tracks": []
                    }
                },
                "stateMachines": {
                    "main": {
                        "id": "main",
                        "entry": "play",
                        "states": { "play": { "timeline": "intro" } },
                        "transitions": [
                            { "id": "entry-play", "from": "entry", "to": "play", "trigger": "onStart" }
                        ]
                    }
                },
                "defaultStateMachine": "main"
            })
            .to_string(),
        )
        .unwrap();

        let narration_path = root.join("row-1.wav");
        run_ffmpeg(vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "sine=frequency=440:duration=0.1".to_string(),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            narration_path.to_string_lossy().to_string(),
        ])
        .unwrap();

        let mut sketch = Sketch::new("Elucim Visual Export");
        let mut row = PlanningRow::new();
        row.screenshot = None;
        row.visual = Some(serde_json::Value::String(
            ".cutready/visuals/intro.json".to_string(),
        ));
        row.narration = Some(NarrationAsset {
            path: "row-1.wav".to_string(),
            source_text: "Hello".to_string(),
            source_text_hash: "hash".to_string(),
            mime_type: "audio/wav".to_string(),
            duration_ms: Some(100),
            leading_silence_ms: None,
            trailing_silence_ms: None,
            silence_threshold_db: None,
            byte_size: narration_path.metadata().unwrap().len(),
            recorded_at: Utc::now(),
        });
        sketch.rows = vec![row];
        project::write_sketch(&sketch, &root.join("elucim-visual.sk"), root).unwrap();

        let output = root.join("elucim-visual.mp4");
        let settings = SketchVideoExportSettings {
            include_title_card: false,
            title_to_first_row_hold_seconds: 0.0,
            final_hold_seconds: 0.0,
            narration_tail_hold_seconds: 0.0,
            video_width: 160,
            video_height: 90,
            video_fps: 30,
            ..SketchVideoExportSettings::default()
        };
        let export = export_sketch_video_with_progress(
            root,
            root,
            "elucim-visual.sk",
            Some(&output),
            settings,
            |_| {},
        )
        .unwrap();

        assert_eq!(export.row_count, 1);
        assert!(output.is_file());
        assert!(output.metadata().unwrap().len() > 0);
    }

    #[test]
    fn export_sketch_video_uses_resolved_demo_media_without_row_screenshot() {
        if ensure_ffmpeg_available().is_err() {
            eprintln!("Skipping resolved demo media export test because FFmpeg is unavailable");
            return;
        }

        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let schema_dir = root.join(".cutready").join("scenecast");
        let frames_dir = schema_dir.join("frames");
        fs::create_dir_all(&frames_dir).unwrap();
        RgbImage::from_pixel(64, 36, Rgb([20, 80, 180]))
            .save(frames_dir.join("open.png"))
            .unwrap();
        RgbImage::from_pixel(64, 36, Rgb([180, 80, 20]))
            .save(frames_dir.join("terminal.png"))
            .unwrap();
        fs::write(
            schema_dir.join("resolved-demo.json"),
            serde_json::json!({
                "schemaVersion": "scenecast.resolved-demo.v1",
                "title": "Demo",
                "startSceneId": "start",
                "capturePolicy": {
                    "kind": "reference-existing-assets",
                    "assetBase": "bundle-relative",
                    "missingCaptureBehavior": "diagnostic"
                },
                "steps": [{
                    "id": "step-start",
                    "order": 0,
                    "sceneId": "start",
                    "title": "Start",
                    "targets": [],
                    "guideMarks": []
                }],
                "segments": [{
                    "id": "segment-start",
                    "kind": "scene",
                    "stepId": "step-start",
                    "startMs": 0,
                    "durationMs": 400,
                    "endMs": 400,
                    "capture": null,
                    "interaction": null,
                    "frames": [
                        { "path": "frames/open.png", "durationMs": 100 },
                        { "path": "frames/terminal.png", "durationMs": 0 }
                    ],
                    "waitMs": 0
                }],
                "diagnostics": []
            })
            .to_string(),
        )
        .unwrap();

        let narration_path = root.join("row-1.wav");
        run_ffmpeg(vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "sine=frequency=440:duration=0.1".to_string(),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            narration_path.to_string_lossy().to_string(),
        ])
        .unwrap();

        let mut sketch = Sketch::new("Resolved Media Export");
        let mut row = PlanningRow::new();
        row.screenshot = None;
        row.narration = Some(NarrationAsset {
            path: "row-1.wav".to_string(),
            source_text: "Hello".to_string(),
            source_text_hash: "hash".to_string(),
            mime_type: "audio/wav".to_string(),
            duration_ms: Some(100),
            leading_silence_ms: None,
            trailing_silence_ms: None,
            silence_threshold_db: None,
            byte_size: narration_path.metadata().unwrap().len(),
            recorded_at: Utc::now(),
        });
        sketch.rows = vec![row];
        project::write_sketch(&sketch, &root.join("resolved-media.sk"), root).unwrap();

        let output = root.join("resolved-media.mp4");
        let settings = SketchVideoExportSettings {
            include_title_card: false,
            title_to_first_row_hold_seconds: 0.0,
            final_hold_seconds: 0.0,
            narration_tail_hold_seconds: 0.0,
            video_width: 64,
            video_height: 36,
            video_fps: 30,
            resolved_demo_path: Some(".cutready/scenecast/resolved-demo.json".to_string()),
            ..SketchVideoExportSettings::default()
        };
        let export = export_sketch_video_with_progress(
            root,
            root,
            "resolved-media.sk",
            Some(&output),
            settings,
            |_| {},
        )
        .unwrap();

        assert_eq!(export.row_count, 1);
        assert_seconds(export.duration_seconds, 0.6);
        assert!(output.is_file());
        assert!(output.metadata().unwrap().len() > 0);
    }

    #[test]
    fn export_sketch_video_skips_resolved_demo_media_for_overlay_rows() {
        if ensure_ffmpeg_available().is_err() {
            eprintln!("Skipping resolved demo media overlay test because FFmpeg is unavailable");
            return;
        }

        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        fs::create_dir_all(root.join(".cutready/screenshots")).unwrap();
        fs::create_dir_all(root.join(".cutready/scenecast")).unwrap();

        let screenshot_path = root.join(".cutready/screenshots/row-1.png");
        RgbImage::from_pixel(64, 36, Rgb([80, 20, 180]))
            .save(&screenshot_path)
            .unwrap();
        fs::write(
            root.join(".cutready/scenecast/resolved-demo.json"),
            serde_json::json!({
                "schemaVersion": "scenecast.resolved-demo.v1",
                "title": "Demo",
                "startSceneId": "start",
                "capturePolicy": {
                    "kind": "reference-existing-assets",
                    "assetBase": "bundle-relative",
                    "missingCaptureBehavior": "diagnostic"
                },
                "steps": [{
                    "id": "step-start",
                    "order": 0,
                    "sceneId": "start",
                    "title": "Start",
                    "targets": [],
                    "guideMarks": []
                }],
                "segments": [{
                    "id": "segment-start",
                    "kind": "scene",
                    "stepId": "step-start",
                    "startMs": 0,
                    "durationMs": 400,
                    "endMs": 400,
                    "capture": { "path": "captures/missing.png" },
                    "interaction": null,
                    "frames": [],
                    "waitMs": 0
                }],
                "diagnostics": []
            })
            .to_string(),
        )
        .unwrap();

        let narration_path = root.join("row-1.wav");
        run_ffmpeg(vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "error".to_string(),
            "-f".to_string(),
            "lavfi".to_string(),
            "-i".to_string(),
            "sine=frequency=440:duration=0.1".to_string(),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            narration_path.to_string_lossy().to_string(),
        ])
        .unwrap();

        let mut sketch = Sketch::new("Resolved Media Overlay Export");
        let mut row = PlanningRow::new();
        row.screenshot = Some(".cutready/screenshots/row-1.png".to_string());
        row.typing_spots = vec![TypingSpot {
            x: 0.2,
            y: 0.25,
            width: 0.5,
            height: 0.12,
            text: "Overlay".to_string(),
            start_offset_ms: Some(0),
            duration_ms: None,
            characters_per_second: Some(24.0),
            show_cursor: Some(true),
            text_color: Some("#ffffff".to_string()),
            font_family: Some("sans".to_string()),
            font_scale: Some(1.0),
        }];
        row.narration = Some(NarrationAsset {
            path: "row-1.wav".to_string(),
            source_text: "Hello".to_string(),
            source_text_hash: "hash".to_string(),
            mime_type: "audio/wav".to_string(),
            duration_ms: Some(100),
            leading_silence_ms: None,
            trailing_silence_ms: None,
            silence_threshold_db: None,
            byte_size: narration_path.metadata().unwrap().len(),
            recorded_at: Utc::now(),
        });
        sketch.rows = vec![row];
        project::write_sketch(&sketch, &root.join("resolved-overlay.sk"), root).unwrap();

        let output = root.join("resolved-overlay.mp4");
        let settings = SketchVideoExportSettings {
            include_title_card: false,
            title_to_first_row_hold_seconds: 0.0,
            final_hold_seconds: 0.0,
            narration_tail_hold_seconds: 0.0,
            video_width: 64,
            video_height: 36,
            video_fps: 30,
            resolved_demo_path: Some(".cutready/scenecast/resolved-demo.json".to_string()),
            ..SketchVideoExportSettings::default()
        };
        let export = export_sketch_video_with_progress(
            root,
            root,
            "resolved-overlay.sk",
            Some(&output),
            settings,
            |_| {},
        )
        .unwrap();

        assert_eq!(export.row_count, 1);
        assert_seconds(export.duration_seconds, 0.6);
        assert!(output.is_file());
        assert!(output.metadata().unwrap().len() > 0);
    }

    #[test]
    fn export_sketch_video_rejects_relative_output_path() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        let mut sketch = Sketch::new("Unsafe Export");
        let mut row = PlanningRow::new();
        row.screenshot = Some("missing.png".to_string());
        row.narration = Some(NarrationAsset {
            path: "missing.wav".to_string(),
            source_text: "Hello".to_string(),
            source_text_hash: "hash".to_string(),
            mime_type: "audio/wav".to_string(),
            duration_ms: Some(250),
            leading_silence_ms: None,
            trailing_silence_ms: None,
            silence_threshold_db: None,
            byte_size: 0,
            recorded_at: Utc::now(),
        });
        sketch.rows = vec![row];
        project::write_sketch(&sketch, &root.join("unsafe.sk"), root).unwrap();

        let error =
            export_sketch_video(root, "unsafe.sk", Some(Path::new("escape.mp4"))).unwrap_err();
        assert!(error.to_string().contains("must be absolute"));
    }
}

#[cfg(test)]
fn test_row_segment(
    row_number: usize,
    audio_duration_seconds: f64,
    narration_tail_hold_seconds: f64,
) -> RowSegment {
    let settings = SketchVideoExportSettings {
        narration_tail_hold_seconds,
        ..SketchVideoExportSettings::default()
    };
    RowSegment {
        row_number,
        image_path: PathBuf::from(format!("row-{row_number}.png")),
        narration_path: PathBuf::from(format!("row-{row_number}.wav")),
        audio_start_seconds: 0.0,
        audio_duration_seconds,
        duration_seconds: row_content_duration_seconds(audio_duration_seconds, 0.0, &settings),
        frame_sequence: None,
        motion_plan: None,
        typing_spots: Vec::new(),
    }
}

#[cfg(test)]
fn assert_seconds(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.000_001,
        "expected {expected}, got {actual}"
    );
}
