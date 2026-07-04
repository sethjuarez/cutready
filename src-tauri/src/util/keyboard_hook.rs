#[cfg(target_os = "windows")]
mod windows_hook {
    use std::{
        collections::HashMap,
        ffi::c_void,
        sync::{LazyLock, Mutex},
    };

    use windows::Win32::{
        Foundation::{LPARAM, LRESULT, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Input::KeyboardAndMouse::GetAsyncKeyState,
            WindowsAndMessaging::{
                CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
                UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN,
                WM_QUIT, WM_SYSKEYDOWN,
            },
        },
    };

    const MOD_CTRL: u8 = 0x01;
    const MOD_SHIFT: u8 = 0x02;
    const MOD_ALT: u8 = 0x04;
    const MOD_WIN: u8 = 0x08;

    type HookKey = (u32, u8);
    type HookCallback = Box<dyn Fn() + Send + 'static>;

    struct SendHook(HHOOK);
    unsafe impl Send for SendHook {}

    struct HookState {
        bindings: HashMap<HookKey, HookCallback>,
        hook_handle: Option<SendHook>,
        thread_id: Option<u32>,
        thread_started: bool,
    }

    static HOOK_STATE: LazyLock<Mutex<HookState>> = LazyLock::new(|| {
        Mutex::new(HookState {
            bindings: HashMap::new(),
            hook_handle: None,
            thread_id: None,
            thread_started: false,
        })
    });

    fn parse_accelerator(accelerator: &str) -> Option<HookKey> {
        let parts: Vec<&str> = accelerator.split('+').map(str::trim).collect();
        let mut modifiers = 0;
        let mut key = "";

        for part in parts {
            match part.to_ascii_lowercase().as_str() {
                "ctrl" | "control" | "cmdorcontrol" | "commandorcontrol" => modifiers |= MOD_CTRL,
                "shift" => modifiers |= MOD_SHIFT,
                "alt" | "option" => modifiers |= MOD_ALT,
                "super" | "meta" | "cmd" | "command" => modifiers |= MOD_WIN,
                _ => key = part,
            }
        }

        Some((key_to_virtual_key(key)?, modifiers))
    }

    fn key_to_virtual_key(key: &str) -> Option<u32> {
        let lower = key.to_ascii_lowercase();

        if lower.len() == 1 {
            let ch = lower.chars().next()?.to_ascii_uppercase();
            if ch.is_ascii_alphanumeric() {
                return Some(ch as u32);
            }
        }

        if let Some(num) = lower
            .strip_prefix("f")
            .and_then(|value| value.parse::<u32>().ok())
        {
            if (1..=24).contains(&num) {
                return Some(0x6f + num);
            }
        }

        if let Some(num) = lower
            .strip_prefix("num")
            .or_else(|| lower.strip_prefix("numpad"))
            .and_then(|value| value.parse::<u32>().ok())
        {
            if num <= 9 {
                return Some(0x60 + num);
            }
        }

        match lower.as_str() {
            "space" => Some(0x20),
            "enter" | "return" => Some(0x0D),
            "tab" => Some(0x09),
            "escape" | "esc" => Some(0x1B),
            "backspace" => Some(0x08),
            "delete" => Some(0x2E),
            "insert" => Some(0x2D),
            "home" => Some(0x24),
            "end" => Some(0x23),
            "pageup" => Some(0x21),
            "pagedown" => Some(0x22),
            "arrowup" | "up" => Some(0x26),
            "arrowdown" | "down" => Some(0x28),
            "arrowleft" | "left" => Some(0x25),
            "arrowright" | "right" => Some(0x27),
            "bracketleft" | "[" => Some(0xDB),
            "bracketright" | "]" => Some(0xDD),
            "minus" | "-" => Some(0xBD),
            "equal" | "=" => Some(0xBB),
            "comma" | "," => Some(0xBC),
            "period" | "." => Some(0xBE),
            "slash" | "/" => Some(0xBF),
            "backslash" | "\\" => Some(0xDC),
            "quote" | "'" => Some(0xDE),
            "semicolon" | ";" => Some(0xBA),
            "backquote" | "`" => Some(0xC0),
            _ => None,
        }
    }

    fn current_modifiers() -> u8 {
        let mut modifiers = 0;
        unsafe {
            if GetAsyncKeyState(0xA2) < 0 || GetAsyncKeyState(0xA3) < 0 {
                modifiers |= MOD_CTRL;
            }
            if GetAsyncKeyState(0xA0) < 0 || GetAsyncKeyState(0xA1) < 0 {
                modifiers |= MOD_SHIFT;
            }
            if GetAsyncKeyState(0xA4) < 0 || GetAsyncKeyState(0xA5) < 0 {
                modifiers |= MOD_ALT;
            }
            if GetAsyncKeyState(0x5B) < 0 || GetAsyncKeyState(0x5C) < 0 {
                modifiers |= MOD_WIN;
            }
        }
        modifiers
    }

    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let message = wparam.0 as u32;
            if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                let event = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                let key = (event.vkCode, current_modifiers());

                if let Ok(state) = HOOK_STATE.try_lock() {
                    if let Some(callback) = state.bindings.get(&key) {
                        callback();
                    }
                }
            }
        }

        CallNextHookEx(
            Some(HHOOK(std::ptr::null_mut() as *mut c_void)),
            code,
            wparam,
            lparam,
        )
    }

    fn ensure_hook_thread() -> Result<(), String> {
        let mut state = HOOK_STATE
            .lock()
            .map_err(|error| format!("Keyboard hook lock error: {error}"))?;
        if state.thread_started {
            return Ok(());
        }

        state.thread_started = true;
        std::thread::Builder::new()
            .name("cutready-presentation-hotkeys".to_string())
            .spawn(|| {
                let thread_id = unsafe { GetCurrentThreadId() };
                let hook =
                    match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) } {
                        Ok(hook) => hook,
                        Err(error) => {
                            tracing::warn!(
                                target: "cutready::hotkeys",
                                error = %error,
                                "Failed to install Windows presentation keyboard hook",
                            );
                            if let Ok(mut state) = HOOK_STATE.lock() {
                                state.thread_started = false;
                            }
                            return;
                        }
                    };

                if let Ok(mut state) = HOOK_STATE.lock() {
                    state.hook_handle = Some(SendHook(hook));
                    state.thread_id = Some(thread_id);
                }

                tracing::info!(
                    target: "cutready::hotkeys",
                    "Installed Windows presentation keyboard hook",
                );

                let mut message = MSG::default();
                while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
                    // Pump messages to keep the low-level keyboard hook active.
                }

                if let Ok(mut state) = HOOK_STATE.lock() {
                    state.hook_handle = None;
                    state.thread_id = None;
                    state.thread_started = false;
                }
            })
            .map_err(|error| format!("Failed to start keyboard hook thread: {error}"))?;

        Ok(())
    }

    pub fn register(accelerator: &str, callback: HookCallback) -> Result<(), String> {
        let key = parse_accelerator(accelerator)
            .ok_or_else(|| format!("Could not parse presentation hotkey: {accelerator}"))?;
        ensure_hook_thread()?;

        let mut state = HOOK_STATE
            .lock()
            .map_err(|error| format!("Keyboard hook lock error: {error}"))?;
        state.bindings.insert(key, callback);
        Ok(())
    }

    pub fn clear() {
        let (hook, thread_id) = if let Ok(mut state) = HOOK_STATE.lock() {
            state.bindings.clear();
            state.thread_started = false;
            (state.hook_handle.take(), state.thread_id.take())
        } else {
            (None, None)
        };

        if let Some(SendHook(hook)) = hook {
            if let Err(error) = unsafe { UnhookWindowsHookEx(hook) } {
                tracing::warn!(
                    target: "cutready::hotkeys",
                    error = %error,
                    "Failed to uninstall Windows presentation keyboard hook",
                );
            }
        }

        if let Some(thread_id) = thread_id {
            if let Err(error) =
                unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) }
            {
                tracing::warn!(
                    target: "cutready::hotkeys",
                    error = %error,
                    "Failed to stop Windows presentation keyboard hook thread",
                );
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn register(accelerator: &str, callback: Box<dyn Fn() + Send + 'static>) -> Result<(), String> {
    windows_hook::register(accelerator, callback)
}

#[cfg(not(target_os = "windows"))]
pub fn register(
    _accelerator: &str,
    _callback: Box<dyn Fn() + Send + 'static>,
) -> Result<(), String> {
    Err("Low-level keyboard hooks are only available on Windows.".to_string())
}

#[cfg(target_os = "windows")]
pub fn clear() {
    windows_hook::clear();
}

#[cfg(not(target_os = "windows"))]
pub fn clear() {}
