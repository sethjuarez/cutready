//! Tauri commands for screen capture.

use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::util::screenshot;
use crate::AppState;

/// Capture params shared between main window and capture window via managed state.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct CaptureParams {
    pub monitor_id: u32,
    pub monitor_w: u32,
    pub monitor_h: u32,
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub bg_path: String,
    pub project_root: String,
}

/// Thread-safe wrapper for capture parameters.
pub struct CaptureState(pub Mutex<Option<CaptureParams>>);

fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

#[tauri::command]
pub async fn list_monitors() -> Result<Vec<screenshot::MonitorInfo>, String> {
    eprintln!("[CAPTURE] list_monitors called");
    let result = screenshot::list_monitors();
    match &result {
        Ok(mons) => eprintln!("[CAPTURE] list_monitors: found {} monitors", mons.len()),
        Err(e) => eprintln!("[CAPTURE] list_monitors FAILED: {}", e),
    }
    result
}

#[tauri::command]
pub async fn capture_region(
    monitor_id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    screenshot::capture_region(&root, monitor_id, x, y, width, height)
}

#[tauri::command]
pub async fn capture_fullscreen(
    monitor_id: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    eprintln!("[CAPTURE] capture_fullscreen: monitor_id={}", monitor_id);
    let root = project_root(&state)?;
    let result = screenshot::capture_fullscreen(&root, monitor_id);
    match &result {
        Ok(path) => eprintln!("[CAPTURE] capture_fullscreen OK: {}", path),
        Err(e) => eprintln!("[CAPTURE] capture_fullscreen FAILED: {}", e),
    }
    result
}

/// Get capture params (called by the capture window on mount).
#[tauri::command]
pub async fn get_capture_params(
    state: State<'_, CaptureState>,
) -> Result<CaptureParams, String> {
    eprintln!("[CAPTURE] get_capture_params called");
    let params = state.0.lock().map_err(|e| e.to_string())?;
    params.clone().ok_or_else(|| "No capture params set".to_string())
}

/// Open a borderless, always-on-top capture window covering the target monitor.
#[tauri::command]
pub async fn open_capture_window(
    app: tauri::AppHandle,
    monitor_id: u32,
    phys_x: i32,
    phys_y: i32,
    phys_w: u32,
    phys_h: u32,
    bg_path: String,
    project_root: String,
) -> Result<(), String> {
    eprintln!("[CAPTURE] open_capture_window: monitor={} pos=({},{}) size={}x{}", monitor_id, phys_x, phys_y, phys_w, phys_h);

    // Store params in managed state for the capture window to read
    {
        let capture_state = app.state::<CaptureState>();
        let mut params = capture_state.0.lock().map_err(|e| e.to_string())?;
        *params = Some(CaptureParams {
            monitor_id,
            monitor_w: phys_w,
            monitor_h: phys_h,
            monitor_x: phys_x,
            monitor_y: phys_y,
            bg_path,
            project_root,
        });
    }

    // Destroy any existing capture window first
    if let Some(existing) = app.get_webview_window("capture") {
        eprintln!("[CAPTURE] destroying existing capture window");
        let _ = existing.destroy();
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // Find matching Tauri monitor by physical position to get scale factor
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let scale = monitors
        .iter()
        .find(|m| {
            let pos = m.position();
            (pos.x - phys_x).abs() < 100 && (pos.y - phys_y).abs() < 100
        })
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    let logical_w = phys_w as f64 / scale;
    let logical_h = phys_h as f64 / scale;
    let logical_x = phys_x as f64 / scale;
    let logical_y = phys_y as f64 / scale;
    eprintln!("[CAPTURE] logical pos=({},{}) size={}x{} scale={}", logical_x, logical_y, logical_w, logical_h, scale);

    // Use initialization_script for mode flag; params via invoke("get_capture_params").
    // WebviewUrl::App("index.html") hits Tauri's special case (uses base URL directly).
    let win = WebviewWindowBuilder::new(&app, "capture", WebviewUrl::App("index.html".into()))
        .initialization_script("window.__IS_CAPTURE = true;")
        .title("CutReady Capture")
        .inner_size(logical_w, logical_h)
        .position(logical_x, logical_y)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .focused(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| {
            eprintln!("[CAPTURE] build FAILED: {}", e);
            e.to_string()
        })?;

    eprintln!("[CAPTURE] window created OK, label={}", win.label());
    Ok(())
}

/// Close the capture overlay window.
#[tauri::command]
pub async fn close_capture_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("capture") {
        eprintln!("[CAPTURE] close_capture_window: destroying");
        win.destroy().map_err(|e| e.to_string())?;
    } else {
        eprintln!("[CAPTURE] close_capture_window: no window found");
    }
    Ok(())
}

/// Crop a region from an already-captured screenshot (avoids re-capturing the monitor).
#[tauri::command]
pub async fn crop_screenshot(
    source_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let root = project_root(&state)?;
    screenshot::crop_screenshot(&root, &source_path, x, y, width, height)
}
