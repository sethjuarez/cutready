//! Recording engine — screen capture lifecycle and edit-ready take assets.
//!
//! The capture pipeline manages native Windows capture where available, FFmpeg
//! fallback command construction, and local-only recording media storage.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::engine::project;
use crate::models::sketch::{PlanningRow, Sketch, StoryboardItem};

const RECORDINGS_DIR: &str = ".cutready/recordings";
const RECORDINGS_GITIGNORE: &str = "*\n!.gitignore\n";
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(5);
const RECORDING_STOP_TIMEOUT: Duration = Duration::from_secs(30);

/// Return the local-only recordings directory for a project.
pub fn recordings_dir(project_root: &Path) -> PathBuf {
    project_root.join(RECORDINGS_DIR)
}

/// Initialize the recording storage folder and ignore rules.
///
/// Recording media can be very large, so the directory contains its own
/// `.gitignore` that ignores every take asset while allowing the ignore file
/// itself to be tracked.
pub fn initialize_recording_storage(project_root: &Path) -> anyhow::Result<PathBuf> {
    let dir = recordings_dir(project_root);
    std::fs::create_dir_all(&dir)?;
    ensure_recordings_gitignore(&dir)?;
    Ok(dir)
}

pub fn clear_local_recordings(project_root: &Path) -> anyhow::Result<u64> {
    let dir = initialize_recording_storage(project_root)?;
    let mut removed = 0;

    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        if name == ".gitignore" {
            continue;
        }

        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
            removed += 1;
        } else if path.is_file() {
            std::fs::remove_file(&path)?;
            removed += 1;
        }
    }

    ensure_recordings_gitignore(&dir)?;
    Ok(removed)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FfmpegStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingDeviceKind {
    Microphone,
    Camera,
    SystemAudio,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingDeviceInfo {
    /// Capture-time identifier. For DirectShow, this is the exact device name.
    pub id: String,
    pub label: String,
    pub kind: RecordingDeviceKind,
    pub is_default: bool,
    #[serde(default)]
    pub camera_formats: Vec<CameraFormatInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CameraFormatInfo {
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub fps: Option<String>,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub pixel_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingDeviceDiscovery {
    pub ffmpeg: FfmpegStatus,
    pub devices: Vec<RecordingDeviceInfo>,
}

pub struct ActiveRecording {
    process: ActiveRecordingProcess,
    camera_process: Option<ActiveCameraProcess>,
    system_audio_process: Option<Child>,
    take: RecordingTake,
    take_dir: PathBuf,
    output_path: PathBuf,
    output_asset_path: String,
    camera_output_path: Option<PathBuf>,
}

enum ActiveRecordingProcess {
    Ffmpeg(Child),
    #[cfg(target_os = "windows")]
    NativeWindows(crate::engine::recording_native_windows::NativeWindowsRecording),
}

enum ActiveCameraProcess {
    Ffmpeg(Child),
    #[cfg(target_os = "windows")]
    NativeWindows(crate::engine::recording_native_camera_windows::NativeCameraRecording),
}

impl ActiveCameraProcess {
    fn stop(self) -> anyhow::Result<()> {
        match self {
            Self::Ffmpeg(mut child) => stop_ffmpeg_child(&mut child),
            #[cfg(target_os = "windows")]
            Self::NativeWindows(recording) => recording.stop(),
        }
    }
}

impl ActiveRecordingProcess {
    fn is_finished(&mut self) -> anyhow::Result<bool> {
        match self {
            Self::Ffmpeg(child) => Ok(child.try_wait()?.is_some()),
            #[cfg(target_os = "windows")]
            Self::NativeWindows(recording) => Ok(recording.is_finished()),
        }
    }

    fn stop(self) -> anyhow::Result<()> {
        match self {
            Self::Ffmpeg(mut child) => stop_ffmpeg_child(&mut child),
            #[cfg(target_os = "windows")]
            Self::NativeWindows(recording) => recording.stop(),
        }
    }
}

pub fn check_ffmpeg_status() -> FfmpegStatus {
    match run_ffmpeg(["-version"]) {
        Ok(output) if output.success => FfmpegStatus {
            available: true,
            version: first_non_empty_line(&output.stdout),
            path: Some("ffmpeg".to_string()),
            error: None,
        },
        Ok(output) => FfmpegStatus {
            available: false,
            version: first_non_empty_line(&output.stdout),
            path: Some("ffmpeg".to_string()),
            error: Some(first_non_empty_line(&output.stderr).unwrap_or_else(|| {
                "FFmpeg did not return a successful version response".to_string()
            })),
        },
        Err(err) => FfmpegStatus {
            available: false,
            version: None,
            path: Some("ffmpeg".to_string()),
            error: Some(err.to_string()),
        },
    }
}

pub fn discover_recording_devices() -> RecordingDeviceDiscovery {
    #[cfg(target_os = "windows")]
    {
        match crate::engine::recording_native_audio_windows::discover_native_audio_devices() {
            Ok(mut devices) => {
                match discover_recording_devices_with_ffmpeg() {
                    Ok(dshow_devices) => devices.extend(
                        dshow_devices
                            .into_iter()
                            .filter(|device| device.kind == RecordingDeviceKind::Camera),
                    ),
                    Err(err) => log::warn!("[recording] DirectShow camera discovery failed: {err}"),
                }
                return RecordingDeviceDiscovery {
                    ffmpeg: check_ffmpeg_status(),
                    devices,
                };
            }
            Err(err) => {
                log::warn!("[recording] native Windows audio discovery failed: {err}");
            }
        }
    }

    let mut ffmpeg = check_ffmpeg_status();
    if !ffmpeg.available {
        return RecordingDeviceDiscovery {
            ffmpeg,
            devices: Vec::new(),
        };
    }

    match discover_recording_devices_with_ffmpeg() {
        Ok(devices) => RecordingDeviceDiscovery { ffmpeg, devices },
        Err(err) => {
            ffmpeg.error = Some(err.to_string());
            RecordingDeviceDiscovery {
                ffmpeg,
                devices: Vec::new(),
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn discover_recording_devices_with_ffmpeg() -> anyhow::Result<Vec<RecordingDeviceInfo>> {
    let output = run_ffmpeg([
        "-hide_banner",
        "-list_devices",
        "true",
        "-f",
        "dshow",
        "-i",
        "dummy",
    ])?;
    Ok(parse_dshow_devices(&output.stderr))
}

#[cfg(target_os = "macos")]
fn discover_recording_devices_with_ffmpeg() -> anyhow::Result<Vec<RecordingDeviceInfo>> {
    let output = run_ffmpeg([
        "-hide_banner",
        "-f",
        "avfoundation",
        "-list_devices",
        "true",
        "-i",
        "",
    ])?;
    Ok(parse_avfoundation_devices(&output.stderr))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn discover_recording_devices_with_ffmpeg() -> anyhow::Result<Vec<RecordingDeviceInfo>> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
pub fn discover_camera_formats(device: &str) -> anyhow::Result<Vec<CameraFormatInfo>> {
    match crate::engine::recording_native_camera_windows::discover_camera_formats_by_name(device) {
        Ok(formats) if !formats.is_empty() => return Ok(formats),
        Ok(_) => {}
        Err(err) => log::warn!("[recording] native camera format discovery failed: {err}"),
    }

    let args = vec![
        "-hide_banner".to_string(),
        "-list_options".to_string(),
        "true".to_string(),
        "-f".to_string(),
        "dshow".to_string(),
        "-i".to_string(),
        format!("video={device}"),
    ];
    let output = run_ffmpeg_vec(args)?;
    Ok(parse_dshow_camera_formats(&output.stderr))
}

#[cfg(target_os = "macos")]
pub fn discover_camera_formats(device: &str) -> anyhow::Result<Vec<CameraFormatInfo>> {
    // avfoundation doesn't provide detailed format listing via FFmpeg CLI
    // Return empty — camera format discovery is best-effort on macOS
    let _ = device;
    Ok(Vec::new())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn discover_camera_formats(_device: &str) -> anyhow::Result<Vec<CameraFormatInfo>> {
    Ok(Vec::new())
}

struct FfmpegCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

fn run_ffmpeg<const N: usize>(args: [&str; N]) -> anyhow::Result<FfmpegCommandOutput> {
    let mut command = Command::new("ffmpeg");
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command.spawn()?;
    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            let output = child.wait_with_output()?;
            return Ok(FfmpegCommandOutput {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }

        if started.elapsed() >= FFMPEG_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!(
                "FFmpeg command timed out after {} seconds",
                FFMPEG_TIMEOUT.as_secs()
            );
        }

        std::thread::sleep(Duration::from_millis(25));
    }
}

fn first_non_empty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(target_os = "windows")]
fn parse_dshow_devices(stderr: &str) -> Vec<RecordingDeviceInfo> {
    #[derive(Copy, Clone)]
    enum Section {
        Video,
        Audio,
    }

    let mut section: Option<Section> = None;
    let mut devices = Vec::new();

    for line in stderr.lines() {
        if line.contains("DirectShow video devices") {
            section = Some(Section::Video);
            continue;
        }
        if line.contains("DirectShow audio devices") {
            section = Some(Section::Audio);
            continue;
        }

        if line.contains("Alternative name") {
            continue;
        }

        let Some(label) = quoted_value(line) else {
            continue;
        };

        if let Some(current_section) = section {
            let kind = match current_section {
                Section::Video => RecordingDeviceKind::Camera,
                Section::Audio => RecordingDeviceKind::Microphone,
            };
            devices.push(RecordingDeviceInfo {
                id: label.clone(),
                label,
                kind,
                is_default: false,
                camera_formats: Vec::new(),
            });
            continue;
        }

        let normalized_line = line.to_ascii_lowercase();
        if normalized_line.contains("(audio") {
            devices.push(RecordingDeviceInfo {
                id: label.clone(),
                label: label.clone(),
                kind: RecordingDeviceKind::Microphone,
                is_default: false,
                camera_formats: Vec::new(),
            });
        }
        if normalized_line.contains("(video") || normalized_line.contains(", video") {
            devices.push(RecordingDeviceInfo {
                id: label.clone(),
                label,
                kind: RecordingDeviceKind::Camera,
                is_default: false,
                camera_formats: Vec::new(),
            });
        }
    }

    devices
}

#[cfg(target_os = "windows")]
fn parse_dshow_camera_formats(stderr: &str) -> Vec<CameraFormatInfo> {
    let mut formats = Vec::new();
    for line in stderr.lines() {
        let Some((codec, pixel_format)) = parse_camera_format_kind(line) else {
            continue;
        };
        let Some((width, height)) = parse_dshow_resolution(line) else {
            continue;
        };
        formats.push(CameraFormatInfo {
            width,
            height,
            fps: parse_dshow_fps(line),
            codec,
            pixel_format,
        });
    }
    formats.sort_by(|a, b| {
        let a_score = camera_format_score(a);
        let b_score = camera_format_score(b);
        b_score.cmp(&a_score)
    });
    formats.dedup();
    formats
}

#[cfg(target_os = "windows")]
fn parse_camera_format_kind(line: &str) -> Option<(Option<String>, Option<String>)> {
    if let Some(codec) = token_after(line, "vcodec=") {
        return Some((Some(codec), None));
    }
    if let Some(pixel_format) = token_after(line, "pixel_format=") {
        return Some((None, Some(pixel_format)));
    }
    None
}

#[cfg(target_os = "windows")]
fn parse_dshow_resolution(line: &str) -> Option<(u32, u32)> {
    let index = line
        .find("max s=")
        .or_else(|| line.find("min s="))
        .or_else(|| line.find(" s="))?;
    let size_start = line[index..].find("s=")? + index + 2;
    let size = line[size_start..]
        .split_whitespace()
        .next()
        .unwrap_or_default();
    let (width, height) = size.split_once('x')?;
    Some((width.parse().ok()?, height.parse().ok()?))
}

#[cfg(target_os = "windows")]
fn parse_dshow_fps(line: &str) -> Option<String> {
    let search_from = line
        .find("max s=")
        .or_else(|| line.find("min s="))
        .unwrap_or(0);
    let fps = token_after(&line[search_from..], "fps=")?;
    Some(fps)
}

#[cfg(target_os = "windows")]
fn token_after(line: &str, marker: &str) -> Option<String> {
    let start = line.find(marker)? + marker.len();
    line[start..]
        .split_whitespace()
        .next()
        .map(|token| token.trim_matches(',').to_string())
        .filter(|token| !token.is_empty())
}

#[cfg(target_os = "windows")]
fn camera_format_score(format: &CameraFormatInfo) -> (u64, u32, u8) {
    let area = format.width as u64 * format.height as u64;
    let fps = format.fps.as_deref().and_then(parse_fps_score).unwrap_or(0);
    let raw_bonus = u8::from(format.pixel_format.is_some());
    (area, fps, raw_bonus)
}

#[cfg(target_os = "windows")]
fn parse_fps_score(fps: &str) -> Option<u32> {
    if let Some((num, den)) = fps.split_once('/') {
        let numerator = num.parse::<f64>().ok()?;
        let denominator = den.parse::<f64>().ok()?;
        if denominator <= 0.0 {
            return None;
        }
        return Some((numerator / denominator * 1000.0).round() as u32);
    }
    Some((fps.parse::<f64>().ok()? * 1000.0).round() as u32)
}

#[cfg(target_os = "windows")]
fn best_camera_format(formats: &[CameraFormatInfo]) -> Option<CameraFormatInfo> {
    formats.iter().cloned().max_by_key(camera_format_score)
}

#[cfg(target_os = "windows")]
fn quoted_value(line: &str) -> Option<String> {
    let start = line.find('"')?;
    let rest = &line[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Parse avfoundation `-list_devices true` output on macOS.
///
/// FFmpeg output looks like:
/// ```text
/// [AVFoundation indev @ ...] AVFoundation video devices:
/// [AVFoundation indev @ ...] [0] FaceTime HD Camera
/// [AVFoundation indev @ ...] [1] Capture screen 0
/// [AVFoundation indev @ ...] AVFoundation audio devices:
/// [AVFoundation indev @ ...] [0] MacBook Pro Microphone
/// [AVFoundation indev @ ...] [1] Microsoft Teams Audio
/// ```
#[cfg(target_os = "macos")]
fn parse_avfoundation_devices(stderr: &str) -> Vec<RecordingDeviceInfo> {
    #[derive(Copy, Clone, PartialEq)]
    enum Section {
        Video,
        Audio,
    }

    let mut section: Option<Section> = None;
    let mut devices = Vec::new();
    let mut screen_index = 0u32;

    for line in stderr.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("avfoundation video devices") {
            section = Some(Section::Video);
            continue;
        }
        if lower.contains("avfoundation audio devices") {
            section = Some(Section::Audio);
            continue;
        }

        // Match lines like "[0] Device Name" after the ] prefix
        let Some(bracket_start) = line.rfind('[') else {
            continue;
        };
        let after_bracket = &line[bracket_start + 1..];
        let Some(bracket_end) = after_bracket.find(']') else {
            continue;
        };
        let index_str = &after_bracket[..bracket_end];
        if index_str.parse::<u32>().is_err() {
            continue;
        }
        let name = after_bracket[bracket_end + 1..].trim().to_string();
        if name.is_empty() {
            continue;
        }

        let Some(current_section) = section else {
            continue;
        };

        // Screen capture devices show as "Capture screen N" — treat as system resource
        if current_section == Section::Video && name.to_ascii_lowercase().contains("capture screen") {
            devices.push(RecordingDeviceInfo {
                id: format!("screen:{screen_index}"),
                label: name,
                kind: RecordingDeviceKind::Camera, // categorized as video source
                is_default: screen_index == 0,
                camera_formats: Vec::new(),
            });
            screen_index += 1;
        } else {
            let kind = match current_section {
                Section::Video => RecordingDeviceKind::Camera,
                Section::Audio => RecordingDeviceKind::Microphone,
            };
            devices.push(RecordingDeviceInfo {
                id: name.clone(),
                label: name,
                kind,
                is_default: false,
                camera_formats: Vec::new(),
            });
        }
    }

    // Mark first mic as default
    if let Some(first_mic) = devices.iter_mut().find(|d| d.kind == RecordingDeviceKind::Microphone) {
        first_mic.is_default = true;
    }

    devices
}

/// Known virtual audio loopback device names on macOS.
const MACOS_LOOPBACK_DEVICE_NAMES: &[&str] = &[
    "blackhole",
    "loopback audio",
    "soundflower",
    "existential audio",
];

/// Detect if a virtual audio loopback device is available on macOS.
/// Returns the device name if found (used as system audio source in avfoundation).
#[cfg(target_os = "macos")]
pub fn detect_macos_loopback_device() -> Option<String> {
    let discovery = discover_recording_devices();
    for device in &discovery.devices {
        if device.kind != RecordingDeviceKind::Microphone {
            continue;
        }
        let lower = device.label.to_ascii_lowercase();
        for &pattern in MACOS_LOOPBACK_DEVICE_NAMES {
            if lower.contains(pattern) {
                log::info!(
                    "[recording] detected macOS loopback device: {}",
                    device.label
                );
                return Some(device.id.clone());
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
pub fn detect_macos_loopback_device() -> Option<String> {
    None
}

pub fn build_prompter_script(
    project_root: &Path,
    scope: &RecordingScope,
) -> anyhow::Result<PrompterScript> {
    match scope {
        RecordingScope::Sketch { path } => {
            let script = prompter_script_for_sketch_path(project_root, path, None)?;
            Ok(PrompterScript {
                title: script.title.clone(),
                steps: script.steps,
            })
        }
        RecordingScope::Storyboard { path } => {
            let storyboard_path = project::safe_resolve(project_root, path)?;
            let storyboard = project::read_storyboard(&storyboard_path)?;
            let mut steps = Vec::new();
            for item in &storyboard.items {
                match item {
                    StoryboardItem::SketchRef { path } => {
                        steps.extend(
                            prompter_script_for_sketch_path(project_root, path, None)?.steps,
                        );
                    }
                    StoryboardItem::Section { title, sketches } => {
                        for sketch_path in sketches {
                            steps.extend(
                                prompter_script_for_sketch_path(
                                    project_root,
                                    sketch_path,
                                    Some(title.clone()),
                                )?
                                .steps,
                            );
                        }
                    }
                }
            }
            Ok(PrompterScript {
                title: storyboard.title,
                steps,
            })
        }
    }
}

fn prompter_script_for_sketch_path(
    project_root: &Path,
    path: &str,
    section: Option<String>,
) -> anyhow::Result<PrompterScript> {
    let sketch_path = project::safe_resolve(project_root, path)?;
    let sketch = project::read_sketch_with_migration(&sketch_path, project_root)?;
    Ok(prompter_script_for_sketch(&sketch, path, section))
}

fn prompter_script_for_sketch(
    sketch: &Sketch,
    source_path: &str,
    section: Option<String>,
) -> PrompterScript {
    let steps = sketch
        .rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            prompter_step_for_row(sketch, source_path, section.as_ref(), index, row)
        })
        .collect();

    PrompterScript {
        title: sketch.title.clone(),
        steps,
    }
}

fn prompter_step_for_row(
    sketch: &Sketch,
    source_path: &str,
    section: Option<&String>,
    row_index: usize,
    row: &PlanningRow,
) -> Option<PrompterStep> {
    let narrative = normalize_prompter_text(&row.narrative);
    let cue = normalize_prompter_text(&row.demo_actions);
    if narrative.is_empty() && cue.is_empty() {
        return None;
    }
    Some(PrompterStep {
        title: sketch.title.clone(),
        section: section.cloned(),
        narrative: if narrative.is_empty() {
            cue.clone()
        } else {
            narrative
        },
        cue: (!cue.is_empty()).then_some(cue),
        source_path: source_path.to_string(),
        row_index,
    })
}

fn normalize_prompter_text(value: &str) -> String {
    value
        .lines()
        .map(|line| {
            line.trim()
                .trim_start_matches(|c: char| c == '-' || c == '*' || c == '•')
                .trim()
                .to_string()
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecordingScope {
    Sketch { path: String },
    Storyboard { path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrompterStep {
    pub title: String,
    pub section: Option<String>,
    pub narrative: String,
    pub cue: Option<String>,
    pub source_path: String,
    pub row_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PrompterScript {
    pub title: String,
    pub steps: Vec<PrompterStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureSource {
    FullScreen,
    Region,
    Window,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureBackend {
    Auto,
    NativeWindowsGraphicsCapture,
    WindowsGraphicsCapture,
    DesktopDuplication,
    GdiGrab,
}

fn default_capture_backend() -> CaptureBackend {
    CaptureBackend::Auto
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputQuality {
    Lossless,
    High,
    Compact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecorderSettings {
    pub capture_source: CaptureSource,
    #[serde(default)]
    pub capture_area: Option<CaptureArea>,
    pub mic_device_id: Option<String>,
    #[serde(default)]
    pub camera_device_id: Option<String>,
    #[serde(default)]
    pub camera_format: Option<CameraFormatInfo>,
    pub countdown_seconds: u8,
    #[serde(default = "default_frame_rate")]
    pub frame_rate: u16,
    pub include_cursor: bool,
    #[serde(default)]
    pub include_system_audio: bool,
    #[serde(default = "default_audio_volume")]
    pub mic_volume: u8,
    #[serde(default = "default_audio_volume")]
    pub system_audio_volume: u8,
    pub output_quality: OutputQuality,
    #[serde(default = "default_capture_backend")]
    pub capture_backend: CaptureBackend,
}

fn default_frame_rate() -> u16 {
    30
}

fn default_audio_volume() -> u8 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CaptureArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub display_index: Option<u32>,
    #[serde(default)]
    pub hmonitor: Option<String>,
    #[serde(default)]
    pub dxgi_output_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingAssetKind {
    Screen,
    ScreenProxy,
    Mic,
    Camera,
    SystemAudio,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingAssetStatus {
    Planned,
    LocalOnly,
    Missing,
    Exported,
    Uploaded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingAssetRef {
    pub kind: RecordingAssetKind,
    /// Path relative to the take directory.
    pub path: String,
    pub status: RecordingAssetStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingMarker {
    /// Recording-relative timestamp.
    pub time_ms: u64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingTakeStatus {
    Prepared,
    Recording,
    Finalized,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordingTake {
    pub schema_version: u32,
    pub id: String,
    pub scope: RecordingScope,
    pub settings: RecorderSettings,
    pub status: RecordingTakeStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Path to `take.json` relative to the project root.
    pub metadata_path: String,
    #[serde(default)]
    pub assets: Vec<RecordingAssetRef>,
    #[serde(default)]
    pub markers: Vec<RecordingMarker>,
}

pub fn create_recording_take(
    project_root: &Path,
    scope: RecordingScope,
    settings: RecorderSettings,
) -> anyhow::Result<RecordingTake> {
    let scope = validate_scope(project_root, scope)?;
    let recordings = initialize_recording_storage(project_root)?;

    for _ in 0..5 {
        let id = generate_take_id();
        if let Some(take) = try_create_recording_take(&recordings, &id, &scope, &settings)? {
            return Ok(take);
        }
    }

    anyhow::bail!("Could not allocate a unique recording take id")
}

fn try_create_recording_take(
    recordings_dir: &Path,
    id: &str,
    scope: &RecordingScope,
    settings: &RecorderSettings,
) -> anyhow::Result<Option<RecordingTake>> {
    validate_take_id(id)?;
    let take_dir = recordings_dir.join(id);
    match std::fs::create_dir(&take_dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
        Err(err) => return Err(err.into()),
    }

    let now = Utc::now();
    let take = RecordingTake {
        schema_version: 1,
        id: id.to_string(),
        scope: scope.clone(),
        settings: settings.clone(),
        status: RecordingTakeStatus::Prepared,
        created_at: now,
        updated_at: now,
        metadata_path: format!("{RECORDINGS_DIR}/{id}/take.json"),
        assets: Vec::new(),
        markers: Vec::new(),
    };

    write_take_sidecar(&take_dir.join("take.json"), &take)?;
    Ok(Some(take))
}

pub fn start_recording_capture(
    project_root: &Path,
    scope: RecordingScope,
    settings: RecorderSettings,
) -> anyhow::Result<ActiveRecording> {
    if settings.capture_source != CaptureSource::FullScreen {
        anyhow::bail!("Only full-screen recording is available in this build");
    }

    let mut take = create_recording_take(project_root, scope, settings)?;
    let take_sidecar = project_root.join(&take.metadata_path);
    let take_dir = take_sidecar
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Recording take metadata path has no parent"))?
        .to_path_buf();
    let output_asset_path = recording_output_asset_path(take.settings.output_quality);
    let output_path = take_dir.join(output_asset_path);
    let ffmpeg_log_path = take_dir.join("ffmpeg.log");
    let camera_output_path = take
        .settings
        .camera_device_id
        .as_ref()
        .filter(|device| !device.trim().is_empty())
        .map(|_| take_dir.join("camera.mp4"));
    let process = match spawn_capture_process(&take.settings, &output_path, &ffmpeg_log_path) {
        Ok(process) => process,
        Err(err) => {
            take.status = RecordingTakeStatus::Failed;
            take.updated_at = Utc::now();
            write_take_sidecar(&take_dir.join("take.json"), &take)?;
            log::warn!(
                "[recording] failed to start capture take={}: {err}",
                take.id
            );
            return Err(err);
        }
    };

    take.status = RecordingTakeStatus::Recording;
    take.updated_at = Utc::now();
    take.assets = vec![RecordingAssetRef {
        kind: RecordingAssetKind::Screen,
        path: output_asset_path.to_string(),
        status: RecordingAssetStatus::Planned,
    }];
    let camera_process = match camera_output_path.as_ref() {
        Some(camera_path) => match spawn_camera_process(
            &take.settings,
            camera_path,
            &take_dir.join("ffmpeg-camera.log"),
        ) {
            Ok(process) => {
                take.assets.push(RecordingAssetRef {
                    kind: RecordingAssetKind::Camera,
                    path: "camera.mp4".to_string(),
                    status: RecordingAssetStatus::Planned,
                });
                Some(process)
            }
            Err(err) => {
                log::warn!(
                    "[recording] camera capture unavailable for take={}: {err}",
                    take.id
                );
                take.assets.push(RecordingAssetRef {
                    kind: RecordingAssetKind::Camera,
                    path: "camera.mp4".to_string(),
                    status: RecordingAssetStatus::Missing,
                });
                None
            }
        },
        None => None,
    };
    write_take_sidecar(&take_dir.join("take.json"), &take)?;

    // System audio capture (macOS: loopback device via avfoundation)
    let system_audio_process = if take.settings.include_system_audio {
        let sys_audio_path = take_dir.join("system-audio.wav");
        match spawn_system_audio_capture(&take.settings, &sys_audio_path) {
            Ok(child) => {
                take.assets.push(RecordingAssetRef {
                    kind: RecordingAssetKind::SystemAudio,
                    path: "system-audio.wav".to_string(),
                    status: RecordingAssetStatus::Planned,
                });
                write_take_sidecar(&take_dir.join("take.json"), &take)?;
                Some(child)
            }
            Err(err) => {
                log::warn!(
                    "[recording] system audio capture unavailable for take={}: {err}",
                    take.id
                );
                None
            }
        }
    } else {
        None
    };

    Ok(ActiveRecording {
        process,
        camera_process,
        system_audio_process,
        take,
        take_dir,
        output_path,
        output_asset_path: output_asset_path.to_string(),
        camera_output_path,
    })
}

pub fn stop_recording_capture(mut active: ActiveRecording) -> anyhow::Result<RecordingTake> {
    if let Some(camera) = active.camera_process.take() {
        if let Err(err) = camera.stop() {
            log::warn!("[recording] failed to stop camera capture: {err}");
        }
    }
    if let Some(mut sys_audio) = active.system_audio_process.take() {
        if let Err(err) = stop_ffmpeg_child(&mut sys_audio) {
            log::warn!("[recording] failed to stop system audio capture: {err}");
        }
    }
    active.process.stop()?;
    let output_ready =
        is_recording_output_ready(&active.output_path, active.take.settings.output_quality);
    active.take.status = if output_ready {
        RecordingTakeStatus::Finalized
    } else {
        RecordingTakeStatus::Failed
    };
    active.take.updated_at = Utc::now();
    let mut assets = vec![RecordingAssetRef {
        kind: RecordingAssetKind::Screen,
        path: active.output_asset_path.clone(),
        status: if output_ready {
            RecordingAssetStatus::LocalOnly
        } else {
            RecordingAssetStatus::Missing
        },
    }];

    let mic_path = active.take_dir.join("mic.wav");
    let explicit_mic = active
        .take
        .settings
        .mic_device_id
        .as_ref()
        .map(|device| !device.trim().is_empty())
        .unwrap_or(false);
    if explicit_mic || recording_asset_ready(&mic_path) {
        assets.push(RecordingAssetRef {
            kind: RecordingAssetKind::Mic,
            path: "mic.wav".to_string(),
            status: if recording_asset_ready(&mic_path) {
                RecordingAssetStatus::LocalOnly
            } else {
                RecordingAssetStatus::Missing
            },
        });
    }

    if active.take.settings.include_system_audio {
        assets.push(RecordingAssetRef {
            kind: RecordingAssetKind::SystemAudio,
            path: "system-audio.wav".to_string(),
            status: if recording_asset_ready(&active.take_dir.join("system-audio.wav")) {
                RecordingAssetStatus::LocalOnly
            } else {
                RecordingAssetStatus::Missing
            },
        });
    }

    if active
        .take
        .settings
        .camera_device_id
        .as_ref()
        .map(|device| !device.trim().is_empty())
        .unwrap_or(false)
    {
        let camera_path = active
            .camera_output_path
            .clone()
            .unwrap_or_else(|| active.take_dir.join("camera.mp4"));
        assets.push(RecordingAssetRef {
            kind: RecordingAssetKind::Camera,
            path: "camera.mp4".to_string(),
            status: if is_recording_output_ready(&camera_path, OutputQuality::High) {
                RecordingAssetStatus::LocalOnly
            } else {
                RecordingAssetStatus::Missing
            },
        });
    }

    if output_ready && active.take.settings.output_quality == OutputQuality::Lossless {
        let proxy_path = active.take_dir.join("screen-proxy.mp4");
        match generate_review_proxy(&active.output_path, &proxy_path, &active.take.settings) {
            Ok(()) => {
                log::info!(
                    "[recording] generated proxy take={} output={}",
                    active.take.id,
                    proxy_path.display()
                );
                assets.push(RecordingAssetRef {
                    kind: RecordingAssetKind::ScreenProxy,
                    path: "screen-proxy.mp4".to_string(),
                    status: RecordingAssetStatus::LocalOnly,
                });
            }
            Err(err) => {
                log::warn!(
                    "[recording] proxy generation failed take={}: {}",
                    active.take.id,
                    err
                );
                assets.push(RecordingAssetRef {
                    kind: RecordingAssetKind::ScreenProxy,
                    path: "screen-proxy.mp4".to_string(),
                    status: RecordingAssetStatus::Missing,
                });
            }
        }
    }

    active.take.assets = assets;
    write_take_sidecar(&active.take_dir.join("take.json"), &active.take)?;
    log::info!(
        "[recording] stopped take={} status={:?} output_ready={}",
        active.take.id,
        active.take.status,
        output_ready
    );
    Ok(active.take)
}

pub fn discard_recording_capture(mut active: ActiveRecording) -> anyhow::Result<RecordingTake> {
    if let Some(camera) = active.camera_process.take() {
        if let Err(err) = camera.stop() {
            log::warn!("[recording] failed to stop camera capture before discard: {err}");
        }
    }
    if let Some(mut sys_audio) = active.system_audio_process.take() {
        if let Err(err) = stop_ffmpeg_child(&mut sys_audio) {
            log::warn!("[recording] failed to stop system audio capture before discard: {err}");
        }
    }
    if let Err(err) = active.process.stop() {
        log::warn!("[recording] failed to stop screen capture before discard: {err}");
    }
    active.take.status = RecordingTakeStatus::Failed;
    active.take.updated_at = Utc::now();
    active.take.assets = Vec::new();
    let take_dir = active.take_dir.clone();
    if take_dir.exists() {
        std::fs::remove_dir_all(&take_dir)?;
    }
    log::info!(
        "[recording] discarded take={} folder={}",
        active.take.id,
        take_dir.display()
    );
    Ok(active.take)
}

pub fn active_recording_take(active: &ActiveRecording) -> RecordingTake {
    active.take.clone()
}

pub fn active_recording_take_dir(active: &ActiveRecording) -> &Path {
    &active.take_dir
}

pub fn finalize_finished_recording(
    active: &mut Option<ActiveRecording>,
) -> anyhow::Result<Option<RecordingTake>> {
    let finished = match active.as_mut() {
        Some(recording) => recording.process.is_finished()?,
        None => false,
    };
    if !finished {
        return Ok(None);
    }

    let recording = active
        .take()
        .ok_or_else(|| anyhow::anyhow!("Recording state changed while finalizing"))?;
    stop_recording_capture(recording).map(Some)
}

fn spawn_capture_process(
    settings: &RecorderSettings,
    output_path: &Path,
    log_path: &Path,
) -> anyhow::Result<ActiveRecordingProcess> {
    #[cfg(target_os = "windows")]
    if should_use_native_windows_capture(settings) {
        match crate::engine::recording_native_windows::NativeWindowsRecording::start(
            settings,
            output_path,
            log_path,
        ) {
            Ok(recording) => {
                log::info!(
                    "[recording] started native Windows capture capture_area={:?} frame_rate={} output={}",
                    settings.capture_area,
                    settings.frame_rate,
                    output_path.display()
                );
                return Ok(ActiveRecordingProcess::NativeWindows(recording));
            }
            Err(err)
                if settings.capture_backend == CaptureBackend::Auto
                    && !settings.include_system_audio =>
            {
                log::warn!(
                    "[recording] native Windows capture unavailable, falling back to FFmpeg: {err}"
                );
            }
            Err(err) => return Err(err),
        }
    }

    let args = build_ffmpeg_capture_args(settings, output_path)?;
    write_ffmpeg_log_header(log_path, &args)?;
    log::info!(
        "[recording] starting FFmpeg capture capture_area={:?} frame_rate={} output={}",
        settings.capture_area,
        settings.frame_rate,
        output_path.display()
    );
    log::debug!("[recording] ffmpeg args: {}", args.join(" "));
    spawn_ffmpeg_capture(args, log_path).map(ActiveRecordingProcess::Ffmpeg)
}

#[cfg(target_os = "windows")]
fn should_use_native_windows_capture(settings: &RecorderSettings) -> bool {
    matches!(
        settings.capture_backend,
        CaptureBackend::Auto | CaptureBackend::NativeWindowsGraphicsCapture
    ) && settings.output_quality != OutputQuality::Lossless
        && settings
            .capture_area
            .as_ref()
            .and_then(|area| area.hmonitor.as_deref())
            .map(|hmonitor| !hmonitor.trim().is_empty())
            .unwrap_or(false)
}

fn stop_ffmpeg_child(child: &mut Child) -> anyhow::Result<()> {
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }

    let started = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if started.elapsed() >= RECORDING_STOP_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    Ok(())
}

fn spawn_ffmpeg_capture(args: Vec<String>, log_path: &Path) -> anyhow::Result<Child> {
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    let mut command = Command::new("ffmpeg");
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    Ok(command.spawn()?)
}

/// Spawn a separate FFmpeg process to capture system audio on macOS via a loopback device.
/// On Windows, system audio is captured natively by WASAPI — this is macOS-only.
fn spawn_system_audio_capture(
    settings: &RecorderSettings,
    output_path: &Path,
) -> anyhow::Result<Child> {
    #[cfg(target_os = "macos")]
    {
        let loopback_device = detect_macos_loopback_device()
            .ok_or_else(|| anyhow::anyhow!("No loopback audio device found on macOS"))?;

        // Find the avfoundation index for this device
        let discovery = discover_recording_devices();
        let device_index = discovery
            .devices
            .iter()
            .filter(|d| d.kind == RecordingDeviceKind::Microphone)
            .position(|d| d.id == loopback_device)
            .ok_or_else(|| {
                anyhow::anyhow!("Loopback device '{}' not found in device list", loopback_device)
            })?;

        let mut args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "warning".to_string(),
            "-f".to_string(),
            "avfoundation".to_string(),
            "-i".to_string(),
            format!("none:{device_index}"),
            "-c:a".to_string(),
            "pcm_s16le".to_string(),
            "-ar".to_string(),
            "48000".to_string(),
            "-ac".to_string(),
            "2".to_string(),
        ];

        if settings.system_audio_volume != default_audio_volume() {
            args.extend([
                "-af".to_string(),
                format!(
                    "volume={:.2}",
                    settings.system_audio_volume.min(200) as f32 / 100.0
                ),
            ]);
        }

        args.push(output_path.to_string_lossy().to_string());

        let log_path = output_path.with_extension("log");
        write_ffmpeg_log_header(&log_path, &args)?;
        log::info!(
            "[recording] starting system audio capture via loopback device='{}' index={} output={}",
            loopback_device,
            device_index,
            output_path.display()
        );
        spawn_ffmpeg_capture(args, &log_path)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (settings, output_path);
        Err(anyhow::anyhow!(
            "System audio capture via loopback is only implemented for macOS"
        ))
    }
}

fn spawn_camera_process(
    settings: &RecorderSettings,
    output_path: &Path,
    log_path: &Path,
) -> anyhow::Result<ActiveCameraProcess> {
    #[allow(unused_mut)]
    let mut prefer_negotiated_camera_fallback = false;

    #[cfg(target_os = "windows")]
    if let Some(device) = settings
        .camera_device_id
        .as_ref()
        .map(|device| device.trim())
        .filter(|device| !device.is_empty())
    {
        match crate::engine::recording_native_camera_windows::NativeCameraRecording::start(
            device.to_string(),
            settings.camera_format.clone(),
            output_path,
            log_path,
        ) {
            Ok(recording) => {
                log::info!(
                    "[recording] started native camera capture device={:?} output={}",
                    settings.camera_device_id,
                    output_path.display()
                );
                return Ok(ActiveCameraProcess::NativeWindows(recording));
            }
            Err(err) => {
                log::warn!(
                    "[recording] native camera capture unavailable, falling back to FFmpeg DirectShow: {err}"
                );
                prefer_negotiated_camera_fallback =
                    native_camera_failure_prefers_negotiated_fallback(&err);
            }
        }
    }

    let Some(args) = build_ffmpeg_camera_args_with_mode(
        settings,
        output_path,
        !prefer_negotiated_camera_fallback,
    )?
    else {
        anyhow::bail!("No camera selected");
    };
    if prefer_negotiated_camera_fallback {
        append_ffmpeg_log(
            log_path,
            "native camera activation failed; starting FFmpeg camera capture in negotiated mode",
        )?;
    }
    let _ = std::fs::remove_file(output_path);
    log::info!(
        "[recording] starting camera capture device={:?} output={}",
        settings.camera_device_id,
        output_path.display()
    );
    let used_explicit_input_options = camera_args_use_explicit_input_options(&args);
    match spawn_ffmpeg_camera_with_startup_check(args, log_path) {
        Ok(child) => return Ok(ActiveCameraProcess::Ffmpeg(child)),
        Err(first_err) if used_explicit_input_options => {
            log::warn!(
                "[recording] camera capture failed with explicit device mode; retrying negotiated mode: {first_err}"
            );
            append_ffmpeg_log(
                log_path,
                &format!(
                    "camera explicit-mode startup failed; retrying without -vcodec/-pixel_format/-video_size/-framerate: {first_err}"
                ),
            )?;
            let _ = std::fs::remove_file(output_path);
            let Some(fallback_args) =
                build_ffmpeg_camera_args_with_mode(settings, output_path, false)?
            else {
                anyhow::bail!("No camera selected");
            };
            spawn_ffmpeg_camera_with_startup_check(fallback_args, log_path)
                .map(ActiveCameraProcess::Ffmpeg)
                .map_err(|fallback_err| {
                    anyhow::anyhow!(
                        "Camera capture failed with explicit mode ({first_err}) and negotiated mode ({fallback_err})"
                    )
                })
        }
        Err(err) => Err(err),
    }
}

#[cfg(target_os = "windows")]
fn native_camera_failure_prefers_negotiated_fallback(err: &anyhow::Error) -> bool {
    format!("{err:#}").contains("Media Foundation camera device activation failed")
}

fn spawn_ffmpeg_camera_with_startup_check(
    args: Vec<String>,
    log_path: &Path,
) -> anyhow::Result<Child> {
    write_ffmpeg_log_header(log_path, &args)?;
    let mut child = spawn_ffmpeg_capture(args, log_path)?;
    std::thread::sleep(Duration::from_millis(500));
    if let Some(status) = child.try_wait()? {
        let log_summary = std::fs::read_to_string(log_path)
            .ok()
            .and_then(|text| {
                text.lines()
                    .rev()
                    .find(|line| !line.trim().is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "no camera log output".to_string());
        anyhow::bail!("Camera capture exited during startup ({status}): {log_summary}");
    }
    Ok(child)
}

fn camera_args_use_explicit_input_options(args: &[String]) -> bool {
    args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "-vcodec" | "-pixel_format" | "-video_size" | "-framerate"
        )
    })
}

fn write_ffmpeg_log_header(path: &Path, args: &[String]) -> anyhow::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "ffmpeg {}", args.join(" "))?;
    Ok(())
}

fn append_ffmpeg_log(path: &Path, message: &str) -> anyhow::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{message}")?;
    Ok(())
}

fn is_recording_output_ready(path: &Path, output_quality: OutputQuality) -> bool {
    if !path
        .metadata()
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
    {
        return false;
    }

    if output_quality == OutputQuality::Lossless {
        return true;
    }

    let mut command = Command::new("ffprobe");
    command
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn recording_asset_ready(path: &Path) -> bool {
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
}

fn generate_review_proxy(
    master_path: &Path,
    proxy_path: &Path,
    settings: &RecorderSettings,
) -> anyhow::Result<()> {
    let args = build_ffmpeg_proxy_args(master_path, proxy_path, settings);
    log::debug!("[recording] ffmpeg proxy args: {}", args.join(" "));
    let output = run_ffmpeg_vec(args)?;
    if output.success {
        return Ok(());
    }

    let message = first_non_empty_line(&output.stderr)
        .or_else(|| first_non_empty_line(&output.stdout))
        .unwrap_or_else(|| "FFmpeg proxy generation failed".to_string());
    anyhow::bail!("{message}");
}

fn run_ffmpeg_vec(args: Vec<String>) -> anyhow::Result<FfmpegCommandOutput> {
    let mut command = Command::new("ffmpeg");
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output()?;
    Ok(FfmpegCommandOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn build_ffmpeg_capture_args(
    settings: &RecorderSettings,
    output_path: &Path,
) -> anyhow::Result<Vec<String>> {
    if settings.capture_source != CaptureSource::FullScreen {
        anyhow::bail!("Only full-screen recording is available in this build");
    }

    #[cfg(target_os = "macos")]
    {
        let mut args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "warning".to_string(),
        ];

        // Screen capture via avfoundation — device "0" is typically first screen
        let screen_index = settings
            .capture_area
            .as_ref()
            .and_then(|area| area.dxgi_output_index) // reuse as screen index on macOS
            .unwrap_or(0);

        args.extend([
            "-f".to_string(),
            "avfoundation".to_string(),
            "-framerate".to_string(),
            settings.frame_rate.to_string(),
            "-capture_cursor".to_string(),
            if settings.include_cursor { "1" } else { "0" }.to_string(),
        ]);

        let has_mic = settings
            .mic_device_id
            .as_ref()
            .map(|device| !device.trim().is_empty())
            .unwrap_or(false);

        // avfoundation input format: "video_device_index:audio_device_index"
        if has_mic {
            let mic_index = settings
                .mic_device_id
                .as_ref()
                .and_then(|d| d.parse::<u32>().ok())
                .unwrap_or(0);
            args.extend(["-i".to_string(), format!("{screen_index}:{mic_index}")]);
        } else {
            args.extend(["-i".to_string(), format!("{screen_index}:none")]);
        }

        // Video encoding
        args.extend(["-map".to_string(), "0:v:0".to_string()]);

        match settings.output_quality {
            OutputQuality::Lossless => args.extend([
                "-r".to_string(),
                settings.frame_rate.to_string(),
                "-c:v".to_string(),
                "ffv1".to_string(),
                "-level".to_string(),
                "3".to_string(),
                "-g".to_string(),
                "1".to_string(),
            ]),
            OutputQuality::High | OutputQuality::Compact => {
                let crf = match settings.output_quality {
                    OutputQuality::High => "20",
                    OutputQuality::Compact => "28",
                    OutputQuality::Lossless => unreachable!(),
                };
                args.extend([
                    "-vf".to_string(),
                    format!("fps={},format=yuv420p", settings.frame_rate),
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "ultrafast".to_string(),
                    "-tune".to_string(),
                    "zerolatency".to_string(),
                    "-crf".to_string(),
                    crf.to_string(),
                ]);
                if settings.output_quality == OutputQuality::Compact {
                    args.extend([
                        "-maxrate".to_string(),
                        "8M".to_string(),
                        "-bufsize".to_string(),
                        "16M".to_string(),
                    ]);
                }
            }
        }

        // Audio encoding
        if has_mic {
            let audio_codec = match settings.output_quality {
                OutputQuality::Lossless => "pcm_s16le",
                OutputQuality::High | OutputQuality::Compact => "aac",
            };
            args.extend([
                "-map".to_string(),
                "0:a:0".to_string(),
                "-c:a".to_string(),
                audio_codec.to_string(),
            ]);
            if settings.mic_volume != default_audio_volume() {
                args.extend([
                    "-af".to_string(),
                    format!("volume={:.2}", settings.mic_volume.min(200) as f32 / 100.0),
                ]);
            }
            if settings.output_quality != OutputQuality::Lossless {
                args.extend(["-b:a".to_string(), "192k".to_string()]);
            }
        }

        if settings.output_quality != OutputQuality::Lossless {
            args.extend(["-movflags".to_string(), "+faststart".to_string()]);
        }

        args.push(output_path.to_string_lossy().to_string());
        return Ok(args);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = output_path;
        return Err(anyhow::anyhow!(
            "Recording capture is not implemented for this platform yet"
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let use_desktop_duplication = matches!(
            settings.capture_backend,
            CaptureBackend::Auto | CaptureBackend::DesktopDuplication
        ) && settings.output_quality != OutputQuality::Lossless
            && settings
                .capture_area
                .as_ref()
                .and_then(|area| area.dxgi_output_index)
                .is_some();
        let use_windows_graphics_capture = matches!(
            settings.capture_backend,
            CaptureBackend::WindowsGraphicsCapture
        ) && settings.output_quality != OutputQuality::Lossless
            && settings
                .capture_area
                .as_ref()
                .and_then(|area| area.hmonitor.as_deref())
                .map(|hmonitor| !hmonitor.trim().is_empty())
                .unwrap_or(false);

        let mut args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "warning".to_string(),
        ];

        if use_desktop_duplication {
            let area = settings.capture_area.as_ref().expect("checked above");
            let output_index = area.dxgi_output_index.expect("checked above");
            args.extend([
                "-f".to_string(),
                "lavfi".to_string(),
                "-i".to_string(),
                format!(
                    "ddagrab=output_idx={output_index}:framerate={}:draw_mouse={}:dup_frames=1,hwdownload,format=bgra",
                    settings.frame_rate,
                    if settings.include_cursor { 1 } else { 0 }
                ),
            ]);
        } else if use_windows_graphics_capture {
            let area = settings.capture_area.as_ref().expect("checked above");
            let hmonitor = area.hmonitor.as_deref().expect("checked above").trim();
            args.extend([
                "-f".to_string(),
                "lavfi".to_string(),
                "-i".to_string(),
                format!(
                    "gfxcapture=hmonitor={hmonitor}:capture_cursor={}:max_framerate={}",
                    if settings.include_cursor { 1 } else { 0 },
                    settings.frame_rate
                ),
            ]);
        } else {
            args.extend([
                "-f".to_string(),
                "gdigrab".to_string(),
                "-framerate".to_string(),
                settings.frame_rate.to_string(),
                "-draw_mouse".to_string(),
                if settings.include_cursor { "1" } else { "0" }.to_string(),
            ]);
            if let Some(area) = &settings.capture_area {
                args.extend([
                    "-offset_x".to_string(),
                    area.x.to_string(),
                    "-offset_y".to_string(),
                    area.y.to_string(),
                    "-video_size".to_string(),
                    format!("{}x{}", area.width, area.height),
                ]);
            }
            args.extend(["-i".to_string(), "desktop".to_string()]);
        }

        let has_mic = settings
            .mic_device_id
            .as_ref()
            .map(|device| !device.trim().is_empty())
            .unwrap_or(false);
        if let Some(device) = settings
            .mic_device_id
            .as_ref()
            .filter(|device| !device.trim().is_empty())
        {
            args.extend([
                "-f".to_string(),
                "dshow".to_string(),
                "-i".to_string(),
                format!("audio={device}"),
            ]);
        }

        args.extend(["-map".to_string(), "0:v:0".to_string()]);

        match settings.output_quality {
            OutputQuality::Lossless => args.extend([
                "-r".to_string(),
                settings.frame_rate.to_string(),
                "-c:v".to_string(),
                "ffv1".to_string(),
                "-level".to_string(),
                "3".to_string(),
                "-g".to_string(),
                "1".to_string(),
            ]),
            OutputQuality::High | OutputQuality::Compact => {
                let crf = match settings.output_quality {
                    OutputQuality::High => "20",
                    OutputQuality::Compact => "28",
                    OutputQuality::Lossless => unreachable!(),
                };
                let video_filter = if use_windows_graphics_capture {
                    format!(
                        "hwdownload,format=bgra,fps={},format=yuv420p",
                        settings.frame_rate
                    )
                } else if use_desktop_duplication {
                    format!("fps={},format=yuv420p", settings.frame_rate)
                } else {
                    format!("fps={},format=yuv420p", settings.frame_rate)
                };
                args.extend([
                    "-vf".to_string(),
                    video_filter,
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-preset".to_string(),
                    "ultrafast".to_string(),
                    "-tune".to_string(),
                    "zerolatency".to_string(),
                    "-crf".to_string(),
                    crf.to_string(),
                ]);
                if settings.output_quality == OutputQuality::Compact {
                    args.extend([
                        "-maxrate".to_string(),
                        "8M".to_string(),
                        "-bufsize".to_string(),
                        "16M".to_string(),
                    ]);
                }
            }
        }

        if has_mic {
            let audio_codec = match settings.output_quality {
                OutputQuality::Lossless => "pcm_s16le",
                OutputQuality::High | OutputQuality::Compact => "aac",
            };
            args.extend([
                "-map".to_string(),
                "1:a:0".to_string(),
                "-c:a".to_string(),
                audio_codec.to_string(),
            ]);
            if settings.mic_volume != default_audio_volume() {
                args.extend([
                    "-af".to_string(),
                    format!("volume={:.2}", settings.mic_volume.min(200) as f32 / 100.0),
                ]);
            }
            if settings.output_quality != OutputQuality::Lossless {
                args.extend(["-b:a".to_string(), "192k".to_string()]);
            }
        }

        if settings.output_quality != OutputQuality::Lossless {
            args.extend(["-movflags".to_string(), "+faststart".to_string()]);
        }

        args.push(output_path.to_string_lossy().to_string());
        Ok(args)
    }
}

#[cfg(test)]
fn build_ffmpeg_camera_args(
    settings: &RecorderSettings,
    output_path: &Path,
) -> anyhow::Result<Option<Vec<String>>> {
    build_ffmpeg_camera_args_with_mode(settings, output_path, true)
}

fn build_ffmpeg_camera_args_with_mode(
    settings: &RecorderSettings,
    output_path: &Path,
    use_explicit_input_options: bool,
) -> anyhow::Result<Option<Vec<String>>> {
    let Some(device) = settings
        .camera_device_id
        .as_ref()
        .map(|device| device.trim())
        .filter(|device| !device.is_empty())
    else {
        return Ok(None);
    };

    #[cfg(target_os = "macos")]
    {
        let _ = use_explicit_input_options;
        let mut args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "warning".to_string(),
            "-f".to_string(),
            "avfoundation".to_string(),
            "-framerate".to_string(),
            "30".to_string(),
            "-i".to_string(),
            format!("{device}:none"),
            "-map".to_string(),
            "0:v:0".to_string(),
            "-an".to_string(),
            "-vf".to_string(),
            "fps=30,format=yuv420p".to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "ultrafast".to_string(),
            "-tune".to_string(),
            "zerolatency".to_string(),
            "-crf".to_string(),
            "23".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
            output_path.to_string_lossy().to_string(),
        ];
        let _ = &mut args; // suppress warning
        return Ok(Some(args));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = output_path;
        let _ = device;
        let _ = use_explicit_input_options;
        return Err(anyhow::anyhow!(
            "Camera recording is not implemented for this platform yet"
        ));
    }

    #[cfg(target_os = "windows")]
    {
        let camera_format = settings.camera_format.clone().or_else(|| {
            discover_camera_formats(device)
                .ok()
                .and_then(|formats| best_camera_format(&formats))
        });
        let mut args = vec![
            "-y".to_string(),
            "-hide_banner".to_string(),
            "-loglevel".to_string(),
            "warning".to_string(),
            "-f".to_string(),
            "dshow".to_string(),
            "-rtbufsize".to_string(),
            "256M".to_string(),
        ];
        if use_explicit_input_options {
            if let Some(format) = camera_format.as_ref() {
                if let Some(codec) = format.codec.as_deref() {
                    args.extend(["-vcodec".to_string(), codec.to_string()]);
                }
                if let Some(pixel_format) = format.pixel_format.as_deref() {
                    args.extend(["-pixel_format".to_string(), pixel_format.to_string()]);
                }
                args.extend([
                    "-video_size".to_string(),
                    format!("{}x{}", format.width, format.height),
                ]);
                if let Some(fps) = format.fps.as_deref() {
                    args.extend(["-framerate".to_string(), fps.to_string()]);
                }
            }
        }
        args.extend([
            "-i".to_string(),
            format!("video={device}"),
            "-map".to_string(),
            "0:v:0".to_string(),
            "-an".to_string(),
            "-vf".to_string(),
            "fps=30,format=yuv420p".to_string(),
            "-c:v".to_string(),
            "libx264".to_string(),
            "-preset".to_string(),
            "ultrafast".to_string(),
            "-tune".to_string(),
            "zerolatency".to_string(),
            "-crf".to_string(),
            "23".to_string(),
            "-movflags".to_string(),
            "+faststart".to_string(),
            output_path.to_string_lossy().to_string(),
        ]);
        Ok(Some(args))
    }
}

fn recording_output_asset_path(output_quality: OutputQuality) -> &'static str {
    match output_quality {
        OutputQuality::Lossless => "screen.mkv",
        OutputQuality::High | OutputQuality::Compact => "screen.mp4",
    }
}

fn build_ffmpeg_proxy_args(
    master_path: &Path,
    proxy_path: &Path,
    settings: &RecorderSettings,
) -> Vec<String> {
    let crf = match settings.output_quality {
        OutputQuality::Lossless => "20",
        OutputQuality::High => "22",
        OutputQuality::Compact => "28",
    };

    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "warning".to_string(),
        "-i".to_string(),
        master_path.to_string_lossy().to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-r".to_string(),
        settings.frame_rate.to_string(),
        "-vf".to_string(),
        format!("fps={},format=yuv420p", settings.frame_rate),
        "-c:v".to_string(),
        "libx264".to_string(),
        "-preset".to_string(),
        "veryfast".to_string(),
        "-crf".to_string(),
        crf.to_string(),
    ];

    if settings.output_quality == OutputQuality::Compact {
        args.extend([
            "-maxrate".to_string(),
            "8M".to_string(),
            "-bufsize".to_string(),
            "16M".to_string(),
        ]);
    }

    args.extend([
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        "192k".to_string(),
        "-movflags".to_string(),
        "+faststart".to_string(),
        proxy_path.to_string_lossy().to_string(),
    ]);

    args
}

fn validate_scope(project_root: &Path, scope: RecordingScope) -> anyhow::Result<RecordingScope> {
    let (path, expected_ext) = match &scope {
        RecordingScope::Sketch { path } => (path, "sk"),
        RecordingScope::Storyboard { path } => (path, "sb"),
    };

    let resolved = project::safe_resolve(project_root, path).map_err(|e| anyhow::anyhow!("{e}"))?;
    if !resolved.exists() {
        anyhow::bail!("Recording scope does not exist: {path}");
    }
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    if !ext.eq_ignore_ascii_case(expected_ext) {
        anyhow::bail!("Recording scope must reference a .{expected_ext} file");
    }

    let normalized = path.replace('\\', "/");
    Ok(match scope {
        RecordingScope::Sketch { .. } => RecordingScope::Sketch { path: normalized },
        RecordingScope::Storyboard { .. } => RecordingScope::Storyboard { path: normalized },
    })
}

fn validate_take_id(id: &str) -> anyhow::Result<()> {
    if id.is_empty() || id.len() > 80 || id.starts_with('.') {
        anyhow::bail!("Invalid recording take id");
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        anyhow::bail!("Invalid recording take id");
    }
    Ok(())
}

fn generate_take_id() -> String {
    let suffix = Uuid::new_v4().simple().to_string();
    format!(
        "take_{}_{}",
        Utc::now().format("%Y%m%d_%H%M%S"),
        &suffix[..8]
    )
}

fn write_take_sidecar(path: &Path, take: &RecordingTake) -> anyhow::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(take)?;
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&json)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn ensure_recordings_gitignore(recordings_dir: &Path) -> anyhow::Result<()> {
    let path = recordings_dir.join(".gitignore");
    if !path.exists() {
        std::fs::write(path, RECORDINGS_GITIGNORE)?;
        return Ok(());
    }

    let existing = std::fs::read_to_string(&path)?;
    let mut updated = existing.clone();
    let mut changed = false;

    for rule in ["*", "!.gitignore"] {
        if !existing.lines().any(|line| line.trim() == rule) {
            if !updated.ends_with('\n') {
                updated.push('\n');
            }
            updated.push_str(rule);
            updated.push('\n');
            changed = true;
        }
    }

    if changed {
        std::fs::write(path, updated)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_settings() -> RecorderSettings {
        RecorderSettings {
            capture_source: CaptureSource::FullScreen,
            capture_area: None,
            mic_device_id: None,
            camera_device_id: None,
            camera_format: None,
            countdown_seconds: 3,
            frame_rate: 30,
            include_cursor: true,
            include_system_audio: false,
            mic_volume: 100,
            system_audio_volume: 100,
            output_quality: OutputQuality::Lossless,
            capture_backend: CaptureBackend::Auto,
        }
    }

    #[test]
    fn prompter_script_uses_narrative_and_action_cues() {
        let mut sketch = Sketch::new("Intro");
        sketch.rows.push(PlanningRow {
            narrative: "- Say hello\n- Explain the goal".into(),
            demo_actions: "* Open the app".into(),
            ..PlanningRow::new()
        });

        let script = prompter_script_for_sketch(&sketch, "intro.sk", None);

        assert_eq!(script.title, "Intro");
        assert_eq!(script.steps.len(), 1);
        assert_eq!(script.steps[0].narrative, "Say hello\nExplain the goal");
        assert_eq!(script.steps[0].cue.as_deref(), Some("Open the app"));
    }

    #[test]
    fn prompter_script_skips_empty_rows() {
        let mut sketch = Sketch::new("Empty");
        sketch.rows.push(PlanningRow::new());
        sketch.rows.push(PlanningRow {
            narrative: String::new(),
            demo_actions: "Click Save".into(),
            ..PlanningRow::new()
        });

        let script = prompter_script_for_sketch(&sketch, "empty.sk", Some("Section".into()));

        assert_eq!(script.steps.len(), 1);
        assert_eq!(script.steps[0].narrative, "Click Save");
        assert_eq!(script.steps[0].section.as_deref(), Some("Section"));
    }

    #[test]
    fn initializes_recording_storage_with_dedicated_gitignore() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();

        assert_eq!(dir, temp.path().join(".cutready").join("recordings"));
        assert!(dir.is_dir());
        assert_eq!(
            std::fs::read_to_string(dir.join(".gitignore")).unwrap(),
            "*\n!.gitignore\n"
        );
    }

    #[test]
    fn recording_storage_initialization_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();
        let gitignore = dir.join(".gitignore");
        let first = std::fs::read(&gitignore).unwrap();

        initialize_recording_storage(temp.path()).unwrap();
        let second = std::fs::read(&gitignore).unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn recording_gitignore_keeps_itself_trackable() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        let rules: Vec<&str> = content.lines().collect();

        assert!(rules.contains(&"*"));
        assert!(rules.contains(&"!.gitignore"));
        assert!(
            !content.contains(".cutready/"),
            "recording ignore rules must not ignore other .cutready assets"
        );
    }

    #[test]
    fn existing_recording_gitignore_preserves_extra_rules() {
        let temp = tempfile::tempdir().unwrap();
        let dir = recordings_dir(temp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "# local notes\n*.tmp\n").unwrap();

        initialize_recording_storage(temp.path()).unwrap();
        let content = std::fs::read_to_string(dir.join(".gitignore")).unwrap();

        assert!(content.contains("# local notes"));
        assert!(content.contains("*.tmp"));
        assert!(content.lines().any(|line| line == "*"));
        assert!(content.lines().any(|line| line == "!.gitignore"));
    }

    #[test]
    fn clears_local_recordings_but_preserves_gitignore() {
        let temp = tempfile::tempdir().unwrap();
        let dir = initialize_recording_storage(temp.path()).unwrap();
        std::fs::create_dir(dir.join("take_one")).unwrap();
        std::fs::write(dir.join("take_one").join("screen.mkv"), "video").unwrap();
        std::fs::write(dir.join("orphan.tmp"), "tmp").unwrap();

        let removed = clear_local_recordings(temp.path()).unwrap();

        assert_eq!(removed, 2);
        assert!(dir.join(".gitignore").exists());
        assert!(!dir.join("take_one").exists());
        assert!(!dir.join("orphan.tmp").exists());
    }

    #[test]
    fn create_take_writes_prepared_sidecar_with_relative_scope() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("intro.sk"), "{}").unwrap();

        let take = create_recording_take(
            temp.path(),
            RecordingScope::Sketch {
                path: "intro.sk".into(),
            },
            default_settings(),
        )
        .unwrap();

        assert_eq!(take.schema_version, 1);
        assert_eq!(take.status, RecordingTakeStatus::Prepared);
        assert_eq!(
            take.scope,
            RecordingScope::Sketch {
                path: "intro.sk".into()
            }
        );
        assert!(take.metadata_path.starts_with(".cutready/recordings/"));

        let sidecar = temp.path().join(&take.metadata_path);
        let parsed: RecordingTake =
            serde_json::from_str(&std::fs::read_to_string(sidecar).unwrap()).unwrap();
        assert_eq!(parsed, take);
    }

    #[test]
    fn create_take_rejects_traversal_scope() {
        let temp = tempfile::tempdir().unwrap();
        let err = create_recording_take(
            temp.path(),
            RecordingScope::Sketch {
                path: "../outside.sk".into(),
            },
            default_settings(),
        )
        .unwrap_err();

        assert!(err.to_string().contains("Path traversal"));
    }

    #[test]
    fn create_take_rejects_wrong_scope_extension() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("intro.md"), "# intro").unwrap();

        let err = create_recording_take(
            temp.path(),
            RecordingScope::Sketch {
                path: "intro.md".into(),
            },
            default_settings(),
        )
        .unwrap_err();

        assert!(err.to_string().contains(".sk"));
    }

    #[test]
    fn validate_take_id_rejects_path_components() {
        for id in [
            "../take",
            "take/one",
            "take\\one",
            ".hidden",
            "take:one",
            "",
        ] {
            assert!(validate_take_id(id).is_err(), "{id} should be rejected");
        }
        assert!(validate_take_id("take_20260511_abcdef12").is_ok());
    }

    #[test]
    fn duplicate_take_id_does_not_clobber_existing_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let recordings = initialize_recording_storage(temp.path()).unwrap();
        std::fs::create_dir(recordings.join("take_duplicate")).unwrap();
        std::fs::write(
            recordings.join("take_duplicate").join("take.json"),
            "existing",
        )
        .unwrap();

        let result = try_create_recording_take(
            &recordings,
            "take_duplicate",
            &RecordingScope::Storyboard {
                path: "demo.sb".into(),
            },
            &default_settings(),
        )
        .unwrap();

        assert!(result.is_none());
        assert_eq!(
            std::fs::read_to_string(recordings.join("take_duplicate").join("take.json")).unwrap(),
            "existing"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parses_directshow_microphones_and_cameras() {
        let stderr = r#"
[dshow @ 000001d8f7a1eac0] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000001d8f7a1eac0]  "Integrated Camera"
[dshow @ 000001d8f7a1eac0]     Alternative name "@device_pnp_\\?\usb#vid_0000"
[dshow @ 000001d8f7a1eac0]  "OBS Virtual Camera"
[dshow @ 000001d8f7a1eac0] DirectShow audio devices
[dshow @ 000001d8f7a1eac0]  "Microphone Array (Intel Smart Sound Technology)"
[dshow @ 000001d8f7a1eac0]     Alternative name "@device_cm_{33d9a762-90c8-11d0-bd43-00a0c911ce86}"
[dshow @ 000001d8f7a1eac0]  "Headset Microphone (USB Audio)"
dummy: Immediate exit requested
"#;

        let devices = parse_dshow_devices(stderr);

        assert_eq!(
            devices,
            vec![
                RecordingDeviceInfo {
                    id: "Integrated Camera".into(),
                    label: "Integrated Camera".into(),
                    kind: RecordingDeviceKind::Camera,
                    is_default: false,
                    camera_formats: Vec::new(),
                },
                RecordingDeviceInfo {
                    id: "OBS Virtual Camera".into(),
                    label: "OBS Virtual Camera".into(),
                    kind: RecordingDeviceKind::Camera,
                    is_default: false,
                    camera_formats: Vec::new(),
                },
                RecordingDeviceInfo {
                    id: "Microphone Array (Intel Smart Sound Technology)".into(),
                    label: "Microphone Array (Intel Smart Sound Technology)".into(),
                    kind: RecordingDeviceKind::Microphone,
                    is_default: false,
                    camera_formats: Vec::new(),
                },
                RecordingDeviceInfo {
                    id: "Headset Microphone (USB Audio)".into(),
                    label: "Headset Microphone (USB Audio)".into(),
                    kind: RecordingDeviceKind::Microphone,
                    is_default: false,
                    camera_formats: Vec::new(),
                },
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn directshow_parser_ignores_alternative_device_names() {
        let stderr = r#"
[dshow @ 000001d8f7a1eac0] DirectShow audio devices
[dshow @ 000001d8f7a1eac0]  "Primary Microphone"
[dshow @ 000001d8f7a1eac0]     Alternative name "Long internal id"
"#;

        let devices = parse_dshow_devices(stderr);

        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "Primary Microphone");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parses_modern_directshow_source_lines() {
        let stderr = r#"
[in#0 @ 0000024d6dfb0a00] "OBS Virtual Camera" (video)
[in#0 @ 0000024d6dfb0a00]   Alternative name "@device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"
[in#0 @ 0000024d6dfb0a00] "Blackmagic WDM Capture" (audio, video)
[in#0 @ 0000024d6dfb0a00] "Microphone (RODECaster Pro II Main Stereo)" (audio)
Error opening input file dummy.
"#;

        let devices = parse_dshow_devices(stderr);

        assert!(devices.contains(&RecordingDeviceInfo {
            id: "OBS Virtual Camera".into(),
            label: "OBS Virtual Camera".into(),
            kind: RecordingDeviceKind::Camera,
            is_default: false,
            camera_formats: Vec::new(),
        }));
        assert!(devices.contains(&RecordingDeviceInfo {
            id: "Blackmagic WDM Capture".into(),
            label: "Blackmagic WDM Capture".into(),
            kind: RecordingDeviceKind::Microphone,
            is_default: false,
            camera_formats: Vec::new(),
        }));
        assert!(devices.contains(&RecordingDeviceInfo {
            id: "Blackmagic WDM Capture".into(),
            label: "Blackmagic WDM Capture".into(),
            kind: RecordingDeviceKind::Camera,
            is_default: false,
            camera_formats: Vec::new(),
        }));
        assert!(devices.contains(&RecordingDeviceInfo {
            id: "Microphone (RODECaster Pro II Main Stereo)".into(),
            label: "Microphone (RODECaster Pro II Main Stereo)".into(),
            kind: RecordingDeviceKind::Microphone,
            is_default: false,
            camera_formats: Vec::new(),
        }));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parses_directshow_camera_format_options_best_first() {
        let stderr = r#"
[dshow @ 0000020d0fd25a40] DirectShow video device options (from video devices)
[dshow @ 0000020d0fd25a40]  Pin "Capture" (alternative pin name "0")
[dshow @ 0000020d0fd25a40]   vcodec=mjpeg  min s=1920x1080 fps=5 max s=3840x2160 fps=30
[dshow @ 0000020d0fd25a40]   pixel_format=uyvy422  min s=1280x720 fps=5 max s=1920x1080 fps=60
[dshow @ 0000020d0fd25a40]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30
"#;

        let formats = parse_dshow_camera_formats(stderr);

        assert_eq!(
            formats[0],
            CameraFormatInfo {
                width: 3840,
                height: 2160,
                fps: Some("30".into()),
                codec: Some("mjpeg".into()),
                pixel_format: None,
            }
        );
        assert!(formats.contains(&CameraFormatInfo {
            width: 1920,
            height: 1080,
            fps: Some("60".into()),
            codec: None,
            pixel_format: Some("uyvy422".into()),
        }));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn builds_full_screen_ffmpeg_capture_args_with_microphone() {
        let mut settings = default_settings();
        settings.mic_device_id = Some("Microphone (RODECaster Pro II Main Stereo)".into());

        let args =
            build_ffmpeg_capture_args(&settings, Path::new("C:\\takes\\screen.mkv")).unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "gdigrab"]));
        assert!(args.windows(2).any(|pair| pair == ["-i", "desktop"]));
        assert!(args.windows(2).any(|pair| pair == ["-framerate", "30"]));
        assert!(args.windows(2).any(|pair| pair == ["-r", "30"]));
        assert!(args.windows(2).any(|pair| pair == ["-f", "dshow"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-i", "audio=Microphone (RODECaster Pro II Main Stereo)"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "ffv1"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "pcm_s16le"]));
        assert_eq!(
            args.last().map(String::as_str),
            Some("C:\\takes\\screen.mkv")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn builds_ffmpeg_capture_args_with_selected_frame_rate() {
        let mut settings = default_settings();
        settings.frame_rate = 60;

        let args = build_ffmpeg_capture_args(&settings, Path::new("screen.mkv")).unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-framerate", "60"]));
        assert!(args.windows(2).any(|pair| pair == ["-r", "60"]));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn builds_high_quality_capture_args_for_direct_mp4_recording() {
        let mut settings = default_settings();
        settings.output_quality = OutputQuality::High;
        settings.frame_rate = 60;
        settings.mic_device_id = Some("Studio Microphone".into());

        let args = build_ffmpeg_capture_args(&settings, Path::new("screen.mp4")).unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-framerate", "60"]));
        assert!(!args.windows(2).any(|pair| pair == ["-r", "60"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|pair| pair == ["-preset", "ultrafast"]));
        assert!(args.windows(2).any(|pair| pair == ["-tune", "zerolatency"]));
        assert!(args.windows(2).any(|pair| pair == ["-crf", "20"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "aac"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-movflags", "+faststart"]));
        assert_eq!(args.last().map(String::as_str), Some("screen.mp4"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn builds_camera_args_as_video_only_mp4_stem() {
        let mut settings = default_settings();
        settings.frame_rate = 60;
        settings.camera_device_id = Some("Integrated Camera".into());
        settings.camera_format = Some(CameraFormatInfo {
            width: 3840,
            height: 2160,
            fps: Some("30".into()),
            codec: Some("mjpeg".into()),
            pixel_format: None,
        });

        let args = build_ffmpeg_camera_args(&settings, Path::new("camera.mp4"))
            .unwrap()
            .unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "dshow"]));
        assert!(args.windows(2).any(|pair| pair == ["-vcodec", "mjpeg"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-video_size", "3840x2160"]));
        assert!(args.windows(2).any(|pair| pair == ["-framerate", "30"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-i", "video=Integrated Camera"]));
        assert!(args.iter().any(|arg| arg == "-an"));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-movflags", "+faststart"]));
        assert_eq!(args.last().map(String::as_str), Some("camera.mp4"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn builds_camera_args_without_explicit_mode_for_fallback() {
        let mut settings = default_settings();
        settings.camera_device_id = Some("Blackmagic WDM Capture".into());
        settings.camera_format = Some(CameraFormatInfo {
            width: 1920,
            height: 1080,
            fps: Some("59.9402".into()),
            codec: None,
            pixel_format: Some("uyvy422".into()),
        });

        let args = build_ffmpeg_camera_args_with_mode(&settings, Path::new("camera.mp4"), false)
            .unwrap()
            .unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "dshow"]));
        assert!(!args.iter().any(|arg| arg == "-pixel_format"));
        assert!(!args.iter().any(|arg| arg == "-video_size"));
        assert!(!args.iter().any(|arg| arg == "-framerate"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-i", "video=Blackmagic WDM Capture"]));
    }

    #[test]
    fn recorder_settings_defaults_missing_optional_recorder_fields() {
        let json = r#"{
            "capture_source": "full_screen",
            "capture_area": null,
            "mic_device_id": null,
            "countdown_seconds": 3,
            "frame_rate": 30,
            "include_cursor": true,
            "include_system_audio": false,
            "output_quality": "high",
            "capture_backend": "auto"
        }"#;

        let settings: RecorderSettings = serde_json::from_str(json).unwrap();

        assert_eq!(settings.camera_device_id, None);
        assert_eq!(settings.mic_volume, 100);
        assert_eq!(settings.system_audio_volume, 100);
    }

    #[test]
    fn builds_review_proxy_args_for_smooth_playback() {
        let mut settings = default_settings();
        settings.frame_rate = 60;
        settings.output_quality = OutputQuality::High;

        let args = build_ffmpeg_proxy_args(
            Path::new("screen.mkv"),
            Path::new("screen-proxy.mp4"),
            &settings,
        );

        assert!(args.windows(2).any(|pair| pair == ["-i", "screen.mkv"]));
        assert!(args.windows(2).any(|pair| pair == ["-map", "0:v:0"]));
        assert!(args.windows(2).any(|pair| pair == ["-map", "0:a?"]));
        assert!(args.windows(2).any(|pair| pair == ["-r", "60"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|pair| pair == ["-crf", "22"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "aac"]));
        assert_eq!(args.last().map(String::as_str), Some("screen-proxy.mp4"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn builds_full_screen_ffmpeg_capture_args_for_selected_area() {
        let mut settings = default_settings();
        settings.capture_area = Some(CaptureArea {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1440,
            display_index: None,
            hmonitor: None,
            dxgi_output_index: None,
        });

        let args = build_ffmpeg_capture_args(&settings, Path::new("screen.mkv")).unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-offset_x", "1920"]));
        assert!(args.windows(2).any(|pair| pair == ["-offset_y", "0"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-video_size", "2560x1440"]));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn display_index_does_not_override_selected_monitor_coordinates() {
        let mut settings = default_settings();
        settings.output_quality = OutputQuality::High;
        settings.frame_rate = 60;
        settings.include_cursor = false;
        settings.capture_area = Some(CaptureArea {
            x: -1920,
            y: 604,
            width: 1920,
            height: 1080,
            display_index: Some(1),
            hmonitor: None,
            dxgi_output_index: None,
        });

        let args = build_ffmpeg_capture_args(&settings, Path::new("screen.mp4")).unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "gdigrab"]));
        assert!(args.windows(2).any(|pair| pair == ["-offset_x", "-1920"]));
        assert!(args.windows(2).any(|pair| pair == ["-offset_y", "604"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-video_size", "1920x1080"]));
        assert!(!args.windows(2).any(|pair| pair == ["-f", "lavfi"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn builds_windows_graphics_capture_args_for_selected_monitor_handle() {
        let mut settings = default_settings();
        settings.output_quality = OutputQuality::High;
        settings.capture_backend = CaptureBackend::WindowsGraphicsCapture;
        settings.frame_rate = 60;
        settings.include_cursor = true;
        settings.capture_area = Some(CaptureArea {
            x: -1920,
            y: 604,
            width: 1920,
            height: 1080,
            display_index: Some(1),
            hmonitor: Some("123456".to_string()),
            dxgi_output_index: None,
        });

        let args = build_ffmpeg_capture_args(&settings, Path::new("screen.mp4")).unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "lavfi"]));
        assert!(args.windows(2).any(|pair| {
            pair[0] == "-i"
                && pair[1].contains("gfxcapture=hmonitor=123456")
                && pair[1].contains("capture_cursor=1")
                && pair[1].contains("max_framerate=60")
        }));
        assert!(!args.windows(2).any(|pair| pair == ["-f", "gdigrab"]));
        assert!(!args.windows(2).any(|pair| pair == ["-offset_x", "-1920"]));
        assert!(!args.windows(2).any(|pair| pair == ["-r", "60"]));
        let filter = args
            .windows(2)
            .find_map(|pair| (pair[0] == "-vf").then_some(pair[1].as_str()))
            .unwrap();
        assert!(filter.contains("hwdownload,format=bgra,fps=60,format=yuv420p"));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn auto_backend_uses_desktop_duplication_when_dxgi_output_index_is_available() {
        let mut settings = default_settings();
        settings.output_quality = OutputQuality::High;
        settings.capture_backend = CaptureBackend::Auto;
        settings.capture_area = Some(CaptureArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            display_index: None,
            hmonitor: Some("123456".to_string()),
            dxgi_output_index: Some(1),
        });

        let args = build_ffmpeg_capture_args(&settings, Path::new("screen.mp4")).unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "lavfi"]));
        assert!(args.windows(2).any(|pair| {
            pair[0] == "-i"
                && pair[1].contains("ddagrab=output_idx=1")
                && pair[1].contains("framerate=30")
                && pair[1].contains("draw_mouse=1")
        }));
        assert!(!args.windows(2).any(|pair| pair == ["-f", "gdigrab"]));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn auto_backend_prefers_native_windows_capture_when_monitor_handle_is_available() {
        let mut settings = default_settings();
        settings.output_quality = OutputQuality::High;
        settings.capture_backend = CaptureBackend::Auto;
        settings.capture_area = Some(CaptureArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            display_index: None,
            hmonitor: Some("123456".to_string()),
            dxgi_output_index: Some(1),
        });

        assert!(should_use_native_windows_capture(&settings));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn lossless_auto_backend_stays_on_ffmpeg_capture() {
        let mut settings = default_settings();
        settings.output_quality = OutputQuality::Lossless;
        settings.capture_backend = CaptureBackend::Auto;
        settings.capture_area = Some(CaptureArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            display_index: None,
            hmonitor: Some("123456".to_string()),
            dxgi_output_index: Some(1),
        });

        assert!(!should_use_native_windows_capture(&settings));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn forced_gdi_grab_ignores_monitor_handle() {
        let mut settings = default_settings();
        settings.output_quality = OutputQuality::High;
        settings.capture_backend = CaptureBackend::GdiGrab;
        settings.capture_area = Some(CaptureArea {
            x: 10,
            y: 20,
            width: 640,
            height: 480,
            display_index: None,
            hmonitor: Some("123456".to_string()),
            dxgi_output_index: Some(1),
        });

        let args = build_ffmpeg_capture_args(&settings, Path::new("screen.mp4")).unwrap();

        assert!(args.windows(2).any(|pair| pair == ["-f", "gdigrab"]));
        assert!(args.windows(2).any(|pair| pair == ["-offset_x", "10"]));
        assert!(args.windows(2).any(|pair| pair == ["-offset_y", "20"]));
        assert!(!args.windows(2).any(|pair| pair == ["-f", "lavfi"]));
    }

    #[test]
    fn rejects_non_full_screen_capture_args_for_now() {
        let mut settings = default_settings();
        settings.capture_source = CaptureSource::Region;

        let err = build_ffmpeg_capture_args(&settings, Path::new("screen.mkv")).unwrap_err();

        assert!(err.to_string().contains("Only full-screen recording"));
    }
}
