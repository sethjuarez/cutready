//! Whether Auditaur diagnostics run, decided once at startup from the build,
//! environment flags and the persisted feedback setting.

use std::fs;

const CUTREADY_DIAGNOSTICS_ENV: &str = "CUTREADY_DIAGNOSTICS";
const AUDITAUR_ENV: &str = "AUDITAUR";
const SETTINGS_FILE: &str = "settings.json";
const AUDITAUR_DIAGNOSTICS_SETTING: &str = "auditaurDiagnosticsEnabled";

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct AuditaurDiagnosticsPolicy {
    pub enabled: bool,
    pub release_build: bool,
    pub source: &'static str,
    pub startup_flag_enabled: bool,
    pub auditaur_flag_enabled: bool,
    pub persisted_setting_enabled: Option<bool>,
    pub settings_path: Option<String>,
}

pub(crate) fn configure_auditaur_startup() -> AuditaurDiagnosticsPolicy {
    let startup_flag_enabled = env_flag(CUTREADY_DIAGNOSTICS_ENV);
    let auditaur_flag_enabled = env_flag(AUDITAUR_ENV);
    let (persisted_setting_enabled, settings_path) = read_persisted_auditaur_setting();
    let debug_build = cfg!(debug_assertions);
    let enabled = debug_build
        || startup_flag_enabled
        || auditaur_flag_enabled
        || persisted_setting_enabled == Some(true);
    let source = if debug_build {
        "debug-build"
    } else if startup_flag_enabled {
        "CUTREADY_DIAGNOSTICS"
    } else if auditaur_flag_enabled {
        "AUDITAUR"
    } else if persisted_setting_enabled == Some(true) {
        "feedback-setting"
    } else {
        "disabled"
    };

    if enabled {
        std::env::set_var(AUDITAUR_ENV, "1");
    }

    AuditaurDiagnosticsPolicy {
        enabled,
        release_build: !debug_build,
        source,
        startup_flag_enabled,
        auditaur_flag_enabled,
        persisted_setting_enabled,
        settings_path: settings_path.map(|path| path.display().to_string()),
    }
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn read_persisted_auditaur_setting() -> (Option<bool>, Option<std::path::PathBuf>) {
    let settings_path =
        dirs::data_dir().map(|data_dir| data_dir.join("com.cutready.app").join(SETTINGS_FILE));
    let Some(settings_path) = settings_path else {
        return (None, None);
    };
    let setting = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|settings| {
            settings
                .get(AUDITAUR_DIAGNOSTICS_SETTING)
                .and_then(|value| value.as_bool())
        });
    (setting, Some(settings_path))
}

