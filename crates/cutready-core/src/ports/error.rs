use std::fmt;

/// What went wrong at a port, independent of the host's I/O library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortErrorKind {
    NotFound,
    InvalidPath,
    /// Another holder has the resource (e.g. the workspace lock).
    Busy,
    Io,
    Corrupt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortError {
    pub kind: PortErrorKind,
    pub message: String,
}

impl PortError {
    pub fn new(kind: PortErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for PortError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PortError {}
