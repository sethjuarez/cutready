use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use cutready_core::{
    Baseline, Images, NewOpLogEntry, OpLogEntry, OpLogState, OpLogStore, PortError, PortErrorKind,
    Resolution, ReviewEffect, Run,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};

const BUSY_TIMEOUT: Duration = Duration::from_secs(10);

const VERSION: i64 = 2;

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
    baseline TEXT,
    has_images INTEGER NOT NULL DEFAULT 0,
    before_image TEXT,
    after_image TEXT,
    effect TEXT,
    resolution TEXT
);
CREATE INDEX IF NOT EXISTS entries_by_run ON entries(run_id, seq);
CREATE INDEX IF NOT EXISTS entries_pending ON entries(seq) WHERE state = 'pending';
";

/// v1 logged writes without review state. Its user writes auto-keep (a
/// pending one too, should reconcile find it landed); agent writes stay up
/// for review (without images, so only a clean undo
/// back to the baseline is possible).
const MIGRATE_1_TO_2: &str = "
ALTER TABLE entries ADD COLUMN has_images INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN before_image TEXT;
ALTER TABLE entries ADD COLUMN after_image TEXT;
ALTER TABLE entries ADD COLUMN effect TEXT;
ALTER TABLE entries ADD COLUMN resolution TEXT;
UPDATE entries SET effect = '{\"kind\":\"auto_keep\"}' WHERE actor = 'user';
UPDATE entries SET resolution = 'kept' WHERE actor = 'user' AND state = 'committed';
";

const COLUMNS: &str = "seq, state, run_id, doc, actor, ops, before_hash, after_hash, at, baseline,
    has_images, before_image, after_image, effect, resolution";

/// Brings the schema to [`VERSION`] in one transaction.
fn migrate(conn: &mut Connection) -> Result<(), PortError> {
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let version: i64 = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    match version {
        0 => tx.execute_batch(SCHEMA).map_err(db_error)?,
        1 => tx.execute_batch(MIGRATE_1_TO_2).map_err(db_error)?,
        VERSION => return Ok(()),
        newer => {
            return Err(PortError::new(
                PortErrorKind::Corrupt,
                format!("Op log schema {newer} is newer than this build supports ({VERSION})."),
            ))
        }
    }
    tx.pragma_update(None, "user_version", VERSION)
        .map_err(db_error)?;
    tx.commit().map_err(db_error)
}

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
        let mut conn = Connection::open(path).map_err(db_error)?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(db_error)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(db_error)?;
        // Every mutation is durable on return (the OpLogStore contract).
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(db_error)?;
        conn.pragma_update(None, "foreign_keys", true)
            .map_err(db_error)?;
        migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn set_state(&self, seq: u64, to: OpLogState) -> Result<(), PortError> {
        let mut conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let row: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT state, effect FROM entries WHERE seq = ?1",
                params![seq as i64],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(db_error)?;
        let (state, effect) = match row {
            Some((state, effect)) => (parse_state(&state)?, effect),
            None => {
                return Err(PortError::new(
                    PortErrorKind::NotFound,
                    format!("Op log entry {seq} not found."),
                ))
            }
        };
        match state {
            OpLogState::Pending => {
                tx.execute(
                    "UPDATE entries SET state = ?1 WHERE seq = ?2",
                    params![state_str(to), seq as i64],
                )
                .map_err(db_error)?;
                if to == OpLogState::Committed {
                    apply_effect(&tx, seq, &parse_effect(effect.as_deref())?)?;
                }
                tx.commit().map_err(db_error)
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
        args: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<OpLogEntry>, PortError> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLUMNS} FROM entries WHERE {filter} ORDER BY seq"
            ))
            .map_err(db_error)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args), read_entry)
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
        let effect = serde_json::to_string(&write.effect).map_err(corrupt)?;
        let (has_images, before_image, after_image) = match write.images {
            Some(images) => (true, images.before, images.after),
            None => (false, None, None),
        };
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO entries
             (state, run_id, doc, actor, ops, before_hash, after_hash, at, baseline,
              has_images, before_image, after_image, effect)
             VALUES ('pending', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                write.run_id,
                write.doc,
                write.actor,
                ops,
                write.before_hash,
                write.after_hash,
                write.at.to_rfc3339(),
                baseline,
                has_images,
                before_image,
                after_image,
                effect
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
        self.entries("state = ?1", &[&"pending"])
    }

    fn entries_for_run(&self, run_id: &str) -> Result<Vec<OpLogEntry>, PortError> {
        self.entries("run_id = ?1", &[&run_id])
    }

    fn resolve(
        &self,
        run_id: &str,
        doc: &str,
        through_seq: u64,
        resolution: Resolution,
    ) -> Result<usize, PortError> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        resolve_entries(&conn, run_id, doc, through_seq, resolution)
    }

    fn unreviewed(&self) -> Result<Vec<OpLogEntry>, PortError> {
        self.entries("state = 'committed' AND resolution IS NULL", &[])
    }
}

fn resolve_entries(
    conn: &Connection,
    run_id: &str,
    doc: &str,
    through_seq: u64,
    resolution: Resolution,
) -> Result<usize, PortError> {
    conn.execute(
        "UPDATE entries SET resolution = ?1
         WHERE run_id = ?2 AND doc = ?3 AND seq <= ?4
           AND state = 'committed' AND resolution IS NULL",
        params![resolution_str(resolution), run_id, doc, through_seq as i64],
    )
    .map_err(db_error)
}

fn apply_effect(tx: &Transaction<'_>, seq: u64, effect: &ReviewEffect) -> Result<(), PortError> {
    if let ReviewEffect::Undo {
        run_id,
        doc,
        through_seq,
    } = effect
    {
        resolve_entries(tx, run_id, doc, *through_seq, Resolution::Undone)?;
    }
    if !matches!(effect, ReviewEffect::Review) {
        tx.execute(
            "UPDATE entries SET resolution = 'kept' WHERE seq = ?1",
            params![seq as i64],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn parse_effect(effect: Option<&str>) -> Result<ReviewEffect, PortError> {
    effect
        .map(serde_json::from_str)
        .transpose()
        .map(Option::unwrap_or_default)
        .map_err(corrupt)
}

fn resolution_str(resolution: Resolution) -> &'static str {
    match resolution {
        Resolution::Kept => "kept",
        Resolution::Undone => "undone",
    }
}

fn parse_resolution(resolution: Option<&str>) -> Result<Option<Resolution>, PortError> {
    match resolution {
        None => Ok(None),
        Some("kept") => Ok(Some(Resolution::Kept)),
        Some("undone") => Ok(Some(Resolution::Undone)),
        Some(other) => Err(PortError::new(
            PortErrorKind::Corrupt,
            format!("Unknown op log resolution {other}."),
        )),
    }
}

struct RawEntry {
    seq: i64,
    state: String,
    run_id: String,
    doc: String,
    actor: String,
    ops: String,
    before_hash: String,
    after_hash: String,
    at: String,
    baseline: Option<String>,
    has_images: bool,
    before_image: Option<String>,
    after_image: Option<String>,
    effect: Option<String>,
    resolution: Option<String>,
}

fn read_entry(row: &Row<'_>) -> rusqlite::Result<Result<OpLogEntry, PortError>> {
    let raw = RawEntry {
        seq: row.get(0)?,
        state: row.get(1)?,
        run_id: row.get(2)?,
        doc: row.get(3)?,
        actor: row.get(4)?,
        ops: row.get(5)?,
        before_hash: row.get(6)?,
        after_hash: row.get(7)?,
        at: row.get(8)?,
        baseline: row.get(9)?,
        has_images: row.get(10)?,
        before_image: row.get(11)?,
        after_image: row.get(12)?,
        effect: row.get(13)?,
        resolution: row.get(14)?,
    };
    Ok(decode_entry(raw))
}

fn decode_entry(raw: RawEntry) -> Result<OpLogEntry, PortError> {
    let RawEntry {
        seq,
        state,
        run_id,
        doc,
        actor,
        ops,
        before_hash,
        after_hash,
        at,
        baseline,
        has_images,
        before_image,
        after_image,
        effect,
        resolution,
    } = raw;
    Ok(OpLogEntry {
        seq: seq as u64,
        state: parse_state(&state)?,
        resolution: parse_resolution(resolution.as_deref())?,
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
            images: has_images.then_some(Images {
                before: before_image,
                after: after_image,
            }),
            effect: parse_effect(effect.as_deref())?,
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
            images: Some(Images {
                before: Some("{}".into()),
                after: None,
            }),
            effect: ReviewEffect::Review,
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

    #[test]
    fn commit_applies_the_review_effect() {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteOpLogStore::open(&dir.path().join("op-log.db")).unwrap();
        let agent = store.begin_run("agent", at()).unwrap();
        let a1 = store.append_pending(entry(&agent, "a.sk", None)).unwrap();
        let a2 = store.append_pending(entry(&agent, "a.sk", None)).unwrap();
        let b = store.append_pending(entry(&agent, "b.sk", None)).unwrap();
        for seq in [a1, a2, b] {
            store.commit(seq).unwrap();
        }
        assert_eq!(store.unreviewed().unwrap().len(), 3);

        let review = store.begin_run("review", at()).unwrap();
        let mut undo = entry(&review, "a.sk", None);
        undo.effect = ReviewEffect::Undo {
            run_id: agent.clone(),
            doc: "a.sk".into(),
            through_seq: a1,
        };
        let undo = store.append_pending(undo).unwrap();
        // Pending: nothing resolved yet.
        assert_eq!(store.unreviewed().unwrap().len(), 3);
        store.commit(undo).unwrap();
        store.commit(undo).unwrap();
        let resolutions = |run: &str| {
            store
                .entries_for_run(run)
                .unwrap()
                .iter()
                .map(|e| e.resolution)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            resolutions(&agent),
            vec![Some(Resolution::Undone), None, None]
        );
        assert_eq!(resolutions(&review), vec![Some(Resolution::Kept)]);
        assert_eq!(
            store.entries_for_run(&review).unwrap()[0].write.effect,
            ReviewEffect::Undo {
                run_id: agent.clone(),
                doc: "a.sk".into(),
                through_seq: a1
            }
        );

        assert_eq!(
            store.resolve(&agent, "a.sk", a2, Resolution::Kept).unwrap(),
            1
        );
        assert_eq!(
            store
                .resolve(&agent, "a.sk", a2, Resolution::Undone)
                .unwrap(),
            0
        );
        assert_eq!(
            resolutions(&agent),
            vec![Some(Resolution::Undone), Some(Resolution::Kept), None]
        );
        assert_eq!(
            store
                .unreviewed()
                .unwrap()
                .iter()
                .map(|e| e.seq)
                .collect::<Vec<_>>(),
            vec![b]
        );

        let user = store.begin_run("user", at()).unwrap();
        let mut kept = entry(&user, "c.md", None);
        kept.effect = ReviewEffect::AutoKeep;
        let kept = store.append_pending(kept).unwrap();
        let abandoned = store.append_pending(entry(&user, "c.md", None)).unwrap();
        store.commit(kept).unwrap();
        store.abandon(abandoned).unwrap();
        assert_eq!(resolutions(&user), vec![Some(Resolution::Kept), None]);
        assert_eq!(store.unreviewed().unwrap().len(), 1);
    }

    #[test]
    fn a_v1_log_migrates_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("op-log.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE runs (id TEXT PRIMARY KEY, actor TEXT NOT NULL, started_at TEXT NOT NULL);
                 CREATE TABLE entries (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL,
                    run_id TEXT NOT NULL REFERENCES runs(id), doc TEXT NOT NULL,
                    actor TEXT NOT NULL, ops TEXT NOT NULL, before_hash TEXT NOT NULL,
                    after_hash TEXT NOT NULL, at TEXT NOT NULL, baseline TEXT);
                 PRAGMA user_version = 1;
                 INSERT INTO runs VALUES ('u', 'user', '2026-01-02T03:04:05+00:00');
                 INSERT INTO runs VALUES ('a', 'agent', '2026-01-02T03:04:05+00:00');
                 INSERT INTO entries (state, run_id, doc, actor, ops, before_hash, after_hash, at)
                   VALUES ('committed', 'u', 'a.md', 'user', '[]', 'x', 'y', '2026-01-02T03:04:05+00:00'),
                          ('committed', 'a', 'a.md', 'agent', '[]', 'y', 'z', '2026-01-02T03:04:05+00:00'),
                          ('pending', 'u', 'b.md', 'user', '[]', 'x', 'y', '2026-01-02T03:04:05+00:00');",
            )
            .unwrap();
        }
        let store = SqliteOpLogStore::open(&path).unwrap();
        let unreviewed = store.unreviewed().unwrap();
        assert_eq!(unreviewed.len(), 1);
        assert_eq!(unreviewed[0].write.run_id, "a");
        assert_eq!(unreviewed[0].write.images, None);
        assert_eq!(unreviewed[0].write.effect, ReviewEffect::Review);
        assert_eq!(
            store.entries_for_run("u").unwrap()[0].resolution,
            Some(Resolution::Kept)
        );
        // A pending v1 user write that reconcile finds landed is kept too.
        let pending = store.pending().unwrap()[0].clone();
        assert_eq!(pending.write.effect, ReviewEffect::AutoKeep);
        store.commit(pending.seq).unwrap();
        assert_eq!(store.unreviewed().unwrap().len(), 1);
        drop(store);
        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, VERSION);
    }

    #[test]
    fn a_newer_log_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("op-log.db");
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 3)
            .unwrap();
        assert_eq!(
            SqliteOpLogStore::open(&path).err().unwrap().kind,
            PortErrorKind::Corrupt
        );
    }
}
