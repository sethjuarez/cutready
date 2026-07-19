//! Export engine — rendered media and output folder assembly.

use std::{
    ffi::OsStr,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    engine::{ffmpeg, narration_preview, project},
    models::sketch::{MotionPlan, MotionPlanKeyframe, Sketch, TypingSpot},
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
    motion_plan: Option<MotionPlan>,
    typing_spots: Vec<TypingSpot>,
}

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

    let segments = collect_row_segments(project_root, &sketch, &settings)?;

    ensure_ffmpeg_available()?;
    let gap_count = segments.len().saturating_sub(1);
    let title_step_count = usize::from(settings.include_title_card);
    let background_music_step_count = usize::from(settings.background_music_path.is_some());
    let total_steps =
        title_step_count + 1 + segments.len() + gap_count + 1 + 1 + background_music_step_count;
    let title_card_duration_seconds = if settings.include_title_card {
        settings.title_card_duration_seconds
    } else {
        0.0
    };
    let duration_seconds = title_card_duration_seconds
        + segments
            .iter()
            .map(|segment| segment.duration_seconds)
            .sum::<f64>()
        + settings.title_to_first_row_hold_seconds
        + (gap_count as f64 * settings.row_transition_hold_seconds)
        + settings.final_hold_seconds;

    let work_relative = format!("{TEMP_DIR}/{}", Utc::now().format("%Y%m%d-%H%M%S-%3f"));
    let work_dir = project::safe_resolve(project_root, &work_relative)?;
    fs::create_dir_all(&work_dir)?;

    let result = (|| {
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
            render_segment(segment, &segment_output, &settings)?;
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
        Ok::<_, anyhow::Error>(())
    })();

    if let Err(cleanup_error) = fs::remove_dir_all(&work_dir) {
        tracing::warn!(
            target: "cutready::export",
            path = %work_dir.display(),
            error = %cleanup_error,
            "could not remove temporary sketch video export directory"
        );
    }

    result?;

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
        row_count = segments.len(),
        duration_seconds,
        "exported sketch video"
    );

    Ok(SketchVideoExport {
        path: output_path.to_string_lossy().to_string(),
        duration_seconds,
        row_count: segments.len(),
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
    sketch: &Sketch,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<Vec<RowSegment>> {
    if sketch.rows.is_empty() {
        anyhow::bail!("Sketch has no rows to export");
    }

    sketch
        .rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
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
            let duration_seconds = audio_duration_seconds + settings.narration_tail_hold_seconds;

            Ok(RowSegment {
                row_number: index + 1,
                image_path,
                narration_path,
                audio_start_seconds,
                audio_duration_seconds,
                duration_seconds,
                motion_plan: row.motion_plan.clone(),
                typing_spots: row.typing_spots.clone(),
            })
        })
        .collect()
}

fn render_segment(
    segment: &RowSegment,
    output_path: &Path,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<()> {
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
    let base_filters = if hold_final_motion_frame {
        if let Some(plan) = segment.motion_plan.as_ref() {
            motion_final_frame_video_filters(plan, &segment.typing_spots, settings)?
        } else {
            still_image_video_filters(&segment.typing_spots, duration_seconds, true, settings)?
        }
    } else {
        still_image_video_filters(&segment.typing_spots, duration_seconds, true, settings)?
    };
    let filters = hold_video_filters(base_filters, duration_seconds, transition, settings);
    render_image_hold_segment_with_filter(
        &segment.image_path,
        duration_seconds,
        output_path,
        filters,
        settings,
    )
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
    let _filter_scripts = match offload_large_filter_arguments(&mut args) {
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

fn offload_large_filter_arguments(args: &mut [String]) -> anyhow::Result<Vec<tempfile::TempPath>> {
    let mut scripts = Vec::new();
    for index in 0..args.len().saturating_sub(1) {
        let Some(script_flag) = ffmpeg_filter_script_flag(&args[index]) else {
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

fn ffmpeg_filter_script_flag(flag: &str) -> Option<&'static str> {
    match flag {
        "-vf" => Some("-filter_script:v"),
        "-af" => Some("-filter_script:a"),
        "-filter_complex" => Some("-filter_complex_script"),
        _ => None,
    }
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

        let scripts = offload_large_filter_arguments(&mut args).unwrap();

        assert_eq!(args[0], "-filter_script:v");
        assert_eq!(scripts.len(), 1);
        assert_eq!(fs::read_to_string(&scripts[0]).unwrap(), filter);
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
