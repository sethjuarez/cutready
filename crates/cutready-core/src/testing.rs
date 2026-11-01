//! In-memory port implementations for tests and tools. They follow the same
//! contracts as the desktop implementations (path rules, missing-file
//! behavior, lock exclusivity) so core tests exercise real semantics.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use chrono::{DateTime, Utc};

use crate::path::project_relative;
use crate::ports::{
    Clock, Files, Lock, LockGuard, Log, LogLevel, NewOpLogEntry, OpLogEntry, OpLogState,
    OpLogStore, PortError, PortErrorKind, Resolution, ReviewEffect, Run, Secrets,
};

/// Files held in a map keyed by normalized project-relative path.
#[derive(Default)]
pub struct MemoryFiles {
    files: Mutex<BTreeMap<PathBuf, Vec<u8>>>,
}

impl MemoryFiles {
    pub fn new() -> Self {
        Self::default()
    }

    /// Normalized paths of every stored file, sorted.
    pub fn paths(&self) -> Vec<PathBuf> {
        self.files.lock().unwrap().keys().cloned().collect()
    }
}

impl Files for MemoryFiles {
    fn read(&self, path: &Path) -> Result<Vec<u8>, PortError> {
        let path = project_relative(path)?;
        self.files
            .lock()
            .unwrap()
            .get(&path)
            .cloned()
            .ok_or_else(|| {
                PortError::new(
                    PortErrorKind::NotFound,
                    format!("{} not found.", path.display()),
                )
            })
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), PortError> {
        let path = project_relative(path)?;
        self.files.lock().unwrap().insert(path, bytes.to_vec());
        Ok(())
    }

    fn exists(&self, path: &Path) -> Result<bool, PortError> {
        let path = project_relative(path)?;
        Ok(self.files.lock().unwrap().contains_key(&path))
    }

    fn remove(&self, path: &Path) -> Result<(), PortError> {
        let path = project_relative(path)?;
        self.files.lock().unwrap().remove(&path);
        Ok(())
    }

    fn list(&self, dir: &Path) -> Result<Vec<PathBuf>, PortError> {
        let dir = if dir.as_os_str().is_empty() {
            PathBuf::new()
        } else {
            project_relative(dir)?
        };
        Ok(self
            .files
            .lock()
            .unwrap()
            .keys()
            .filter(|path| path.parent() == Some(dir.as_path()))
            .cloned()
            .collect())
    }
}

/// A clock that returns a fixed instant until moved.
/// A fixed instant for tests that need a timestamp but don't care which.
pub fn test_now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-01-02T03:04:05Z")
        .expect("valid timestamp")
        .with_timezone(&Utc)
}

pub struct FixedClock(Mutex<DateTime<Utc>>);

impl FixedClock {
    pub fn new(now: DateTime<Utc>) -> Self {
        Self(Mutex::new(now))
    }

    pub fn set(&self, now: DateTime<Utc>) {
        *self.0.lock().unwrap() = now;
    }
}

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}

/// Records log lines for assertions.
#[derive(Default)]
pub struct MemoryLog {
    lines: Mutex<Vec<(LogLevel, String, String)>>,
}

impl MemoryLog {
    pub fn lines(&self) -> Vec<(LogLevel, String, String)> {
        self.lines.lock().unwrap().clone()
    }
}

impl Log for MemoryLog {
    fn log(&self, level: LogLevel, target: &str, message: &str) {
        self.lines
            .lock()
            .unwrap()
            .push((level, target.to_string(), message.to_string()));
    }
}

#[derive(Default)]
pub struct MemorySecrets {
    values: Mutex<BTreeMap<String, String>>,
}

impl Secrets for MemorySecrets {
    fn get(&self, key: &str) -> Result<Option<String>, PortError> {
        Ok(self.values.lock().unwrap().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), PortError> {
        self.values
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), PortError> {
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}

/// An exclusive lock shared by clones within one process.
#[derive(Clone, Default)]
pub struct MemoryLock {
    state: Arc<(Mutex<bool>, Condvar)>,
}

struct MemoryLockGuard(Arc<(Mutex<bool>, Condvar)>);

impl LockGuard for MemoryLockGuard {}

impl Drop for MemoryLockGuard {
    fn drop(&mut self) {
        let (held, released) = &*self.0;
        *held.lock().unwrap() = false;
        released.notify_one();
    }
}

impl Lock for MemoryLock {
    fn acquire(&self) -> Result<Box<dyn LockGuard>, PortError> {
        let (held, released) = &*self.state;
        let mut held = held.lock().unwrap();
        while *held {
            held = released.wait(held).unwrap();
        }
        *held = true;
        Ok(Box::new(MemoryLockGuard(self.state.clone())))
    }

    fn try_acquire(&self) -> Result<Box<dyn LockGuard>, PortError> {
        let mut held = self.state.0.lock().unwrap();
        if *held {
            return Err(PortError::new(
                PortErrorKind::Busy,
                "The workspace is locked by another writer.",
            ));
        }
        *held = true;
        Ok(Box::new(MemoryLockGuard(self.state.clone())))
    }
}

#[derive(Default)]
pub struct MemoryOpLog {
    runs: Mutex<Vec<Run>>,
    entries: Mutex<Vec<OpLogEntry>>,
}

impl MemoryOpLog {
    fn set_state(&self, seq: u64, to: OpLogState) -> Result<(), PortError> {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries
            .iter_mut()
            .find(|entry| entry.seq == seq)
            .ok_or_else(|| {
                PortError::new(
                    PortErrorKind::NotFound,
                    format!("Op log entry {seq} not found."),
                )
            })?;
        match entry.state {
            OpLogState::Pending => {
                entry.state = to;
                if to == OpLogState::Committed {
                    let effect = entry.write.effect.clone();
                    apply_effect(&mut entries, seq, &effect);
                }
            }
            state if state == to => {}
            state => {
                return Err(PortError::new(
                    PortErrorKind::Corrupt,
                    format!("Op log entry {seq} is already {state:?}."),
                ))
            }
        }
        Ok(())
    }
}

fn apply_effect(entries: &mut [OpLogEntry], seq: u64, effect: &ReviewEffect) {
    let resolve = |entries: &mut [OpLogEntry], run: &str, doc: &str, through: u64, to| {
        for entry in entries.iter_mut().filter(|e| {
            e.write.run_id == run
                && e.write.doc == doc
                && e.seq <= through
                && e.state == OpLogState::Committed
                && e.resolution.is_none()
        }) {
            entry.resolution = Some(to);
        }
    };
    match effect {
        ReviewEffect::Review => {}
        ReviewEffect::AutoKeep => {
            if let Some(entry) = entries.iter_mut().find(|e| e.seq == seq) {
                entry.resolution = Some(Resolution::Kept);
            }
        }
        ReviewEffect::Undo {
            run_id,
            doc,
            through_seq,
        } => {
            resolve(entries, run_id, doc, *through_seq, Resolution::Undone);
            if let Some(entry) = entries.iter_mut().find(|e| e.seq == seq) {
                entry.resolution = Some(Resolution::Kept);
            }
        }
    }
}

impl OpLogStore for MemoryOpLog {
    fn begin_run(&self, actor: &str, started_at: DateTime<Utc>) -> Result<String, PortError> {
        let mut runs = self.runs.lock().unwrap();
        let id = format!("run-{}", runs.len() + 1);
        runs.push(Run {
            id: id.clone(),
            actor: actor.into(),
            started_at,
        });
        Ok(id)
    }

    fn run(&self, run_id: &str) -> Result<Run, PortError> {
        self.runs
            .lock()
            .unwrap()
            .iter()
            .find(|run| run.id == run_id)
            .cloned()
            .ok_or_else(|| {
                PortError::new(PortErrorKind::NotFound, format!("Run {run_id} not found."))
            })
    }

    fn append_pending(&self, write: NewOpLogEntry) -> Result<u64, PortError> {
        let mut entries = self.entries.lock().unwrap();
        let seq = entries.len() as u64 + 1;
        entries.push(OpLogEntry {
            seq,
            state: OpLogState::Pending,
            resolution: None,
            write,
        });
        Ok(seq)
    }

    fn commit(&self, seq: u64) -> Result<(), PortError> {
        self.set_state(seq, OpLogState::Committed)
    }

    fn abandon(&self, seq: u64) -> Result<(), PortError> {
        self.set_state(seq, OpLogState::Abandoned)
    }

    fn pending(&self) -> Result<Vec<OpLogEntry>, PortError> {
        Ok(self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| entry.state == OpLogState::Pending)
            .cloned()
            .collect())
    }

    fn entries_for_run(&self, run_id: &str) -> Result<Vec<OpLogEntry>, PortError> {
        Ok(self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| entry.write.run_id == run_id)
            .cloned()
            .collect())
    }

    fn resolve(
        &self,
        run_id: &str,
        doc: &str,
        through_seq: u64,
        resolution: Resolution,
    ) -> Result<usize, PortError> {
        let mut entries = self.entries.lock().unwrap();
        let mut changed = 0;
        for entry in entries.iter_mut().filter(|e| {
            e.write.run_id == run_id
                && e.write.doc == doc
                && e.seq <= through_seq
                && e.state == OpLogState::Committed
                && e.resolution.is_none()
        }) {
            entry.resolution = Some(resolution);
            changed += 1;
        }
        Ok(changed)
    }

    fn unreviewed(&self) -> Result<Vec<OpLogEntry>, PortError> {
        Ok(self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.state == OpLogState::Committed && e.resolution.is_none())
            .cloned()
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn memory_files_follow_the_files_contract() {
        let files = MemoryFiles::new();
        files
            .write_atomic(Path::new("notes/plan.md"), b"# Plan")
            .unwrap();
        files.write_atomic(Path::new("intro.sk"), b"{}").unwrap();

        assert_eq!(files.read(Path::new("notes/./plan.md")).unwrap(), b"# Plan");
        assert!(files.exists(Path::new("intro.sk")).unwrap());
        assert_eq!(
            files.list(Path::new("")).unwrap(),
            vec![PathBuf::from("intro.sk")]
        );
        assert_eq!(
            files.read(Path::new("missing.sk")).unwrap_err().kind,
            PortErrorKind::NotFound
        );
        assert_eq!(
            files.read(Path::new("../outside.sk")).unwrap_err().kind,
            PortErrorKind::InvalidPath
        );
        files.remove(Path::new("intro.sk")).unwrap();
        files.remove(Path::new("intro.sk")).unwrap();
        assert!(!files.exists(Path::new("intro.sk")).unwrap());
    }

    #[test]
    fn memory_lock_is_exclusive_until_dropped() {
        let lock = MemoryLock::default();
        let guard = lock.acquire().unwrap();
        assert_eq!(
            lock.clone().try_acquire().err().unwrap().kind,
            PortErrorKind::Busy
        );
        drop(guard);
        assert!(lock.try_acquire().is_ok());
    }

    #[test]
    fn memory_op_log_tracks_pending_writes() {
        let log = MemoryOpLog::default();
        let entry = |run: &str| NewOpLogEntry {
            run_id: run.into(),
            doc: "intro.sk".into(),
            actor: "user".into(),
            ops: serde_json::json!([]),
            before_hash: "a".into(),
            after_hash: "b".into(),
            at: Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap(),
            baseline: None,
            images: None,
            effect: ReviewEffect::Review,
        };
        let first = log.append_pending(entry("r1")).unwrap();
        let second = log.append_pending(entry("r2")).unwrap();
        log.commit(first).unwrap();
        log.commit(first).unwrap();

        assert_eq!(
            log.pending()
                .unwrap()
                .iter()
                .map(|e| e.seq)
                .collect::<Vec<_>>(),
            vec![second]
        );
        assert_eq!(log.entries_for_run("r1").unwrap()[0].seq, first);
        assert_eq!(log.commit(99).unwrap_err().kind, PortErrorKind::NotFound);
        assert_eq!(log.abandon(first).unwrap_err().kind, PortErrorKind::Corrupt);
        log.abandon(second).unwrap();
        log.abandon(second).unwrap();
        assert!(log.pending().unwrap().is_empty());
        assert_eq!(log.commit(second).unwrap_err().kind, PortErrorKind::Corrupt);

        let at = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        let run = log.begin_run("agent", at).unwrap();
        assert_eq!(log.run(&run).unwrap().actor, "agent");
        assert_eq!(log.run("nope").unwrap_err().kind, PortErrorKind::NotFound);
    }

    #[test]
    fn fixed_clock_and_memory_ports_round_trip() {
        let at = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        let clock = FixedClock::new(at);
        assert_eq!(clock.now(), at);

        let secrets = MemorySecrets::default();
        secrets.set("k", "v").unwrap();
        assert_eq!(secrets.get("k").unwrap().as_deref(), Some("v"));
        secrets.delete("k").unwrap();
        secrets.delete("k").unwrap();
        assert_eq!(secrets.get("k").unwrap(), None);

        let log = MemoryLog::default();
        log.log(LogLevel::Warn, "core", "hello");
        assert_eq!(
            log.lines(),
            vec![(LogLevel::Warn, "core".into(), "hello".into())]
        );
    }
}
