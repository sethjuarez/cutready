use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use crate::engine::recording::{CaptureArea, OutputQuality, RecorderSettings};
use crate::engine::recording_native_audio_windows::NativeAudioRecording;

type CaptureError = Box<dyn std::error::Error + Send + Sync>;

pub struct NativeWindowsRecording {
    control: Option<CaptureControl<NativeWgcCapture, CaptureError>>,
    audio_recordings: Vec<NativeAudioRecording>,
    video_temp_path: PathBuf,
    output_path: PathBuf,
    log_path: PathBuf,
}

#[derive(Clone)]
struct NativeWgcFlags {
    output_path: PathBuf,
    width: u32,
    height: u32,
    frame_rate: u16,
    bitrate: u32,
}

struct NativeWgcCapture {
    encoder: Option<VideoEncoder>,
    frames: u64,
}

impl GraphicsCaptureApiHandler for NativeWgcCapture {
    type Flags = NativeWgcFlags;
    type Error = CaptureError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(ctx.flags.width, ctx.flags.height)
                .sub_type(VideoSettingsSubType::H264)
                .bitrate(ctx.flags.bitrate)
                .frame_rate(ctx.flags.frame_rate as u32),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &ctx.flags.output_path,
        )?;

        Ok(Self {
            encoder: Some(encoder),
            frames: 0,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if let Some(encoder) = self.encoder.as_mut() {
            encoder.send_frame(frame)?;
            self.frames = self.frames.saturating_add(1);
        }
        Ok(())
    }
}

impl NativeWgcCapture {
    fn finish(&mut self) -> Result<u64, CaptureError> {
        if let Some(encoder) = self.encoder.take() {
            encoder.finish()?;
        }
        Ok(self.frames)
    }
}

impl NativeWindowsRecording {
    pub fn start(
        settings: &RecorderSettings,
        output_path: &Path,
        log_path: &Path,
    ) -> anyhow::Result<Self> {
        let area = settings
            .capture_area
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Native Windows capture requires a selected monitor"))?;
        let hmonitor = parse_hmonitor(area)?;
        let monitor = Monitor::from_raw_hmonitor(hmonitor as *mut std::ffi::c_void);
        let video_temp_path = output_path.with_file_name("screen-native-video.mp4");
        let mic_path = output_path.with_file_name("mic.wav");
        let system_audio_path = output_path.with_file_name("system-audio.wav");

        let _ = std::fs::remove_file(&video_temp_path);
        let _ = std::fs::remove_file(output_path);
        let _ = std::fs::remove_file(&mic_path);
        let _ = std::fs::remove_file(&system_audio_path);

        let flags = NativeWgcFlags {
            output_path: video_temp_path.clone(),
            width: area.width,
            height: area.height,
            frame_rate: settings.frame_rate,
            bitrate: match settings.output_quality {
                OutputQuality::Compact => 8_000_000,
                OutputQuality::High | OutputQuality::Lossless => 15_000_000,
            },
        };
        let capture_settings = Settings::new(
            monitor,
            if settings.include_cursor {
                CursorCaptureSettings::WithCursor
            } else {
                CursorCaptureSettings::WithoutCursor
            },
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        );

        write_native_log_header(
            log_path,
            settings,
            &video_temp_path,
            settings
                .mic_device_id
                .as_ref()
                .filter(|device| !device.trim().is_empty())
                .map(|_| mic_path.as_path()),
            settings
                .include_system_audio
                .then_some(system_audio_path.as_path()),
        )?;

        let control = NativeWgcCapture::start_free_threaded(capture_settings)
            .map_err(|err| anyhow::anyhow!("Native Windows capture failed to start: {err}"))?;
        let mut audio_recordings = Vec::new();
        let mic_device = settings
            .mic_device_id
            .as_deref()
            .filter(|device| !device.trim().is_empty());
        if mic_device.is_some() {
            match NativeAudioRecording::start_microphone(
                mic_device,
                settings.mic_volume,
                &mic_path,
                log_path,
            ) {
                Ok(recording) => audio_recordings.push(recording),
                Err(err) => {
                    let _ = control.stop();
                    return Err(err);
                }
            }
        }
        if settings.include_system_audio {
            match NativeAudioRecording::start_system_audio(
                settings.system_audio_volume,
                &system_audio_path,
                log_path,
            ) {
                Ok(recording) => audio_recordings.push(recording),
                Err(err) => {
                    let _ = control.stop();
                    return Err(err);
                }
            }
        }

        Ok(Self {
            control: Some(control),
            audio_recordings,
            video_temp_path,
            output_path: output_path.to_path_buf(),
            log_path: log_path.to_path_buf(),
        })
    }

    pub fn is_finished(&self) -> bool {
        self.control
            .as_ref()
            .map(|control| control.is_finished())
            .unwrap_or(true)
    }

    pub fn stop(mut self) -> anyhow::Result<()> {
        let mut first_error: Option<anyhow::Error> = None;
        if let Some(control) = self.control.take() {
            let callback = control.callback();
            if let Err(err) = control.stop() {
                first_error = Some(anyhow::anyhow!(
                    "Native Windows capture failed to stop: {err}"
                ));
            }
            let finish_result = callback.lock().finish();
            match finish_result {
                Ok(frames) => {
                    append_log(
                        &self.log_path,
                        &format!("native_windows_graphics_capture frames={frames}"),
                    )?;
                }
                Err(err) if first_error.is_none() => {
                    first_error = Some(anyhow::anyhow!(
                        "Native Windows capture encoder failed to finish: {err}"
                    ));
                }
                Err(_) => {}
            }
        }

        for recording in self.audio_recordings.drain(..) {
            if let Err(err) = recording.stop() {
                append_log(
                    &self.log_path,
                    &format!("native_windows_audio stop_error {err}"),
                )?;
            }
        }

        if first_error.is_none() {
            let _ = std::fs::remove_file(&self.output_path);
            std::fs::rename(&self.video_temp_path, &self.output_path)?;
        }

        let _ = std::fs::remove_file(&self.video_temp_path);

        if let Some(err) = first_error {
            Err(err)
        } else {
            Ok(())
        }
    }
}

fn parse_hmonitor(area: &CaptureArea) -> anyhow::Result<usize> {
    let hmonitor = area
        .hmonitor
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Native Windows capture requires HMONITOR metadata"))?
        .trim();
    if hmonitor.is_empty() {
        anyhow::bail!("Native Windows capture requires non-empty HMONITOR metadata");
    }
    Ok(hmonitor.parse::<usize>()?)
}

fn write_native_log_header(
    path: &Path,
    settings: &RecorderSettings,
    video_path: &Path,
    mic_path: Option<&Path>,
    system_audio_path: Option<&Path>,
) -> anyhow::Result<()> {
    append_log(
        path,
        &format!(
            "native_windows_graphics_capture hmonitor={} frame_rate={} cursor={} output={}",
            settings
                .capture_area
                .as_ref()
                .and_then(|area| area.hmonitor.as_deref())
                .unwrap_or("<none>"),
            settings.frame_rate,
            settings.include_cursor,
            video_path.display()
        ),
    )?;
    if let Some(audio_path) = mic_path {
        append_log(
            path,
            &format!("native_windows_mic_temp {}", audio_path.display()),
        )?;
    }
    if let Some(audio_path) = system_audio_path {
        append_log(
            path,
            &format!("native_windows_system_audio_temp {}", audio_path.display()),
        )?;
    }
    Ok(())
}

fn append_log(path: &Path, message: &str) -> anyhow::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{message}")?;
    Ok(())
}
