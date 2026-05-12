use std::ffi::c_void;
use std::ptr;

use windows::core::{GUID, PWSTR};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFMediaSource, MFCreateAttributes,
    MFCreateSourceReaderFromMediaSource, MFEnumDeviceSources, MFShutdown, MFStartup,
    MFVideoFormat_MJPG, MFVideoFormat_NV12, MFVideoFormat_RGB32, MFVideoFormat_YUY2,
    MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID, MF_E_NO_MORE_TYPES, MF_MT_FRAME_RATE,
    MF_MT_FRAME_SIZE, MF_MT_SUBTYPE, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};
use windows::Win32::System::Com::CoTaskMemFree;

use crate::engine::recording::CameraFormatInfo;

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

fn subtype_to_format(subtype: Option<GUID>) -> (Option<String>, Option<String>) {
    match subtype {
        Some(value) if value == MFVideoFormat_MJPG => (Some("mjpeg".to_string()), None),
        Some(value) if value == MFVideoFormat_NV12 => (None, Some("nv12".to_string())),
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
