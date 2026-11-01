use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use cutready_core::path::project_relative;
use cutready_core::{Files, PortError, PortErrorKind};

use crate::io_error;

/// Files rooted at one project folder. Paths follow `project_relative`, and,
/// like the app's `safe_resolve`, a path whose existing file or parent
/// canonicalizes outside the root (for example through a symlink) is
/// rejected.
#[derive(Debug, Clone)]
pub struct StdFiles {
    root: PathBuf,
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

impl StdFiles {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn resolve(&self, path: &Path) -> Result<(PathBuf, PathBuf), PortError> {
        let relative = project_relative(path)?;
        let resolved = self.root.join(&relative);
        if let Ok(root) = self.root.canonicalize() {
            let check = if resolved.exists() {
                resolved.canonicalize().ok()
            } else {
                resolved.parent().and_then(|parent| {
                    parent
                        .canonicalize()
                        .ok()
                        .map(|p| p.join(resolved.file_name().unwrap_or_default()))
                })
            };
            if let Some(canonical) = check {
                if !canonical.starts_with(&root) {
                    return Err(PortError::new(
                        PortErrorKind::InvalidPath,
                        format!("Path {} leaves the project folder.", path.display()),
                    ));
                }
            }
        }
        Ok((relative, resolved))
    }
}

impl Files for StdFiles {
    fn read(&self, path: &Path) -> Result<Vec<u8>, PortError> {
        let (relative, full) = self.resolve(path)?;
        fs::read(&full).map_err(|err| io_error(relative.display(), err))
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), PortError> {
        let (relative, full) = self.resolve(path)?;
        let parent = full.parent().unwrap_or(&self.root);
        fs::create_dir_all(parent).map_err(|err| io_error(relative.display(), err))?;
        // The temp file sits beside the target so the rename never crosses
        // volumes; the dot prefix keeps it out of project scans.
        let file_name = full.file_name().unwrap_or_default().to_string_lossy();
        let temp = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = fs::File::create(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temp, &full)
        })();
        if let Err(err) = result {
            let _ = fs::remove_file(&temp);
            return Err(io_error(relative.display(), err));
        }
        Ok(())
    }

    fn exists(&self, path: &Path) -> Result<bool, PortError> {
        let (_, full) = self.resolve(path)?;
        Ok(full.is_file())
    }

    fn remove(&self, path: &Path) -> Result<(), PortError> {
        let (relative, full) = self.resolve(path)?;
        match fs::remove_file(&full) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
                Err(io_error(relative.display(), err))
            }
            _ => Ok(()),
        }
    }

    fn list(&self, dir: &Path) -> Result<Vec<PathBuf>, PortError> {
        let (relative, full) = if dir.as_os_str().is_empty() {
            (PathBuf::new(), self.root.clone())
        } else {
            self.resolve(dir)?
        };
        let mut paths = Vec::new();
        for entry in fs::read_dir(&full).map_err(|err| io_error(relative.display(), err))? {
            let entry = entry.map_err(|err| io_error(relative.display(), err))?;
            let is_file = entry
                .file_type()
                .map_err(|err| io_error(relative.display(), err))?
                .is_file();
            if is_file {
                paths.push(relative.join(entry.file_name()));
            }
        }
        paths.sort();
        Ok(paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_writes_lists_and_removes_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let files = StdFiles::new(dir.path());

        files
            .write_atomic(Path::new("notes/plan.md"), b"# Plan")
            .unwrap();
        files.write_atomic(Path::new("b.sk"), b"{}").unwrap();
        files.write_atomic(Path::new("a.sk"), b"{}").unwrap();
        files.write_atomic(Path::new("a.sk"), b"{\"v\":2}").unwrap();

        assert_eq!(files.read(Path::new("notes/plan.md")).unwrap(), b"# Plan");
        assert_eq!(files.read(Path::new("a.sk")).unwrap(), b"{\"v\":2}");
        assert_eq!(
            files.list(Path::new("")).unwrap(),
            vec![PathBuf::from("a.sk"), PathBuf::from("b.sk")]
        );
        assert_eq!(
            files.list(Path::new("notes")).unwrap(),
            vec![PathBuf::from("notes").join("plan.md")]
        );
        assert!(!files.exists(Path::new("notes")).unwrap());

        files.remove(Path::new("a.sk")).unwrap();
        files.remove(Path::new("a.sk")).unwrap();
        assert_eq!(
            files.read(Path::new("a.sk")).unwrap_err().kind,
            PortErrorKind::NotFound
        );
        // No temp files are left behind.
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            2,
            "expected only b.sk and notes/"
        );
    }

    #[test]
    fn rejects_paths_that_leave_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let files = StdFiles::new(dir.path().join("project"));
        for bad in ["../x.sk", "/x.sk", "C:\\x.sk"] {
            assert_eq!(
                files.read(Path::new(bad)).unwrap_err().kind,
                PortErrorKind::InvalidPath,
                "{bad}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_leave_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(dir.path(), root.join("escape")).unwrap();
        let files = StdFiles::new(&root);
        assert_eq!(
            files.read(Path::new("escape/secret.txt")).unwrap_err().kind,
            PortErrorKind::InvalidPath
        );
    }
}
