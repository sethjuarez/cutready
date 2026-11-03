//! Deep-link (`cutready://`) wiring for app setup.

use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;

/// Registers the URL scheme and forwards launch and runtime deep links to the
/// webview as `deep-link-received` events.
pub fn setup(app: &tauri::App) {
    // Register URL scheme handler on Windows/Linux
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    {
        let _ = app.deep_link().register_all();
    }

    // Check if the app was launched via a deep link URL. Defer the emit so
    // the webview JS event system is initialized first.
    {
        let handle = app.handle().clone();
        if let Ok(Some(urls)) = app.deep_link().get_current() {
            let url_strings: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
            if !url_strings.is_empty() {
                crate::util::spawn::spawn_named("deep-link-replay", async move {
                    // Give the webview time to initialize its event listeners
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    for url_str in url_strings {
                        let _ = handle.emit("deep-link-received", url_str);
                    }
                });
            }
        }
    }

    // Listen for URLs arriving while the app is running (macOS)
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let _ = handle.emit("deep-link-received", url.to_string());
        }
    });
}
