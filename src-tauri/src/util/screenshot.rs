//! Screenshot capture utilities using xcap.

use std::path::{Path, PathBuf};
use xcap::Monitor;

/// Information about an available monitor.
#[derive(serde::Serialize, Clone, Debug)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

/// List all available monitors.
pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    let mut result = Vec::new();
    for m in &monitors {
        result.push(MonitorInfo {
            id: m.id().map_err(|e| format!("Monitor id error: {e}"))?,
            name: m.name().map_err(|e| format!("Monitor name error: {e}"))?,
            x: m.x().map_err(|e| format!("Monitor x error: {e}"))?,
            y: m.y().map_err(|e| format!("Monitor y error: {e}"))?,
            width: m.width().map_err(|e| format!("Monitor width error: {e}"))?,
            height: m.height().map_err(|e| format!("Monitor height error: {e}"))?,
            is_primary: m.is_primary().unwrap_or(false),
        });
    }
    Ok(result)
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
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create screenshots dir: {e}"))?;
    Ok(dir)
}

/// Generate a timestamped filename for a screenshot.
fn screenshot_filename() -> String {
    let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S_%3f");
    format!("{ts}.png")
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

    cropped
        .save(&abs_path)
        .map_err(|e| format!("Failed to save screenshot: {e}"))?;

    let rel_path = format!(".cutready/screenshots/{filename}");
    Ok(rel_path)
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

    img.save(&abs_path)
        .map_err(|e| format!("Failed to save screenshot: {e}"))?;

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
    let img = image::open(&source_abs)
        .map_err(|e| format!("Failed to open source image: {e}"))?;

    let cropped = image::imageops::crop_imm(&img, x, y, width, height).to_image();

    let dir = screenshots_dir(project_dir)?;
    let filename = screenshot_filename();
    let abs_path = dir.join(&filename);

    cropped
        .save(&abs_path)
        .map_err(|e| format!("Failed to save cropped screenshot: {e}"))?;

    let rel_path = format!(".cutready/screenshots/{filename}");
    Ok(rel_path)
}
