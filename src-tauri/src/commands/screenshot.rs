//! Tauri commands for screen capture.

use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::util::screenshot;
use crate::AppState;

fn project_root(state: &AppState) -> Result<std::path::PathBuf, String> {
    let current = state.current_project.lock().map_err(|e| e.to_string())?;
    let view = current.as_ref().ok_or("No project is currently open")?;
    Ok(view.root.clone())
}

#[tauri::command]
pub async fn list_monitors() -> Result<Vec<screenshot::MonitorInfo>, String> {
    screenshot::list_monitors()
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
    let root = project_root(&state)?;
    screenshot::capture_fullscreen(&root, monitor_id)
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
    // Close any existing capture window first
    if let Some(existing) = app.get_webview_window("capture") {
        let _ = existing.close();
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

    // Encode params into query string
    let bg_enc = urlencoding::encode(&bg_path);
    let root_enc = urlencoding::encode(&project_root);
    let url = format!(
        "index.html?mode=capture&monitorId={}&mw={}&mh={}&mx={}&my={}&bg={}&root={}",
        monitor_id, phys_w, phys_h, phys_x, phys_y, bg_enc, root_enc
    );

    WebviewWindowBuilder::new(&app, "capture", WebviewUrl::App(url.into()))
        .title("CutReady Capture")
        .inner_size(logical_w, logical_h)
        .position(logical_x, logical_y)
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .focused(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Close the capture overlay window.
#[tauri::command]
pub async fn close_capture_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("capture") {
        win.close().map_err(|e| e.to_string())?;
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
