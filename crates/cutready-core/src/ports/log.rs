#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// Structured diagnostics. Desktop forwards to `tracing`; other hosts choose
/// their own sink.
pub trait Log: Send + Sync {
    fn log(&self, level: LogLevel, target: &str, message: &str);
}
