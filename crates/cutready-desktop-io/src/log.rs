use cutready_core::{Log, LogLevel};

/// Forwards core diagnostics to `tracing`, so they reach the app's
/// subscribers (log files, Auditaur) like any other backend trace.
#[derive(Debug, Default, Clone, Copy)]
pub struct TracingLog;

impl Log for TracingLog {
    fn log(&self, level: LogLevel, target: &str, message: &str) {
        match level {
            LogLevel::Debug => tracing::debug!(core_target = target, "{message}"),
            LogLevel::Info => tracing::info!(core_target = target, "{message}"),
            LogLevel::Warn => tracing::warn!(core_target = target, "{message}"),
            LogLevel::Error => tracing::error!(core_target = target, "{message}"),
        }
    }
}
