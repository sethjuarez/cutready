//! The repository write lock: one OS file lock per git work tree, shared by
//! every CutReady process (app, CLI, MCP server) and every thread.
//!
//! It lives at `<git dir>/cutready/write.lock`, so all the projects of a
//! multi-project repository and the repository-wide Draftline operations
//! (save, switch, merge, move) exclude one another. Paths outside any
//! repository lock a file under the temp dir keyed by the path, which keeps the
//! folder itself untouched (cloning or adopting needs it empty of `.git`).
//!
//! The lock is reentrant for the acquiring thread, so a command holding it can
//! call writers that take it again. [`WriteGuard`] is `!Send` to keep that
//! sound: async commands can't hold it across an `.await`, where the task
//! could resume on another thread.

use std::collections::HashMap;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::thread::ThreadId;

use cutready_core::{Lock, LockGuard, PortError};
use cutready_desktop_io::FileLock;

pub const LOCK_FILENAME: &str = "write.lock";

type Key = (ThreadId, PathBuf);

struct Held {
    count: usize,
    _os: Box<dyn LockGuard>,
}

static HELD: LazyLock<Mutex<HashMap<Key, Held>>> = LazyLock::new(Default::default);

/// Holds the repository write lock until dropped.
#[must_use = "the lock is released when the guard drops"]
pub struct WriteGuard {
    _held: Reentry,
    _not_send: PhantomData<*const ()>,
}

/// Acquire the write lock of the repository containing `path`, blocking until
/// other holders release it.
pub fn lock(path: &Path) -> Result<WriteGuard, String> {
    lock_at(&lock_file(path))
}

/// Run `setup`, which may create or adopt the repository at `path`, while
/// holding a lock keyed by the folder itself and the write lock of whatever
/// repository holds it before and after. Concurrent setups of one folder queue
/// on the folder key, and writers of the new repository wait once it exists.
pub fn with_setup_lock<T>(path: &Path, setup: impl FnOnce() -> T) -> Result<T, String> {
    let _folder = lock_at(&folder_lock_file(path))?;
    let _before = lock(path)?;
    let result = setup();
    // Taking the new repository's lock waits out writers that found it
    // mid-setup before the folder lock (and setup) is released.
    let _after = lock(path)?;
    Ok(result)
}

fn lock_at(file: &Path) -> Result<WriteGuard, String> {
    acquire(file, true)
        .map(|held| WriteGuard {
            _held: held,
            _not_send: PhantomData,
        })
        .map_err(|e| format!("Could not lock the workspace for writing: {}", e.message))
}

/// The lock file for `path`: `<git dir>/cutready/write.lock` inside a
/// repository (per-worktree git dir for linked worktrees), otherwise a file
/// under the temp dir keyed by the path.
pub fn lock_file(path: &Path) -> PathBuf {
    if let Ok(repo) = git2::Repository::discover(path) {
        if !repo.is_bare() {
            let git_dir = std::fs::canonicalize(repo.path()).unwrap_or_else(|_| repo.path().into());
            return git_dir.join("cutready").join(LOCK_FILENAME);
        }
    }
    folder_lock_file(path)
}

fn folder_lock_file(path: &Path) -> PathBuf {
    let key = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    std::env::temp_dir().join("cutready-locks").join(format!(
        "{:016x}.lock",
        fnv1a(key.to_string_lossy().as_bytes())
    ))
}

/// The lock as a core [`Lock`] port, so `EditSession` takes the same
/// reentrant lock its callers may already hold.
pub struct RepoLock {
    file: PathBuf,
}

impl RepoLock {
    pub fn for_path(path: &Path) -> Self {
        Self {
            file: lock_file(path),
        }
    }
}

impl Lock for RepoLock {
    fn acquire(&self) -> Result<Box<dyn LockGuard>, PortError> {
        Ok(Box::new(acquire(&self.file, true)?))
    }

    fn try_acquire(&self) -> Result<Box<dyn LockGuard>, PortError> {
        Ok(Box::new(acquire(&self.file, false)?))
    }
}

/// One counted hold on a lock file by the thread that took it. Dropping it on
/// any thread releases that thread's hold correctly.
struct Reentry {
    key: Key,
}

impl LockGuard for Reentry {}

impl Drop for Reentry {
    fn drop(&mut self) {
        let mut held = HELD.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = held.get_mut(&self.key) {
            entry.count -= 1;
            if entry.count == 0 {
                held.remove(&self.key);
            }
        }
    }
}

fn acquire(file: &Path, wait: bool) -> Result<Reentry, PortError> {
    let key: Key = (std::thread::current().id(), file.to_path_buf());
    if let Some(entry) = HELD.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&key) {
        entry.count += 1;
        return Ok(Reentry { key });
    }
    // Block on the OS lock without holding the map, so other threads can
    // still take and release their own locks.
    let lock = FileLock::new(file)?;
    let os = if wait {
        lock.acquire()?
    } else {
        lock.try_acquire()?
    };
    HELD.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key.clone(), Held { count: 1, _os: os });
    Ok(Reentry { key })
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git2::Repository::init(dir.path()).unwrap();
        dir
    }

    #[test]
    fn projects_of_one_repository_share_its_lock() {
        let dir = repo();
        std::fs::create_dir_all(dir.path().join("alpha")).unwrap();
        let git_dir = std::fs::canonicalize(dir.path().join(".git")).unwrap();
        assert_eq!(
            lock_file(dir.path()),
            git_dir.join("cutready").join(LOCK_FILENAME)
        );
        assert_eq!(lock_file(&dir.path().join("alpha")), lock_file(dir.path()));
    }

    #[test]
    fn paths_outside_a_repository_lock_outside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("not-yet-cloned");
        let file = lock_file(&target);
        assert!(!file.starts_with(dir.path()));
        assert_eq!(file, lock_file(&target));
        let _guard = lock(&target).unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn the_holding_thread_can_take_the_lock_again() {
        let dir = repo();
        let outer = lock(dir.path()).unwrap();
        let inner = lock(&dir.path().join("alpha")).unwrap();
        let port = RepoLock::for_path(dir.path());
        let nested = port.try_acquire().unwrap();
        drop((inner, nested));

        // Still held by the outer guard.
        let file = lock_file(dir.path());
        let other = std::thread::spawn(move || {
            RepoLock { file }
                .try_acquire()
                .map(|_| ())
                .unwrap_err()
                .kind
        })
        .join()
        .unwrap();
        assert_eq!(other, cutready_core::PortErrorKind::Busy);
        drop(outer);
    }

    #[test]
    fn setup_holds_the_folder_and_the_new_repository_locks() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("demo");
        std::fs::create_dir_all(&target).unwrap();
        let folder = folder_lock_file(&target);
        let busy = |file: PathBuf| {
            std::thread::spawn(move || {
                RepoLock { file }
                    .try_acquire()
                    .map(|_| ())
                    .unwrap_err()
                    .kind
            })
            .join()
            .unwrap()
        };
        let observed = with_setup_lock(&target, || {
            git2::Repository::init(&target).unwrap();
            let repo = lock_file(&target);
            assert_ne!(repo, folder);
            // The new repository's lock is taken before setup's lock is released.
            let _held = lock(&target).unwrap();
            (busy(folder.clone()), busy(repo))
        })
        .unwrap();
        let busy_kind = cutready_core::PortErrorKind::Busy;
        assert_eq!(observed, (busy_kind, busy_kind));
        RepoLock { file: folder }.try_acquire().unwrap();
    }

    #[test]
    fn another_thread_waits_for_the_holder() {
        let dir = repo();
        let guard = lock(dir.path()).unwrap();
        let path = dir.path().to_path_buf();
        let (tx, rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let _guard = lock(&path).unwrap();
            tx.send(()).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
        drop(guard);
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn a_port_guard_dropped_on_another_thread_releases_its_hold() {
        let dir = repo();
        let port = RepoLock::for_path(dir.path());
        let guard = port.acquire().unwrap();
        std::thread::spawn(move || drop(guard)).join().unwrap();
        let file = lock_file(dir.path());
        std::thread::spawn(move || RepoLock { file }.try_acquire().map(|_| ()))
            .join()
            .unwrap()
            .unwrap();
    }
}
