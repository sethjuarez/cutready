use super::PortError;

/// Host credential storage (Stronghold on desktop, Keychain on iOS). Values are
/// opaque strings; callers own their encoding.
pub trait Secrets: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, PortError>;
    fn set(&self, key: &str, value: &str) -> Result<(), PortError>;
    /// Deleting a missing key is not an error.
    fn delete(&self, key: &str) -> Result<(), PortError>;
}
