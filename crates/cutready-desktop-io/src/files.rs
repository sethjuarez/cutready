use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use cutready_core::path::project_relative;
use cutready_core::{Files, PortError, PortErrorKind};

use crate::io_error;

/// Files rooted at one project folder. Paths follow `project_relative`. In
/// addition, the deepest part of a path that already exists must
/// canonicalize inside the root, so a symlink or junction can't redirect a
/// read or write (including directory creation) outside the project.
#[derive(Debug, Clone)]
pub struct StdFiles {
    root: PathBuf,
}

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
        let escapes = || {
            PortError::new(
                PortErrorKind::InvalidPath,
                format!("Path {} leaves the project folder.", path.display()),
            )
        };
        // A missing root has nothing inside it to escape through yet.
        let Ok(root) = self.root.canonicalize() else {
            return Ok((relative, resolved));
        };
        for ancestor in resolved.ancestors() {
            if fs::symlink_metadata(ancestor).is_err() {
                continue;
            }
            // Dangling links fail to canonicalize and are rejected too.
            let canonical = ancestor.canonicalize().map_err(|_| escapes())?;
            if !canonical.starts_with(&root) {
                return Err(escapes());
            }
            break;
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
        let fail = |err| io_error(relative.display(), err);
        fs::create_dir_all(parent).map_err(fail)?;
        // A fresh, randomly named temp file beside the target (created with
        // create_new, so it never follows an existing entry); the rename
        // stays on one volume. Dropping it on error deletes it.
        let file_name = full.file_name().unwrap_or_default().to_string_lossy();
        let mut temp = tempfile::Builder::new()
            .prefix(&format!(".{file_name}."))
            .suffix(".tmp")
            .tempfile_in(parent)
            .map_err(fail)?;
        temp.write_all(bytes).map_err(fail)?;
        temp.as_file().sync_all().map_err(fail)?;
        temp.persist(&full).map_err(|err| fail(err.error))?;
        sync_dir(parent).map_err(fail)?;
        Ok(())
    }

    fn exists(&self, path: &Path) -> Result<bool, PortError> {
        let (relative, full) = self.resolve(path)?;
        match fs::metadata(&full) {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(io_error(relative.display(), err)),
        }
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
        let fail = |err| io_error(relative.display(), err);
        let mut paths = Vec::new();
        for entry in fs::read_dir(&full).map_err(fail)? {
            let entry = entry.map_err(fail)?;
            if entry.file_type().map_err(fail)?.is_file() {
                paths.push(relative.join(entry.file_name()));
            }
        }
        paths.sort();
        Ok(paths)
    }
}

/// Makes a rename in `dir` durable. NTFS journals renames, and Windows can't
/// open a directory for flushing without backup semantics, so this is a
/// no-op there.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
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
        std::os::unix::fs::symlink(dir.path().join("gone"), root.join("dangling")).unwrap();
        let files = StdFiles::new(&root);
        for bad in [
            "escape/secret.txt",
            "escape/new/deeper/x.sk",
            "dangling/x.sk",
        ] {
            assert_eq!(
                files.read(Path::new(bad)).unwrap_err().kind,
                PortErrorKind::InvalidPath,
                "{bad}"
            );
        }
        assert_eq!(
            files
                .write_atomic(Path::new("escape/new/deeper/x.sk"), b"x")
                .unwrap_err()
                .kind,
            PortErrorKind::InvalidPath
        );
        assert!(!dir.path().join("new").exists());
    }
}
