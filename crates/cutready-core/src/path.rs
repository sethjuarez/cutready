//! Project-relative paths. Core never sees absolute paths: hosts root a
//! [`Files`](crate::Files) port at the project folder and core addresses
//! documents relative to it.

use std::path::{Component, Path, PathBuf};

use crate::ports::{PortError, PortErrorKind};

/// Normalizes a project-relative path. Rejects non-UTF-8 paths, absolute
/// paths, drive or UNC prefixes, and any `..` component, matching the
/// desktop's `safe_resolve`. Both `/` and `\` separate components on every
/// platform, so a project written on Windows resolves the same on macOS and
/// iOS (backslashes in file names are not supported).
pub fn project_relative(path: impl AsRef<Path>) -> Result<PathBuf, PortError> {
    let path = path.as_ref();
    let text = path
        .to_str()
        .ok_or_else(|| invalid(path, "is not valid UTF-8"))?;
    // Reject Windows-style absolute paths even when running on Unix, where
    // `Path` treats them as plain names.
    let bytes = text.as_bytes();
    let windows_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if text.starts_with('/') || text.starts_with('\\') || windows_drive {
        return Err(invalid(path, "must be relative to the project root"));
    }
    let mut normalized = PathBuf::new();
    for component in Path::new(&text.replace('\\', "/")).components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir => return Err(invalid(path, "must not contain `..`")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(invalid(path, "must be relative to the project root"));
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(invalid(path, "is empty"));
    }
    Ok(normalized)
}

fn invalid(path: &Path, why: &str) -> PortError {
    PortError::new(
        PortErrorKind::InvalidPath,
        format!("Path {} {why}.", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_plain_relative_paths() {
        assert_eq!(
            project_relative("intro.sk").unwrap(),
            PathBuf::from("intro.sk")
        );
        assert_eq!(
            project_relative("./screenshots\\a.png").unwrap(),
            PathBuf::from("screenshots").join("a.png")
        );
    }

    #[test]
    fn rejects_paths_outside_the_project() {
        for bad in [
            "",
            ".",
            "../x.sk",
            "a/../../x.sk",
            "a/../b.sk",
            "/etc/passwd",
            "\\\\server\\share\\x",
            "C:\\x.sk",
            "c:x.sk",
        ] {
            let err = project_relative(bad).unwrap_err();
            assert_eq!(err.kind, PortErrorKind::InvalidPath, "{bad:?}");
        }
    }
}
