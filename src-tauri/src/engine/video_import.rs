//! Video import engine for transcript-first sketch creation.
//!
//! The first pass uses a sidecar transcript (`.srt`, `.vtt`, or `.txt`) as the
//! speech-to-text provider so media extraction and sketch synthesis can be
//! validated independently from automatic STT.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::engine::agent::llm::{self, ChatMessage, LlmConfig};
use crate::engine::{ffmpeg, project};
use crate::models::sketch::{PlanningRow, Sketch};

const IMPORTS_DIR: &str = ".cutready/recordings/imports";
const SCREENSHOTS_DIR: &str = ".cutready/screenshots";
const MAX_SCENE_SECONDS: u64 = 35;
const MAX_SCENE_CHARS: usize = 520;
const PAUSE_BOUNDARY_MS: u64 = 2_000;
const MAX_SKETCH_VIDEO_DURATION_MS: u64 = 15 * 60 * 1_000;
const LLM_REFINEMENT_TIMEOUT: Duration = Duration::from_secs(240);
const LLM_REFINEMENT_PROGRESS_INTERVAL: Duration = Duration::from_secs(20);
const LLM_REFINEMENT_PROGRESS_MESSAGES: [&str; 6] = [
    "Scene analyst is reading the transcript for natural demo beats",
    "Scene analyst is checking boundaries against the heuristic cut list",
    "Scene analyst is keeping transcript segments in order",
    "Scene analyst is choosing screenshot-friendly representative moments",
    "Scene analyst is validating the scene map before frame extraction",
    "Scene analyst is still working; heuristic fallback is ready if needed",
];
const MISSING_TRANSCRIPT_PREFIX: &str = "VIDEO_IMPORT_MISSING_TRANSCRIPT:";
const DURATION_LIMIT_PREFIX: &str = "VIDEO_IMPORT_DURATION_LIMIT:";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VideoImportResult {
    pub sketch_path: String,
    pub title: String,
    pub row_count: usize,
    pub screenshot_count: usize,
    pub manifest_path: String,
    pub transcript_path: String,
    pub llm_refined: bool,
    pub llm_refinement_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoImportProgress {
    pub phase: String,
    pub current: usize,
    pub total: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoImportManifest {
    pub schema_version: u32,
    pub import_id: String,
    pub source_video: String,
    pub sidecar_transcript: String,
    pub audio_path: Option<String>,
    pub sketch_path: String,
    pub imported_at: chrono::DateTime<Utc>,
    pub transcript_segments: Vec<TranscriptSegment>,
    pub heuristic_evidence: VideoImportHeuristicEvidence,
    pub analyzer_row_plan: Option<AnalyzerRowPlan>,
    pub scenes: Vec<SceneCandidate>,
    pub llm_refinement: Option<LlmSceneRefinementSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptSegment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SceneCandidate {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub transcript_segment_ids: Vec<String>,
    pub transcript_text: String,
    pub narrative: Option<String>,
    pub demo_actions: Vec<String>,
    pub screenshot: Option<String>,
    pub frame_timestamp_ms: u64,
    pub grouping_reason: String,
    pub refinement_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VideoImportHeuristicEvidence {
    pub max_sketch_video_duration_ms: u64,
    pub segments: Vec<TranscriptSegmentEvidence>,
    pub heuristic_scenes: Vec<HeuristicSceneEvidence>,
    pub candidate_boundaries: Vec<CandidateBoundaryEvidence>,
    pub candidate_frames: Vec<CandidateFrameEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptSegmentEvidence {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub duration_ms: u64,
    pub text: String,
    pub word_count: usize,
    pub char_count: usize,
    pub gap_before_ms: Option<u64>,
    pub gap_after_ms: Option<u64>,
    pub words_per_minute: Option<f64>,
    pub sentence_end: bool,
    pub topic_cue: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HeuristicSceneEvidence {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub duration_ms: u64,
    pub segment_ids: Vec<String>,
    pub frame_timestamp_ms: u64,
    pub grouping_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CandidateBoundaryEvidence {
    pub after_segment_id: String,
    pub timestamp_ms: u64,
    pub score: f64,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CandidateFrameEvidence {
    pub id: String,
    pub scene_id: String,
    pub segment_id: String,
    pub timestamp_ms: u64,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalyzerRowPlan {
    pub rows: Vec<AnalyzerRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalyzerRow {
    pub segment_ids: Vec<String>,
    pub representative_segment_id: Option<String>,
    pub representative_timestamp_ms: Option<u64>,
    pub confidence: Option<f32>,
    pub reason: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmSceneRefinementSummary {
    pub provider: String,
    pub model: String,
    pub input_scene_count: usize,
    pub output_scene_count: usize,
    pub summary: String,
}

#[derive(Debug, Clone)]
pub struct VideoImportLlmOptions {
    pub config: LlmConfig,
    pub reported_context_length: Option<usize>,
    pub provider_label: String,
    pub model: String,
}

pub async fn import_video_from_sidecar(
    project_root: &Path,
    video_path: &Path,
    sketch_relative_path: &str,
    title: &str,
    llm_options: Option<VideoImportLlmOptions>,
) -> anyhow::Result<VideoImportResult> {
    import_video_from_sidecar_with_progress(
        project_root,
        video_path,
        sketch_relative_path,
        title,
        llm_options,
        |_| {},
    )
    .await
}

pub async fn import_video_from_sidecar_with_progress<F>(
    project_root: &Path,
    video_path: &Path,
    sketch_relative_path: &str,
    title: &str,
    llm_options: Option<VideoImportLlmOptions>,
    mut on_progress: F,
) -> anyhow::Result<VideoImportResult>
where
    F: FnMut(VideoImportProgress),
{
    let total_steps = 7;
    emit_progress(
        &mut on_progress,
        "validating",
        0,
        total_steps,
        "Validating video and transcript sidecar",
    );
    validate_video_path(video_path)?;
    validate_sketch_video_duration(video_path)?;
    let transcript_path = find_sidecar_transcript(video_path)?;
    emit_progress(
        &mut on_progress,
        "transcript",
        1,
        total_steps,
        "Parsing timestamped transcript",
    );
    let transcript_segments = parse_transcript_file(&transcript_path)?;
    if transcript_segments.is_empty() {
        anyhow::bail!("Transcript sidecar did not contain any usable segments");
    }

    let import_id = format!("video-{}", Uuid::new_v4().simple());
    let import_rel_dir = format!("{IMPORTS_DIR}/{import_id}");
    let import_dir = project::safe_resolve(project_root, &import_rel_dir)?;
    std::fs::create_dir_all(&import_dir)?;

    emit_progress(
        &mut on_progress,
        "audio",
        2,
        total_steps,
        "Extracting import audio for local reference",
    );
    let audio_path = extract_audio(video_path, &import_dir).ok();
    emit_progress(
        &mut on_progress,
        "grouping",
        3,
        total_steps,
        "Creating heuristic transcript scenes",
    );
    let mut scenes = group_transcript_scenes(&transcript_segments);
    let heuristic_evidence = build_heuristic_evidence(&transcript_segments, &scenes);
    emit_progress(
        &mut on_progress,
        "llm",
        4,
        total_steps,
        if llm_options.is_some() {
            "Asking the Video Import Scene Analyst to refine scenes; this can take a few minutes"
        } else {
            "Skipping AI scene refinement because no provider is configured"
        },
    );
    let has_llm_options = llm_options.is_some();
    let refinement = if has_llm_options {
        let mut refinement = Box::pin(refine_scenes_with_llm(
            &transcript_segments,
            &heuristic_evidence,
            llm_options,
        ));
        let mut progress_tick = 0usize;
        loop {
            tokio::select! {
                outcome = &mut refinement => break outcome,
                _ = tokio::time::sleep(LLM_REFINEMENT_PROGRESS_INTERVAL) => {
                    emit_progress(
                        &mut on_progress,
                        "llm",
                        4,
                        total_steps,
                        llm_refinement_progress_message(progress_tick),
                    );
                    progress_tick += 1;
                }
            }
        }
    } else {
        refine_scenes_with_llm(&transcript_segments, &heuristic_evidence, llm_options).await
    };
    let llm_refinement = match refinement {
        SceneRefinementOutcome::Refined {
            scenes: refined,
            summary,
            row_plan,
        } => {
            tracing::info!(
                target: "cutready::video_import",
                input_scenes = scenes.len(),
                output_scenes = refined.len(),
                "video import scene analyst refined transcript scenes"
            );
            scenes = refined;
            (Some(summary), Some(row_plan), true)
        }
        SceneRefinementOutcome::Skipped => (None, None, false),
        SceneRefinementOutcome::Failed { summary } => {
            tracing::warn!(
                target: "cutready::video_import",
                provider = %summary.provider,
                model = %summary.model,
                reason = %summary.summary,
                "video import scene analyst failed; using heuristic scenes"
            );
            (Some(summary), None, false)
        }
    };
    emit_progress(
        &mut on_progress,
        "screenshots",
        5,
        total_steps,
        format!("Extracting {} representative screenshots", scenes.len()),
    );
    extract_scene_screenshots(project_root, video_path, &import_id, &mut scenes)?;

    emit_progress(
        &mut on_progress,
        "saving",
        6,
        total_steps,
        "Saving imported sketch and manifest",
    );
    let mut sketch = Sketch::new(title);
    sketch.description = serde_json::Value::String(format!(
        "Imported from video `{}` using sidecar transcript `{}`. Scene rows are transcript-derived and ready for review.",
        video_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("video"),
        transcript_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("transcript")
    ));
    sketch.rows = scenes.iter().map(scene_to_row).collect();
    sketch.updated_at = Utc::now();

    let sketch_abs = project::safe_resolve(project_root, sketch_relative_path)?;
    project::write_sketch(&sketch, &sketch_abs, project_root)?;

    let manifest = VideoImportManifest {
        schema_version: 1,
        import_id,
        source_video: video_path.display().to_string(),
        sidecar_transcript: transcript_path.display().to_string(),
        audio_path: audio_path.map(|path| path.to_string_lossy().replace('\\', "/")),
        sketch_path: sketch_relative_path.to_string(),
        imported_at: Utc::now(),
        transcript_segments,
        heuristic_evidence,
        analyzer_row_plan: llm_refinement.1.clone(),
        scenes: scenes.clone(),
        llm_refinement: llm_refinement.0.clone(),
    };
    let manifest_rel_path = format!("{import_rel_dir}/manifest.json");
    let manifest_abs = project::safe_resolve(project_root, &manifest_rel_path)?;
    std::fs::write(&manifest_abs, serde_json::to_string_pretty(&manifest)?)?;
    emit_progress(
        &mut on_progress,
        "complete",
        total_steps,
        total_steps,
        "Video import complete",
    );

    tracing::info!(
        target: "cutready::video_import",
        sketch_path = %sketch_relative_path,
        rows = scenes.len(),
        screenshots = scenes.iter().filter(|scene| scene.screenshot.is_some()).count(),
        "imported video sidecar transcript as sketch"
    );

    Ok(VideoImportResult {
        sketch_path: sketch_relative_path.to_string(),
        title: title.to_string(),
        row_count: sketch.rows.len(),
        screenshot_count: scenes
            .iter()
            .filter(|scene| scene.screenshot.is_some())
            .count(),
        manifest_path: manifest_rel_path,
        transcript_path: transcript_path.display().to_string(),
        llm_refined: llm_refinement.2,
        llm_refinement_status: llm_refinement.0.map(|summary| summary.summary),
    })
}

fn emit_progress<F>(
    on_progress: &mut F,
    phase: impl Into<String>,
    current: usize,
    total: usize,
    message: impl Into<String>,
) where
    F: FnMut(VideoImportProgress),
{
    on_progress(VideoImportProgress {
        phase: phase.into(),
        current,
        total,
        message: message.into(),
    });
}

fn validate_video_path(video_path: &Path) -> anyhow::Result<()> {
    if !video_path.is_file() {
        anyhow::bail!("Video file does not exist: {}", video_path.display());
    }
    let extension = video_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !matches!(
        extension.as_str(),
        "mp4" | "mov" | "mkv" | "webm" | "avi" | "m4v"
    ) {
        anyhow::bail!("Unsupported video file extension: {extension}");
    }
    Ok(())
}

fn validate_sketch_video_duration(video_path: &Path) -> anyhow::Result<()> {
    let output = ffmpeg::run_ffprobe([
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        &video_path.to_string_lossy(),
    ])?;
    if !output.status.success() {
        anyhow::bail!(
            "FFprobe duration check failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let duration_seconds = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()?;
    if !duration_seconds.is_finite() || duration_seconds < 0.0 {
        anyhow::bail!("FFprobe returned an invalid video duration");
    }
    let duration_ms = (duration_seconds * 1_000.0).round() as u64;
    if duration_ms > MAX_SKETCH_VIDEO_DURATION_MS {
        anyhow::bail!(
            "{DURATION_LIMIT_PREFIX}This video is {} long. Sketch video import supports videos up to 15:00. Use storyboard import for longer recordings once that workflow is available.",
            format_timestamp(duration_ms)
        );
    }
    Ok(())
}

fn llm_refinement_progress_message(tick: usize) -> String {
    LLM_REFINEMENT_PROGRESS_MESSAGES[tick % LLM_REFINEMENT_PROGRESS_MESSAGES.len()].to_string()
}

fn find_sidecar_transcript(video_path: &Path) -> anyhow::Result<PathBuf> {
    let stem = video_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| anyhow::anyhow!("Video path has no filename"))?;
    let parent = video_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Video path has no parent folder"))?;

    for ext in ["srt", "vtt", "txt"] {
        let candidate = parent.join(format!("{stem}.{ext}"));
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    let video_name = video_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("the selected video");
    anyhow::bail!(
        "{MISSING_TRANSCRIPT_PREFIX}CutReady needs a transcript sidecar before it can turn \"{video_name}\" into a sketch.\n\nAdd a transcript file next to the video with the same base name, such as:\n\n  {stem}.srt\n\nCutReady also accepts {stem}.vtt or {stem}.txt. For now, generate the transcript with a tool like Whisper, Descript, Premiere, Resolve, or exported captions, then try the import again.\n\nWe are working on generating this transcript inside CutReady soon."
    )
}

fn parse_transcript_file(path: &Path) -> anyhow::Result<Vec<TranscriptSegment>> {
    let content = std::fs::read_to_string(path)?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "srt" | "vtt" => parse_timestamped_transcript(&content),
        "txt" => parse_plain_transcript(&content),
        _ => anyhow::bail!("Unsupported transcript extension: {extension}"),
    }
}

fn parse_timestamped_transcript(content: &str) -> anyhow::Result<Vec<TranscriptSegment>> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut segments = Vec::new();

    for block in normalized.split("\n\n") {
        let lines = block
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && *line != "WEBVTT")
            .collect::<Vec<_>>();
        let Some(time_index) = lines.iter().position(|line| line.contains("-->")) else {
            continue;
        };
        let (start_ms, end_ms) = parse_time_range(lines[time_index])?;
        let text = lines[(time_index + 1)..].join(" ").trim().to_string();
        if text.is_empty() {
            continue;
        }
        segments.push(TranscriptSegment {
            id: format!("seg-{}", segments.len() + 1),
            start_ms,
            end_ms: end_ms.max(start_ms + 1),
            text,
        });
    }

    Ok(segments)
}

fn parse_plain_transcript(content: &str) -> anyhow::Result<Vec<TranscriptSegment>> {
    let text = content.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![TranscriptSegment {
        id: "seg-1".to_string(),
        start_ms: 0,
        end_ms: 30_000,
        text: text.to_string(),
    }])
}

fn parse_time_range(line: &str) -> anyhow::Result<(u64, u64)> {
    let mut parts = line.split("-->");
    let start = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("Missing transcript start timestamp"))?;
    let end = parts
        .next()
        .ok_or_else(|| anyhow::anyhow!("Missing transcript end timestamp"))?;
    Ok((parse_timestamp_ms(start)?, parse_timestamp_ms(end)?))
}

fn parse_timestamp_ms(value: &str) -> anyhow::Result<u64> {
    let clean = value
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .replace(',', ".");
    let parts = clean.split(':').collect::<Vec<_>>();
    if !(2..=3).contains(&parts.len()) {
        anyhow::bail!("Invalid transcript timestamp: {value}");
    }
    let (hours, minutes, seconds_value) = if parts.len() == 3 {
        (parts[0].parse::<u64>()?, parts[1].parse::<u64>()?, parts[2])
    } else {
        (0, parts[0].parse::<u64>()?, parts[1])
    };
    let seconds_parts = seconds_value.split('.').collect::<Vec<_>>();
    let seconds = seconds_parts[0].parse::<u64>()?;
    let millis = seconds_parts
        .get(1)
        .map(|fraction| {
            let mut ms = fraction.chars().take(3).collect::<String>();
            while ms.len() < 3 {
                ms.push('0');
            }
            ms.parse::<u64>()
        })
        .transpose()?
        .unwrap_or(0);
    Ok((((hours * 60) + minutes) * 60 + seconds) * 1_000 + millis)
}

fn group_transcript_scenes(segments: &[TranscriptSegment]) -> Vec<SceneCandidate> {
    let mut scenes = Vec::new();
    let mut current: Vec<TranscriptSegment> = Vec::new();
    let mut reason = "initial segment".to_string();

    for segment in segments {
        if current.is_empty() {
            current.push(segment.clone());
            continue;
        }

        let previous = current.last().expect("current scene has a segment");
        let start = current
            .first()
            .map(|seg| seg.start_ms)
            .unwrap_or(segment.start_ms);
        let duration_ms = segment.end_ms.saturating_sub(start);
        let chars = current.iter().map(|seg| seg.text.len()).sum::<usize>() + segment.text.len();
        let gap_ms = segment.start_ms.saturating_sub(previous.end_ms);

        let boundary_reason = if gap_ms >= PAUSE_BOUNDARY_MS {
            Some(format!("pause of {:.1}s", gap_ms as f64 / 1_000.0))
        } else if duration_ms >= MAX_SCENE_SECONDS * 1_000 {
            Some(format!("duration reached {MAX_SCENE_SECONDS}s"))
        } else if chars >= MAX_SCENE_CHARS {
            Some("transcript text reached row-sized chunk".to_string())
        } else if duration_ms >= 8_000 && starts_topic_shift(&segment.text) {
            Some("transcript topic shift cue".to_string())
        } else {
            None
        };

        if let Some(boundary_reason) = boundary_reason {
            scenes.push(scene_from_segments(scenes.len() + 1, &current, &reason));
            current.clear();
            current.push(segment.clone());
            reason = boundary_reason;
        } else {
            current.push(segment.clone());
        }
    }

    if !current.is_empty() {
        scenes.push(scene_from_segments(scenes.len() + 1, &current, &reason));
    }

    scenes
}

fn build_heuristic_evidence(
    segments: &[TranscriptSegment],
    heuristic_scenes: &[SceneCandidate],
) -> VideoImportHeuristicEvidence {
    VideoImportHeuristicEvidence {
        max_sketch_video_duration_ms: MAX_SKETCH_VIDEO_DURATION_MS,
        segments: build_segment_evidence(segments),
        heuristic_scenes: heuristic_scenes
            .iter()
            .map(|scene| HeuristicSceneEvidence {
                id: scene.id.clone(),
                start_ms: scene.start_ms,
                end_ms: scene.end_ms,
                duration_ms: scene.end_ms.saturating_sub(scene.start_ms),
                segment_ids: scene.transcript_segment_ids.clone(),
                frame_timestamp_ms: scene.frame_timestamp_ms,
                grouping_reason: scene.grouping_reason.clone(),
            })
            .collect(),
        candidate_boundaries: build_candidate_boundaries(segments),
        candidate_frames: build_candidate_frames(segments, heuristic_scenes),
    }
}

fn build_segment_evidence(segments: &[TranscriptSegment]) -> Vec<TranscriptSegmentEvidence> {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            let duration_ms = segment.end_ms.saturating_sub(segment.start_ms).max(1);
            let word_count = segment.text.split_whitespace().count();
            let words_per_minute = if word_count == 0 {
                None
            } else {
                Some(((word_count as f64) / (duration_ms as f64 / 60_000.0) * 10.0).round() / 10.0)
            };
            TranscriptSegmentEvidence {
                id: segment.id.clone(),
                start_ms: segment.start_ms,
                end_ms: segment.end_ms,
                duration_ms,
                text: segment.text.clone(),
                word_count,
                char_count: segment.text.chars().count(),
                gap_before_ms: index
                    .checked_sub(1)
                    .and_then(|previous| segments.get(previous))
                    .map(|previous| segment.start_ms.saturating_sub(previous.end_ms)),
                gap_after_ms: segments
                    .get(index + 1)
                    .map(|next| next.start_ms.saturating_sub(segment.end_ms)),
                words_per_minute,
                sentence_end: ends_sentence(&segment.text),
                topic_cue: starts_topic_shift(&segment.text),
            }
        })
        .collect()
}

fn build_candidate_boundaries(segments: &[TranscriptSegment]) -> Vec<CandidateBoundaryEvidence> {
    segments
        .windows(2)
        .filter_map(|pair| {
            let current = &pair[0];
            let next = &pair[1];
            let gap_ms = next.start_ms.saturating_sub(current.end_ms);
            let mut score = 0.0f64;
            let mut reasons = Vec::new();

            if gap_ms >= PAUSE_BOUNDARY_MS {
                score += 0.55;
                reasons.push(format!("pause_after_{}ms", gap_ms));
            }
            if ends_sentence(&current.text) {
                score += 0.18;
                reasons.push("sentence_end".to_string());
            }
            if starts_topic_shift(&next.text) {
                score += 0.32;
                reasons.push("next_topic_cue".to_string());
            }
            if current.text.chars().count() >= MAX_SCENE_CHARS / 2 {
                score += 0.12;
                reasons.push("dense_caption".to_string());
            }

            if reasons.is_empty() {
                return None;
            }

            Some(CandidateBoundaryEvidence {
                after_segment_id: current.id.clone(),
                timestamp_ms: current.end_ms,
                score: score.min(1.0),
                reasons,
            })
        })
        .collect()
}

fn build_candidate_frames(
    segments: &[TranscriptSegment],
    heuristic_scenes: &[SceneCandidate],
) -> Vec<CandidateFrameEvidence> {
    heuristic_scenes
        .iter()
        .filter_map(|scene| {
            let representative = segments
                .iter()
                .filter(|segment| scene.transcript_segment_ids.contains(&segment.id))
                .max_by_key(|segment| segment.end_ms.saturating_sub(segment.start_ms))?;
            Some(CandidateFrameEvidence {
                id: format!("{}-midpoint", scene.id),
                scene_id: scene.id.clone(),
                segment_id: representative.id.clone(),
                timestamp_ms: representative.start_ms
                    + (representative
                        .end_ms
                        .saturating_sub(representative.start_ms)
                        / 2),
                reasons: vec![
                    "longest_segment_midpoint".to_string(),
                    "heuristic_scene_candidate".to_string(),
                ],
            })
        })
        .collect()
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end()
        .chars()
        .last()
        .is_some_and(|last| matches!(last, '.' | '?' | '!'))
}

fn starts_topic_shift(text: &str) -> bool {
    let normalized = text.trim().to_ascii_lowercase();
    [
        "now let's",
        "now let me",
        "the second",
        "second thing",
        "finally",
        "and then finally",
        "what if",
        "that's where",
        "let me go",
        "let me show",
    ]
    .iter()
    .any(|cue| normalized.starts_with(cue))
}

fn scene_from_segments(
    index: usize,
    segments: &[TranscriptSegment],
    reason: &str,
) -> SceneCandidate {
    let start_ms = segments.first().map(|seg| seg.start_ms).unwrap_or_default();
    let end_ms = segments
        .last()
        .map(|seg| seg.end_ms)
        .unwrap_or(start_ms + 1)
        .max(start_ms + 1);
    SceneCandidate {
        id: format!("scene-{index}"),
        start_ms,
        end_ms,
        transcript_segment_ids: segments.iter().map(|seg| seg.id.clone()).collect(),
        transcript_text: segments
            .iter()
            .map(|seg| seg.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        narrative: None,
        demo_actions: Vec::new(),
        screenshot: None,
        frame_timestamp_ms: start_ms + ((end_ms - start_ms) / 2),
        grouping_reason: reason.to_string(),
        refinement_notes: None,
    }
}

fn scene_to_row(scene: &SceneCandidate) -> PlanningRow {
    let mut row = PlanningRow::new();
    row.time = format!(
        "{} - {}",
        format_timestamp(scene.start_ms),
        format_timestamp(scene.end_ms)
    );
    row.duration_seconds = Some(((scene.end_ms - scene.start_ms) as f64 / 1_000.0).round() as u32);
    row.narrative = scene.transcript_text.clone();
    row.demo_actions = String::new();
    row.screenshot = scene.screenshot.clone();
    row
}

enum SceneRefinementOutcome {
    Refined {
        scenes: Vec<SceneCandidate>,
        summary: LlmSceneRefinementSummary,
        row_plan: AnalyzerRowPlan,
    },
    Skipped,
    Failed {
        summary: LlmSceneRefinementSummary,
    },
}

#[derive(Debug, Deserialize)]
struct LlmSceneRefinementResponse {
    rows: Vec<LlmScene>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LlmScene {
    segment_ids: Vec<String>,
    #[serde(default)]
    representative_segment_id: Option<String>,
    #[serde(default)]
    representative_timestamp_ms: Option<u64>,
    #[serde(default)]
    confidence: Option<f32>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

async fn refine_scenes_with_llm(
    segments: &[TranscriptSegment],
    heuristic_evidence: &VideoImportHeuristicEvidence,
    options: Option<VideoImportLlmOptions>,
) -> SceneRefinementOutcome {
    let Some(options) = options else {
        return SceneRefinementOutcome::Skipped;
    };

    let input_scene_count = heuristic_evidence.heuristic_scenes.len();
    let provider = llm::build_provider(&options.config, options.reported_context_length);
    let user_prompt = build_scene_refinement_prompt(heuristic_evidence);
    tracing::info!(
        target: "cutready::video_import",
        provider = %options.provider_label,
        model = %options.model,
        transcript_segments = segments.len(),
        heuristic_scenes = heuristic_evidence.heuristic_scenes.len(),
        prompt_chars = user_prompt.len(),
        timeout_seconds = LLM_REFINEMENT_TIMEOUT.as_secs(),
        "starting video import scene analyst request"
    );
    let failure_summary = |summary: String| LlmSceneRefinementSummary {
        provider: options.provider_label.clone(),
        model: options.model.clone(),
        input_scene_count,
        output_scene_count: input_scene_count,
        summary,
    };
    let messages = vec![
        ChatMessage::system(VIDEO_IMPORT_SCENE_ANALYST_PROMPT),
        ChatMessage::user(&user_prompt),
    ];
    let result =
        tokio::time::timeout(LLM_REFINEMENT_TIMEOUT, llm::simple_chat(provider, messages)).await;

    let response = match result {
        Ok(Ok(message)) => message,
        Ok(Err(err)) => {
            return SceneRefinementOutcome::Failed {
                summary: failure_summary(format!("Scene analyst request failed: {err}")),
            };
        }
        Err(_) => {
            return SceneRefinementOutcome::Failed {
                summary: failure_summary(format!(
                    "Scene analyst timed out after {} seconds",
                    LLM_REFINEMENT_TIMEOUT.as_secs()
                )),
            };
        }
    };

    let Some(text) = response.text() else {
        return SceneRefinementOutcome::Failed {
            summary: failure_summary("Scene analyst returned no text".to_string()),
        };
    };

    match apply_llm_scene_refinement(segments, text) {
        Ok((scenes, row_plan, summary_text)) => {
            let summary = LlmSceneRefinementSummary {
                provider: options.provider_label,
                model: options.model,
                input_scene_count,
                output_scene_count: scenes.len(),
                summary: summary_text,
            };
            SceneRefinementOutcome::Refined {
                scenes,
                summary,
                row_plan,
            }
        }
        Err(err) => SceneRefinementOutcome::Failed {
            summary: failure_summary(format!("Scene analyst returned unusable boundaries: {err}")),
        },
    }
}

const VIDEO_IMPORT_SCENE_ANALYST_PROMPT: &str = r#"You are CutReady's Video Import Scene Analyst.

Your job is to review timestamped demo transcript segments and deterministic heuristic evidence before screenshots are extracted. You are not a script writer. The transcript text is immutable source material and the backend will copy it verbatim into the sketch.

Rules:
- Return only valid JSON. No markdown fences, no prose outside JSON.
- Use each transcript segment exactly once, in the original order.
- Do not invent segment IDs or split a segment.
- Prefer fewer useful demo scenes over many tiny transcript chunks.
- Keep scenes coherent for a product demo sketch row: one goal, one presenter beat, or one visible task.
- Do not return narrative text, transcript text, rewritten words, summaries for sketch rows, or demo actions.
- Choose row boundaries and representative timing only.
- Pick representative_segment_id from within the scene. It should be the segment whose midpoint is most likely to show the key screen for the scene.
- representative_timestamp_ms is optional. If present, it must be inside the row time range.
- Use confidence from 0.0 to 1.0 only when the evidence supports a clear score.
- Use plain ASCII punctuation.

JSON shape:
{
  "summary": "One sentence explaining the boundary/timestamp plan.",
  "rows": [
    {
      "segment_ids": ["seg-1", "seg-2"],
      "representative_segment_id": "seg-2",
      "representative_timestamp_ms": 6400,
      "confidence": 0.82,
      "reason": "Pause and topic-cue evidence agree.",
      "label": "setup"
    }
  ]
}"#;

fn build_scene_refinement_prompt(heuristic_evidence: &VideoImportHeuristicEvidence) -> String {
    let evidence_json =
        serde_json::to_string_pretty(heuristic_evidence).unwrap_or_else(|_| "{}".to_string());
    format!(
        "Review this bounded heuristic evidence JSON. Return only the row plan JSON shape from the system instructions. Do not copy, rewrite, summarize, or output transcript text.\n\n{evidence_json}"
    )
}

fn apply_llm_scene_refinement(
    segments: &[TranscriptSegment],
    response_text: &str,
) -> anyhow::Result<(Vec<SceneCandidate>, AnalyzerRowPlan, String)> {
    let json_text = extract_json_object(response_text)?;
    let response: LlmSceneRefinementResponse = serde_json::from_str(json_text)?;
    if response.rows.is_empty() {
        anyhow::bail!("no rows returned");
    }

    let segment_ids = segments
        .iter()
        .map(|segment| segment.id.as_str())
        .collect::<Vec<_>>();
    let mut next_index = 0usize;
    let mut scenes = Vec::with_capacity(response.rows.len());
    let mut row_plan = AnalyzerRowPlan {
        rows: Vec::with_capacity(response.rows.len()),
    };

    for (scene_index, llm_scene) in response.rows.into_iter().enumerate() {
        if llm_scene.segment_ids.is_empty() {
            anyhow::bail!("row {} has no segment IDs", scene_index + 1);
        }

        let mut scene_segments = Vec::with_capacity(llm_scene.segment_ids.len());
        for segment_id in &llm_scene.segment_ids {
            let Some(expected_id) = segment_ids.get(next_index) else {
                anyhow::bail!("scene output contains extra segment {segment_id}");
            };
            if segment_id != expected_id {
                anyhow::bail!(
                    "expected segment {} at position {}, got {}",
                    expected_id,
                    next_index + 1,
                    segment_id
                );
            }
            scene_segments.push(segments[next_index].clone());
            next_index += 1;
        }

        let mut candidate = scene_from_segments(
            scene_index + 1,
            &scene_segments,
            "Analyzer selected transcript row",
        );
        candidate.refinement_notes = analyzer_notes(
            llm_scene.reason.as_deref(),
            llm_scene.confidence,
            llm_scene.label.as_deref(),
        );

        if let Some(representative_id) = llm_scene.representative_segment_id {
            let representative = scene_segments
                .iter()
                .find(|segment| segment.id == representative_id)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "representative segment {representative_id} is not inside scene {}",
                        scene_index + 1
                    )
                })?;
            candidate.frame_timestamp_ms =
                representative.start_ms + ((representative.end_ms - representative.start_ms) / 2);
        }
        if let Some(timestamp_ms) = llm_scene.representative_timestamp_ms {
            if timestamp_ms < candidate.start_ms || timestamp_ms > candidate.end_ms {
                anyhow::bail!(
                    "representative timestamp for row {} is outside the row range",
                    scene_index + 1
                );
            }
            candidate.frame_timestamp_ms = timestamp_ms;
        }

        row_plan.rows.push(AnalyzerRow {
            segment_ids: candidate.transcript_segment_ids.clone(),
            representative_segment_id: scene_segments
                .iter()
                .find(|segment| {
                    segment.start_ms <= candidate.frame_timestamp_ms
                        && candidate.frame_timestamp_ms <= segment.end_ms
                })
                .map(|segment| segment.id.clone()),
            representative_timestamp_ms: Some(candidate.frame_timestamp_ms),
            confidence: llm_scene.confidence,
            reason: llm_scene.reason,
            label: llm_scene.label,
        });
        scenes.push(candidate);
    }

    if next_index != segments.len() {
        anyhow::bail!(
            "row output omitted {} transcript segment(s)",
            segments.len() - next_index
        );
    }

    Ok((
        scenes,
        row_plan,
        response
            .summary
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "Scene analyst refined transcript boundaries.".to_string()),
    ))
}

fn analyzer_notes(
    reason: Option<&str>,
    confidence: Option<f32>,
    label: Option<&str>,
) -> Option<String> {
    let mut notes = Vec::new();
    if let Some(reason) = reason.map(str::trim).filter(|reason| !reason.is_empty()) {
        notes.push(format!("reason={reason}"));
    }
    if let Some(confidence) = confidence {
        notes.push(format!("confidence={:.2}", confidence.clamp(0.0, 1.0)));
    }
    if let Some(label) = label.map(str::trim).filter(|label| !label.is_empty()) {
        notes.push(format!("label={label}"));
    }
    if notes.is_empty() {
        None
    } else {
        Some(notes.join("; "))
    }
}

fn extract_json_object(text: &str) -> anyhow::Result<&str> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Ok(trimmed);
    }

    if let Some(fenced) = trimmed.strip_prefix("```json") {
        if let Some((body, _)) = fenced.trim_start().rsplit_once("```") {
            return Ok(body.trim());
        }
    }
    if let Some(fenced) = trimmed.strip_prefix("```") {
        if let Some((body, _)) = fenced.trim_start().rsplit_once("```") {
            return Ok(body.trim());
        }
    }

    let start = trimmed
        .find('{')
        .ok_or_else(|| anyhow::anyhow!("missing JSON object start"))?;
    let end = trimmed
        .rfind('}')
        .ok_or_else(|| anyhow::anyhow!("missing JSON object end"))?;
    if end <= start {
        anyhow::bail!("invalid JSON object range");
    }
    Ok(&trimmed[start..=end])
}

fn format_timestamp(ms: u64) -> String {
    let total_seconds = ms / 1_000;
    let minutes = total_seconds / 60;
    let seconds = total_seconds % 60;
    format!("{minutes}:{seconds:02}")
}

fn extract_audio(video_path: &Path, import_dir: &Path) -> anyhow::Result<PathBuf> {
    let output_path = import_dir.join("audio.wav");
    let output = ffmpeg::run_ffmpeg([
        "-y",
        "-i",
        &video_path.to_string_lossy(),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        &output_path.to_string_lossy(),
    ])?;
    if !output.status.success() {
        anyhow::bail!(
            "FFmpeg audio extraction failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(output_path)
}

fn extract_scene_screenshots(
    project_root: &Path,
    video_path: &Path,
    import_id: &str,
    scenes: &mut [SceneCandidate],
) -> anyhow::Result<()> {
    let screenshot_dir = project::safe_resolve(project_root, SCREENSHOTS_DIR)?;
    std::fs::create_dir_all(&screenshot_dir)?;

    for (index, scene) in scenes.iter_mut().enumerate() {
        let filename = format!("{import_id}-scene-{:02}.png", index + 1);
        let relative_path = format!("{SCREENSHOTS_DIR}/{filename}");
        let output_path = project::safe_resolve(project_root, &relative_path)?;
        let seek = format!("{:.3}", scene.frame_timestamp_ms as f64 / 1_000.0);
        let output = ffmpeg::run_ffmpeg([
            "-y",
            "-ss",
            &seek,
            "-i",
            &video_path.to_string_lossy(),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            &output_path.to_string_lossy(),
        ])?;
        if output.status.success() && output_path.is_file() {
            scene.screenshot = Some(relative_path);
        } else {
            tracing::warn!(
                target: "cutready::video_import",
                scene = %scene.id,
                stderr = %String::from_utf8_lossy(&output.stderr),
                "failed to extract representative frame"
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_srt_segments() {
        let srt = r#"1
00:00:00,000 --> 00:00:03,960
Now that Jess has deployed our contract policy expert into Foundry,

2
00:00:03,960 --> 00:00:07,160
it's time to observe how the agent is behaving.
"#;

        let segments = parse_timestamped_transcript(srt).unwrap();

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 3_960);
        assert!(segments[1].text.contains("observe"));
    }

    #[test]
    fn missing_sidecar_transcript_explains_how_to_continue() {
        let missing_video = PathBuf::from("/tmp/demo-video.mp4");
        let error = find_sidecar_transcript(&missing_video)
            .unwrap_err()
            .to_string();

        assert!(error.starts_with(MISSING_TRANSCRIPT_PREFIX));
        assert!(error.contains("demo-video.srt"));
        assert!(error.contains("CutReady also accepts demo-video.vtt or demo-video.txt"));
        assert!(error.contains("working on generating this transcript inside CutReady soon"));
    }

    #[test]
    fn parses_vtt_short_timestamps() {
        let vtt = r#"WEBVTT

01:30.500 --> 01:34.000
This is a short-form WebVTT cue.
"#;

        let segments = parse_timestamped_transcript(vtt).unwrap();

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_ms, 90_500);
        assert_eq!(segments[0].end_ms, 94_000);
    }

    #[test]
    fn parses_plain_transcript_as_single_segment() {
        let segments = parse_plain_transcript("One continuous transcript.").unwrap();

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 30_000);
    }

    #[test]
    fn groups_on_topic_shift_cues() {
        let segments = vec![
            TranscriptSegment {
                id: "seg-1".into(),
                start_ms: 0,
                end_ms: 4_000,
                text: "Let's start with behavior.".into(),
            },
            TranscriptSegment {
                id: "seg-2".into(),
                start_ms: 4_000,
                end_ms: 9_000,
                text: "Notice I can go to the details tab.".into(),
            },
            TranscriptSegment {
                id: "seg-3".into(),
                start_ms: 9_000,
                end_ms: 12_000,
                text: "Now let's talk about performance.".into(),
            },
        ];

        let scenes = group_transcript_scenes(&segments);

        assert_eq!(scenes.len(), 2);
        assert_eq!(scenes[0].transcript_segment_ids, vec!["seg-1", "seg-2"]);
        assert_eq!(scenes[1].transcript_segment_ids, vec!["seg-3"]);
    }

    #[test]
    fn formats_row_timing_and_preserves_verbatim_transcript_text() {
        let scene = SceneCandidate {
            id: "scene-1".into(),
            start_ms: 9_320,
            end_ms: 23_080,
            transcript_segment_ids: vec!["seg-1".into()],
            transcript_text: "Notice I can go to the details tab.".into(),
            narrative: Some("The details tab shows the current run.".into()),
            demo_actions: vec!["Open the details tab".into()],
            screenshot: Some(".cutready/screenshots/frame.png".into()),
            frame_timestamp_ms: 16_200,
            grouping_reason: "test".into(),
            refinement_notes: Some("Representative frame selected by test.".into()),
        };

        let row = scene_to_row(&scene);

        assert_eq!(row.time, "0:09 - 0:23");
        assert_eq!(row.duration_seconds, Some(14));
        assert_eq!(row.narrative, "Notice I can go to the details tab.");
        assert_eq!(row.demo_actions, "");
        assert_eq!(
            row.screenshot.as_deref(),
            Some(".cutready/screenshots/frame.png")
        );
    }

    #[test]
    fn leaves_actions_blank_when_scene_has_no_grounded_actions() {
        let scene = SceneCandidate {
            id: "scene-1".into(),
            start_ms: 9_320,
            end_ms: 23_080,
            transcript_segment_ids: vec!["seg-1".into()],
            transcript_text: "Notice I can go to the details tab.".into(),
            narrative: None,
            demo_actions: Vec::new(),
            screenshot: Some(".cutready/screenshots/frame.png".into()),
            frame_timestamp_ms: 16_200,
            grouping_reason: "transcript topic shift cue".into(),
            refinement_notes: None,
        };

        let row = scene_to_row(&scene);

        assert_eq!(row.time, "0:09 - 0:23");
        assert_eq!(row.duration_seconds, Some(14));
        assert_eq!(row.demo_actions, "");
    }

    #[test]
    fn applies_llm_scene_refinement_when_boundaries_cover_all_segments() {
        let segments = vec![
            TranscriptSegment {
                id: "seg-1".into(),
                start_ms: 0,
                end_ms: 4_000,
                text: "Start on the overview.".into(),
            },
            TranscriptSegment {
                id: "seg-2".into(),
                start_ms: 4_000,
                end_ms: 8_000,
                text: "Open the runs tab.".into(),
            },
            TranscriptSegment {
                id: "seg-3".into(),
                start_ms: 8_000,
                end_ms: 12_000,
                text: "Review the trace.".into(),
            },
        ];
        let response = r#"{
          "summary": "Merged the setup into one scene and kept trace review separate.",
          "rows": [
            {
              "segment_ids": ["seg-1", "seg-2"],
              "representative_segment_id": "seg-2",
              "confidence": 0.91,
              "reason": "The second segment shows the screen transition.",
              "label": "setup"
            },
            {
              "segment_ids": ["seg-3"],
              "representative_segment_id": "seg-3"
            }
          ]
        }"#;

        let (scenes, row_plan, summary) = apply_llm_scene_refinement(&segments, response).unwrap();

        assert_eq!(
            summary,
            "Merged the setup into one scene and kept trace review separate."
        );
        assert_eq!(scenes.len(), 2);
        assert_eq!(scenes[0].transcript_segment_ids, vec!["seg-1", "seg-2"]);
        assert_eq!(scenes[0].narrative, None);
        assert!(scenes[0].demo_actions.is_empty());
        assert_eq!(scenes[0].frame_timestamp_ms, 6_000);
        assert_eq!(scenes[1].transcript_segment_ids, vec!["seg-3"]);
        assert_eq!(row_plan.rows.len(), 2);
        assert_eq!(row_plan.rows[0].confidence, Some(0.91));
    }

    #[test]
    fn rejects_llm_scene_refinement_that_outputs_narrative() {
        let segments = vec![TranscriptSegment {
            id: "seg-1".into(),
            start_ms: 0,
            end_ms: 4_000,
            text: "Start on the overview.".into(),
        }];
        let response = r#"{
          "summary": "Kept the scene as-is.",
          "rows": [
            {
              "segment_ids": ["seg-1"],
              "narrative": "Start on the overview.",
              "representative_segment_id": "seg-1"
            }
          ]
        }"#;

        let err = apply_llm_scene_refinement(&segments, response).unwrap_err();

        assert!(err.to_string().contains("unknown field"));
    }

    #[test]
    fn rejects_llm_scene_refinement_that_skips_segments() {
        let segments = vec![
            TranscriptSegment {
                id: "seg-1".into(),
                start_ms: 0,
                end_ms: 4_000,
                text: "Start on the overview.".into(),
            },
            TranscriptSegment {
                id: "seg-2".into(),
                start_ms: 4_000,
                end_ms: 8_000,
                text: "Open the runs tab.".into(),
            },
        ];
        let response = r#"{
          "rows": [
            { "segment_ids": ["seg-2"] }
          ]
        }"#;

        let err = apply_llm_scene_refinement(&segments, response).unwrap_err();

        assert!(err.to_string().contains("expected segment seg-1"));
    }

    #[tokio::test]
    async fn imports_sample_video_when_env_fixture_is_set() {
        let Ok(sample) = std::env::var("CUTREADY_VIDEO_IMPORT_SAMPLE") else {
            return;
        };
        let sample = PathBuf::from(sample);
        if !sample.is_file() {
            panic!("CUTREADY_VIDEO_IMPORT_SAMPLE does not point to a file");
        }
        let root = tempfile::tempdir().unwrap();

        let result = import_video_from_sidecar(
            root.path(),
            &sample,
            "observe-agent-performance-v2.sk",
            "Observe Agent Performance V2",
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.sketch_path, "observe-agent-performance-v2.sk");
        assert!(result.row_count >= 3);
        assert_eq!(result.row_count, result.screenshot_count);
        assert!(root.path().join(&result.sketch_path).is_file());
        assert!(root.path().join(&result.manifest_path).is_file());
    }
}
