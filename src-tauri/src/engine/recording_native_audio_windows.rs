use std::fs::OpenOptions;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use wasapi::{Device, DeviceEnumerator, Direction, Role, SampleType, StreamMode, WaveFormat};

use crate::engine::recording::{RecordingDeviceInfo, RecordingDeviceKind};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const BITS_PER_SAMPLE: u16 = 16;
const SOURCE_BYTES_PER_FRAME: usize = 8; // 32-bit float stereo.
const START_TIMEOUT: Duration = Duration::from_secs(5);

pub struct NativeAudioRecording {
    name: &'static str,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<anyhow::Result<()>>>,
}

impl NativeAudioRecording {
    pub fn start_microphone(
        device_id: Option<&str>,
        volume: u8,
        output_path: &Path,
        log_path: &Path,
    ) -> anyhow::Result<Self> {
        start_audio_recording(
            "mic",
            AudioSource::Microphone(device_id.map(ToOwned::to_owned)),
            volume,
            output_path,
            log_path,
        )
    }

    pub fn start_system_audio(
        volume: u8,
        output_path: &Path,
        log_path: &Path,
    ) -> anyhow::Result<Self> {
        start_audio_recording(
            "system_audio",
            AudioSource::SystemLoopback,
            volume,
            output_path,
            log_path,
        )
    }

    pub fn stop(mut self) -> anyhow::Result<()> {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            match handle.join() {
                Ok(result) => result,
                Err(_) => anyhow::bail!("Native Windows {} capture thread panicked", self.name),
            }
        } else {
            Ok(())
        }
    }
}

impl Drop for NativeAudioRecording {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub fn discover_native_audio_devices() -> anyhow::Result<Vec<RecordingDeviceInfo>> {
    let _com = ComApartment::initialize()?;
    let enumerator = DeviceEnumerator::new()?;
    let default_capture_id = enumerator
        .get_default_device_for_role(&Direction::Capture, &Role::Console)
        .ok()
        .and_then(|device| device.get_id().ok());
    let default_render_id = enumerator
        .get_default_device_for_role(&Direction::Render, &Role::Console)
        .ok()
        .and_then(|device| device.get_id().ok());
    let mut devices = Vec::new();

    for device in &enumerator.get_device_collection(&Direction::Capture)? {
        let device = device?;
        let id = device.get_id()?;
        let label = device.get_friendlyname()?;
        devices.push(RecordingDeviceInfo {
            is_default: default_capture_id.as_deref() == Some(id.as_str()),
            id,
            label,
            kind: RecordingDeviceKind::Microphone,
            camera_formats: Vec::new(),
        });
    }

    for device in &enumerator.get_device_collection(&Direction::Render)? {
        let device = device?;
        let id = device.get_id()?;
        let label = device.get_friendlyname()?;
        devices.push(RecordingDeviceInfo {
            is_default: default_render_id.as_deref() == Some(id.as_str()),
            id,
            label,
            kind: RecordingDeviceKind::SystemAudio,
            camera_formats: Vec::new(),
        });
    }

    Ok(devices)
}

enum AudioSource {
    Microphone(Option<String>),
    SystemLoopback,
}

struct ComApartment;

impl ComApartment {
    fn initialize() -> anyhow::Result<Self> {
        let hr = wasapi::initialize_mta();
        hr.ok()
            .map_err(|err| anyhow::anyhow!("Could not initialize Windows audio COM: {err}"))?;
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        wasapi::deinitialize();
    }
}

fn start_audio_recording(
    name: &'static str,
    source: AudioSource,
    volume: u8,
    output_path: &Path,
    log_path: &Path,
) -> anyhow::Result<NativeAudioRecording> {
    let output_path = output_path.to_path_buf();
    let log_path = log_path.to_path_buf();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let started = Arc::new(AtomicBool::new(false));
    let thread_started = Arc::clone(&started);
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let thread_started_tx = started_tx.clone();

    let handle = thread::Builder::new()
        .name(format!("cutready-{name}-wasapi"))
        .spawn(move || {
            let result = capture_audio_to_wav(
                source,
                volume,
                &output_path,
                &log_path,
                thread_stop,
                name,
                thread_started,
                started_tx,
            );
            if let Err(err) = &result {
                if !started.load(Ordering::SeqCst) {
                    let _ = thread_started_tx.send(Err(err.to_string()));
                    let _ = append_log(
                        &log_path,
                        &format!("native_windows_audio {name} startup failed: {err}"),
                    );
                }
                let _ = append_log(
                    &log_path,
                    &format!("native_windows_audio {name} failed: {err}"),
                );
            }
            result
        })?;

    match started_rx.recv_timeout(START_TIMEOUT) {
        Ok(Ok(())) => Ok(NativeAudioRecording {
            name,
            stop,
            handle: Some(handle),
        }),
        Ok(Err(err)) => {
            let _ = handle.join();
            Err(anyhow::anyhow!(err))
        }
        Err(err) => {
            stop.store(true, Ordering::SeqCst);
            let _ = handle.join();
            Err(anyhow::anyhow!(
                "Native Windows {name} capture did not start within {} seconds: {err}",
                START_TIMEOUT.as_secs()
            ))
        }
    }
}

fn capture_audio_to_wav(
    source: AudioSource,
    volume: u8,
    output_path: &Path,
    log_path: &Path,
    stop: Arc<AtomicBool>,
    name: &'static str,
    started: Arc<AtomicBool>,
    started_tx: mpsc::SyncSender<Result<(), String>>,
) -> anyhow::Result<()> {
    let _com = ComApartment::initialize()?;
    let enumerator = DeviceEnumerator::new()?;
    let loopback = matches!(source, AudioSource::SystemLoopback);
    let device = match source {
        AudioSource::Microphone(device_id) => {
            resolve_capture_device(&enumerator, device_id.as_deref())?
        }
        AudioSource::SystemLoopback => {
            enumerator.get_default_device_for_role(&Direction::Render, &Role::Console)?
        }
    };
    let friendly_name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "<unknown>".to_string());
    let mut audio_client = device.get_iaudioclient()?;
    let desired_format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        SAMPLE_RATE as usize,
        CHANNELS as usize,
        None,
    );
    let (_, min_time) = audio_client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_time,
    };
    audio_client.initialize_client(&desired_format, &Direction::Capture, &mode)?;
    let event = audio_client.set_get_eventhandle()?;
    let buffer_frames = audio_client.get_buffer_size()?;
    let capture_client = audio_client.get_audiocaptureclient()?;
    let volume = volume.min(200);
    let gain = volume as f32 / 100.0;
    let mut writer = PcmWavWriter::create(output_path)?;

    append_log(
        log_path,
        &format!(
            "native_windows_audio {name} device=\"{friendly_name}\" output={} sample_rate={} channels={} volume={} gain={gain:.2}",
            output_path.display(),
            SAMPLE_RATE,
            CHANNELS,
            volume
        ),
    )?;

    audio_client.start_stream()?;
    started.store(true, Ordering::SeqCst);
    let _ = started_tx.send(Ok(()));
    let started = Instant::now();
    let mut buffer = vec![0u8; buffer_frames.max(1) as usize * SOURCE_BYTES_PER_FRAME];

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }

        match event.wait_for_event(100) {
            Ok(()) => {}
            Err(_) => {
                if loopback {
                    writer.pad_to_elapsed(started.elapsed())?;
                }
                continue;
            }
        }

        loop {
            let next_packet = capture_client.get_next_packet_size()?.unwrap_or(0);
            if next_packet == 0 {
                break;
            }
            let needed = next_packet as usize * SOURCE_BYTES_PER_FRAME;
            if buffer.len() < needed {
                buffer.resize(needed, 0);
            }
            let (frames, info) = capture_client.read_from_device(&mut buffer[..needed])?;
            if frames == 0 {
                break;
            }
            let bytes = frames as usize * SOURCE_BYTES_PER_FRAME;
            if info.flags.silent {
                writer.write_silence(frames as u64)?;
            } else {
                writer.write_float32_stereo(&buffer[..bytes], gain)?;
            }
        }
    }

    if loopback {
        writer.pad_to_elapsed(started.elapsed())?;
    }
    let _ = audio_client.stop_stream();
    writer.finalize()?;
    append_log(
        log_path,
        &format!(
            "native_windows_audio {name} frames={}",
            writer.frames_written()
        ),
    )?;
    Ok(())
}

fn resolve_capture_device(
    enumerator: &DeviceEnumerator,
    device_id: Option<&str>,
) -> anyhow::Result<Device> {
    let Some(device_id) = device_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(enumerator.get_default_device_for_role(&Direction::Capture, &Role::Console)?);
    };

    if let Ok(device) = enumerator.get_device(device_id) {
        return Ok(device);
    }

    let devices = enumerator.get_device_collection(&Direction::Capture)?;
    if let Ok(device) = devices.get_device_with_name(device_id) {
        return Ok(device);
    }

    anyhow::bail!("Windows microphone device was not found: {device_id}")
}

struct PcmWavWriter {
    file: std::fs::File,
    frames_written: u64,
}

impl PcmWavWriter {
    fn create(path: &Path) -> anyhow::Result<Self> {
        let _ = std::fs::remove_file(path);
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(path)?;
        write_wav_header(&mut file, 0)?;
        Ok(Self {
            file,
            frames_written: 0,
        })
    }

    fn write_float32_stereo(&mut self, bytes: &[u8], gain: f32) -> anyhow::Result<()> {
        let mut pcm = Vec::with_capacity(bytes.len() / 2);
        for sample in bytes.chunks_exact(4) {
            let value = f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]);
            let clipped = (value * gain).clamp(-1.0, 1.0);
            let sample = (clipped * i16::MAX as f32).round() as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        self.file.write_all(&pcm)?;
        self.frames_written += (pcm.len() / bytes_per_frame()) as u64;
        Ok(())
    }

    fn write_silence(&mut self, frames: u64) -> anyhow::Result<()> {
        let bytes = frames.saturating_mul(bytes_per_frame() as u64);
        write_zeroes(&mut self.file, bytes)?;
        self.frames_written = self.frames_written.saturating_add(frames);
        Ok(())
    }

    fn pad_to_elapsed(&mut self, elapsed: Duration) -> anyhow::Result<()> {
        let target_frames = (elapsed.as_secs_f64() * SAMPLE_RATE as f64).floor() as u64;
        if target_frames > self.frames_written {
            self.write_silence(target_frames - self.frames_written)?;
        }
        Ok(())
    }

    fn frames_written(&self) -> u64 {
        self.frames_written
    }

    fn finalize(&mut self) -> anyhow::Result<()> {
        let data_bytes = self.frames_written.saturating_mul(bytes_per_frame() as u64);
        self.file.seek(SeekFrom::Start(0))?;
        write_wav_header(&mut self.file, data_bytes.min(u32::MAX as u64) as u32)?;
        self.file.flush()?;
        self.file.sync_all()?;
        Ok(())
    }
}

fn bytes_per_frame() -> usize {
    CHANNELS as usize * (BITS_PER_SAMPLE as usize / 8)
}

fn write_wav_header(file: &mut std::fs::File, data_bytes: u32) -> anyhow::Result<()> {
    let byte_rate = SAMPLE_RATE * CHANNELS as u32 * BITS_PER_SAMPLE as u32 / 8;
    let block_align = CHANNELS * BITS_PER_SAMPLE / 8;
    let riff_size = 36u32.saturating_add(data_bytes);

    file.write_all(b"RIFF")?;
    file.write_all(&riff_size.to_le_bytes())?;
    file.write_all(b"WAVE")?;
    file.write_all(b"fmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&CHANNELS.to_le_bytes())?;
    file.write_all(&SAMPLE_RATE.to_le_bytes())?;
    file.write_all(&byte_rate.to_le_bytes())?;
    file.write_all(&block_align.to_le_bytes())?;
    file.write_all(&BITS_PER_SAMPLE.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_bytes.to_le_bytes())?;
    Ok(())
}

fn write_zeroes(file: &mut std::fs::File, mut bytes: u64) -> anyhow::Result<()> {
    const ZEROES: [u8; 8192] = [0; 8192];
    while bytes > 0 {
        let chunk = bytes.min(ZEROES.len() as u64) as usize;
        file.write_all(&ZEROES[..chunk])?;
        bytes -= chunk as u64;
    }
    Ok(())
}

fn append_log(path: &Path, message: &str) -> anyhow::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{message}")?;
    Ok(())
}
