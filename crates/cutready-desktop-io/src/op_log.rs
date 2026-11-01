use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use cutready_core::{
    Baseline, NewOpLogEntry, OpLogEntry, OpLogState, OpLogStore, PortError, PortErrorKind, Run,
};
use rusqlite::{params, Connection, OptionalExtension, Row};

const BUSY_TIMEOUT: Duration = Duration::from_secs(10);

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    doc TEXT NOT NULL,
    actor TEXT NOT NULL,
    ops TEXT NOT NULL,
    before_hash TEXT NOT NULL,
    after_hash TEXT NOT NULL,
    at TEXT NOT NULL,
    baseline TEXT
);
CREATE INDEX IF NOT EXISTS entries_by_run ON entries(run_id, seq);
CREATE INDEX IF NOT EXISTS entries_pending ON entries(seq) WHERE state = 'pending';
PRAGMA user_version = 1;
";

/// The op log in SQLite (`op-log.db` in the project's runtime state dir).
/// Shared by the app, CLI and MCP server; SQLite's own locking makes
/// concurrent opens safe, and writers also hold the project's `FileLock`.
pub struct SqliteOpLogStore {
    conn: Mutex<Connection>,
}

impl SqliteOpLogStore {
    /// Opens or creates the store, creating the parent folder.
    pub fn open(path: &Path) -> Result<Self, PortError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| crate::io_error(parent.display(), err))?;
        }
        let conn = Connection::open(path).map_err(db_error)?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(db_error)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(db_error)?;
        // Every mutation is durable on return (the OpLogStore contract).
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(db_error)?;
        conn.pragma_update(None, "foreign_keys", true)
            .map_err(db_error)?;
        conn.execute_batch(SCHEMA).map_err(db_error)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn set_state(&self, seq: u64, to: OpLogState) -> Result<(), PortError> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let state: Option<String> = conn
            .query_row(
                "SELECT state FROM entries WHERE seq = ?1",
                params![seq as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let state = match state {
            Some(state) => parse_state(&state)?,
            None => {
                return Err(PortError::new(
                    PortErrorKind::NotFound,
                    format!("Op log entry {seq} not found."),
                ))
            }
        };
        match state {
            OpLogState::Pending => {
                conn.execute(
                    "UPDATE entries SET state = ?1 WHERE seq = ?2",
                    params![state_str(to), seq as i64],
                )
                .map_err(db_error)?;
                Ok(())
            }
            state if state == to => Ok(()),
            state => Err(PortError::new(
                PortErrorKind::Corrupt,
                format!("Op log entry {seq} is already {state:?}."),
            )),
        }
    }

    fn entries(
        &self,
        filter: &str,
        arg: &dyn rusqlite::ToSql,
    ) -> Result<Vec<OpLogEntry>, PortError> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare(&format!(
                "SELECT seq, state, run_id, doc, actor, ops, before_hash, after_hash, at, baseline
                 FROM entries WHERE {filter} ORDER BY seq"
            ))
            .map_err(db_error)?;
        let rows = stmt
            .query_map([arg], read_entry)
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        rows.into_iter().collect()
    }
}

impl OpLogStore for SqliteOpLogStore {
    fn begin_run(&self, actor: &str, started_at: DateTime<Utc>) -> Result<String, PortError> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO runs (id, actor, started_at) VALUES (?1, ?2, ?3)",
            params![id, actor, started_at.to_rfc3339()],
        )
        .map_err(db_error)?;
        Ok(id)
    }

    fn run(&self, run_id: &str) -> Result<Run, PortError> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let row = conn
            .query_row(
                "SELECT id, actor, started_at FROM runs WHERE id = ?1",
                params![run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?;
        let (id, actor, started_at) = row.ok_or_else(|| {
            PortError::new(PortErrorKind::NotFound, format!("Run {run_id} not found."))
        })?;
        Ok(Run {
            id,
            actor,
            started_at: parse_time(&started_at)?,
        })
    }

    fn append_pending(&self, write: NewOpLogEntry) -> Result<u64, PortError> {
        let ops = serde_json::to_string(&write.ops).map_err(corrupt)?;
        let baseline = write
            .baseline
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(corrupt)?;
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO entries
             (state, run_id, doc, actor, ops, before_hash, after_hash, at, baseline)
             VALUES ('pending', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                write.run_id,
                write.doc,
                write.actor,
                ops,
                write.before_hash,
                write.after_hash,
                write.at.to_rfc3339(),
                baseline
            ],
        )
        .map_err(db_error)?;
        Ok(conn.last_insert_rowid() as u64)
    }

    fn commit(&self, seq: u64) -> Result<(), PortError> {
        self.set_state(seq, OpLogState::Committed)
    }

    fn abandon(&self, seq: u64) -> Result<(), PortError> {
        self.set_state(seq, OpLogState::Abandoned)
    }

    fn pending(&self) -> Result<Vec<OpLogEntry>, PortError> {
        self.entries("state = ?1", &"pending")
    }

    fn entries_for_run(&self, run_id: &str) -> Result<Vec<OpLogEntry>, PortError> {
        self.entries("run_id = ?1", &run_id)
    }
}

type RawEntry = (
    i64,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
);

fn read_entry(row: &Row<'_>) -> rusqlite::Result<Result<OpLogEntry, PortError>> {
    let raw: RawEntry = (
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    );
    Ok(decode_entry(raw))
}

fn decode_entry(
    (seq, state, run_id, doc, actor, ops, before_hash, after_hash, at, baseline): RawEntry,
) -> Result<OpLogEntry, PortError> {
    Ok(OpLogEntry {
        seq: seq as u64,
        state: parse_state(&state)?,
        write: NewOpLogEntry {
            run_id,
            doc,
            actor,
            ops: serde_json::from_str(&ops).map_err(corrupt)?,
            before_hash,
            after_hash,
            at: parse_time(&at)?,
            baseline: baseline
                .map(|b| serde_json::from_str::<Baseline>(&b))
                .transpose()
                .map_err(corrupt)?,
        },
    })
}

fn state_str(state: OpLogState) -> &'static str {
    match state {
        OpLogState::Pending => "pending",
        OpLogState::Committed => "committed",
        OpLogState::Abandoned => "abandoned",
    }
}

fn parse_state(state: &str) -> Result<OpLogState, PortError> {
    match state {
        "pending" => Ok(OpLogState::Pending),
        "committed" => Ok(OpLogState::Committed),
        "abandoned" => Ok(OpLogState::Abandoned),
        other => Err(PortError::new(
            PortErrorKind::Corrupt,
            format!("Unknown op log state {other}."),
        )),
    }
}

fn parse_time(at: &str) -> Result<DateTime<Utc>, PortError> {
    DateTime::parse_from_rfc3339(at)
        .map(|t| t.with_timezone(&Utc))
        .map_err(corrupt)
}

fn db_error(err: rusqlite::Error) -> PortError {
    let kind = match err.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            PortErrorKind::Busy
        }
        Some(rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt) => {
            PortErrorKind::Corrupt
        }
        _ => PortErrorKind::Io,
    };
    PortError::new(kind, format!("Op log: {err}"))
}

fn corrupt(err: impl std::fmt::Display) -> PortError {
    PortError::new(PortErrorKind::Corrupt, format!("Op log: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap()
    }

    fn entry(run: &str, doc: &str, baseline: Option<Baseline>) -> NewOpLogEntry {
        NewOpLogEntry {
            run_id: run.into(),
            doc: doc.into(),
            actor: "agent:writer".into(),
            ops: serde_json::json!([{ "kind": "set_title", "title": "T" }]),
            before_hash: "sha256:a".into(),
            after_hash: "sha256:b".into(),
            at: at(),
            baseline,
        }
    }

    #[test]
    fn entries_round_trip_and_survive_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join("op-log.db");
        let store = SqliteOpLogStore::open(&path).unwrap();
        let run = store.begin_run("agent:writer", at()).unwrap();
        let first = store
            .append_pending(entry(
                &run,
                "intro.sk",
                Some(Baseline::Content("{}".into())),
            ))
            .unwrap();
        let second = store
            .append_pending(entry(&run, "new.md", Some(Baseline::Absent)))
            .unwrap();
        let third = store.append_pending(entry(&run, "intro.sk", None)).unwrap();
        store.commit(first).unwrap();
        store.abandon(second).unwrap();
        drop(store);

        let store = SqliteOpLogStore::open(&path).unwrap();
        assert_eq!(
            store.run(&run).unwrap(),
            Run {
                id: run.clone(),
                actor: "agent:writer".into(),
                started_at: at()
            }
        );
        let entries = store.entries_for_run(&run).unwrap();
        assert_eq!(
            entries.iter().map(|e| (e.seq, e.state)).collect::<Vec<_>>(),
            vec![
                (first, OpLogState::Committed),
                (second, OpLogState::Abandoned),
                (third, OpLogState::Pending)
            ]
        );
        assert_eq!(
            entries[0].write,
            entry(&run, "intro.sk", Some(Baseline::Content("{}".into())))
        );
        assert_eq!(entries[1].write.baseline, Some(Baseline::Absent));
        assert_eq!(
            store
                .pending()
                .unwrap()
                .iter()
                .map(|e| e.seq)
                .collect::<Vec<_>>(),
            vec![third]
        );
    }

    #[test]
    fn state_changes_follow_the_port_contract() {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteOpLogStore::open(&dir.path().join("op-log.db")).unwrap();
        let run = store.begin_run("user", at()).unwrap();
        let seq = store.append_pending(entry(&run, "a.md", None)).unwrap();

        store.commit(seq).unwrap();
        store.commit(seq).unwrap();
        assert_eq!(store.abandon(seq).unwrap_err().kind, PortErrorKind::Corrupt);
        assert_eq!(store.commit(99).unwrap_err().kind, PortErrorKind::NotFound);
        assert_eq!(store.run("nope").unwrap_err().kind, PortErrorKind::NotFound);
        assert_eq!(
            store
                .append_pending(entry("nope", "a.md", None))
                .unwrap_err()
                .kind,
            PortErrorKind::Io
        );
    }

    #[test]
    fn two_handles_share_one_log() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("op-log.db");
        let app = SqliteOpLogStore::open(&path).unwrap();
        let cli = SqliteOpLogStore::open(&path).unwrap();
        let run = cli.begin_run("cli", at()).unwrap();
        let seq = cli.append_pending(entry(&run, "a.md", None)).unwrap();

        assert_eq!(app.pending().unwrap()[0].seq, seq);
        app.commit(seq).unwrap();
        assert!(cli.pending().unwrap().is_empty());
    }
}
