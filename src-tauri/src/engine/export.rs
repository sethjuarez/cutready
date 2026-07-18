//! Export engine — rendered media and output folder assembly.

use std::{
    ffi::OsStr,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    engine::{ffmpeg, project},
    models::sketch::{MotionPlan, MotionPlanKeyframe, Sketch},
};

const EXPORTS_DIR: &str = "exports";
const TEMP_DIR: &str = ".cutready/exports/tmp";
const BACKGROUND_MUSIC_DIR: &str = ".cutready/audio/background";
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
    #[serde(default)]
    pub narration_path: Option<String>,
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
    pub used_narration: bool,
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
}

pub fn export_sketch_video(
    project_root: &Path,
    sketch_path: &str,
    output_path: Option<&Path>,
) -> anyhow::Result<SketchVideoExport> {
    export_sketch_video_with_progress(
        project_root,
        sketch_path,
        output_path,
        SketchVideoExportSettings::default(),
        |_| {},
    )
}

pub fn import_background_music(
    project_root: &Path,
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
    let destination = project::safe_resolve(project_root, &relative_path)?;
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

pub fn delete_background_music(project_root: &Path, relative_path: &str) -> anyhow::Result<()> {
    if !relative_path.starts_with(BACKGROUND_MUSIC_DIR) {
        anyhow::bail!("Background music path must be under {BACKGROUND_MUSIC_DIR}");
    }
    if relative_path
        .rsplit_once('.')
        .map(|(_, extension)| !extension.eq_ignore_ascii_case("wav"))
        .unwrap_or(true)
    {
        anyhow::bail!("Background music path must point to a WAV file");
    }
    let path = project::safe_resolve(project_root, relative_path)?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn render_background_music_preview(
    project_root: &Path,
    settings: BackgroundMusicPreviewSettings,
) -> anyhow::Result<BackgroundMusicPreview> {
    ensure_ffmpeg_available()?;
    let music_path = project::safe_resolve(project_root, settings.background_music_path.trim())?;
    if !music_path.is_file() {
        anyhow::bail!("Background music file was not found");
    }
    let narration_path = settings
        .narration_path
        .as_ref()
        .map(|path| project::safe_resolve(project_root, path.trim()))
        .transpose()?
        .filter(|path| path.is_file());
    let used_narration = narration_path.is_some();
    let narration_duration = narration_path
        .as_deref()
        .and_then(|path| probe_media_duration_seconds(path).ok());
    let music_duration = probe_media_duration_seconds(&music_path).ok();
    let duration_seconds = background_music_preview_duration(narration_duration, music_duration);
    let work_relative = format!(
        "{TEMP_DIR}/music-preview-{}.wav",
        Utc::now().format("%Y%m%d-%H%M%S-%3f")
    );
    let output_path = project::safe_resolve(project_root, &work_relative)?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let preview_settings = SketchVideoExportSettings {
        background_music_volume_db: sanitize_background_music_volume_db(
            settings.background_music_volume_db,
        ),
        background_music_duck_narration: settings.background_music_duck_narration && used_narration,
        background_music_fade_seconds: sanitize_non_negative_duration(
            settings.background_music_fade_seconds,
            DEFAULT_BACKGROUND_MUSIC_FADE_SECONDS,
        ),
        ..SketchVideoExportSettings::default()
    };
    render_background_music_preview_audio(
        narration_path.as_deref(),
        &music_path,
        &output_path,
        duration_seconds,
        &preview_settings,
    )?;

    Ok(BackgroundMusicPreview {
        path: output_path.to_string_lossy().to_string(),
        duration_seconds,
        used_narration,
    })
}

pub fn export_sketch_video_with_progress<F>(
    project_root: &Path,
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
            project_root,
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
    let text_dir = output_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Title card output path has no parent directory"))?;
    let title_filter = title_card_filter(sketch, text_dir, settings)?;

    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        format!(
            "color=c=#faf9f7:s={}x{}:r={}:d={duration}",
            settings.video_width, settings.video_height, settings.video_fps
        ),
        "-f".to_string(),
        "lavfi".to_string(),
        "-t".to_string(),
        duration,
        "-i".to_string(),
        "anullsrc=channel_layout=stereo:sample_rate=48000".to_string(),
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
    let vf = segment
        .motion_plan
        .as_ref()
        .map(|plan| motion_image_video_filter(plan, segment.duration_seconds, settings))
        .transpose()?
        .unwrap_or_else(|| still_image_video_filter(settings));
    let af = narration_audio_filter(&audio_start, &audio_duration, &duration);
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
    ];
    if segment.motion_plan.is_none() {
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
    if segment.motion_plan.is_none() {
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

fn still_image_video_filter(settings: &SketchVideoExportSettings) -> String {
    format!(
        "scale={}:{}:force_original_aspect_ratio=decrease:flags=neighbor,\
         pad={}:{}:(ow-iw)/2:(oh-ih)/2,\
         fps={},setsar=1,format={}",
        settings.video_width,
        settings.video_height,
        settings.video_width,
        settings.video_height,
        settings.video_fps,
        settings.video_pixel_format
    )
}

fn motion_image_video_filter(
    plan: &MotionPlan,
    duration_seconds: f64,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<String> {
    let mut keyframes = valid_motion_keyframes(plan);
    if keyframes.len() < 2 {
        anyhow::bail!("Motion plan needs at least two valid keyframes");
    }
    keyframes.sort_by_key(|keyframe| keyframe.time_ms);
    let frames = ((duration_seconds.max(MIN_ROW_DURATION_SECONDS) * settings.video_fps as f64)
        .ceil() as u32)
        .max(1);
    let crop_keyframes = motion_crop_keyframes(&keyframes, frames, settings)?;
    let crop_width = piecewise_crop_expression(&crop_keyframes, |crop| crop.width);
    let crop_x = piecewise_crop_expression(&crop_keyframes, |crop| crop.x);
    let crop_y = piecewise_crop_expression(&crop_keyframes, |crop| crop.y);

    Ok(format!(
        "scale={}:{}:force_original_aspect_ratio=decrease:flags=lanczos,\
         pad={}:{}:(ow-iw)/2:(oh-ih)/2,\
         zoompan=z='1/({crop_width})':x='iw*({crop_x})':y='ih*({crop_y})':d={frames}:s={}x{}:fps={},\
         setsar=1,format={}",
        settings.video_width,
        settings.video_height,
        settings.video_width,
        settings.video_height,
        settings.video_width,
        settings.video_height,
        settings.video_fps,
        settings.video_pixel_format
    ))
}

fn motion_final_frame_video_filter(
    plan: &MotionPlan,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<String> {
    let mut keyframes = valid_motion_keyframes(plan);
    if keyframes.is_empty() {
        anyhow::bail!("Motion plan needs at least one valid keyframe");
    }
    keyframes.sort_by_key(|keyframe| keyframe.time_ms);
    let crop = motion_crop_rect(keyframes[keyframes.len() - 1], settings.motion_max_scale);

    Ok(format!(
        "scale={}:{}:force_original_aspect_ratio=decrease:flags=lanczos,\
         pad={}:{}:(ow-iw)/2:(oh-ih)/2,\
         zoompan=z='1/{:.6}':x='iw*({:.6})':y='ih*({:.6})':d=1:s={}x{}:fps={},\
         fps={},setsar=1,format={}",
        settings.video_width,
        settings.video_height,
        settings.video_width,
        settings.video_height,
        crop.width,
        crop.x,
        crop.y,
        settings.video_width,
        settings.video_height,
        settings.video_fps,
        settings.video_fps,
        settings.video_pixel_format
    ))
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
    let mut expression = format!("{:.6}", value(last_crop));
    for window in crop_keyframes.windows(2).rev() {
        let (start_frame, start_crop) = window[0];
        let (end_frame, end_crop) = window[1];
        let span = end_frame.saturating_sub(start_frame).max(1);
        let start_value = value(start_crop);
        let end_value = value(end_crop);
        let segment = format!(
            "{start_value:.6}+(({end_value:.6}-{start_value:.6})*(min(max(on-{start_frame},0)/{span},1)))"
        );
        expression = format!("if(lte(on,{end_frame}),{segment},{expression})");
    }
    expression
}

fn narration_audio_filter(
    audio_start: &str,
    audio_duration: &str,
    output_duration: &str,
) -> String {
    format!(
        "atrim=start={audio_start}:duration={audio_duration},asetpts=PTS-STARTPTS,apad,atrim=duration={output_duration},aresample=48000,aformat=channel_layouts=stereo"
    )
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
        still_image_video_filter(settings),
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
    let base_filter = if hold_final_motion_frame {
        segment
            .motion_plan
            .as_ref()
            .map(|plan| motion_final_frame_video_filter(plan, settings))
            .transpose()?
            .unwrap_or_else(|| still_image_video_filter(settings))
    } else {
        still_image_video_filter(settings)
    };
    let filter = hold_video_filter(base_filter, duration_seconds, transition, settings);
    render_image_hold_segment_with_filter(
        &segment.image_path,
        duration_seconds,
        output_path,
        filter,
        settings,
    )
}

#[derive(Clone, Copy)]
enum HoldTransition {
    None,
    FadeOutToBlack,
    FadeInFromBlack,
}

fn hold_video_filter(
    base_filter: String,
    duration_seconds: f64,
    transition: HoldTransition,
    settings: &SketchVideoExportSettings,
) -> String {
    let fade_duration = duration_seconds
        .min(settings.row_transition_dip_seconds)
        .max(MIN_ROW_DURATION_SECONDS);
    match transition {
        HoldTransition::None => base_filter,
        HoldTransition::FadeOutToBlack => {
            let start = (duration_seconds - fade_duration).max(0.0);
            format!(
                "{base_filter},fade=t=out:st={}:d={}:color=black",
                format_seconds(start),
                format_seconds(fade_duration)
            )
        }
        HoldTransition::FadeInFromBlack => format!(
            "{base_filter},fade=t=in:st=0:d={}:color=black",
            format_seconds(fade_duration)
        ),
    }
}

fn render_image_hold_segment_with_filter(
    image_path: &Path,
    duration_seconds: f64,
    output_path: &Path,
    video_filter: String,
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
        "anullsrc=channel_layout=stereo:sample_rate=48000".to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "1:a:0".to_string(),
        "-vf".to_string(),
        video_filter,
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
    project_root: &Path,
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
        "aresample=async=1:first_pts=0".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        concatenated_output_path.to_string_lossy().to_string(),
    ])?;

    if let Some(background_music_path) = &settings.background_music_path {
        let music_path = project::safe_resolve(project_root, background_music_path)?;
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
            "anullsrc=r=48000:cl=stereo".to_string(),
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
    let narration = format!(
        "[0:a]apad,atrim=0:{duration},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo[previewNarration];"
    );
    format!(
        "{narration}{}",
        background_music_filter_with_narration_label(
            duration,
            fade_duration,
            fade_out_start,
            settings,
            "previewNarration",
        )
    )
}

fn background_music_filter_with_narration_label(
    duration: String,
    fade_duration: f64,
    fade_out_start: f64,
    settings: &SketchVideoExportSettings,
    narration_label: &str,
) -> String {
    let mut music_filter = format!(
        "[1:a]atrim=0:{duration},asetpts=PTS-STARTPTS,volume={}dB",
        settings.background_music_volume_db
    );
    if fade_duration > 0.0 {
        music_filter.push_str(&format!(
            ",afade=t=in:st=0:d={},afade=t=out:st={}:d={}",
            format_duration(fade_duration),
            format_duration(fade_out_start),
            format_duration(fade_duration)
        ));
    }
    if settings.background_music_duck_narration {
        format!(
            "{music_filter}[music];[music][{narration_label}]sidechaincompress=threshold=0.035:ratio=8:attack=20:release=350[ducked];[{narration_label}][ducked]amix=inputs=2:duration=first:dropout_transition=0[a]"
        )
    } else {
        format!(
            "{music_filter}[music];[{narration_label}][music]amix=inputs=2:duration=first:dropout_transition=0[a]"
        )
    }
}

fn title_card_filter(
    sketch: &Sketch,
    text_dir: &Path,
    settings: &SketchVideoExportSettings,
) -> anyhow::Result<String> {
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
        let text_file = write_drawtext_file(text_dir, "title", index, line)?;
        filters.push(drawtext_filter(
            font_path.as_deref(),
            &text_file,
            72,
            "#2b2926",
            title_start_y + (index as i32 * title_line_height),
        ));
    }
    for (index, line) in description_lines.iter().enumerate() {
        let text_file = write_drawtext_file(text_dir, "description", index, line)?;
        filters.push(drawtext_filter(
            font_path.as_deref(),
            &text_file,
            30,
            "#6f6760",
            description_start_y + (index as i32 * description_line_height),
        ));
    }
    filters.push(format!("fps={}", settings.video_fps));
    filters.push("setsar=1".to_string());
    filters.push(format!("format={}", settings.video_pixel_format));
    Ok(filters.join(","))
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
    text_file: &Path,
    font_size: u32,
    color: &str,
    y: i32,
) -> String {
    let fontfile =
        font_path.map(|path| format!(":fontfile='{}'", ffmpeg_filter_font_path_escape(path)));
    format!(
        "drawtext=textfile='{}'{}:fontcolor={}:fontsize={}:x=(w-text_w)/2:y={}",
        ffmpeg_filter_file_path_escape(text_file),
        fontfile.unwrap_or_default(),
        color,
        font_size,
        y
    )
}

fn write_drawtext_file(
    text_dir: &Path,
    kind: &str,
    index: usize,
    text: &str,
) -> anyhow::Result<PathBuf> {
    let path = text_dir.join(format!("title-card-{kind}-{index:02}.txt"));
    fs::write(&path, text.as_bytes())?;
    Ok(path)
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

fn ffmpeg_filter_escape(value: &str) -> String {
    value
        .replace('\\', r"\\")
        .replace('\'', r"\'")
        .replace(':', r"\:")
        .replace('%', r"\%")
        .replace(',', r"\,")
        .replace('[', r"\[")
        .replace(']', r"\]")
}

fn ffmpeg_filter_file_path_escape(path: &Path) -> String {
    let normalized = path
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    ffmpeg_filter_escape(&normalized)
}

fn ffmpeg_filter_font_path_escape(path: &Path) -> String {
    let mut normalized = path
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    #[cfg(target_os = "windows")]
    {
        if normalized.len() >= 3
            && normalized.as_bytes()[1] == b':'
            && normalized.as_bytes()[2] == b'/'
        {
            normalized.replace_range(..2, "");
        }
    }
    ffmpeg_filter_escape(&normalized)
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
    let output = ffmpeg::run_ffmpeg(args)?;
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
    let message = lines
        .iter()
        .copied()
        .find(|line| !line.starts_with("Fontconfig error:"))
        .or_else(|| lines.first().copied())
        .unwrap_or("FFmpeg failed");
    anyhow::bail!("{message}");
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
        PlanningRow, Sketch,
    };
    use image::{Rgb, RgbImage};
    use tempfile::TempDir;

    #[test]
    fn slugify_returns_stable_file_safe_name() {
        assert_eq!(slugify("Demo: Login Flow!"), "demo-login-flow");
        assert_eq!(slugify("   "), "sketch");
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
        let fade_out = hold_video_filter(
            "base".to_string(),
            0.5,
            HoldTransition::FadeOutToBlack,
            &settings,
        );
        assert_eq!(fade_out, "base,fade=t=out:st=0.150:d=0.350:color=black");

        let fade_in = hold_video_filter(
            "base".to_string(),
            0.5,
            HoldTransition::FadeInFromBlack,
            &settings,
        );
        assert_eq!(fade_in, "base,fade=t=in:st=0:d=0.350:color=black");

        let unchanged = hold_video_filter("base".to_string(), 3.0, HoldTransition::None, &settings);
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

        let filter = motion_image_video_filter(&plan, 3.0, &settings).unwrap();
        assert!(filter.contains("zoompan=z='1/(if(lte(on,60),1.000000+((0.862069-1.000000)*(min(max(on-0,0)/60,1))),0.862069))'"));
        assert!(filter.contains(":x='iw*(if(lte(on,60),"));
        assert!(filter.contains(":y='ih*(if(lte(on,60),"));
        assert!(filter.contains("d=90"));
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
        let filter = motion_image_video_filter(&plan, 3.0, &settings).unwrap();
        assert!(filter.contains("if(lte(on,30),"));
        assert!(filter.contains("if(lte(on,60),"));
        assert!(filter.contains("min(max(on-30,0)/30,1)"));
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

        let filter = motion_final_frame_video_filter(&plan, &settings).unwrap();
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
        let temp_dir = TempDir::new().unwrap();
        let mut sketch = Sketch::new("Demo: Export, Now 100%");
        sketch.description = serde_json::json!([{ "type": "paragraph", "children": [{ "text": "Direction's script, A [B]" }] }]);

        let settings = SketchVideoExportSettings::default();
        let filter = title_card_filter(&sketch, temp_dir.path(), &settings).unwrap();
        assert!(filter.contains("drawtext=textfile='"));
        assert!(filter.contains("title-card-title-00.txt"));
        assert!(filter.contains("title-card-description-00.txt"));
        assert!(!filter.contains("text='"));
        assert!(!filter.contains("paragraph"));
        assert_eq!(
            fs::read_to_string(temp_dir.path().join("title-card-title-00.txt")).unwrap(),
            "Demo: Export, Now 100%"
        );
        assert_eq!(
            fs::read_to_string(temp_dir.path().join("title-card-description-00.txt")).unwrap(),
            "Direction's script, A [B]"
        );
    }

    #[test]
    fn ffmpeg_filter_file_path_escape_uses_filter_safe_paths() {
        let path = ["font root", "demo's:font.ttf"].iter().collect::<PathBuf>();
        assert_eq!(
            ffmpeg_filter_file_path_escape(&path),
            r"font root/demo\'s\:font.ttf"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ffmpeg_filter_file_path_escape_keeps_windows_drive_prefix() {
        assert_eq!(
            ffmpeg_filter_file_path_escape(Path::new(r"C:\cutready\rko\title-card.txt")),
            r"C\:/cutready/rko/title-card.txt"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn ffmpeg_filter_font_path_escape_strips_windows_drive_prefix() {
        assert_eq!(
            ffmpeg_filter_font_path_escape(Path::new(r"C:\Windows\Fonts\segoeui.ttf")),
            r"/Windows/Fonts/segoeui.ttf"
        );
    }

    #[test]
    fn export_sketch_video_renders_mp4_when_ffmpeg_is_available() {
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
