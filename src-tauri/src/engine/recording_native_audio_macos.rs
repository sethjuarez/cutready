//! Native macOS audio capture via ScreenCaptureKit.
//!
//! Captures system audio (and optionally microphone) using Apple's
//! ScreenCaptureKit framework (macOS 13+). This eliminates the need for
//! third-party virtual audio drivers like BlackHole for system audio capture.
//!
//! Audio is written as 16-bit PCM WAV (48 kHz stereo) to match the
//! Windows WASAPI stem format.

use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};

use screencapturekit::prelude::*;

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const BITS_PER_SAMPLE: u16 = 16;

pub struct NativeMacAudioRecording {
    name: &'static str,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<anyhow::Result<()>>>,
}

impl NativeMacAudioRecording {
    /// Start capturing system audio via ScreenCaptureKit.
    /// Writes PCM WAV to the specified output path.
    pub fn start_system_audio(
        volume: u8,
        output_path: &Path,
    ) -> anyhow::Result<Self> {
        start_sck_audio_recording("system_audio", volume, output_path)
    }

    pub fn stop(mut self) -> anyhow::Result<()> {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            match handle.join() {
                Ok(result) => result,
                Err(_) => anyhow::bail!("macOS {} capture thread panicked", self.name),
            }
        } else {
            Ok(())
        }
    }
}

impl Drop for NativeMacAudioRecording {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Check whether ScreenCaptureKit is available and the user has granted
/// screen recording permission. Returns true if system audio capture is possible.
pub fn is_system_audio_available() -> bool {
    // ScreenCaptureKit requires macOS 12.3+ for screen capture,
    // but system audio capture requires macOS 13.0+.
    // Try to get shareable content — this will fail if permission is denied.
    match SCShareableContent::get() {
        Ok(_) => true,
        Err(e) => {
            log::debug!("[recording] ScreenCaptureKit not available: {e}");
            false
        }
    }
}

struct AudioHandler {
    stop: Arc<AtomicBool>,
    writer: Arc<Mutex<WavWriter>>,
    volume_scale: f32,
}

impl SCStreamOutputTrait for AudioHandler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if self.stop.load(Ordering::SeqCst) {
            return;
        }
        if of_type != SCStreamOutputType::Audio {
            return;
        }

        // Get audio buffer list from the sample buffer
        let Some(audio_list) = sample.audio_buffer_list() else {
            return;
        };

        // Process each audio buffer (typically one per channel or interleaved)
        for i in 0..audio_list.num_buffers() {
            let Some(buffer) = audio_list.get(i) else {
                continue;
            };
            let raw_data = buffer.data();
            if raw_data.is_empty() {
                continue;
            }

            // Convert f32 samples to i16 PCM with volume scaling
            let f32_samples = bytemuck_cast_f32(raw_data);
            let mut pcm_data = Vec::with_capacity(f32_samples.len() * 2);
            for &sample_val in f32_samples {
                let scaled = (sample_val * self.volume_scale).clamp(-1.0, 1.0);
                let pcm = (scaled * 32767.0) as i16;
                pcm_data.extend_from_slice(&pcm.to_le_bytes());
            }

            if let Ok(mut writer) = self.writer.lock() {
                let _ = writer.write_samples(&pcm_data);
            }
        }
    }
}

fn bytemuck_cast_f32(data: &[u8]) -> &[f32] {
    if data.len() % 4 != 0 || data.as_ptr() as usize % 4 != 0 {
        return &[];
    }
    // SAFETY: f32 is 4 bytes, data is aligned and length is a multiple of 4
    unsafe { std::slice::from_raw_parts(data.as_ptr() as *const f32, data.len() / 4) }
}

fn start_sck_audio_recording(
    name: &'static str,
    volume: u8,
    output_path: &Path,
) -> anyhow::Result<NativeMacAudioRecording> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();
    let output = output_path.to_path_buf();

    // Verify ScreenCaptureKit access before spawning thread
    let content = SCShareableContent::get()
        .map_err(|e| anyhow::anyhow!("Screen Recording permission required: {e}"))?;
    let displays = content.displays();
    if displays.is_empty() {
        anyhow::bail!("No displays found for ScreenCaptureKit audio capture");
    }

    let handle = thread::Builder::new()
        .name(format!("sck-{name}"))
        .spawn(move || -> anyhow::Result<()> {
            run_sck_audio_capture(&stop_clone, &output, volume)
        })?;

    // Brief startup check
    std::thread::sleep(std::time::Duration::from_millis(300));
    if handle.is_finished() {
        match handle.join() {
            Ok(Ok(())) => anyhow::bail!("macOS {name} capture exited unexpectedly"),
            Ok(Err(e)) => return Err(e),
            Err(_) => anyhow::bail!("macOS {name} capture thread panicked during startup"),
        }
    }

    Ok(NativeMacAudioRecording {
        name,
        stop,
        handle: Some(handle),
    })
}

fn run_sck_audio_capture(
    stop: &AtomicBool,
    output_path: &Path,
    volume: u8,
) -> anyhow::Result<()> {
    let content = SCShareableContent::get()
        .map_err(|e| anyhow::anyhow!("ScreenCaptureKit access denied: {e}"))?;
    let display = content
        .displays()
        .into_iter()
        .next()
        .ok_or_else(|| anyhow::anyhow!("No display available"))?;

    // We need a display filter even though we only want audio.
    // ScreenCaptureKit requires a content filter to start a stream.
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();

    // Configure for audio-only capture (1x1 video to minimize overhead)
    let config = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_captures_audio(true)
        .with_excludes_current_process_audio(true)
        .with_sample_rate(SAMPLE_RATE as i32)
        .with_channel_count(CHANNELS as i32);

    let writer = WavWriter::create(output_path, SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE)?;
    let writer = Arc::new(Mutex::new(writer));

    let volume_scale = volume.min(200) as f32 / 100.0;
    let handler = AudioHandler {
        stop: Arc::new(AtomicBool::new(false)),
        writer: writer.clone(),
        volume_scale,
    };

    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(handler, SCStreamOutputType::Audio);
    stream
        .start_capture()
        .map_err(|e| anyhow::anyhow!("Failed to start ScreenCaptureKit audio: {e}"))?;

    log::info!(
        "[recording] ScreenCaptureKit system audio capture started output={}",
        output_path.display()
    );

    // Wait for stop signal
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    stream
        .stop_capture()
        .map_err(|e| anyhow::anyhow!("Failed to stop ScreenCaptureKit audio: {e}"))?;

    // Finalize WAV header
    if let Ok(mut w) = writer.lock() {
        w.finalize()?;
    }

    log::info!(
        "[recording] ScreenCaptureKit system audio capture stopped output={}",
        output_path.display()
    );

    Ok(())
}

/// Minimal WAV file writer for 16-bit PCM audio.
struct WavWriter {
    file: std::fs::File,
    data_bytes: u32,
}

impl WavWriter {
    fn create(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
    ) -> anyhow::Result<Self> {
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)?;

        let byte_rate = sample_rate * channels as u32 * bits_per_sample as u32 / 8;
        let block_align = channels * bits_per_sample / 8;

        // Write WAV header (44 bytes) with placeholder sizes
        file.write_all(b"RIFF")?;
        file.write_all(&0u32.to_le_bytes())?; // file size - 8 (placeholder)
        file.write_all(b"WAVE")?;
        file.write_all(b"fmt ")?;
        file.write_all(&16u32.to_le_bytes())?; // fmt chunk size
        file.write_all(&1u16.to_le_bytes())?; // PCM format
        file.write_all(&channels.to_le_bytes())?;
        file.write_all(&sample_rate.to_le_bytes())?;
        file.write_all(&byte_rate.to_le_bytes())?;
        file.write_all(&block_align.to_le_bytes())?;
        file.write_all(&bits_per_sample.to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(&0u32.to_le_bytes())?; // data size (placeholder)

        Ok(Self {
            file,
            data_bytes: 0,
        })
    }

    fn write_samples(&mut self, pcm: &[u8]) -> anyhow::Result<()> {
        self.file.write_all(pcm)?;
        self.data_bytes += pcm.len() as u32;
        Ok(())
    }

    fn finalize(&mut self) -> anyhow::Result<()> {
        // Update RIFF size (file_size - 8)
        let riff_size = 36 + self.data_bytes;
        self.file.seek(SeekFrom::Start(4))?;
        self.file.write_all(&riff_size.to_le_bytes())?;

        // Update data chunk size
        self.file.seek(SeekFrom::Start(40))?;
        self.file.write_all(&self.data_bytes.to_le_bytes())?;

        self.file.flush()?;
        Ok(())
    }
}
