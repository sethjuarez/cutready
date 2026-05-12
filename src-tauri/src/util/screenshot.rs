//! Screenshot capture utilities using xcap.

use image::ImageEncoder;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use xcap::Monitor;

/// Information about an available monitor.
#[derive(serde::Serialize, Clone, Debug)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub device_name: Option<String>,
    pub hmonitor: Option<String>,
    pub dxgi_output_index: Option<u32>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

/// List all available monitors.
pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    let native_monitors = native_monitor_infos();
    let mut result = Vec::new();
    for m in &monitors {
        let x = m.x().map_err(|e| format!("Monitor x error: {e}"))?;
        let y = m.y().map_err(|e| format!("Monitor y error: {e}"))?;
        let width = m.width().map_err(|e| format!("Monitor width error: {e}"))?;
        let height = m
            .height()
            .map_err(|e| format!("Monitor height error: {e}"))?;
        let native = native_monitors.iter().find(|monitor| {
            monitor.x == x && monitor.y == y && monitor.width == width && monitor.height == height
        });
        result.push(MonitorInfo {
            id: m.id().map_err(|e| format!("Monitor id error: {e}"))?,
            name: m.name().map_err(|e| format!("Monitor name error: {e}"))?,
            device_name: native.map(|monitor| monitor.device_name.clone()),
            hmonitor: native.map(|monitor| monitor.hmonitor.clone()),
            dxgi_output_index: native.and_then(|monitor| monitor.dxgi_output_index),
            x,
            y,
            width,
            height,
            is_primary: m.is_primary().unwrap_or(false),
        });
    }
    Ok(result)
}

#[derive(Clone, Debug)]
struct NativeMonitorInfo {
    device_name: String,
    hmonitor: String,
    dxgi_output_index: Option<u32>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
fn native_monitor_infos() -> Vec<NativeMonitorInfo> {
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
    };

    struct EnumState {
        monitors: Vec<NativeMonitorInfo>,
        dxgi_outputs: Vec<DxgiOutputInfo>,
    }

    unsafe extern "system" fn enum_monitor(
        hmonitor: HMONITOR,
        _hdc: HDC,
        rect: *mut RECT,
        param: LPARAM,
    ) -> windows::core::BOOL {
        let state = &mut *(param.0 as *mut EnumState);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;

        if GetMonitorInfoW(hmonitor, &mut info as *mut MONITORINFOEXW as *mut _).as_bool() {
            let device_name = String::from_utf16_lossy(&info.szDevice)
                .trim_end_matches('\0')
                .to_string();
            let rect = *rect;
            let hmonitor_string = (hmonitor.0 as usize).to_string();
            state.monitors.push(NativeMonitorInfo {
                device_name,
                dxgi_output_index: state
                    .dxgi_outputs
                    .iter()
                    .find(|output| output.hmonitor == hmonitor_string)
                    .map(|output| output.index),
                hmonitor: hmonitor_string,
                x: rect.left,
                y: rect.top,
                width: (rect.right - rect.left).max(0) as u32,
                height: (rect.bottom - rect.top).max(0) as u32,
            });
        }

        true.into()
    }

    let mut state = EnumState {
        monitors: Vec::new(),
        dxgi_outputs: dxgi_output_infos(),
    };
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitor),
            LPARAM(&mut state as *mut EnumState as isize),
        );
    }
    state.monitors
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug)]
struct DxgiOutputInfo {
    index: u32,
    hmonitor: String,
}

#[cfg(target_os = "windows")]
fn dxgi_output_infos() -> Vec<DxgiOutputInfo> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ERROR_NOT_FOUND};

    let mut outputs = Vec::new();
    unsafe {
        let factory = match CreateDXGIFactory1::<IDXGIFactory1>() {
            Ok(factory) => factory,
            Err(_) => return outputs,
        };
        let mut adapter_index = 0;
        let mut output_index = 0;
        loop {
            let adapter = match factory.EnumAdapters1(adapter_index) {
                Ok(adapter) => adapter,
                Err(err) if err.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(_) => break,
            };

            let mut adapter_output_index = 0;
            loop {
                let output = match adapter.EnumOutputs(adapter_output_index) {
                    Ok(output) => output,
                    Err(err) if err.code() == DXGI_ERROR_NOT_FOUND => break,
                    Err(_) => break,
                };
                if let Ok(desc) = output.GetDesc() {
                    outputs.push(DxgiOutputInfo {
                        index: output_index,
                        hmonitor: (desc.Monitor.0 as usize).to_string(),
                    });
                    output_index += 1;
                }
                adapter_output_index += 1;
            }
            adapter_index += 1;
        }
    }
    outputs
}

#[cfg(not(target_os = "windows"))]
fn native_monitor_infos() -> Vec<NativeMonitorInfo> {
    Vec::new()
}

fn find_monitor(monitor_id: u32) -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    monitors
        .into_iter()
        .find(|m| m.id().unwrap_or(0) == monitor_id)
        .ok_or_else(|| format!("Monitor {monitor_id} not found"))
}

/// Ensure the screenshots directory exists and return its path.
fn screenshots_dir(project_dir: &Path) -> Result<PathBuf, String> {
    let dir = project_dir.join(".cutready").join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create screenshots dir: {e}"))?;
    Ok(dir)
}

/// Generate a unique timestamped filename for a screenshot.
fn screenshot_filename() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S_%3f");
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{ts}_{seq}.jpg")
}

/// Save an RGBA image as JPEG (quality 95). Much faster than PNG for large screenshots.
fn save_jpeg(img: &image::RgbaImage, path: &Path) -> Result<(), String> {
    // JPEG doesn't support alpha — convert RGBA → RGB
    let rgb: image::RgbImage = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
    let file = std::fs::File::create(path).map_err(|e| format!("Failed to create file: {e}"))?;
    let writer = BufWriter::new(file);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, 95);
    encoder
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("JPEG encode failed: {e}"))
}

/// Capture a region of a monitor and save to the project's screenshot directory.
/// Returns the relative path from project root (e.g. ".cutready/screenshots/xxx.png").
pub fn capture_region(
    project_dir: &Path,
    monitor_id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let monitor = find_monitor(monitor_id)?;

    // Coordinates are absolute screen coords; convert to monitor-relative
    let mon_x = monitor.x().map_err(|e| format!("Monitor x error: {e}"))?;
    let mon_y = monitor.y().map_err(|e| format!("Monitor y error: {e}"))?;
    let rel_x = (x - mon_x).max(0) as u32;
    let rel_y = (y - mon_y).max(0) as u32;

    let img = monitor
        .capture_image()
        .map_err(|e| format!("Capture failed: {e}"))?;

    // Crop to the selected region
    let cropped = image::imageops::crop_imm(&img, rel_x, rel_y, width, height).to_image();

    let dir = screenshots_dir(project_dir)?;
    let filename = screenshot_filename();
    let abs_path = dir.join(&filename);

    save_jpeg(&cropped, &abs_path)?;

    let rel_path = format!(".cutready/screenshots/{filename}");
    Ok(rel_path)
}

/// Capture multiple monitors in parallel and save to the project's screenshot directory.
/// Returns a map of monitor_id → relative screenshot path.
pub fn capture_all_monitors(
    project_dir: &Path,
    monitor_ids: &[u32],
) -> Result<std::collections::HashMap<u32, String>, String> {
    let dir = screenshots_dir(project_dir)?;
    let all_monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;

    // Capture images on the main thread (Monitor is !Send due to HMONITOR)
    let captures: Vec<(u32, image::RgbaImage)> = monitor_ids
        .iter()
        .map(|&mid| {
            let monitor = all_monitors
                .iter()
                .find(|m| m.id().unwrap_or(0) == mid)
                .ok_or_else(|| format!("Monitor {mid} not found"))?;
            let img = monitor
                .capture_image()
                .map_err(|e| format!("Capture failed for monitor {mid}: {e}"))?;
            Ok((mid, img))
        })
        .collect::<Result<Vec<_>, String>>()?;

    // Encode + save in parallel threads (image data is Send)
    let handles: Vec<_> = captures
        .into_iter()
        .map(|(mid, img)| {
            let dir = dir.clone();
            std::thread::spawn(move || -> Result<(u32, String), String> {
                let filename = screenshot_filename();
                let abs_path = dir.join(&filename);
                save_jpeg(&img, &abs_path)?;
                let rel_path = format!(".cutready/screenshots/{filename}");
                Ok((mid, rel_path))
            })
        })
        .collect();

    let mut results = std::collections::HashMap::new();
    for h in handles {
        let (mid, path) = h.join().map_err(|_| "Thread panicked".to_string())??;
        results.insert(mid, path);
    }
    Ok(results)
}

/// Capture the entire monitor and save to the project's screenshot directory.
pub fn capture_fullscreen(project_dir: &Path, monitor_id: u32) -> Result<String, String> {
    let monitor = find_monitor(monitor_id)?;
    let img = monitor
        .capture_image()
        .map_err(|e| format!("Capture failed: {e}"))?;

    let dir = screenshots_dir(project_dir)?;
    let filename = screenshot_filename();
    let abs_path = dir.join(&filename);

    save_jpeg(&img, &abs_path)?;

    let rel_path = format!(".cutready/screenshots/{filename}");
    Ok(rel_path)
}

/// Crop a region from an existing screenshot image and save as a new file.
/// `source_rel` is the relative path from project root (e.g. ".cutready/screenshots/xxx.png").
/// Crop coordinates are in image pixels.
pub fn crop_screenshot(
    project_dir: &Path,
    source_rel: &str,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let source_abs = project_dir.join(source_rel);
    let img = image::open(&source_abs).map_err(|e| format!("Failed to open source image: {e}"))?;

    let cropped = image::imageops::crop_imm(&img, x, y, width, height).to_image();

    let dir = screenshots_dir(project_dir)?;
    let filename = screenshot_filename();
    let abs_path = dir.join(&filename);

    save_jpeg(&cropped, &abs_path)?;

    let rel_path = format!(".cutready/screenshots/{filename}");
    Ok(rel_path)
}
