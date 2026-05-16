//! Tauri commands for screen capture.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    Manager, PhysicalPosition, PhysicalSize, Position, Size, State, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_store::StoreExt;

use crate::engine::recording;
use crate::util::screenshot;
use crate::AppState;

const UI_STORE_FILE: &str = "ui-settings.json";
const RECORDING_CONTROL_POSITION_KEY: &str = "recording_control_position";
const RECORDING_CONTROL_WIDTH: f64 = 420.0;
const RECORDING_CONTROL_HEIGHT: f64 = 220.0;
const RECORDER_SETUP_WIDTH: f64 = 890.0;
const RECORDER_SETUP_HEIGHT: f64 = 260.0;

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

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct RecordingCountdownParams {
    pub monitor_id: u32,
    pub monitor_w: u32,
    pub monitor_h: u32,
    pub monitor_x: i32,
    pub monitor_y: i32,
    pub countdown_seconds: u8,
    pub document_title: String,
}

pub struct RecordingCountdownState(pub Mutex<Option<RecordingCountdownParams>>);

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct RecordingControlParams {
    #[serde(default)]
    pub take_id: Option<String>,
    pub document_title: String,
    #[serde(default)]
    pub scope: Option<recording::RecordingScope>,
}

pub struct RecordingControlState(pub Mutex<Option<RecordingControlParams>>);

#[derive(Clone, Serialize, Deserialize)]
pub struct RecordingPrompterParams {
    pub document_title: String,
    pub script: recording::PrompterScript,
    #[serde(default)]
    pub read_mode: bool,
    #[serde(default)]
    pub monitor_x: i32,
    #[serde(default)]
    pub monitor_y: i32,
    #[serde(default)]
    pub monitor_w: u32,
    #[serde(default)]
    pub monitor_h: u32,
}

pub struct RecordingPrompterState(pub Mutex<Option<RecordingPrompterParams>>);

#[derive(Clone, Serialize, Deserialize)]
pub struct RecordingControlPosition {
    pub x: i32,
    pub y: i32,
}

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

/// Capture all specified monitors in parallel.
/// Returns a map of monitor_id → relative screenshot path.
#[tauri::command]
pub async fn capture_all_monitors(
    monitor_ids: Vec<u32>,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<u32, String>, String> {
    eprintln!("[CAPTURE] capture_all_monitors: {:?}", monitor_ids);
    let root = project_root(&state)?;
    let result = screenshot::capture_all_monitors(&root, &monitor_ids);
    match &result {
        Ok(map) => eprintln!("[CAPTURE] capture_all_monitors OK: {} results", map.len()),
        Err(e) => eprintln!("[CAPTURE] capture_all_monitors FAILED: {}", e),
    }
    result
}

/// Get capture params (called by the capture window on mount).
#[tauri::command]
pub async fn get_capture_params(state: State<'_, CaptureState>) -> Result<CaptureParams, String> {
    eprintln!("[CAPTURE] get_capture_params called");
    let params = state.0.lock().map_err(|e| e.to_string())?;
    params
        .clone()
        .ok_or_else(|| "No capture params set".to_string())
}

#[tauri::command]
pub async fn get_recording_countdown_params(
    state: State<'_, RecordingCountdownState>,
) -> Result<RecordingCountdownParams, String> {
    let params = state.0.lock().map_err(|e| e.to_string())?;
    params
        .clone()
        .ok_or_else(|| "No recording countdown params set".to_string())
}

#[tauri::command]
pub async fn get_recording_control_params(
    state: State<'_, RecordingControlState>,
) -> Result<RecordingControlParams, String> {
    let params = state.0.lock().map_err(|e| e.to_string())?;
    params
        .clone()
        .ok_or_else(|| "No recording control params set".to_string())
}

/// Open a borderless, always-on-top capture window covering the target monitor.
#[allow(clippy::too_many_arguments)]
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
    eprintln!(
        "[CAPTURE] open_capture_window: monitor={} pos=({},{}) size={}x{}",
        monitor_id, phys_x, phys_y, phys_w, phys_h
    );

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
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
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
    eprintln!(
        "[CAPTURE] logical pos=({},{}) size={}x{} scale={}",
        logical_x, logical_y, logical_w, logical_h, scale
    );

    // Use initialization_script for mode flag; params via invoke("get_capture_params").
    // WebviewUrl::App("index.html") hits Tauri's special case (uses base URL directly).
    let win = WebviewWindowBuilder::new(&app, "capture", WebviewUrl::App("index.html".into()))
        .initialization_script("window.__IS_CAPTURE = true;")
        .title("CutReady Capture")
        .inner_size(logical_w, logical_h)
        .position(logical_x, logical_y)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .resizable(false)
        .focused(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| {
            eprintln!("[CAPTURE] build FAILED: {}", e);
            e.to_string()
        })?;
    fit_window_extended_frame_to_physical_bounds(&win, phys_x, phys_y, phys_w, phys_h);

    eprintln!("[CAPTURE] window created OK, label={}", win.label());
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn open_recording_countdown_window(
    app: tauri::AppHandle,
    monitor_id: u32,
    phys_x: i32,
    phys_y: i32,
    phys_w: u32,
    phys_h: u32,
    countdown_seconds: u8,
    document_title: String,
) -> Result<(), String> {
    log::info!(
        "[recording] open countdown window: monitor={} pos=({},{}) size={}x{} countdown={}",
        monitor_id,
        phys_x,
        phys_y,
        phys_w,
        phys_h,
        countdown_seconds
    );

    {
        let countdown_state = app.state::<RecordingCountdownState>();
        let mut params = countdown_state.0.lock().map_err(|e| e.to_string())?;
        *params = Some(RecordingCountdownParams {
            monitor_id,
            monitor_w: phys_w,
            monitor_h: phys_h,
            monitor_x: phys_x,
            monitor_y: phys_y,
            countdown_seconds,
            document_title,
        });
    }

    if let Some(existing) = app.get_webview_window("recording-countdown") {
        let _ = existing.destroy();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

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

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(
        &app,
        "recording-countdown",
        WebviewUrl::App("index.html".into()),
    )
    .initialization_script("window.__IS_RECORDING_COUNTDOWN = true;")
    .title("CutReady Recording Countdown")
    .inner_size(logical_w, logical_h)
    .position(logical_x, logical_y)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .resizable(false)
    .focused(true)
    .skip_taskbar(true);
    #[cfg(target_os = "windows")]
    {
        builder = builder.transparent(true);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    fit_window_extended_frame_to_physical_bounds(&win, phys_x, phys_y, phys_w, phys_h);

    let app_handle = app.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let state = app_handle.state::<RecordingCountdownState>();
            let lock_result = state.0.lock();
            if let Ok(mut params) = lock_result {
                *params = None;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn open_recording_control_window(
    app: tauri::AppHandle,
    take_id: String,
    document_title: String,
) -> Result<(), String> {
    {
        let control_state = app.state::<RecordingControlState>();
        let mut params = control_state.0.lock().map_err(|e| e.to_string())?;
        *params = Some(RecordingControlParams {
            take_id: Some(take_id),
            document_title,
            scope: None,
        });
    }

    if let Some(existing) = app.get_webview_window("recording-control") {
        let _ = existing.destroy();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    let (logical_x, logical_y) = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let scale = monitor.scale_factor();
            (
                (position.x as f64 + size.width as f64
                    - RECORDING_CONTROL_WIDTH * scale
                    - 24.0 * scale)
                    / scale,
                (position.y as f64 + size.height as f64
                    - RECORDING_CONTROL_HEIGHT * scale
                    - 48.0 * scale)
                    / scale,
            )
        })
        .unwrap_or((80.0, 80.0));

    let win = WebviewWindowBuilder::new(
        &app,
        "recording-control",
        WebviewUrl::App("index.html".into()),
    )
    .initialization_script("window.__IS_RECORDING_CONTROL = true;")
    .title("CutReady Recording")
    .inner_size(RECORDING_CONTROL_WIDTH, RECORDING_CONTROL_HEIGHT)
    .position(logical_x, logical_y)
    .decorations(false)
    .always_on_top(true)
    .resizable(false)
    .focused(false)
    .skip_taskbar(false)
    .build()
    .map_err(|e| e.to_string())?;
    exclude_window_from_capture(&win);

    if let Some(position) = get_saved_recording_control_position(&app) {
        let _ = win.set_position(Position::Physical(PhysicalPosition {
            x: position.x,
            y: position.y,
        }));
    }

    let app_handle = app.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let state = app_handle.state::<RecordingControlState>();
            let lock_result = state.0.lock();
            if let Ok(mut params) = lock_result {
                *params = None;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn open_recorder_window(
    app: tauri::AppHandle,
    scope: recording::RecordingScope,
    document_title: String,
) -> Result<(), String> {
    {
        let control_state = app.state::<RecordingControlState>();
        let mut params = control_state.0.lock().map_err(|e| e.to_string())?;
        *params = Some(RecordingControlParams {
            take_id: None,
            document_title,
            scope: Some(scope),
        });
    }

    if let Some(existing) = app.get_webview_window("recording-control") {
        let _ = existing.destroy();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    let (logical_x, logical_y) = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let scale = monitor.scale_factor();
            (
                (position.x as f64 + size.width as f64
                    - RECORDER_SETUP_WIDTH * scale
                    - 24.0 * scale)
                    / scale,
                (position.y as f64 + 64.0 * scale) / scale,
            )
        })
        .unwrap_or((80.0, 80.0));

    let win = WebviewWindowBuilder::new(
        &app,
        "recording-control",
        WebviewUrl::App("index.html".into()),
    )
    .initialization_script("window.__IS_RECORDING_CONTROL = true;")
    .title("CutReady Recorder")
    .inner_size(RECORDER_SETUP_WIDTH, RECORDER_SETUP_HEIGHT)
    .min_inner_size(870.0, 250.0)
    .position(logical_x, logical_y)
    .decorations(false)
    .always_on_top(true)
    .resizable(true)
    .focused(true)
    .skip_taskbar(false)
    .build()
    .map_err(|e| e.to_string())?;
    exclude_window_from_capture(&win);

    if let Some(position) = get_saved_recording_control_position(&app) {
        let _ = win.set_position(Position::Physical(PhysicalPosition {
            x: position.x,
            y: position.y,
        }));
    }

    let app_handle = app.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let state = app_handle.state::<RecordingControlState>();
            let lock_result = state.0.lock();
            if let Ok(mut params) = lock_result {
                *params = None;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn get_recording_prompter_params(
    state: State<'_, RecordingPrompterState>,
) -> Result<RecordingPrompterParams, String> {
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "No recording prompter params set".to_string())
}

#[tauri::command]
pub async fn open_recording_prompter_window(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scope: recording::RecordingScope,
    document_title: String,
    phys_x: i32,
    phys_y: i32,
    phys_w: u32,
    phys_h: u32,
    read_mode: bool,
) -> Result<(), String> {
    let root = project_root(&state)?;
    let script = recording::build_prompter_script(&root, &scope).map_err(|e| e.to_string())?;
    if script.steps.is_empty() {
        return Err("No narrative or action text found for the prompter".to_string());
    }

    if let Some(existing) = app.get_webview_window("recording-prompter") {
        let _ = existing.destroy();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    {
        let prompter_state = app.state::<RecordingPrompterState>();
        let mut params = prompter_state.0.lock().map_err(|e| e.to_string())?;
        *params = Some(RecordingPrompterParams {
            document_title,
            script,
            read_mode,
            monitor_x: phys_x,
            monitor_y: phys_y,
            monitor_w: phys_w,
            monitor_h: phys_h,
        });
    }

    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let scale = monitors
        .iter()
        .find(|m| {
            let pos = m.position();
            (pos.x - phys_x).abs() < 100 && (pos.y - phys_y).abs() < 100
        })
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    let monitor_w = phys_w as f64 / scale;
    let monitor_h = phys_h as f64 / scale;
    let logical_w = (monitor_w * 0.22).clamp(280.0, 380.0);
    let logical_h = monitor_h;
    let logical_x = phys_x as f64 / scale + monitor_w - logical_w;
    let logical_y = phys_y as f64 / scale;

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(
        &app,
        "recording-prompter",
        WebviewUrl::App("index.html".into()),
    )
    .initialization_script("window.__IS_RECORDING_PROMPTER = true;")
    .title("CutReady Prompter")
    .inner_size(logical_w, logical_h)
    .min_inner_size(240.0, 280.0)
    .position(logical_x, logical_y)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .resizable(true)
    .focused(!read_mode)
    .skip_taskbar(true);
    #[cfg(target_os = "windows")]
    {
        builder = builder.transparent(true);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    exclude_window_from_capture(&win);
    if read_mode {
        let _ = win.set_ignore_cursor_events(true);
    }

    let app_handle = app.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let state = app_handle.state::<RecordingPrompterState>();
            let lock_result = state.0.lock();
            if let Ok(mut params) = lock_result {
                *params = None;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn close_recording_prompter_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("recording-prompter") {
        win.destroy().map_err(|e| e.to_string())?;
    }
    if let Ok(mut params) = app.state::<RecordingPrompterState>().0.lock() {
        *params = None;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn exclude_window_from_capture(win: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };

    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn exclude_window_from_capture(_win: &tauri::WebviewWindow) {}

fn set_physical_bounds(win: &tauri::WebviewWindow, x: i32, y: i32, width: u32, height: u32) {
    let _ = win.set_position(Position::Physical(PhysicalPosition { x, y }));
    let _ = win.set_size(Size::Physical(PhysicalSize { width, height }));
}

#[cfg(target_os = "windows")]
fn fit_window_extended_frame_to_physical_bounds(
    win: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    set_physical_bounds(win, x, y, width, height);

    let Ok(hwnd) = win.hwnd() else {
        return;
    };

    let mut window_rect = RECT::default();
    let mut frame_rect = RECT::default();
    let got_bounds = unsafe {
        GetWindowRect(hwnd, &mut window_rect).is_ok()
            && DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut frame_rect as *mut _ as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_ok()
    };

    if !got_bounds {
        return;
    }

    let left_inset = frame_rect.left - window_rect.left;
    let top_inset = frame_rect.top - window_rect.top;
    let right_inset = window_rect.right - frame_rect.right;
    let bottom_inset = window_rect.bottom - frame_rect.bottom;

    if left_inset == 0 && top_inset == 0 && right_inset == 0 && bottom_inset == 0 {
        return;
    }

    let outer_width = (width as i32 + left_inset + right_inset).max(1) as u32;
    let outer_height = (height as i32 + top_inset + bottom_inset).max(1) as u32;
    set_physical_bounds(
        win,
        x - left_inset,
        y - top_inset,
        outer_width,
        outer_height,
    );
}

#[cfg(not(target_os = "windows"))]
fn fit_window_extended_frame_to_physical_bounds(
    win: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) {
    set_physical_bounds(win, x, y, width, height);
}

#[tauri::command]
pub async fn save_recording_control_position(
    app: tauri::AppHandle,
    position: RecordingControlPosition,
) -> Result<(), String> {
    let store = app.store(UI_STORE_FILE).map_err(|e| e.to_string())?;
    store.set(
        RECORDING_CONTROL_POSITION_KEY,
        serde_json::to_value(position).map_err(|e| e.to_string())?,
    );
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

fn get_saved_recording_control_position(
    app: &tauri::AppHandle,
) -> Option<RecordingControlPosition> {
    let store = app.store(UI_STORE_FILE).ok()?;
    store
        .get(RECORDING_CONTROL_POSITION_KEY)
        .and_then(|value| serde_json::from_value(value).ok())
}

/// Open a fullscreen preview window on the primary monitor.
///
/// On macOS, uses native fullscreen (hides menu bar + dock) for a PowerPoint-style
/// presentation experience. On Windows, uses borderless manual positioning.
/// If phys dimensions are all zero, auto-detects primary monitor size.
#[tauri::command]
pub async fn open_preview_window(
    app: tauri::AppHandle,
    phys_x: i32,
    phys_y: i32,
    phys_w: u32,
    phys_h: u32,
) -> Result<(), String> {
    eprintln!(
        "[PREVIEW] open_preview_window: pos=({},{}) size={}x{}",
        phys_x, phys_y, phys_w, phys_h
    );

    // Destroy any existing preview window first
    if let Some(existing) = app.get_webview_window("preview") {
        eprintln!("[PREVIEW] destroying existing preview window");
        let _ = existing.destroy();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    // Use Tauri's own monitor API to determine size/position if not provided
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let target_monitor = if phys_w > 0 && phys_h > 0 {
        monitors.iter().find(|m| {
            let pos = m.position();
            (pos.x - phys_x).abs() < 100 && (pos.y - phys_y).abs() < 100
        })
    } else {
        None
    };
    let primary = app.primary_monitor().map_err(|e| e.to_string())?;
    let monitor = target_monitor.or(primary.as_ref()).or(monitors.first());

    let (scale, logical_w, logical_h, logical_x, logical_y) = if let Some(m) = monitor {
        let s = m.scale_factor();
        let size = m.size();
        let pos = m.position();
        (s, size.width as f64 / s, size.height as f64 / s, pos.x as f64 / s, pos.y as f64 / s)
    } else if phys_w > 0 {
        (1.0, phys_w as f64, phys_h as f64, phys_x as f64, phys_y as f64)
    } else {
        (1.0, 1920.0, 1080.0, 0.0, 0.0)
    };

    eprintln!(
        "[PREVIEW] logical pos=({},{}) size={}x{} scale={}",
        logical_x, logical_y, logical_w, logical_h, scale
    );

    #[cfg(target_os = "macos")]
    {
        // macOS: use native fullscreen for PowerPoint-style presentation
        let win =
            WebviewWindowBuilder::new(&app, "preview", WebviewUrl::App("index.html".into()))
                .initialization_script("window.__IS_PREVIEW = true;")
                .title("CutReady Preview")
                .inner_size(logical_w, logical_h)
                .position(logical_x, logical_y)
                .focused(true)
                .build()
                .map_err(|e| {
                    eprintln!("[PREVIEW] build FAILED: {}", e);
                    e.to_string()
                })?;
        win.set_fullscreen(true).map_err(|e| e.to_string())?;
        eprintln!("[PREVIEW] macOS fullscreen window created OK, label={}", win.label());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let win =
            WebviewWindowBuilder::new(&app, "preview", WebviewUrl::App("index.html".into()))
                .initialization_script("window.__IS_PREVIEW = true;")
                .title("CutReady Preview")
                .inner_size(logical_w, logical_h)
                .position(logical_x, logical_y)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .focused(true)
                .skip_taskbar(true)
                .build()
                .map_err(|e| {
                    eprintln!("[PREVIEW] build FAILED: {}", e);
                    e.to_string()
                })?;
        fit_window_extended_frame_to_physical_bounds(&win, phys_x, phys_y, phys_w, phys_h);
        eprintln!("[PREVIEW] window created OK, label={}", win.label());
    }

    Ok(())
}

/// Close the preview window.
#[tauri::command]
pub async fn close_preview_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("preview") {
        eprintln!("[PREVIEW] close_preview_window: destroying");
        win.destroy().map_err(|e| e.to_string())?;
    } else {
        eprintln!("[PREVIEW] close_preview_window: no window found");
    }
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

#[tauri::command]
pub async fn close_recording_countdown_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("recording-countdown") {
        win.destroy().map_err(|e| e.to_string())?;
    }
    if let Ok(mut params) = app.state::<RecordingCountdownState>().0.lock() {
        *params = None;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_recording_control_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("recording-control") {
        win.destroy().map_err(|e| e.to_string())?;
    }
    if let Ok(mut params) = app.state::<RecordingControlState>().0.lock() {
        *params = None;
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
