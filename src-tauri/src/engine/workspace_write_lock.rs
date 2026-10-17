use std::sync::{Mutex, MutexGuard, OnceLock};

static WORKSPACE_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn mutex() -> &'static Mutex<()> {
    WORKSPACE_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn lock() -> Result<MutexGuard<'static, ()>, String> {
    mutex()
        .lock()
        .map_err(|_| "Workspace write lock is poisoned.".to_string())
}
