//! Tauri commands for the recording engine.

use serde::Serialize;
use std::path::{Path, PathBuf};

use chrono::Utc;
use sha2::{Digest, Sha256};
use tauri::State;
use tauri_plugin_auditaur::auditaur_command;
use uuid::Uuid;

use crate::{
    engine::{project, recording},
    models::sketch::{NarrationAsset, Sketch},
    AppState,
};

pub struct RecordingCaptureState(pub tokio::sync::Mutex<Option<recording::ActiveRecording>>);

#[derive(Debug, Clone, Serialize)]
pub struct RecordingAudioLevel {
    pub available: bool,
    pub rms: f32,
    pub peak: f32,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingPlatformCapabilities {
    pub platform: &'static str,
    pub supports_system_audio: bool,
    pub supports_native_monitor_capture: bool,
    pub supports_window_capture_exclusion: bool,
    pub supports_click_through_prompter: bool,
    pub supports_camera_format_discovery: bool,
    /// Hint message when system audio requires additional setup (e.g. macOS loopback driver)
    pub system_audio_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrationAssetInfo {
    pub path: String,
    pub size: u64,
    pub mime_type: String,
    pub modified_at: u64,
    pub referenced_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NarrationAssetData {
    pub data: Vec<u8>,
    pub mime_type: String,
}

fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    current
        .as_ref()
        .map(|p| std::path::PathBuf::from(&p.root))
        .ok_or_else(|| "No project open".to_string())
}

#[tauri::command]
pub async fn initialize_recording_storage(state: State<'_, AppState>) -> Result<String, String> {
    let root = project_root(&state)?;
    let dir = recording::initialize_recording_storage(&root).map_err(|e| e.to_string())?;
    dir.strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_local_recordings(state: State<'_, AppState>) -> Result<u64, String> {
    let root = project_root(&state)?;
    recording::clear_local_recordings(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_ffmpeg_status() -> Result<recording::FfmpegStatus, String> {
    Ok(recording::check_ffmpeg_status())
}

#[tauri::command]
pub async fn discover_recording_devices() -> Result<recording::RecordingDeviceDiscovery, String> {
    Ok(recording::discover_recording_devices())
}

#[tauri::command]
pub async fn get_recording_platform_capabilities() -> Result<RecordingPlatformCapabilities, String>
{
    Ok(recording_platform_capabilities())
}

#[tauri::command]
pub async fn discover_camera_formats(
    camera_device_id: String,
) -> Result<Vec<recording::CameraFormatInfo>, String> {
    recording::discover_camera_formats(&camera_device_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_recording_prompter_script(
    scope: recording::RecordingScope,
    state: State<'_, AppState>,
) -> Result<recording::PrompterScript, String> {
    let root = project_root(&state)?;
    recording::build_prompter_script(&root, &scope).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_recording_take(
    scope: recording::RecordingScope,
    settings: recording::RecorderSettings,
    state: State<'_, AppState>,
) -> Result<recording::RecordingTake, String> {
    let root = project_root(&state)?;
    recording::create_recording_take(&root, scope, settings).map_err(|e| e.to_string())
}

#[auditaur_command(skip_all, err)]
pub async fn list_project_narration_assets(
    state: State<'_, AppState>,
) -> Result<Vec<NarrationAssetInfo>, String> {
    let root = project_root(&state)?;
    let narration_root = root.join(".cutready").join("narration");
    let mut assets = Vec::new();
    collect_project_audio_assets(&root, &narration_root, &mut assets).map_err(|e| e.to_string())?;
    populate_narration_references(&root, &mut assets).map_err(|e| e.to_string())?;
    assets.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(assets)
}

#[auditaur_command(skip_all, err)]
pub async fn delete_orphaned_narration_assets(state: State<'_, AppState>) -> Result<u32, String> {
    let root = project_root(&state)?;
    let narration_root = root.join(".cutready").join("narration");
    let mut assets = Vec::new();
    collect_project_audio_assets(&root, &narration_root, &mut assets).map_err(|e| e.to_string())?;
    populate_narration_references(&root, &mut assets).map_err(|e| e.to_string())?;

    let mut deleted = 0u32;
    for asset in assets.iter().filter(|asset| asset.referenced_by.is_empty()) {
        let abs_path = project::safe_resolve(&root, &asset.path).map_err(|e| e.to_string())?;
        if !abs_path.starts_with(&narration_root) {
            return Err(format!(
                "Refusing to delete narration asset outside .cutready/narration: {}",
                asset.path
            ));
        }
        if !abs_path.exists() {
            continue;
        }
        if audio_mime_from_path(&abs_path).is_none() {
            return Err(format!(
                "Refusing to delete non-audio asset: {}",
                asset.path
            ));
        }
        std::fs::remove_file(&abs_path)
            .map_err(|e| format!("Failed to delete {}: {e}", asset.path))?;
        deleted += 1;
    }

    Ok(deleted)
}

#[auditaur_command(skip_all, err)]
pub async fn read_narration_asset(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<NarrationAssetData, String> {
    let root = project_root(&state)?;
    let narration_root = root.join(".cutready").join("narration");
    let asset_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
    if !asset_path.starts_with(&narration_root) {
        return Err(format!(
            "Refusing to read narration asset outside .cutready/narration: {relative_path}"
        ));
    }
    let Some(mime_type) = audio_mime_from_path(&asset_path) else {
        return Err(format!(
            "Refusing to read non-audio narration asset: {relative_path}"
        ));
    };

    let data = std::fs::read(&asset_path)
        .map_err(|e| format!("Failed to read narration asset {relative_path}: {e}"))?;
    tracing::debug!(
        target: "cutready::recording",
        path = %relative_path,
        bytes = data.len(),
        mime_type,
        "read narration asset for playback"
    );
    Ok(NarrationAssetData {
        data,
        mime_type: mime_type.to_string(),
    })
}

#[tauri::command]
pub async fn save_narration_recording(
    sketch_path: String,
    row_index: usize,
    audio_data: Vec<u8>,
    mime_type: String,
    duration_ms: Option<u32>,
    source_text: String,
    leading_silence_ms: Option<u32>,
    trailing_silence_ms: Option<u32>,
    silence_threshold_db: Option<f32>,
    state: State<'_, AppState>,
) -> Result<Sketch, String> {
    const MAX_NARRATION_BYTES: usize = 50 * 1024 * 1024;

    if audio_data.is_empty() {
        return Err("Narration recording is empty".to_string());
    }
    if audio_data.len() > MAX_NARRATION_BYTES {
        return Err("Narration recording is too large".to_string());
    }

    let root = project_root(&state)?;
    let sketch_abs = project::safe_resolve(&root, &sketch_path).map_err(|e| e.to_string())?;
    let mut sketch = project::read_sketch(&sketch_abs).map_err(|e| e.to_string())?;
    project::ensure_sketch_unlocked(&sketch).map_err(|e| e.to_string())?;

    let row = sketch
        .rows
        .get_mut(row_index)
        .ok_or_else(|| format!("Planning row {row_index} does not exist"))?;
    if row.locked {
        return Err("Planning row is locked".to_string());
    }

    let narration_dir = root.join(".cutready").join("narration");
    std::fs::create_dir_all(&narration_dir)
        .map_err(|e| format!("Failed to create narration directory: {e}"))?;

    let extension = narration_extension(&mime_type);
    let file_name = format!(
        "row-{}-{}.{}",
        row_index + 1,
        &Uuid::new_v4().simple().to_string()[..12],
        extension
    );
    let relative_path = format!(".cutready/narration/{file_name}");
    let output_path = project::safe_resolve(&root, &relative_path).map_err(|e| e.to_string())?;
    let tmp_path = output_path.with_extension(format!("{extension}.tmp"));
    std::fs::write(&tmp_path, &audio_data)
        .map_err(|e| format!("Failed to write narration recording: {e}"))?;
    std::fs::rename(&tmp_path, &output_path)
        .map_err(|e| format!("Failed to finalize narration recording: {e}"))?;

    let asset = NarrationAsset {
        path: relative_path,
        source_text_hash: sha256_hex(&source_text),
        source_text,
        mime_type,
        duration_ms,
        leading_silence_ms,
        trailing_silence_ms,
        silence_threshold_db,
        byte_size: audio_data.len() as u64,
        recorded_at: Utc::now(),
    };
    row.narration = Some(asset);
    sketch.updated_at = Utc::now();

    project::write_sketch(&sketch, &sketch_abs, &root).map_err(|e| e.to_string())?;
    tracing::info!(
        target: "cutready::recording",
        sketch_path = %sketch_path,
        row_index,
        bytes = audio_data.len(),
        leading_silence_ms,
        trailing_silence_ms,
        silence_threshold_db,
        "saved narration recording"
    );
    Ok(sketch)
}

fn narration_extension(mime_type: &str) -> &'static str {
    let normalized = mime_type.split(';').next().unwrap_or("").trim();
    match normalized {
        "audio/webm" => "webm",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/wave" | "audio/x-wav" => "wav",
        _ => "webm",
    }
}

fn collect_project_audio_assets(
    root: &Path,
    dir: &Path,
    assets: &mut Vec<NarrationAssetInfo>,
) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if path.is_dir() {
            if matches!(file_name, ".git" | "node_modules" | "target") {
                continue;
            }
            collect_project_audio_assets(root, &path, assets)?;
            continue;
        }

        let Some(mime_type) = audio_mime_from_path(&path) else {
            continue;
        };
        let metadata = entry.metadata()?;
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        assets.push(NarrationAssetInfo {
            path: relative_path,
            size: metadata.len(),
            mime_type: mime_type.to_string(),
            modified_at,
            referenced_by: Vec::new(),
        });
    }
    Ok(())
}

fn populate_narration_references(
    root: &Path,
    assets: &mut [NarrationAssetInfo],
) -> std::io::Result<()> {
    let mut ref_map = std::collections::HashMap::<String, Vec<String>>::new();
    for asset in assets.iter() {
        ref_map.insert(asset.path.clone(), Vec::new());
    }
    if ref_map.is_empty() {
        return Ok(());
    }

    collect_sketch_narration_references(root, root, &mut ref_map)?;

    for asset in assets {
        asset.referenced_by = ref_map.remove(&asset.path).unwrap_or_default();
    }
    Ok(())
}

fn collect_sketch_narration_references(
    root: &Path,
    dir: &Path,
    ref_map: &mut std::collections::HashMap<String, Vec<String>>,
) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if path.is_dir() {
            if matches!(file_name, ".git" | "node_modules" | "target") {
                continue;
            }
            collect_sketch_narration_references(root, &path, ref_map)?;
            continue;
        }

        if path.extension().and_then(|extension| extension.to_str()) != Some("sk") {
            continue;
        }

        let content = std::fs::read_to_string(&path)?;
        let relative_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        for narration_ref in extract_sketch_narration_refs(&content) {
            if let Some(referrers) = ref_map.get_mut(&narration_ref) {
                referrers.push(relative_path.clone());
            }
        }
    }
    Ok(())
}

fn extract_sketch_narration_refs(content: &str) -> Vec<String> {
    let mut refs = Vec::new();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(rows) = value.get("rows").and_then(|rows| rows.as_array()) {
            for row in rows {
                let Some(path) = row
                    .get("narration")
                    .and_then(|narration| narration.get("path"))
                    .and_then(|path| path.as_str())
                else {
                    continue;
                };
                refs.push(path.replace('\\', "/"));
            }
        }
    }
    refs
}

fn audio_mime_from_path(path: &PathBuf) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("webm") => Some("audio/webm"),
        Some("ogg") | Some("oga") => Some("audio/ogg"),
        Some("mp3") => Some("audio/mpeg"),
        Some("wav") => Some("audio/wav"),
        Some("m4a") | Some("mp4") => Some("audio/mp4"),
        Some("flac") => Some("audio/flac"),
        _ => None,
    }
}

fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[tauri::command]
pub async fn start_recording_take(
    scope: recording::RecordingScope,
    settings: recording::RecorderSettings,
    state: State<'_, AppState>,
    capture: State<'_, RecordingCaptureState>,
) -> Result<recording::RecordingTake, String> {
    // On macOS, request screen recording permission before starting
    #[cfg(target_os = "macos")]
    {
        if !request_macos_screen_recording_permission() {
            return Err(
                "Screen Recording permission is required. Please grant it in System Settings → Privacy & Security → Screen & System Audio Recording, then restart CutReady."
                    .to_string(),
            );
        }
    }

    let root = project_root(&state)?;
    let mut active = capture.0.lock().await;
    let _ = recording::finalize_finished_recording(&mut active).map_err(|e| e.to_string())?;
    if let Some(current) = active.as_ref() {
        return Err(format!(
            "Recording already in progress: {}",
            recording::active_recording_take(current).id
        ));
    }

    let next =
        recording::start_recording_capture(&root, scope, settings).map_err(|e| e.to_string())?;
    let take = recording::active_recording_take(&next);
    *active = Some(next);
    Ok(take)
}

#[tauri::command]
pub async fn stop_recording_take(
    capture: State<'_, RecordingCaptureState>,
) -> Result<recording::RecordingTake, String> {
    let mut active = capture.0.lock().await;
    let recording = active
        .take()
        .ok_or_else(|| "No recording is currently in progress".to_string())?;
    let take_dir = recording::active_recording_take_dir(&recording).to_path_buf();
    let take = recording::stop_recording_capture(recording).map_err(|e| e.to_string())?;
    if take.status == recording::RecordingTakeStatus::Finalized {
        if let Err(err) = open_folder_path(&take_dir) {
            log::warn!(
                "[recording] failed to open finalized take folder {}: {}",
                take_dir.display(),
                err
            );
        }
    }
    Ok(take)
}

#[tauri::command]
pub async fn discard_recording_take(
    capture: State<'_, RecordingCaptureState>,
) -> Result<recording::RecordingTake, String> {
    let mut active = capture.0.lock().await;
    let recording = active
        .take()
        .ok_or_else(|| "No recording is currently in progress".to_string())?;
    recording::discard_recording_capture(recording).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_recording_audio_level(
    capture: State<'_, RecordingCaptureState>,
) -> Result<RecordingAudioLevel, String> {
    let active = capture.0.lock().await;
    let Some(recording) = active.as_ref() else {
        return Ok(RecordingAudioLevel {
            available: false,
            rms: 0.0,
            peak: 0.0,
            bytes: 0,
        });
    };

    let mic_path = recording::active_recording_take_dir(recording).join("mic.wav");
    read_recent_wav_level(&mic_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_recording_take_folder(
    metadata_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let metadata = project::safe_resolve(&root, &metadata_path).map_err(|e| e.to_string())?;
    let take_dir = metadata
        .parent()
        .ok_or_else(|| "Recording metadata path has no parent folder".to_string())?;
    open_folder_path(take_dir)
}

fn read_recent_wav_level(path: &Path) -> std::io::Result<RecordingAudioLevel> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecordingAudioLevel {
                available: false,
                rms: 0.0,
                peak: 0.0,
                bytes: 0,
            });
        }
        Err(err) => return Err(err),
    };
    let len = file.metadata()?.len();
    if len <= 44 {
        return Ok(RecordingAudioLevel {
            available: true,
            rms: 0.0,
            peak: 0.0,
            bytes: len,
        });
    }

    const SAMPLE_BYTES: u64 = 32 * 1024;
    let start = len.saturating_sub(SAMPLE_BYTES).max(44);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    if bytes.len() < 2 {
        return Ok(RecordingAudioLevel {
            available: true,
            rms: 0.0,
            peak: 0.0,
            bytes: len,
        });
    }

    let mut peak = 0.0f32;
    let mut sum = 0.0f64;
    let mut count = 0u64;
    for chunk in bytes.chunks_exact(2) {
        let sample = i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / i16::MAX as f32;
        let abs = sample.abs();
        peak = peak.max(abs);
        sum += (sample as f64) * (sample as f64);
        count += 1;
    }

    let rms = if count == 0 {
        0.0
    } else {
        (sum / count as f64).sqrt() as f32
    };

    Ok(RecordingAudioLevel {
        available: true,
        rms: rms.clamp(0.0, 1.0),
        peak: peak.clamp(0.0, 1.0),
        bytes: len,
    })
}

fn recording_platform_capabilities() -> RecordingPlatformCapabilities {
    #[cfg(target_os = "macos")]
    let (supports_system_audio, system_audio_hint) = {
        // ScreenCaptureKit provides native system audio capture on macOS 13+.
        // Falls back to loopback device detection (BlackHole/Soundflower) if SCK unavailable.
        if crate::engine::recording_native_audio_macos::is_system_audio_available() {
            (true, None)
        } else {
            match recording::detect_macos_loopback_device() {
                Some(_device_name) => (true, None),
                None => (
                    false,
                    Some(
                        "Grant Screen Recording permission in System Settings → \
                         Privacy & Security, then restart CutReady."
                            .to_string(),
                    ),
                ),
            }
        }
    };

    #[cfg(target_os = "windows")]
    let (supports_system_audio, system_audio_hint) = (true, None);

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let (supports_system_audio, system_audio_hint): (bool, Option<String>) = (false, None);

    RecordingPlatformCapabilities {
        platform: current_platform(),
        supports_system_audio,
        supports_native_monitor_capture: cfg!(target_os = "windows"),
        supports_window_capture_exclusion: cfg!(target_os = "windows"),
        supports_click_through_prompter: true,
        supports_camera_format_discovery: cfg!(target_os = "windows"),
        system_audio_hint,
    }
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

fn open_folder_path(take_dir: &Path) -> Result<(), String> {
    if !take_dir.is_dir() {
        return Err(format!(
            "Recording folder does not exist: {}",
            take_dir.display()
        ));
    }

    let shell_path = take_dir
        .canonicalize()
        .unwrap_or_else(|_| take_dir.to_path_buf());
    log::info!("[recording] opening take folder: {}", shell_path.display());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        let mut command = std::process::Command::new("explorer.exe");
        command.arg(windows_shell_path(&shell_path));
        command.creation_flags(0x08000000);
        command.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(take_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(take_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Opening recording folders is not supported on this platform".to_string())
}

#[cfg(target_os = "windows")]
fn windows_shell_path(path: &Path) -> String {
    let raw = path.as_os_str().to_string_lossy().replace('/', "\\");
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw
    }
}

/// Request Screen Recording permission on macOS.
/// Returns true if permission is granted, false if denied.
/// On first call, this triggers the system permission dialog.
#[cfg(target_os = "macos")]
fn request_macos_screen_recording_permission() -> bool {
    // CGPreflightScreenCaptureAccess checks without prompting,
    // CGRequestScreenCaptureAccess prompts if not yet decided.
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    unsafe {
        if CGPreflightScreenCaptureAccess() {
            return true;
        }
        // Triggers the system dialog if user hasn't decided yet
        CGRequestScreenCaptureAccess()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn platform_capabilities_are_consistent_with_current_os() {
        let capabilities = super::recording_platform_capabilities();

        #[cfg(target_os = "windows")]
        {
            assert_eq!(capabilities.platform, "windows");
            assert!(capabilities.supports_system_audio);
            assert!(capabilities.supports_native_monitor_capture);
            assert!(capabilities.supports_window_capture_exclusion);
            assert!(capabilities.supports_camera_format_discovery);
            assert!(capabilities.system_audio_hint.is_none());
        }

        #[cfg(target_os = "macos")]
        {
            assert_eq!(capabilities.platform, "macos");
            // system_audio depends on whether a loopback device is installed
            if !capabilities.supports_system_audio {
                assert!(capabilities.system_audio_hint.is_some());
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            assert!(!capabilities.supports_system_audio);
            assert!(!capabilities.supports_native_monitor_capture);
            assert!(!capabilities.supports_window_capture_exclusion);
            assert!(!capabilities.supports_camera_format_discovery);
        }

        assert!(capabilities.supports_click_through_prompter);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_path_strips_verbatim_drive_prefix_for_explorer() {
        let path = std::path::Path::new(r"\\?\D:\cutready\demo\.cutready\recordings\take_1");

        assert_eq!(
            super::windows_shell_path(path),
            r"D:\cutready\demo\.cutready\recordings\take_1"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_path_strips_verbatim_unc_prefix_for_explorer() {
        let path = std::path::Path::new(r"\\?\UNC\server\share\demo");

        assert_eq!(super::windows_shell_path(path), r"\\server\share\demo");
    }
}
