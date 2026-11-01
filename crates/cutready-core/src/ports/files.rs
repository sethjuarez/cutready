use std::path::{Path, PathBuf};

use super::PortError;

/// Project files, addressed by project-relative paths (see
/// [`crate::path::project_relative`]). Implementations are rooted at one
/// project folder and must reject paths that leave it.
pub trait Files: Send + Sync {
    fn read(&self, path: &Path) -> Result<Vec<u8>, PortError>;

    /// Replaces the file atomically (write a temp file, then rename), creating
    /// parent directories as needed. Readers never see a partial file.
    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), PortError>;

    fn exists(&self, path: &Path) -> Result<bool, PortError>;

    /// Removes a file. Removing a missing file is not an error.
    fn remove(&self, path: &Path) -> Result<(), PortError>;

    /// Files (not directories) directly inside `dir`, as project-relative
    /// paths sorted by name. Use an empty path for the project root.
    fn list(&self, dir: &Path) -> Result<Vec<PathBuf>, PortError>;
}
