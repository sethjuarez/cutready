//! Named background work. Tasks and threads the app starts go through here so
//! traces, debuggers and panic messages say which one it was. Clippy rejects
//! raw `tokio::spawn`, `tauri::async_runtime::spawn` and `std::thread::spawn`
//! in this crate (see `src-tauri/clippy.toml`).

use std::future::Future;
use std::thread;

use tracing::Instrument;

/// Spawn a named async task. It runs on the current Tokio runtime, or on
/// Tauri's runtime when called from outside one (for example, app setup).
#[allow(clippy::disallowed_methods)]
pub fn spawn_named<F>(name: &'static str, future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let future = future.instrument(tracing::debug_span!("task", name));
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => handle.spawn(future),
        Err(_) => tauri::async_runtime::handle().inner().spawn(future),
    }
}

/// Spawn a named OS thread.
pub fn spawn_thread_named<F, T>(
    name: impl Into<String>,
    f: F,
) -> std::io::Result<thread::JoinHandle<T>>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    thread::Builder::new().name(name.into()).spawn(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_task_runs_on_the_current_runtime() {
        assert_eq!(spawn_named("test-task", async { 7 }).await.unwrap(), 7);
    }

    #[test]
    fn a_task_spawned_outside_a_runtime_uses_tauris() {
        let handle = spawn_named("test-task", async { 7 });
        assert_eq!(tauri::async_runtime::block_on(handle).unwrap(), 7);
    }

    #[test]
    fn a_thread_carries_its_name() {
        let handle = spawn_thread_named("test-thread", || {
            thread::current().name().map(str::to_owned)
        })
        .unwrap();
        assert_eq!(handle.join().unwrap().as_deref(), Some("test-thread"));
    }
}
