use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::PathBuf;

use cutready_core::{Lock, LockGuard, PortError, PortErrorKind};

use crate::io_error;

/// An exclusive OS file lock, so the app, CLI and MCP server serialize writes
/// to the same project. Each acquire opens its own handle, which makes the
/// lock exclusive between threads of one process as well as between
/// processes. Every host must derive the same absolute path for a project
/// (runs wire this from the project's runtime state dir under the git dir,
/// roadmap 4.9); keep it out of the project folder so it never shows up as a
/// change.
#[derive(Debug, Clone)]
pub struct FileLock {
    path: PathBuf,
}

struct FileLockGuard(File);

impl LockGuard for FileLockGuard {}

impl Drop for FileLockGuard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

impl FileLock {
    /// `path` must be absolute, so hosts with different working directories
    /// can't end up holding different locks.
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, PortError> {
        let path = path.into();
        if !path.is_absolute() {
            return Err(PortError::new(
                PortErrorKind::InvalidPath,
                format!("Lock path {} must be absolute.", path.display()),
            ));
        }
        Ok(Self { path })
    }

    fn open(&self) -> Result<File, PortError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| io_error(self.path.display(), err))?;
        }
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&self.path)
            .map_err(|err| io_error(self.path.display(), err))
    }
}

impl Lock for FileLock {
    fn acquire(&self) -> Result<Box<dyn LockGuard>, PortError> {
        let file = self.open()?;
        file.lock()
            .map_err(|err| io_error(self.path.display(), err))?;
        Ok(Box::new(FileLockGuard(file)))
    }

    fn try_acquire(&self) -> Result<Box<dyn LockGuard>, PortError> {
        let file = self.open()?;
        match file.try_lock() {
            Ok(()) => Ok(Box::new(FileLockGuard(file))),
            Err(TryLockError::WouldBlock) => Err(PortError::new(
                PortErrorKind::Busy,
                "The project is locked by another CutReady writer.",
            )),
            Err(TryLockError::Error(err)) => Err(io_error(self.path.display(), err)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn second_holder_is_busy_until_the_first_drops() {
        let dir = tempfile::tempdir().unwrap();
        let lock = FileLock::new(dir.path().join("state").join("write.lock")).unwrap();
        let other = lock.clone();

        let guard = lock.acquire().unwrap();
        assert_eq!(other.try_acquire().err().unwrap().kind, PortErrorKind::Busy);
        drop(guard);
        drop(other.try_acquire().unwrap());
    }

    #[test]
    fn rejects_relative_lock_paths() {
        assert_eq!(
            FileLock::new("state/write.lock").unwrap_err().kind,
            PortErrorKind::InvalidPath
        );
    }

    #[test]
    fn acquire_waits_for_the_holder() {
        let dir = tempfile::tempdir().unwrap();
        let lock = FileLock::new(dir.path().join("write.lock")).unwrap();
        let guard = lock.acquire().unwrap();

        let (tx, rx) = mpsc::channel();
        let waiter = lock.clone();
        let handle = std::thread::spawn(move || {
            let _guard = waiter.acquire().unwrap();
            tx.send(()).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        drop(guard);
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        handle.join().unwrap();
    }
}
