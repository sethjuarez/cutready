//! Export engine — rendered media and output folder assembly.

use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{engine::project, models::sketch::Sketch};

const EXPORTS_DIR: &str = "exports";
const TEMP_DIR: &str = ".cutready/exports/tmp";
const VIDEO_WIDTH: u32 = 1920;
const VIDEO_HEIGHT: u32 = 1080;
const VIDEO_FPS: u32 = 30;
const MIN_ROW_DURATION_SECONDS: f64 = 0.1;
const DEFAULT_TITLE_CARD_DURATION_SECONDS: f64 = 3.0;
const DEFAULT_TITLE_TO_FIRST_ROW_HOLD_DURATION_SECONDS: f64 = 0.5;
const DEFAULT_ROW_TRANSITION_HOLD_SECONDS: f64 = 1.0;
const DEFAULT_FINAL_HOLD_DURATION_SECONDS: f64 = 3.0;
const DEFAULT_NORMALIZE_NARRATION_AUDIO: bool = true;
const VIDEO_ENCODER: &str = "libx264rgb";
const VIDEO_PIXEL_FORMAT: &str = "rgb24";
const VIDEO_CRF: &str = "0";
const NARRATION_LOUDNESS_TARGET_LUFS: &str = "-16";
const NARRATION_LOUDNESS_TRUE_PEAK: &str = "-1.5";
const NARRATION_LOUDNESS_RANGE: &str = "11";

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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchVideoExportSettings {
    #[serde(default = "default_title_card_duration_seconds")]
    pub title_card_duration_seconds: f64,
    #[serde(default = "default_title_to_first_row_hold_seconds")]
    pub title_to_first_row_hold_seconds: f64,
    #[serde(default = "default_row_transition_hold_seconds")]
    pub row_transition_hold_seconds: f64,
    #[serde(default = "default_final_hold_seconds")]
    pub final_hold_seconds: f64,
    #[serde(default = "default_normalize_narration_audio")]
    pub normalize_narration_audio: bool,
}

impl Default for SketchVideoExportSettings {
    fn default() -> Self {
        Self {
            title_card_duration_seconds: DEFAULT_TITLE_CARD_DURATION_SECONDS,
            title_to_first_row_hold_seconds: DEFAULT_TITLE_TO_FIRST_ROW_HOLD_DURATION_SECONDS,
            row_transition_hold_seconds: DEFAULT_ROW_TRANSITION_HOLD_SECONDS,
            final_hold_seconds: DEFAULT_FINAL_HOLD_DURATION_SECONDS,
            normalize_narration_audio: DEFAULT_NORMALIZE_NARRATION_AUDIO,
        }
    }
}

impl SketchVideoExportSettings {
    fn normalized(&self) -> Self {
        Self {
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
            normalize_narration_audio: self.normalize_narration_audio,
        }
    }
}

struct RowSegment {
    row_number: usize,
    image_path: PathBuf,
    narration_path: PathBuf,
    audio_start_seconds: f64,
    duration_seconds: f64,
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

    let segments = collect_row_segments(project_root, &sketch)?;

    ensure_ffmpeg_available()?;
    let gap_count = segments.len().saturating_sub(1);
    let total_steps = 1 + 1 + segments.len() + gap_count + 1 + 1;

    let work_relative = format!("{TEMP_DIR}/{}", Utc::now().format("%Y%m%d-%H%M%S-%3f"));
    let work_dir = project::safe_resolve(project_root, &work_relative)?;
    fs::create_dir_all(&work_dir)?;

    let result = (|| {
        let mut segment_files = Vec::with_capacity(segments.len() + (gap_count * 2) + 3);
        let title_card_output = work_dir.join("title-card.mp4");
        emit_progress(
            &mut on_progress,
            "title",
            1,
            total_steps,
            "Rendering sketch title card",
        );
        render_title_card(
            &sketch,
            settings.title_card_duration_seconds,
            &title_card_output,
        )?;
        segment_files.push(title_card_output);
        let mut current_step = 1;
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
            render_segment(segment, &segment_output, settings.normalize_narration_audio)?;
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
                render_image_hold_segment(
                    &segment.image_path,
                    settings.row_transition_hold_seconds / 2.0,
                    &outgoing_gap_output,
                )?;
                segment_files.push(outgoing_gap_output);

                let incoming_gap_output = work_dir.join(format!(
                    "gap-before-row-{:03}-in.mp4",
                    next_segment.row_number
                ));
                render_image_hold_segment(
                    &next_segment.image_path,
                    settings.row_transition_hold_seconds / 2.0,
                    &incoming_gap_output,
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
        render_image_hold_segment(
            &final_segment.image_path,
            settings.final_hold_seconds,
            &final_hold_output,
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
        concatenate_segments(&work_dir, &segment_files, &output_path)?;
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

    let duration_seconds = settings.title_card_duration_seconds
        + segments
            .iter()
            .map(|segment| segment.duration_seconds)
            .sum::<f64>()
        + settings.title_to_first_row_hold_seconds
        + (gap_count as f64 * settings.row_transition_hold_seconds)
        + settings.final_hold_seconds;
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
) -> anyhow::Result<()> {
    let duration = format_duration(duration_seconds);

    run_ffmpeg(vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        format!("color=c=#faf9f7:s={VIDEO_WIDTH}x{VIDEO_HEIGHT}:r={VIDEO_FPS}:d={duration}"),
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
        title_card_filter(sketch),
        "-c:v".to_string(),
        VIDEO_ENCODER.to_string(),
        "-preset".to_string(),
        "medium".to_string(),
        "-tune".to_string(),
        "stillimage".to_string(),
        "-crf".to_string(),
        VIDEO_CRF.to_string(),
        "-pix_fmt".to_string(),
        VIDEO_PIXEL_FORMAT.to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "160k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().to_string(),
    ])
}

fn collect_row_segments(project_root: &Path, sketch: &Sketch) -> anyhow::Result<Vec<RowSegment>> {
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

            let source_duration_seconds = narration
                .duration_ms
                .map(|duration_ms| duration_ms as f64 / 1000.0)
                .or_else(|| probe_media_duration_seconds(&narration_path).ok())
                .ok_or_else(|| {
                    anyhow::anyhow!("Could not determine row {} narration duration", index + 1)
                })?;
            let (audio_start_seconds, duration_seconds) = effective_narration_timing(
                source_duration_seconds,
                narration.leading_silence_ms,
                narration.trailing_silence_ms,
            );

            Ok(RowSegment {
                row_number: index + 1,
                image_path,
                narration_path,
                audio_start_seconds,
                duration_seconds,
            })
        })
        .collect()
}

fn render_segment(
    segment: &RowSegment,
    output_path: &Path,
    normalize_narration_audio: bool,
) -> anyhow::Result<()> {
    let duration = format_duration(segment.duration_seconds);
    let audio_start = format_seconds(segment.audio_start_seconds);
    let vf = still_image_video_filter();
    let af = narration_audio_filter(&audio_start, &duration, normalize_narration_audio);
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-loop".to_string(),
        "1".to_string(),
        "-framerate".to_string(),
        VIDEO_FPS.to_string(),
        "-t".to_string(),
        duration.clone(),
        "-i".to_string(),
        segment.image_path.to_string_lossy().to_string(),
    ];

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
        VIDEO_ENCODER.to_string(),
        "-preset".to_string(),
        "medium".to_string(),
        "-tune".to_string(),
        "stillimage".to_string(),
        "-crf".to_string(),
        VIDEO_CRF.to_string(),
        "-pix_fmt".to_string(),
        VIDEO_PIXEL_FORMAT.to_string(),
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

fn still_image_video_filter() -> String {
    format!(
        "scale={VIDEO_WIDTH}:{VIDEO_HEIGHT}:force_original_aspect_ratio=decrease:flags=neighbor,\
         pad={VIDEO_WIDTH}:{VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2,\
         fps={VIDEO_FPS},setsar=1,format={VIDEO_PIXEL_FORMAT}"
    )
}

fn narration_audio_filter(audio_start: &str, duration: &str, normalize_audio: bool) -> String {
    let base = format!(
        "atrim=start={audio_start}:duration={duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
    );
    if normalize_audio {
        format!(
            "{base},loudnorm=I={NARRATION_LOUDNESS_TARGET_LUFS}:TP={NARRATION_LOUDNESS_TRUE_PEAK}:LRA={NARRATION_LOUDNESS_RANGE},aresample=48000,aformat=channel_layouts=stereo"
        )
    } else {
        base
    }
}

fn render_image_hold_segment(
    image_path: &Path,
    duration_seconds: f64,
    output_path: &Path,
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
        VIDEO_FPS.to_string(),
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
        still_image_video_filter(),
        "-c:v".to_string(),
        VIDEO_ENCODER.to_string(),
        "-preset".to_string(),
        "medium".to_string(),
        "-tune".to_string(),
        "stillimage".to_string(),
        "-crf".to_string(),
        VIDEO_CRF.to_string(),
        "-pix_fmt".to_string(),
        VIDEO_PIXEL_FORMAT.to_string(),
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
    work_dir: &Path,
    segment_files: &[PathBuf],
    output_path: &Path,
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
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().to_string(),
        "-c".to_string(),
        "copy".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        output_path.to_string_lossy().to_string(),
    ])
}

fn title_card_filter(sketch: &Sketch) -> String {
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
    let title_start_y = ((VIDEO_HEIGHT as i32 - content_height) / 2).max(160);
    let description_start_y = if description_lines.is_empty() {
        title_start_y
    } else {
        title_start_y + (title_lines.len() as i32 * title_line_height) + title_description_gap
    };

    let mut filters = Vec::new();
    filters.extend(title_lines.iter().enumerate().map(|(index, line)| {
        drawtext_filter(
            line,
            72,
            "#2b2926",
            title_start_y + (index as i32 * title_line_height),
        )
    }));
    filters.extend(description_lines.iter().enumerate().map(|(index, line)| {
        drawtext_filter(
            line,
            30,
            "#6f6760",
            description_start_y + (index as i32 * description_line_height),
        )
    }));
    filters.push(format!("fps={VIDEO_FPS}"));
    filters.push("setsar=1".to_string());
    filters.push(format!("format={VIDEO_PIXEL_FORMAT}"));
    filters.join(",")
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

fn drawtext_filter(text: &str, font_size: u32, color: &str, y: i32) -> String {
    let fontfile = title_card_fontfile().map(|path| {
        format!(
            ":fontfile='{}'",
            ffmpeg_filter_escape(&path.to_string_lossy())
        )
    });
    format!(
        "drawtext=text='{}'{}:fontcolor={}:fontsize={}:x=(w-text_w)/2:y={}",
        ffmpeg_filter_escape(text),
        fontfile.unwrap_or_default(),
        color,
        font_size,
        y
    )
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

fn ensure_ffmpeg_available() -> anyhow::Result<()> {
    let output = run_command("ffmpeg", ["-version"])?;
    if output.status.success() {
        return Ok(());
    }
    anyhow::bail!("FFmpeg is not available");
}

fn probe_media_duration_seconds(path: &Path) -> anyhow::Result<f64> {
    let output = run_command(
        "ffprobe",
        [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path.to_string_lossy().as_ref(),
        ],
    )?;
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

fn run_ffmpeg(args: Vec<String>) -> anyhow::Result<()> {
    let output = run_command("ffmpeg", args)?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = stderr
        .lines()
        .chain(stdout.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("FFmpeg failed");
    anyhow::bail!("{message}");
}

fn run_command<I, S>(program: &str, args: I) -> anyhow::Result<std::process::Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new(program);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command.output()?)
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

fn default_title_to_first_row_hold_seconds() -> f64 {
    DEFAULT_TITLE_TO_FIRST_ROW_HOLD_DURATION_SECONDS
}

fn default_row_transition_hold_seconds() -> f64 {
    DEFAULT_ROW_TRANSITION_HOLD_SECONDS
}

fn default_final_hold_seconds() -> f64 {
    DEFAULT_FINAL_HOLD_DURATION_SECONDS
}

fn default_normalize_narration_audio() -> bool {
    DEFAULT_NORMALIZE_NARRATION_AUDIO
}

fn sanitize_duration(value: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.max(MIN_ROW_DURATION_SECONDS)
    } else {
        fallback
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
    use crate::models::sketch::{NarrationAsset, PlanningRow, Sketch};
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
    fn narration_audio_filter_normalizes_when_enabled() {
        let normalized = narration_audio_filter("0.500", "3.000", true);
        assert!(normalized.contains("loudnorm=I=-16:TP=-1.5:LRA=11"));
        assert!(normalized.ends_with("aresample=48000,aformat=channel_layouts=stereo"));

        let unchanged = narration_audio_filter("0.500", "3.000", false);
        assert!(!unchanged.contains("loudnorm"));
        assert_eq!(
            unchanged,
            "atrim=start=0.500:duration=3.000,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
        );
    }

    #[test]
    fn export_settings_default_to_audio_normalization() {
        assert!(SketchVideoExportSettings::default().normalize_narration_audio);
    }

    #[test]
    fn effective_narration_timing_trims_silence_metadata() {
        let (start, duration) = effective_narration_timing(5.0, Some(700), Some(1200));
        assert_eq!(format_seconds(start), "0.700");
        assert_eq!(format_duration(duration), "3.100");
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
        sketch.description =
            serde_json::json!([{ "type": "paragraph", "children": [{ "text": "A [B]" }] }]);

        let filter = title_card_filter(&sketch);
        assert!(filter.contains(r"Demo\: Export\, Now 100\%"));
        assert!(filter.contains(r"A \[B\]"));
        assert!(!filter.contains("paragraph"));
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
