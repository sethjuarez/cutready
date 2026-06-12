//! Project-scoped persistence for agent run state.
//!
//! Agentive owns the serializable observability/resumability models. CutReady
//! owns where those records are stored, how they are retained, and how future UI
//! surfaces will query them.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agentive::{
    Checkpoint, CheckpointStore, MemoryPromotionCandidate, MemoryPromotionHook,
    MemoryPromotionOutcome, ResumeContext, TouchedResource, TrajectoryEvent, TrajectoryMetadata,
    TrajectorySink, VerificationResult,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row};

const AGENT_STATE_RELATIVE_PATH: &str = ".cutready/agent-state.db";
const SCHEMA_VERSION: i32 = 1;
const BUSY_TIMEOUT: Duration = Duration::from_millis(750);
const MAX_COMPLETED_RUNS: usize = 100;
const MAX_EVENTS_PER_RUN: usize = 1_000;
const MAX_CHECKPOINTS_PER_RUN: usize = 25;
const MAX_RESUME_CONTEXTS_PER_RUN: usize = 25;
const MAX_TOUCHED_RESOURCES_PER_RUN: usize = 500;
const MAX_VERIFICATION_RESULTS_PER_RUN: usize = 500;
const MAX_MEMORY_PROMOTIONS_PER_RUN: usize = 200;

#[derive(Debug, Clone)]
pub struct AgentStateStore {
    db_path: Arc<PathBuf>,
    run_id: Arc<str>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct AgentRunRecord {
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct AgentRunSummary {
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    pub initial_goal: Option<String>,
    pub trajectory_event_count: usize,
    pub touched_resource_count: usize,
    pub checkpoint_count: usize,
    pub resume_context_count: usize,
    pub verification_result_count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct AgentTrajectoryEventRecord {
    pub id: i64,
    pub event_id: Option<String>,
    pub parent_event_id: Option<String>,
    pub iteration: Option<i64>,
    pub event_type: String,
    pub created_at: DateTime<Utc>,
    pub event: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct AgentTouchedResourceRecord {
    pub id: i64,
    pub kind: String,
    pub resource_id: String,
    pub operation: String,
    pub created_at: DateTime<Utc>,
    pub resource: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct AgentCheckpointRecord {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub checkpoint: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct AgentResumeContextRecord {
    pub id: i64,
    pub checkpoint_id: String,
    pub created_at: DateTime<Utc>,
    pub context: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct AgentVerificationResultRecord {
    pub id: i64,
    pub criterion: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub result: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct AgentRunDetail {
    pub run: AgentRunSummary,
    pub metadata: serde_json::Value,
    pub trajectory_events: Vec<AgentTrajectoryEventRecord>,
    pub touched_resources: Vec<AgentTouchedResourceRecord>,
    pub checkpoints: Vec<AgentCheckpointRecord>,
    pub resume_contexts: Vec<AgentResumeContextRecord>,
    pub verification_results: Vec<AgentVerificationResultRecord>,
}

impl AgentStateStore {
    pub fn for_project(project_root: &Path, run_id: impl Into<String>) -> Result<Self, String> {
        let db_path = project_root.join(AGENT_STATE_RELATIVE_PATH);
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create CutReady agent state directory: {e}"))?;
        }

        let store = Self {
            db_path: Arc::new(db_path),
            run_id: Arc::from(run_id.into()),
        };
        store.initialize()?;
        Ok(store)
    }

    #[cfg(test)]
    fn for_database_path(db_path: PathBuf, run_id: impl Into<String>) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!("Could not create CutReady agent state test directory: {e}")
            })?;
        }
        let store = Self {
            db_path: Arc::new(db_path),
            run_id: Arc::from(run_id.into()),
        };
        store.initialize()?;
        Ok(store)
    }

    #[allow(dead_code)]
    pub fn db_path(&self) -> &Path {
        self.db_path.as_path()
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn initialize(&self) -> Result<(), String> {
        let conn = self.connect()?;
        initialize_schema(&conn)
    }

    pub fn list_recent_runs(
        project_root: &Path,
        limit: usize,
    ) -> Result<Vec<AgentRunSummary>, String> {
        let Some(conn) = Self::connect_existing_project_database(project_root)? else {
            return Ok(Vec::new());
        };
        let mut stmt = conn
            .prepare(
                "SELECT
                    r.run_id,
                    r.parent_run_id,
                    r.provider,
                    r.model,
                    r.status,
                    r.started_at,
                    r.completed_at,
                    (SELECT COUNT(*) FROM trajectory_events te WHERE te.run_id = r.run_id),
                    (SELECT COUNT(*) FROM touched_resources tr WHERE tr.run_id = r.run_id),
                    (SELECT COUNT(*) FROM checkpoints c WHERE c.run_id = r.run_id),
                    (SELECT COUNT(*) FROM resume_contexts rc WHERE rc.run_id = r.run_id),
                    (SELECT COUNT(*) FROM verification_results vr WHERE vr.run_id = r.run_id),
                    (SELECT json_extract(te.event_json, '$.goal')
                       FROM trajectory_events te
                      WHERE te.run_id = r.run_id AND te.event_type = 'turn_started'
                      ORDER BY te.id ASC
                      LIMIT 1)
                 FROM agent_runs r
                 ORDER BY datetime(r.started_at) DESC, r.run_id DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("Could not prepare agent run query: {e}"))?;
        let rows = stmt
            .query_map(
                params![limit.max(1).min(MAX_COMPLETED_RUNS) as i64],
                Self::read_run_summary,
            )
            .map_err(|e| format!("Could not query agent runs: {e}"))?;

        let mut runs = Vec::new();
        for row in rows {
            runs.push(row.map_err(|e| format!("Could not read agent run row: {e}"))?);
        }
        Ok(runs)
    }

    pub fn get_run_detail(
        project_root: &Path,
        run_id: &str,
    ) -> Result<Option<AgentRunDetail>, String> {
        let Some(conn) = Self::connect_existing_project_database(project_root)? else {
            return Ok(None);
        };
        let row = conn
            .query_row(
                "SELECT
                    r.run_id,
                    r.parent_run_id,
                    r.provider,
                    r.model,
                    r.status,
                    r.started_at,
                    r.completed_at,
                    (SELECT COUNT(*) FROM trajectory_events te WHERE te.run_id = r.run_id),
                    (SELECT COUNT(*) FROM touched_resources tr WHERE tr.run_id = r.run_id),
                    (SELECT COUNT(*) FROM checkpoints c WHERE c.run_id = r.run_id),
                    (SELECT COUNT(*) FROM resume_contexts rc WHERE rc.run_id = r.run_id),
                    (SELECT COUNT(*) FROM verification_results vr WHERE vr.run_id = r.run_id),
                    (SELECT json_extract(te.event_json, '$.goal')
                       FROM trajectory_events te
                      WHERE te.run_id = r.run_id AND te.event_type = 'turn_started'
                      ORDER BY te.id ASC
                      LIMIT 1),
                    r.metadata_json
                 FROM agent_runs r
                 WHERE r.run_id = ?1",
                params![run_id],
                |row| {
                    let run = Self::read_run_summary(row)?;
                    let metadata_json: String = row.get(13)?;
                    Ok((run, metadata_json))
                },
            )
            .optional()
            .map_err(|e| format!("Could not read agent run detail: {e}"))?;

        let Some((run, metadata_json)) = row else {
            return Ok(None);
        };
        let metadata = Self::parse_json_value(&metadata_json, "run metadata")?;
        Ok(Some(AgentRunDetail {
            trajectory_events: Self::query_trajectory_events(&conn, run_id)?,
            touched_resources: Self::query_touched_resources(&conn, run_id)?,
            checkpoints: Self::query_checkpoints(&conn, run_id)?,
            resume_contexts: Self::query_resume_contexts(&conn, run_id)?,
            verification_results: Self::query_verification_results(&conn, run_id)?,
            run,
            metadata,
        }))
    }

    pub fn insert_run(
        &self,
        parent_run_id: Option<&str>,
        provider: &str,
        model: &str,
        metadata: serde_json::Value,
    ) -> Result<(), String> {
        let conn = self.connect()?;
        let metadata_json = serde_json::to_string(&metadata).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO agent_runs
                (run_id, parent_run_id, provider, model, status, started_at, completed_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, 'running', ?5, NULL, ?6)",
            params![
                self.run_id(),
                parent_run_id,
                provider,
                model,
                Utc::now().to_rfc3339(),
                metadata_json
            ],
        )
        .map_err(|e| format!("Could not insert agent run: {e}"))?;
        prune_completed_runs(&conn)?;
        Ok(())
    }

    fn connect_existing_project_database(
        project_root: &Path,
    ) -> Result<Option<Connection>, String> {
        let db_path = project_root.join(AGENT_STATE_RELATIVE_PATH);
        if !db_path.exists() {
            return Ok(None);
        }
        let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Could not open CutReady agent state database: {e}"))?;
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(|e| format!("Could not configure agent state database timeout: {e}"))?;
        let existing_version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| format!("Could not read agent state schema version: {e}"))?;
        if existing_version > SCHEMA_VERSION {
            return Err(format!(
                "Agent state database schema version {existing_version} is newer than this CutReady build supports ({SCHEMA_VERSION})"
            ));
        }
        Ok(Some(conn))
    }

    fn read_run_summary(row: &Row<'_>) -> rusqlite::Result<AgentRunSummary> {
        Ok(AgentRunSummary {
            run_id: row.get(0)?,
            parent_run_id: row.get(1)?,
            provider: row.get(2)?,
            model: row.get(3)?,
            status: row.get(4)?,
            started_at: parse_rfc3339_row(row.get::<_, String>(5)?, 5)?,
            completed_at: row
                .get::<_, Option<String>>(6)?
                .map(|value| parse_rfc3339_row(value, 6))
                .transpose()?,
            trajectory_event_count: row.get::<_, usize>(7)?,
            touched_resource_count: row.get::<_, usize>(8)?,
            checkpoint_count: row.get::<_, usize>(9)?,
            resume_context_count: row.get::<_, usize>(10)?,
            verification_result_count: row.get::<_, usize>(11)?,
            initial_goal: row.get(12)?,
        })
    }

    fn query_trajectory_events(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Vec<AgentTrajectoryEventRecord>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, event_id, parent_event_id, iteration, event_type, event_json, created_at
                 FROM trajectory_events
                 WHERE run_id = ?1
                 ORDER BY id ASC",
            )
            .map_err(|e| format!("Could not prepare trajectory event query: {e}"))?;
        let rows = stmt
            .query_map(params![run_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    parse_rfc3339_row(row.get::<_, String>(6)?, 6)?,
                ))
            })
            .map_err(|e| format!("Could not query trajectory events: {e}"))?;

        let mut events = Vec::new();
        for row in rows {
            let (id, event_id, parent_event_id, iteration, event_type, event_json, created_at) =
                row.map_err(|e| format!("Could not read trajectory event row: {e}"))?;
            events.push(AgentTrajectoryEventRecord {
                id,
                event_id,
                parent_event_id,
                iteration,
                event_type,
                created_at,
                event: Self::parse_json_value(&event_json, "trajectory event")?,
            });
        }
        Ok(events)
    }

    fn query_touched_resources(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Vec<AgentTouchedResourceRecord>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, resource_id, operation, resource_json, created_at
                 FROM touched_resources
                 WHERE run_id = ?1
                 ORDER BY id ASC",
            )
            .map_err(|e| format!("Could not prepare touched resource query: {e}"))?;
        let rows = stmt
            .query_map(params![run_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    parse_rfc3339_row(row.get::<_, String>(5)?, 5)?,
                ))
            })
            .map_err(|e| format!("Could not query touched resources: {e}"))?;

        let mut resources = Vec::new();
        for row in rows {
            let (id, kind, resource_id, operation, resource_json, created_at) =
                row.map_err(|e| format!("Could not read touched resource row: {e}"))?;
            resources.push(AgentTouchedResourceRecord {
                id,
                kind,
                resource_id,
                operation,
                created_at,
                resource: Self::parse_json_value(&resource_json, "touched resource")?,
            });
        }
        Ok(resources)
    }

    fn query_checkpoints(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Vec<AgentCheckpointRecord>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, created_at, checkpoint_json
                 FROM checkpoints
                 WHERE run_id = ?1
                 ORDER BY datetime(created_at) ASC, id ASC",
            )
            .map_err(|e| format!("Could not prepare checkpoint query: {e}"))?;
        let rows = stmt
            .query_map(params![run_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    parse_rfc3339_row(row.get::<_, String>(1)?, 1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("Could not query checkpoints: {e}"))?;

        let mut checkpoints = Vec::new();
        for row in rows {
            let (id, created_at, checkpoint_json) =
                row.map_err(|e| format!("Could not read checkpoint row: {e}"))?;
            checkpoints.push(AgentCheckpointRecord {
                id,
                created_at,
                checkpoint: Self::parse_json_value(&checkpoint_json, "checkpoint")?,
            });
        }
        Ok(checkpoints)
    }

    fn query_resume_contexts(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Vec<AgentResumeContextRecord>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, checkpoint_id, created_at, context_json
                 FROM resume_contexts
                 WHERE run_id = ?1
                 ORDER BY id ASC",
            )
            .map_err(|e| format!("Could not prepare resume context query: {e}"))?;
        let rows = stmt
            .query_map(params![run_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    parse_rfc3339_row(row.get::<_, String>(2)?, 2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| format!("Could not query resume contexts: {e}"))?;

        let mut contexts = Vec::new();
        for row in rows {
            let (id, checkpoint_id, created_at, context_json) =
                row.map_err(|e| format!("Could not read resume context row: {e}"))?;
            contexts.push(AgentResumeContextRecord {
                id,
                checkpoint_id,
                created_at,
                context: Self::parse_json_value(&context_json, "resume context")?,
            });
        }
        Ok(contexts)
    }

    fn query_verification_results(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Vec<AgentVerificationResultRecord>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT id, criterion, status, result_json, created_at
                 FROM verification_results
                 WHERE run_id = ?1
                 ORDER BY id ASC",
            )
            .map_err(|e| format!("Could not prepare verification result query: {e}"))?;
        let rows = stmt
            .query_map(params![run_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    parse_rfc3339_row(row.get::<_, String>(4)?, 4)?,
                ))
            })
            .map_err(|e| format!("Could not query verification results: {e}"))?;

        let mut results = Vec::new();
        for row in rows {
            let (id, criterion, status, result_json, created_at) =
                row.map_err(|e| format!("Could not read verification result row: {e}"))?;
            results.push(AgentVerificationResultRecord {
                id,
                criterion,
                status,
                created_at,
                result: Self::parse_json_value(&result_json, "verification result")?,
            });
        }
        Ok(results)
    }

    fn parse_json_value(json: &str, label: &str) -> Result<serde_json::Value, String> {
        serde_json::from_str(json).map_err(|e| format!("Could not parse {label}: {e}"))
    }

    pub fn finish_run(&self, status: &str) -> Result<(), String> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE agent_runs SET status = ?2, completed_at = ?3 WHERE run_id = ?1",
            params![self.run_id(), status, Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Could not finish agent run: {e}"))?;
        prune_completed_runs(&conn)?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn save_resume_context(&self, context: ResumeContext) -> Result<(), String> {
        let conn = self.connect()?;
        let context_json = serde_json::to_string(&context).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO resume_contexts (run_id, checkpoint_id, created_at, context_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                self.run_id(),
                context.checkpoint.id,
                context.generated_at.to_rfc3339(),
                context_json
            ],
        )
        .map_err(|e| format!("Could not save resume context: {e}"))?;
        prune_by_run_limit(
            &conn,
            "resume_contexts",
            self.run_id(),
            MAX_RESUME_CONTEXTS_PER_RUN,
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn record_touched_resource(&self, resource: &TouchedResource) -> Result<(), String> {
        let conn = self.connect()?;
        insert_touched_resource(&conn, self.run_id(), resource)
    }

    #[allow(dead_code)]
    pub fn record_verification_result(&self, result: &VerificationResult) -> Result<(), String> {
        let conn = self.connect()?;
        insert_verification_result(&conn, self.run_id(), result)
    }

    pub fn record_memory_promotion_decision(
        &self,
        candidate: &MemoryPromotionCandidate,
        outcome: Option<&MemoryPromotionOutcome>,
    ) -> Result<(), String> {
        let conn = self.connect()?;
        insert_memory_promotion(&conn, self.run_id(), candidate, outcome)
    }

    #[allow(dead_code)]
    pub fn get_run(&self, run_id: &str) -> Result<Option<AgentRunRecord>, String> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT run_id, parent_run_id, provider, model, status, started_at, completed_at
             FROM agent_runs WHERE run_id = ?1",
            params![run_id],
            |row| {
                Ok(AgentRunRecord {
                    run_id: row.get(0)?,
                    parent_run_id: row.get(1)?,
                    provider: row.get(2)?,
                    model: row.get(3)?,
                    status: row.get(4)?,
                    started_at: parse_rfc3339_row(row.get::<_, String>(5)?, 5)?,
                    completed_at: row
                        .get::<_, Option<String>>(6)?
                        .map(|value| parse_rfc3339_row(value, 6))
                        .transpose()?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Could not read agent run: {e}"))
    }

    #[allow(dead_code)]
    pub fn trajectory_event_count(&self, run_id: &str) -> Result<usize, String> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT COUNT(*) FROM trajectory_events WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, usize>(0),
        )
        .map_err(|e| format!("Could not count trajectory events: {e}"))
    }

    #[allow(dead_code)]
    pub fn touched_resource_count(&self, run_id: &str) -> Result<usize, String> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT COUNT(*) FROM touched_resources WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, usize>(0),
        )
        .map_err(|e| format!("Could not count touched resources: {e}"))
    }

    #[allow(dead_code)]
    pub fn verification_result_count(&self, run_id: &str) -> Result<usize, String> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT COUNT(*) FROM verification_results WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, usize>(0),
        )
        .map_err(|e| format!("Could not count verification results: {e}"))
    }

    #[allow(dead_code)]
    pub fn memory_promotion_count(&self, run_id: &str) -> Result<usize, String> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT COUNT(*) FROM memory_promotions WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, usize>(0),
        )
        .map_err(|e| format!("Could not count memory promotions: {e}"))
    }

    fn connect(&self) -> Result<Connection, String> {
        let conn = Connection::open(self.db_path.as_path())
            .map_err(|e| format!("Could not open CutReady agent state database: {e}"))?;
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(|e| format!("Could not configure agent state database timeout: {e}"))?;
        Ok(conn)
    }
}

impl TrajectorySink for AgentStateStore {
    fn record(&self, event: TrajectoryEvent) -> Result<(), String> {
        let conn = self.connect()?;
        insert_trajectory_event(&conn, self.run_id(), &event)?;

        match &event {
            TrajectoryEvent::ResourceTouched { resource, .. } => {
                insert_touched_resource(&conn, self.run_id(), resource)?;
            }
            TrajectoryEvent::VerificationRecorded { result, .. } => {
                insert_verification_result(&conn, self.run_id(), result)?;
            }
            TrajectoryEvent::MemoryPromotionSuggested { candidate, .. } => {
                insert_memory_promotion(&conn, self.run_id(), candidate, None)?;
            }
            _ => {}
        }

        Ok(())
    }
}

impl CheckpointStore for AgentStateStore {
    fn save_checkpoint(&self, checkpoint: Checkpoint) -> Result<(), String> {
        let conn = self.connect()?;
        let run_id = checkpoint
            .metadata
            .get("run_id")
            .map(String::as_str)
            .unwrap_or_else(|| self.run_id());
        let checkpoint_json = serde_json::to_string(&checkpoint).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO checkpoints
                (id, run_id, created_at, checkpoint_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                checkpoint.id,
                run_id,
                checkpoint.created_at.to_rfc3339(),
                checkpoint_json
            ],
        )
        .map_err(|e| format!("Could not save checkpoint: {e}"))?;
        prune_checkpoints_for_run(&conn, run_id)?;
        Ok(())
    }

    fn latest_checkpoint(&self, run_id: &str) -> Result<Option<Checkpoint>, String> {
        let conn = self.connect()?;
        conn.query_row(
            "SELECT checkpoint_json FROM checkpoints
             WHERE run_id = ?1
             ORDER BY datetime(created_at) DESC, id DESC
             LIMIT 1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("Could not read latest checkpoint: {e}"))?
        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        .transpose()
    }

    fn list_checkpoints(&self, run_id: &str) -> Result<Vec<Checkpoint>, String> {
        let conn = self.connect()?;
        let mut stmt = conn
            .prepare(
                "SELECT checkpoint_json FROM checkpoints
                 WHERE run_id = ?1
                 ORDER BY datetime(created_at) ASC, id ASC",
            )
            .map_err(|e| format!("Could not prepare checkpoint query: {e}"))?;
        let rows = stmt
            .query_map(params![run_id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Could not query checkpoints: {e}"))?;

        let mut checkpoints = Vec::new();
        for row in rows {
            let json = row.map_err(|e| format!("Could not read checkpoint row: {e}"))?;
            checkpoints.push(serde_json::from_str(&json).map_err(|e| e.to_string())?);
        }
        Ok(checkpoints)
    }
}

impl MemoryPromotionHook for AgentStateStore {
    fn consider(
        &self,
        candidate: MemoryPromotionCandidate,
    ) -> Result<MemoryPromotionOutcome, String> {
        let outcome = MemoryPromotionOutcome::Deferred {
            reason: Some("CutReady memory-promotion UI is not enabled yet".into()),
        };
        self.record_memory_promotion_decision(&candidate, Some(&outcome))?;
        Ok(outcome)
    }
}

fn initialize_schema(conn: &Connection) -> Result<(), String> {
    let existing_version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("Could not read agent state schema version: {e}"))?;
    if existing_version > SCHEMA_VERSION {
        return Err(format!(
            "Agent state database schema version {existing_version} is newer than this CutReady build supports ({SCHEMA_VERSION})"
        ));
    }

    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS agent_runs (
            run_id TEXT PRIMARY KEY,
            parent_run_id TEXT,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS trajectory_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            event_id TEXT,
            parent_event_id TEXT,
            iteration INTEGER,
            event_type TEXT NOT NULL,
            event_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_trajectory_events_run
            ON trajectory_events (run_id, id);
        CREATE TABLE IF NOT EXISTS checkpoints (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            checkpoint_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_checkpoints_run
            ON checkpoints (run_id, created_at);
        CREATE TABLE IF NOT EXISTS resume_contexts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            checkpoint_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            context_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_resume_contexts_run
            ON resume_contexts (run_id, id);
        CREATE TABLE IF NOT EXISTS touched_resources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            resource_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_touched_resources_run
            ON touched_resources (run_id, id);
        CREATE TABLE IF NOT EXISTS verification_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            criterion TEXT NOT NULL,
            status TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_verification_results_run
            ON verification_results (run_id, id);
        CREATE TABLE IF NOT EXISTS memory_promotions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            status TEXT NOT NULL,
            candidate_json TEXT NOT NULL,
            outcome_json TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_promotions_run
            ON memory_promotions (run_id, id);
        ",
    )
    .map_err(|e| format!("Could not initialize agent state schema: {e}"))?;
    if existing_version < SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|e| format!("Could not set agent state schema version: {e}"))?;
    }
    Ok(())
}

fn insert_trajectory_event(
    conn: &Connection,
    fallback_run_id: &str,
    event: &TrajectoryEvent,
) -> Result<(), String> {
    let metadata = event_metadata(event);
    let run_id = metadata.run_id.as_deref().unwrap_or(fallback_run_id);
    let event_json = serde_json::to_string(event).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO trajectory_events
            (run_id, event_id, parent_event_id, iteration, event_type, event_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            run_id,
            metadata.event_id.as_deref(),
            metadata.parent_event_id.as_deref(),
            metadata.iteration.map(|value| value as i64),
            event_type(event),
            event_json,
            metadata.timestamp.to_rfc3339(),
        ],
    )
    .map_err(|e| format!("Could not insert trajectory event: {e}"))?;
    prune_by_run_limit(conn, "trajectory_events", run_id, MAX_EVENTS_PER_RUN)?;
    Ok(())
}

fn insert_touched_resource(
    conn: &Connection,
    run_id: &str,
    resource: &TouchedResource,
) -> Result<(), String> {
    let resource_json = serde_json::to_string(resource).map_err(|e| e.to_string())?;
    let operation = serde_json::to_value(&resource.operation)
        .map_err(|e| e.to_string())?
        .as_str()
        .unwrap_or("custom")
        .to_string();
    conn.execute(
        "INSERT INTO touched_resources
            (run_id, kind, resource_id, operation, resource_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            run_id,
            resource.kind,
            resource.id,
            operation,
            resource_json,
            Utc::now().to_rfc3339()
        ],
    )
    .map_err(|e| format!("Could not insert touched resource: {e}"))?;
    prune_by_run_limit(
        conn,
        "touched_resources",
        run_id,
        MAX_TOUCHED_RESOURCES_PER_RUN,
    )?;
    Ok(())
}

fn insert_verification_result(
    conn: &Connection,
    run_id: &str,
    result: &VerificationResult,
) -> Result<(), String> {
    let result_json = serde_json::to_string(result).map_err(|e| e.to_string())?;
    let status = serde_json::to_value(&result.status)
        .map_err(|e| e.to_string())?
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    conn.execute(
        "INSERT INTO verification_results
            (run_id, criterion, status, result_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            run_id,
            result.criterion,
            status,
            result_json,
            Utc::now().to_rfc3339()
        ],
    )
    .map_err(|e| format!("Could not insert verification result: {e}"))?;
    prune_by_run_limit(
        conn,
        "verification_results",
        run_id,
        MAX_VERIFICATION_RESULTS_PER_RUN,
    )?;
    Ok(())
}

fn insert_memory_promotion(
    conn: &Connection,
    run_id: &str,
    candidate: &MemoryPromotionCandidate,
    outcome: Option<&MemoryPromotionOutcome>,
) -> Result<(), String> {
    let candidate_json = serde_json::to_string(candidate).map_err(|e| e.to_string())?;
    let outcome_json = outcome
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;
    let status = outcome.map(memory_outcome_status).unwrap_or("suggested");
    conn.execute(
        "INSERT INTO memory_promotions
            (run_id, status, candidate_json, outcome_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            run_id,
            status,
            candidate_json,
            outcome_json,
            Utc::now().to_rfc3339()
        ],
    )
    .map_err(|e| format!("Could not insert memory promotion: {e}"))?;
    prune_by_run_limit(
        conn,
        "memory_promotions",
        run_id,
        MAX_MEMORY_PROMOTIONS_PER_RUN,
    )?;
    Ok(())
}

fn prune_completed_runs(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM trajectory_events WHERE run_id IN (
            SELECT run_id FROM agent_runs
            WHERE status != 'running' AND completed_at IS NOT NULL
            ORDER BY datetime(completed_at) DESC, started_at DESC
            LIMIT -1 OFFSET ?1
        )",
        params![MAX_COMPLETED_RUNS as i64],
    )
    .map_err(|e| format!("Could not prune old trajectory events: {e}"))?;
    conn.execute(
        "DELETE FROM checkpoints WHERE run_id IN (
            SELECT run_id FROM agent_runs
            WHERE status != 'running' AND completed_at IS NOT NULL
            ORDER BY datetime(completed_at) DESC, started_at DESC
            LIMIT -1 OFFSET ?1
        )",
        params![MAX_COMPLETED_RUNS as i64],
    )
    .map_err(|e| format!("Could not prune old checkpoints: {e}"))?;
    conn.execute(
        "DELETE FROM resume_contexts WHERE run_id IN (
            SELECT run_id FROM agent_runs
            WHERE status != 'running' AND completed_at IS NOT NULL
            ORDER BY datetime(completed_at) DESC, started_at DESC
            LIMIT -1 OFFSET ?1
        )",
        params![MAX_COMPLETED_RUNS as i64],
    )
    .map_err(|e| format!("Could not prune old resume contexts: {e}"))?;
    conn.execute(
        "DELETE FROM touched_resources WHERE run_id IN (
            SELECT run_id FROM agent_runs
            WHERE status != 'running' AND completed_at IS NOT NULL
            ORDER BY datetime(completed_at) DESC, started_at DESC
            LIMIT -1 OFFSET ?1
        )",
        params![MAX_COMPLETED_RUNS as i64],
    )
    .map_err(|e| format!("Could not prune old touched resources: {e}"))?;
    conn.execute(
        "DELETE FROM verification_results WHERE run_id IN (
            SELECT run_id FROM agent_runs
            WHERE status != 'running' AND completed_at IS NOT NULL
            ORDER BY datetime(completed_at) DESC, started_at DESC
            LIMIT -1 OFFSET ?1
        )",
        params![MAX_COMPLETED_RUNS as i64],
    )
    .map_err(|e| format!("Could not prune old verification results: {e}"))?;
    conn.execute(
        "DELETE FROM memory_promotions WHERE run_id IN (
            SELECT run_id FROM agent_runs
            WHERE status != 'running' AND completed_at IS NOT NULL
            ORDER BY datetime(completed_at) DESC, started_at DESC
            LIMIT -1 OFFSET ?1
        )",
        params![MAX_COMPLETED_RUNS as i64],
    )
    .map_err(|e| format!("Could not prune old memory promotions: {e}"))?;
    conn.execute(
        "DELETE FROM agent_runs WHERE run_id IN (
            SELECT run_id FROM agent_runs
            WHERE status != 'running' AND completed_at IS NOT NULL
            ORDER BY datetime(completed_at) DESC, started_at DESC
            LIMIT -1 OFFSET ?1
        )",
        params![MAX_COMPLETED_RUNS as i64],
    )
    .map_err(|e| format!("Could not prune old agent runs: {e}"))?;
    Ok(())
}

fn prune_by_run_limit(
    conn: &Connection,
    table: &str,
    run_id: &str,
    max_rows: usize,
) -> Result<(), String> {
    let sql = format!(
        "DELETE FROM {table}
         WHERE run_id = ?1
           AND id NOT IN (
             SELECT id FROM {table}
             WHERE run_id = ?1
             ORDER BY id DESC
             LIMIT ?2
           )"
    );
    conn.execute(&sql, params![run_id, max_rows as i64])
        .map_err(|e| format!("Could not prune {table}: {e}"))?;
    Ok(())
}

fn prune_checkpoints_for_run(conn: &Connection, run_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM checkpoints
         WHERE run_id = ?1
           AND id NOT IN (
             SELECT id FROM checkpoints
             WHERE run_id = ?1
             ORDER BY datetime(created_at) DESC, id DESC
             LIMIT ?2
           )",
        params![run_id, MAX_CHECKPOINTS_PER_RUN as i64],
    )
    .map_err(|e| format!("Could not prune checkpoints: {e}"))?;
    Ok(())
}

fn event_metadata(event: &TrajectoryEvent) -> &TrajectoryMetadata {
    match event {
        TrajectoryEvent::TurnStarted { metadata, .. }
        | TrajectoryEvent::TurnCompleted { metadata, .. }
        | TrajectoryEvent::ModelCallStarted { metadata, .. }
        | TrajectoryEvent::ModelCallCompleted { metadata, .. }
        | TrajectoryEvent::ToolCallStarted { metadata, .. }
        | TrajectoryEvent::ToolCallCompleted { metadata, .. }
        | TrajectoryEvent::Permission { metadata, .. }
        | TrajectoryEvent::RetryScheduled { metadata, .. }
        | TrajectoryEvent::VerificationRecorded { metadata, .. }
        | TrajectoryEvent::CheckpointCreated { metadata, .. }
        | TrajectoryEvent::CompactionStarted { metadata, .. }
        | TrajectoryEvent::CompactionCompleted { metadata, .. }
        | TrajectoryEvent::MemoryPromotionSuggested { metadata, .. }
        | TrajectoryEvent::MemoryPromotionCompleted { metadata, .. }
        | TrajectoryEvent::ResourceTouched { metadata, .. }
        | TrajectoryEvent::Custom { metadata, .. } => metadata,
    }
}

fn event_type(event: &TrajectoryEvent) -> &'static str {
    match event {
        TrajectoryEvent::TurnStarted { .. } => "turn_started",
        TrajectoryEvent::TurnCompleted { .. } => "turn_completed",
        TrajectoryEvent::ModelCallStarted { .. } => "model_call_started",
        TrajectoryEvent::ModelCallCompleted { .. } => "model_call_completed",
        TrajectoryEvent::ToolCallStarted { .. } => "tool_call_started",
        TrajectoryEvent::ToolCallCompleted { .. } => "tool_call_completed",
        TrajectoryEvent::Permission { .. } => "permission",
        TrajectoryEvent::RetryScheduled { .. } => "retry_scheduled",
        TrajectoryEvent::VerificationRecorded { .. } => "verification_recorded",
        TrajectoryEvent::CheckpointCreated { .. } => "checkpoint_created",
        TrajectoryEvent::CompactionStarted { .. } => "compaction_started",
        TrajectoryEvent::CompactionCompleted { .. } => "compaction_completed",
        TrajectoryEvent::MemoryPromotionSuggested { .. } => "memory_promotion_suggested",
        TrajectoryEvent::MemoryPromotionCompleted { .. } => "memory_promotion_completed",
        TrajectoryEvent::ResourceTouched { .. } => "resource_touched",
        TrajectoryEvent::Custom { .. } => "custom",
    }
}

fn memory_outcome_status(outcome: &MemoryPromotionOutcome) -> &'static str {
    match outcome {
        MemoryPromotionOutcome::Accepted { .. } => "accepted",
        MemoryPromotionOutcome::Rejected { .. } => "rejected",
        MemoryPromotionOutcome::Deferred { .. } => "deferred",
        MemoryPromotionOutcome::Failed { .. } => "failed",
    }
}

fn parse_rfc3339_row(value: String, column: usize) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Text,
                Box::new(err),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentive::{
        CheckpointStore, ErrorKind, ResourceOperation, TrajectoryMetadata, VerificationStatus,
    };

    fn test_store(run_id: &str) -> AgentStateStore {
        let dir = tempfile::tempdir().unwrap().keep();
        AgentStateStore::for_database_path(dir.join(".cutready").join("agent-state.db"), run_id)
            .unwrap()
    }

    #[test]
    fn schema_initializes_idempotently() {
        let store = test_store("run-schema");
        store.initialize().unwrap();
        store.initialize().unwrap();

        let conn = Connection::open(store.db_path()).unwrap();
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn schema_rejects_newer_database_versions() {
        let dir = tempfile::tempdir().unwrap().keep();
        let db_path = dir.join(".cutready").join("agent-state.db");
        std::fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .unwrap();
        drop(conn);

        let err = AgentStateStore::for_database_path(db_path, "run-newer-schema").unwrap_err();
        assert!(err.contains("newer than this CutReady build supports"));
    }

    #[test]
    fn run_event_checkpoint_and_resume_context_round_trip() {
        let store = test_store("run-round-trip");
        store
            .insert_run(
                None,
                "openai",
                "gpt-4o",
                serde_json::json!({"source":"test"}),
            )
            .unwrap();

        store
            .record(TrajectoryEvent::TurnStarted {
                metadata: TrajectoryMetadata::new().with_run_id("run-round-trip"),
                goal: "Improve sketch".into(),
            })
            .unwrap();

        let checkpoint = Checkpoint::new("checkpoint-1", "Improve sketch")
            .with_metadata("run_id", "run-round-trip")
            .with_next_step("Verify update");
        store.save_checkpoint(checkpoint.clone()).unwrap();
        store
            .save_resume_context(ResumeContext::new(checkpoint.clone()))
            .unwrap();

        let run = store.get_run("run-round-trip").unwrap().unwrap();
        assert_eq!(run.status, "running");
        assert_eq!(store.trajectory_event_count("run-round-trip").unwrap(), 1);
        assert_eq!(
            store
                .latest_checkpoint("run-round-trip")
                .unwrap()
                .unwrap()
                .id,
            checkpoint.id
        );
        assert_eq!(store.list_checkpoints("run-round-trip").unwrap().len(), 1);
    }

    #[test]
    fn resource_verification_and_memory_records_use_agentive_types() {
        let store = test_store("run-metadata");
        let resource = TouchedResource::new("sketch", "intro.sk", ResourceOperation::Write)
            .with_metadata("tool", "write_sketch");
        let verification = VerificationResult::new(
            "Tool write_sketch completed",
            VerificationStatus::Passed,
            "Tool returned a success response",
        );
        let candidate = MemoryPromotionCandidate::new("User prefers concise narration")
            .with_category("core")
            .with_tag("preference");

        let resource_json = serde_json::to_string(&resource).unwrap();
        let verification_json = serde_json::to_string(&verification).unwrap();
        let candidate_json = serde_json::to_string(&candidate).unwrap();
        assert_eq!(
            serde_json::from_str::<TouchedResource>(&resource_json).unwrap(),
            resource
        );
        assert_eq!(
            serde_json::from_str::<VerificationResult>(&verification_json).unwrap(),
            verification
        );
        assert_eq!(
            serde_json::from_str::<MemoryPromotionCandidate>(&candidate_json).unwrap(),
            candidate
        );

        store.record_touched_resource(&resource).unwrap();
        store.record_verification_result(&verification).unwrap();
        let outcome = MemoryPromotionOutcome::Failed {
            failure_kind: ErrorKind::ToolError,
            reason: "test hook failure".into(),
        };
        store
            .record_memory_promotion_decision(&candidate, Some(&outcome))
            .unwrap();

        assert_eq!(store.touched_resource_count("run-metadata").unwrap(), 1);
        assert_eq!(store.verification_result_count("run-metadata").unwrap(), 1);
        assert_eq!(store.memory_promotion_count("run-metadata").unwrap(), 1);
    }

    #[test]
    fn trajectory_sink_extracts_resource_and_verification_records() {
        let store = test_store("run-trajectory");
        let metadata = TrajectoryMetadata::new().with_run_id("run-trajectory");
        store
            .record(TrajectoryEvent::ResourceTouched {
                metadata: metadata.clone(),
                resource: TouchedResource::new("note", "plan.md", ResourceOperation::Read),
            })
            .unwrap();
        store
            .record(TrajectoryEvent::VerificationRecorded {
                metadata,
                result: VerificationResult::new(
                    "Tool read_note completed",
                    VerificationStatus::Passed,
                    "Read note content",
                ),
            })
            .unwrap();

        assert_eq!(store.trajectory_event_count("run-trajectory").unwrap(), 2);
        assert_eq!(store.touched_resource_count("run-trajectory").unwrap(), 1);
        assert_eq!(
            store.verification_result_count("run-trajectory").unwrap(),
            1
        );
    }

    #[test]
    fn query_projection_returns_recent_runs_and_detail() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let store = AgentStateStore::for_database_path(
            project_root.join(".cutready").join("agent-state.db"),
            "run-query",
        )
        .unwrap();
        store
            .insert_run(
                None,
                "microsoft_foundry",
                "gpt-5-codex",
                serde_json::json!({"messages":2,"vision_enabled":true}),
            )
            .unwrap();
        store
            .record(TrajectoryEvent::TurnStarted {
                metadata: TrajectoryMetadata::new().with_run_id("run-query"),
                goal: "Summarize the first sketch".into(),
            })
            .unwrap();
        store
            .record(TrajectoryEvent::VerificationRecorded {
                metadata: TrajectoryMetadata::new().with_run_id("run-query"),
                result: VerificationResult::new(
                    "Result was valid",
                    VerificationStatus::Passed,
                    "Parsed successfully",
                ),
            })
            .unwrap();

        let runs = AgentStateStore::list_recent_runs(&project_root, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "run-query");
        assert_eq!(
            runs[0].initial_goal.as_deref(),
            Some("Summarize the first sketch")
        );
        assert_eq!(runs[0].trajectory_event_count, 2);
        assert_eq!(runs[0].verification_result_count, 1);

        let detail = AgentStateStore::get_run_detail(&project_root, "run-query")
            .unwrap()
            .unwrap();
        assert_eq!(detail.run.model, "gpt-5-codex");
        assert_eq!(detail.metadata["messages"], 2);
        assert_eq!(detail.trajectory_events.len(), 2);
        assert_eq!(detail.verification_results[0].criterion, "Result was valid");
    }

    #[test]
    fn query_projection_returns_empty_for_missing_database() {
        let project_root = tempfile::tempdir().unwrap().keep();
        assert!(AgentStateStore::list_recent_runs(&project_root, 10)
            .unwrap()
            .is_empty());
        assert!(AgentStateStore::get_run_detail(&project_root, "missing")
            .unwrap()
            .is_none());
    }

    #[test]
    fn retention_caps_append_only_rows_per_run() {
        let store = test_store("run-retention");
        for index in 0..(MAX_EVENTS_PER_RUN + 5) {
            store
                .record(TrajectoryEvent::Custom {
                    metadata: TrajectoryMetadata::new()
                        .with_run_id("run-retention")
                        .with_event_id(format!("event-{index}")),
                    name: "test".into(),
                    fields: Default::default(),
                })
                .unwrap();
        }

        assert_eq!(
            store.trajectory_event_count("run-retention").unwrap(),
            MAX_EVENTS_PER_RUN
        );
    }
}
