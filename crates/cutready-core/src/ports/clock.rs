use chrono::{DateTime, Utc};

/// Wall-clock time. Core never reads the system clock directly, so tests and
/// golden files can pin timestamps.
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}
