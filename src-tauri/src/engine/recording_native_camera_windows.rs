use std::ffi::c_void;
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread::{self, JoinHandle};

use anyhow::Context;
use windows::core::{GUID, PCWSTR, PWSTR};
use windows::Win32::Media::MediaFoundation::{
    eAVEncH264VProfile_High, IMFActivate, IMFAttributes, IMFMediaSource, IMFSample,
    MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFCreateSinkWriterFromURL, MFCreateSourceReaderFromMediaSource, MFEnumDeviceSources,
    MFMediaType_Video, MFShutdown, MFStartup, MFVideoFormat_H264, MFVideoFormat_MJPG,
    MFVideoFormat_NV12, MFVideoFormat_RGB32, MFVideoFormat_UYVY, MFVideoFormat_YUY2,
    MFVideoInterlace_Progressive, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
    MF_E_NO_MORE_TYPES, MF_LOW_LATENCY, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE,
    MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
    MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SINK_WRITER_DISABLE_THROTTLING,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED,
};

use crate::engine::recording::CameraFormatInfo;

const HNS_PER_SECOND: i64 = 10_000_000;
const CAMERA_BITRATE: u32 = 15_000_000;

#[derive(Clone, Copy, Debug)]
enum SourceFormat {
    Nv12,
    Uyvy,
    Yuy2,
}

#[derive(Clone, Copy, Debug)]
struct SourceFormatConfig {
    format: SourceFormat,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
}

pub struct NativeCameraRecording {
    stop_requested: Arc<AtomicBool>,
    handle: Option<JoinHandle<anyhow::Result<()>>>,
    output_path: PathBuf,
}

impl NativeCameraRecording {
    pub fn start(
        friendly_name: String,
        format: Option<CameraFormatInfo>,
        output_path: &Path,
        log_path: &Path,
    ) -> anyhow::Result<Self> {
        let output_path = output_path.to_path_buf();
        let log_path = log_path.to_path_buf();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop_requested);
        let (started_tx, started_rx) = mpsc::channel();
        let thread_output_path = output_path.clone();

        let handle = thread::spawn(move || {
            let result = run_native_camera_capture(
                &friendly_name,
                format,
                &thread_output_path,
                &log_path,
                thread_stop,
                started_tx,
            );
            if let Err(err) = &result {
                let _ = append_log(&log_path, &format!("native_camera error {err:#}"));
            }
            result
        });

        match started_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                stop_requested,
                handle: Some(handle),
                output_path,
            }),
            Ok(Err(err)) => {
                let _ = handle.join();
                Err(err)
            }
            Err(err) => {
                let _ = handle.join();
                Err(anyhow::anyhow!(
                    "Native camera capture failed before startup completed: {err}"
                ))
            }
        }
    }

    pub fn stop(mut self) -> anyhow::Result<()> {
        self.stop_requested.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            match handle.join() {
                Ok(result) => result?,
                Err(_) => anyhow::bail!("Native camera capture thread panicked"),
            }
        }
        if !self
            .output_path
            .metadata()
            .map(|metadata| metadata.len() > 0)
            .unwrap_or(false)
        {
            anyhow::bail!(
                "Native camera capture did not produce output: {}",
                self.output_path.display()
            );
        }
        Ok(())
    }
}

pub fn discover_camera_formats_by_name(
    friendly_name: &str,
) -> anyhow::Result<Vec<CameraFormatInfo>> {
    let _session = MediaFoundationSession::start()?;
    let devices = enumerate_video_devices()?;
    for device in devices {
        let name = allocated_string(&device, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)?;
        if name == friendly_name {
            return native_formats_for_device(&device);
        }
    }
    Ok(Vec::new())
}

fn run_native_camera_capture(
    friendly_name: &str,
    requested_format: Option<CameraFormatInfo>,
    output_path: &Path,
    log_path: &Path,
    stop_requested: Arc<AtomicBool>,
    started_tx: mpsc::Sender<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    let startup = (|| -> anyhow::Result<NativeCameraPipeline> {
        let _com = ComMtaGuard::initialize()?;
        let _session = MediaFoundationSession::start()?;
        append_log(
            log_path,
            &format!(
                "native_camera starting device={friendly_name:?} output={}",
                output_path.display()
            ),
        )?;

        let device = find_video_device_by_name(friendly_name)?
            .ok_or_else(|| anyhow::anyhow!("Native camera device not found: {friendly_name}"))?;
        append_log(log_path, "native_camera device found")?;
        let selected_format = requested_format
            .or_else(|| {
                native_formats_for_device(&device)
                    .ok()
                    .and_then(|formats| best_format(&formats))
            })
            .unwrap_or(CameraFormatInfo {
                width: 1920,
                height: 1080,
                fps: Some("30".to_string()),
                codec: None,
                pixel_format: None,
            });
        append_log(
            log_path,
            &format!(
                "native_camera selected requested format {}x{} fps={:?} codec={:?} pixel={:?}",
                selected_format.width,
                selected_format.height,
                selected_format.fps,
                selected_format.codec,
                selected_format.pixel_format
            ),
        )?;

        append_log(log_path, "native_camera activating Media Foundation source")?;
        let source: IMFMediaSource = unsafe { device.ActivateObject() }
            .context("Media Foundation camera device activation failed")?;
        append_log(log_path, "native_camera creating source reader")?;
        let reader = unsafe { MFCreateSourceReaderFromMediaSource(&source, None) }
            .context("Media Foundation source reader creation failed")?;
        append_log(log_path, "native_camera selecting first video stream")?;
        unsafe {
            reader
                .SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, true)
                .context("Media Foundation source reader stream selection failed")?;
        }

        let source_config = configure_reader_source_format(&reader, &selected_format, log_path)?;
        let input_type = create_video_type(
            MFVideoFormat_NV12,
            source_config.width,
            source_config.height,
            source_config.fps_num,
            source_config.fps_den,
            None,
        )?;

        let sink_attributes = create_sink_writer_attributes()?;
        let output_url = wide_path(output_path);
        let writer = unsafe {
            MFCreateSinkWriterFromURL(PCWSTR(output_url.as_ptr()), None, &sink_attributes)?
        };
        let output_type = create_video_type(
            MFVideoFormat_H264,
            source_config.width,
            source_config.height,
            source_config.fps_num,
            source_config.fps_den,
            Some(CAMERA_BITRATE),
        )?;
        let stream_index = unsafe { writer.AddStream(&output_type)? };
        unsafe {
            writer.SetInputMediaType(stream_index, &input_type, &sink_attributes)?;
            writer.BeginWriting()?;
        }

        append_log(
            log_path,
            &format!(
                "native_camera format={}x{} fps={}/{} source={:?} bitrate={}",
                source_config.width,
                source_config.height,
                source_config.fps_num,
                source_config.fps_den,
                source_config.format,
                CAMERA_BITRATE
            ),
        )?;

        Ok(NativeCameraPipeline {
            _com,
            _session,
            source,
            reader,
            writer,
            stream_index,
            source_config,
        })
    })();

    let mut pipeline = match startup {
        Ok(pipeline) => {
            let _ = started_tx.send(Ok(()));
            pipeline
        }
        Err(err) => {
            let message = format!("{err:#}");
            let _ = started_tx.send(Err(anyhow::anyhow!(message.clone())));
            return Err(anyhow::anyhow!(message));
        }
    };

    let loop_result = pipeline.capture_loop(stop_requested);
    let finalize_result = unsafe { pipeline.writer.Finalize().map_err(anyhow::Error::from) };
    let shutdown_result = unsafe { pipeline.source.Shutdown().map_err(anyhow::Error::from) };

    loop_result?;
    finalize_result?;
    shutdown_result?;
    Ok(())
}

struct NativeCameraPipeline {
    _com: ComMtaGuard,
    _session: MediaFoundationSession,
    source: IMFMediaSource,
    reader: windows::Win32::Media::MediaFoundation::IMFSourceReader,
    writer: windows::Win32::Media::MediaFoundation::IMFSinkWriter,
    stream_index: u32,
    source_config: SourceFormatConfig,
}

impl NativeCameraPipeline {
    fn capture_loop(&mut self, stop_requested: Arc<AtomicBool>) -> anyhow::Result<()> {
        let mut first_sample_time: Option<i64> = None;
        let frame_duration = HNS_PER_SECOND * self.source_config.fps_den as i64
            / self.source_config.fps_num.max(1) as i64;

        while !stop_requested.load(Ordering::SeqCst) {
            let mut flags = 0u32;
            let mut timestamp = 0i64;
            let mut sample: Option<IMFSample> = None;
            unsafe {
                self.reader.ReadSample(
                    MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                    0,
                    None,
                    Some(&mut flags),
                    Some(&mut timestamp),
                    Some(&mut sample),
                )?;
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
            let Some(sample) = sample else {
                continue;
            };
            let first = *first_sample_time.get_or_insert(timestamp);
            let rebased_time = timestamp.saturating_sub(first);
            let sample = match self.source_config.format {
                SourceFormat::Nv12 => sample,
                SourceFormat::Uyvy | SourceFormat::Yuy2 => {
                    convert_packed_yuv_sample_to_nv12(&sample, &self.source_config)?
                }
            };
            unsafe {
                sample.SetSampleTime(rebased_time)?;
                sample.SetSampleDuration(frame_duration)?;
                self.writer.WriteSample(self.stream_index, &sample)?;
            }
        }

        Ok(())
    }
}

struct ComMtaGuard;

impl ComMtaGuard {
    fn initialize() -> anyhow::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        }
        Ok(Self)
    }
}

impl Drop for ComMtaGuard {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

struct MediaFoundationSession;

impl MediaFoundationSession {
    fn start() -> anyhow::Result<Self> {
        unsafe {
            MFStartup(MF_VERSION, 0)?;
        }
        Ok(Self)
    }
}

impl Drop for MediaFoundationSession {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
        }
    }
}

fn enumerate_video_devices() -> anyhow::Result<Vec<IMFActivate>> {
    unsafe {
        let mut attributes: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attributes, 1)?;
        let attributes = attributes
            .ok_or_else(|| anyhow::anyhow!("Media Foundation did not create attributes"))?;
        attributes.SetGUID(
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        )?;

        let mut raw_devices: *mut Option<IMFActivate> = ptr::null_mut();
        let mut count = 0u32;
        MFEnumDeviceSources(&attributes, &mut raw_devices, &mut count)?;
        if raw_devices.is_null() || count == 0 {
            return Ok(Vec::new());
        }

        let mut devices = Vec::with_capacity(count as usize);
        let slice = std::slice::from_raw_parts_mut(raw_devices, count as usize);
        for entry in slice.iter_mut() {
            if let Some(device) = entry.take() {
                devices.push(device);
            }
        }
        CoTaskMemFree(Some(raw_devices.cast::<c_void>()));
        Ok(devices)
    }
}

fn find_video_device_by_name(friendly_name: &str) -> anyhow::Result<Option<IMFActivate>> {
    for device in enumerate_video_devices()? {
        let name = allocated_string(&device, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)?;
        if name == friendly_name {
            return Ok(Some(device));
        }
    }
    Ok(None)
}

fn native_formats_for_device(device: &IMFActivate) -> anyhow::Result<Vec<CameraFormatInfo>> {
    unsafe {
        let source: IMFMediaSource = device.ActivateObject()?;
        let reader = MFCreateSourceReaderFromMediaSource(&source, None)?;
        let mut formats = Vec::new();
        let mut index = 0u32;
        loop {
            match reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, index) {
                Ok(media_type) => {
                    if let Some(format) = camera_format_from_media_type(&media_type) {
                        formats.push(format);
                    }
                    index += 1;
                }
                Err(err) if err.code() == MF_E_NO_MORE_TYPES => break,
                Err(err) => {
                    let _ = source.Shutdown();
                    return Err(err.into());
                }
            }
        }
        let _ = source.Shutdown();
        formats.sort_by(|a, b| {
            let a_score = camera_format_score(a);
            let b_score = camera_format_score(b);
            b_score.cmp(&a_score)
        });
        formats.dedup();
        Ok(formats)
    }
}

fn configure_reader_source_format(
    reader: &windows::Win32::Media::MediaFoundation::IMFSourceReader,
    selected_format: &CameraFormatInfo,
    log_path: &Path,
) -> anyhow::Result<SourceFormatConfig> {
    let (fps_num, fps_den) = parse_fps_ratio(selected_format.fps.as_deref()).unwrap_or((30, 1));
    let nv12_type = create_video_type(
        MFVideoFormat_NV12,
        selected_format.width,
        selected_format.height,
        fps_num,
        fps_den,
        None,
    )?;

    unsafe {
        match reader.SetCurrentMediaType(
            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
            None,
            &nv12_type,
        ) {
            Ok(()) => {
                append_log(log_path, "native_camera source reader using NV12 output")?;
                return Ok(SourceFormatConfig {
                    format: SourceFormat::Nv12,
                    width: selected_format.width,
                    height: selected_format.height,
                    fps_num,
                    fps_den,
                });
            }
            Err(err) => {
                append_log(
                    log_path,
                    &format!(
                        "native_camera NV12 source reader setup failed; trying native packed YUV: {err}"
                    ),
                )?;
            }
        }
    }

    let (native_type, config) =
        select_native_packed_yuv_type(reader, selected_format).ok_or_else(|| {
            anyhow::anyhow!("Camera does not expose NV12, UYVY, or YUY2 Media Foundation output")
        })?;
    unsafe {
        reader.SetCurrentMediaType(
            MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
            None,
            &native_type,
        )?;
    }
    append_log(
        log_path,
        &format!(
            "native_camera source reader using native {:?} output with app-side NV12 conversion",
            config.format
        ),
    )?;
    Ok(config)
}

fn select_native_packed_yuv_type(
    reader: &windows::Win32::Media::MediaFoundation::IMFSourceReader,
    selected_format: &CameraFormatInfo,
) -> Option<(
    windows::Win32::Media::MediaFoundation::IMFMediaType,
    SourceFormatConfig,
)> {
    let selected_fps = selected_format
        .fps
        .as_deref()
        .and_then(parse_fps_score)
        .unwrap_or(0);
    let mut best: Option<(
        (u8, u8, u64, u32),
        windows::Win32::Media::MediaFoundation::IMFMediaType,
        SourceFormatConfig,
    )> = None;
    let mut index = 0u32;

    loop {
        let media_type = unsafe {
            match reader.GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, index) {
                Ok(media_type) => media_type,
                Err(err) if err.code() == MF_E_NO_MORE_TYPES => break,
                Err(_) => break,
            }
        };
        index += 1;

        let Some(subtype) = (unsafe { media_type.GetGUID(&MF_MT_SUBTYPE).ok() }) else {
            continue;
        };
        let format = if subtype == MFVideoFormat_UYVY {
            SourceFormat::Uyvy
        } else if subtype == MFVideoFormat_YUY2 {
            SourceFormat::Yuy2
        } else {
            continue;
        };
        let Some((width, height)) = attribute_size(&media_type, &MF_MT_FRAME_SIZE) else {
            continue;
        };
        let (fps_num, fps_den) = attribute_ratio(&media_type, &MF_MT_FRAME_RATE).unwrap_or((30, 1));
        let fps = if fps_num == 0 || fps_den == 0 {
            0
        } else {
            ((fps_num as f64 / fps_den as f64) * 1000.0).round() as u32
        };
        let score = (
            u8::from(width == selected_format.width && height == selected_format.height),
            u8::from(selected_fps == 0 || selected_fps == fps),
            width as u64 * height as u64,
            fps,
        );
        let config = SourceFormatConfig {
            format,
            width,
            height,
            fps_num: fps_num.max(1),
            fps_den: fps_den.max(1),
        };
        if best
            .as_ref()
            .is_none_or(|(best_score, _, _)| score > *best_score)
        {
            best = Some((score, media_type, config));
        }
    }

    best.map(|(_, media_type, config)| (media_type, config))
}

fn convert_packed_yuv_sample_to_nv12(
    sample: &IMFSample,
    config: &SourceFormatConfig,
) -> anyhow::Result<IMFSample> {
    let width = config.width as usize;
    let height = config.height as usize;
    if width % 2 != 0 || height % 2 != 0 {
        return Err(anyhow::anyhow!(
            "Packed-YUV camera frames must have even dimensions for NV12 conversion: {}x{}",
            width,
            height
        ));
    }
    let source_stride = width
        .checked_mul(2)
        .ok_or_else(|| anyhow::anyhow!("Camera frame width is too large"))?;
    let y_plane_len = width
        .checked_mul(height)
        .ok_or_else(|| anyhow::anyhow!("Camera frame dimensions are too large"))?;
    let nv12_len = y_plane_len
        .checked_add(y_plane_len / 2)
        .ok_or_else(|| anyhow::anyhow!("Camera NV12 frame size is too large"))?;

    unsafe {
        let source_buffer = sample.ConvertToContiguousBuffer()?;
        let mut source_ptr = ptr::null_mut();
        let mut source_max_len = 0u32;
        let mut source_current_len = 0u32;
        source_buffer.Lock(
            &mut source_ptr,
            Some(&mut source_max_len),
            Some(&mut source_current_len),
        )?;
        let source = std::slice::from_raw_parts(source_ptr, source_current_len as usize);

        let required_source_len = source_stride
            .checked_mul(height)
            .ok_or_else(|| anyhow::anyhow!("Camera source frame size is too large"))?;
        if source.len() < required_source_len {
            source_buffer.Unlock()?;
            return Err(anyhow::anyhow!(
                "Camera source frame is shorter than expected: {} < {}",
                source.len(),
                required_source_len
            ));
        }

        let dest_buffer = MFCreateMemoryBuffer(nv12_len as u32)?;
        let mut dest_ptr = ptr::null_mut();
        let mut dest_max_len = 0u32;
        let mut dest_current_len = 0u32;
        dest_buffer.Lock(
            &mut dest_ptr,
            Some(&mut dest_max_len),
            Some(&mut dest_current_len),
        )?;
        let dest = std::slice::from_raw_parts_mut(dest_ptr, nv12_len);
        packed_yuv_to_nv12(source, dest, width, height, config.format);
        dest_buffer.Unlock()?;
        dest_buffer.SetCurrentLength(nv12_len as u32)?;
        source_buffer.Unlock()?;

        let converted = MFCreateSample()?;
        converted.AddBuffer(&dest_buffer)?;
        Ok(converted)
    }
}

fn packed_yuv_to_nv12(
    source: &[u8],
    dest: &mut [u8],
    width: usize,
    height: usize,
    format: SourceFormat,
) {
    let source_stride = width * 2;
    let (y_plane, uv_plane) = dest.split_at_mut(width * height);

    for row in 0..height {
        let source_row = &source[row * source_stride..(row + 1) * source_stride];
        let y_row = &mut y_plane[row * width..(row + 1) * width];
        for x in (0..width).step_by(2) {
            let pair = &source_row[x * 2..];
            match format {
                SourceFormat::Uyvy => {
                    y_row[x] = pair[1];
                    if x + 1 < width {
                        y_row[x + 1] = pair[3];
                    }
                }
                SourceFormat::Yuy2 => {
                    y_row[x] = pair[0];
                    if x + 1 < width {
                        y_row[x + 1] = pair[2];
                    }
                }
                SourceFormat::Nv12 => {
                    unreachable!("NV12 samples do not need packed-YUV conversion")
                }
            }
        }
    }

    for row in (0..height).step_by(2) {
        let next_row = (row + 1).min(height - 1);
        let uv_row = (row / 2) * width;
        for x in (0..width).step_by(2) {
            let (u0, v0) = packed_yuv_chroma(source, width, row, x, format);
            let (u1, v1) = packed_yuv_chroma(source, width, next_row, x, format);
            uv_plane[uv_row + x] = ((u0 as u16 + u1 as u16) / 2) as u8;
            if x + 1 < width {
                uv_plane[uv_row + x + 1] = ((v0 as u16 + v1 as u16) / 2) as u8;
            }
        }
    }
}

fn packed_yuv_chroma(
    source: &[u8],
    width: usize,
    row: usize,
    x: usize,
    format: SourceFormat,
) -> (u8, u8) {
    let source_stride = width * 2;
    let pair_offset = row * source_stride + x * 2;
    match format {
        SourceFormat::Uyvy => (source[pair_offset], source[pair_offset + 2]),
        SourceFormat::Yuy2 => (source[pair_offset + 1], source[pair_offset + 3]),
        SourceFormat::Nv12 => unreachable!("NV12 samples do not need packed-YUV conversion"),
    }
}

fn create_sink_writer_attributes() -> anyhow::Result<IMFAttributes> {
    unsafe {
        let mut attributes: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attributes, 4)?;
        let attributes = attributes
            .ok_or_else(|| anyhow::anyhow!("Media Foundation did not create writer attributes"))?;
        attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
        attributes.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1)?;
        attributes.SetUINT32(&MF_LOW_LATENCY, 1)?;
        Ok(attributes)
    }
}

fn create_video_type(
    subtype: GUID,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    bitrate: Option<u32>,
) -> anyhow::Result<windows::Win32::Media::MediaFoundation::IMFMediaType> {
    unsafe {
        let media_type = MFCreateMediaType()?;
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
        media_type.SetUINT64(&MF_MT_FRAME_SIZE, pack_ratio(width, height))?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(fps_num, fps_den.max(1)))?;
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_ratio(1, 1))?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        if let Some(bitrate) = bitrate {
            media_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            media_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 0)?;
        }
        Ok(media_type)
    }
}

fn pack_ratio(numerator: u32, denominator: u32) -> u64 {
    ((numerator as u64) << 32) | denominator as u64
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn append_log(path: &Path, message: &str) -> anyhow::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{message}")?;
    Ok(())
}

fn best_format(formats: &[CameraFormatInfo]) -> Option<CameraFormatInfo> {
    formats.iter().cloned().max_by_key(camera_format_score)
}

fn camera_format_from_media_type(media_type: &IMFAttributes) -> Option<CameraFormatInfo> {
    let (width, height) = attribute_size(media_type, &MF_MT_FRAME_SIZE)?;
    let (fps_num, fps_den) = attribute_ratio(media_type, &MF_MT_FRAME_RATE).unwrap_or((0, 0));
    let subtype = unsafe { media_type.GetGUID(&MF_MT_SUBTYPE).ok() };
    let (codec, pixel_format) = subtype_to_format(subtype);
    Some(CameraFormatInfo {
        width,
        height,
        fps: format_fps(fps_num, fps_den),
        codec,
        pixel_format,
    })
}

fn allocated_string(attributes: &IMFAttributes, key: &GUID) -> anyhow::Result<String> {
    unsafe {
        let mut raw = PWSTR::null();
        let mut len = 0u32;
        attributes.GetAllocatedString(key, &mut raw, &mut len)?;
        let value = raw.to_string()?;
        CoTaskMemFree(Some(raw.as_ptr().cast::<c_void>()));
        Ok(value)
    }
}

fn attribute_size(attributes: &IMFAttributes, key: &GUID) -> Option<(u32, u32)> {
    let packed = unsafe { attributes.GetUINT64(key).ok()? };
    Some(((packed >> 32) as u32, packed as u32))
}

fn attribute_ratio(attributes: &IMFAttributes, key: &GUID) -> Option<(u32, u32)> {
    attribute_size(attributes, key)
}

fn format_fps(numerator: u32, denominator: u32) -> Option<String> {
    if numerator == 0 || denominator == 0 {
        return None;
    }
    if denominator == 1 {
        Some(numerator.to_string())
    } else {
        Some(format!("{numerator}/{denominator}"))
    }
}

fn parse_fps_ratio(fps: Option<&str>) -> Option<(u32, u32)> {
    let fps = fps?;
    if let Some((num, den)) = fps.split_once('/') {
        let numerator = num.parse::<u32>().ok()?;
        let denominator = den.parse::<u32>().ok()?;
        return (numerator > 0 && denominator > 0).then_some((numerator, denominator));
    }
    let parsed = fps.parse::<f64>().ok()?;
    if parsed <= 0.0 {
        return None;
    }
    let scaled = (parsed * 10_000.0).round() as u32;
    Some((scaled, 10_000))
}

fn subtype_to_format(subtype: Option<GUID>) -> (Option<String>, Option<String>) {
    match subtype {
        Some(value) if value == MFVideoFormat_MJPG => (Some("mjpeg".to_string()), None),
        Some(value) if value == MFVideoFormat_NV12 => (None, Some("nv12".to_string())),
        Some(value) if value == MFVideoFormat_UYVY => (None, Some("uyvy422".to_string())),
        Some(value) if value == MFVideoFormat_YUY2 => (None, Some("yuy2".to_string())),
        Some(value) if value == MFVideoFormat_RGB32 => (None, Some("rgb32".to_string())),
        _ => (None, None),
    }
}

fn camera_format_score(format: &CameraFormatInfo) -> (u64, u32, u8) {
    let area = format.width as u64 * format.height as u64;
    let fps = format.fps.as_deref().and_then(parse_fps_score).unwrap_or(0);
    let raw_bonus = u8::from(format.pixel_format.is_some());
    (area, fps, raw_bonus)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_uyvy_to_nv12() {
        let source = vec![
            10, 1, 20, 2, //
            30, 3, 50, 4,
        ];
        let mut dest = vec![0; 6];

        packed_yuv_to_nv12(&source, &mut dest, 2, 2, SourceFormat::Uyvy);

        assert_eq!(dest, vec![1, 2, 3, 4, 20, 35]);
    }

    #[test]
    fn converts_yuy2_to_nv12() {
        let source = vec![
            1, 10, 2, 20, //
            3, 30, 4, 50,
        ];
        let mut dest = vec![0; 6];

        packed_yuv_to_nv12(&source, &mut dest, 2, 2, SourceFormat::Yuy2);

        assert_eq!(dest, vec![1, 2, 3, 4, 20, 35]);
    }
}
