//! Tauri commands for the recording engine.

use serde::Serialize;
use std::path::Path;

use tauri::State;

use crate::{
    engine::{project, recording},
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
pub async fn discover_camera_formats(
    camera_device_id: String,
) -> Result<Vec<recording::CameraFormatInfo>, String> {
    recording::discover_camera_formats(&camera_device_id).map_err(|e| e.to_string())
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

#[tauri::command]
pub async fn start_recording_take(
    scope: recording::RecordingScope,
    settings: recording::RecorderSettings,
    state: State<'_, AppState>,
    capture: State<'_, RecordingCaptureState>,
) -> Result<recording::RecordingTake, String> {
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

#[cfg(test)]
mod tests {
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
