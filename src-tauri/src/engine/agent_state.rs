//! Project-scoped persistence for agent run state.
//!
//! Agentive owns the serializable observability/resumability models. CutReady
//! owns where those records are stored, how they are retained, and how future UI
//! surfaces will query them.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use agentive::{
    Checkpoint, CheckpointStore, MemoryPromotionCandidate, MemoryPromotionHook,
    MemoryPromotionOutcome, ResumeContext, TouchedResource, TrajectoryEvent, TrajectoryMetadata,
    TrajectorySink, VerificationResult,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use sha2::{Digest, Sha256};

const AGENT_STATE_FILENAME: &str = "agent-state.db";
const SCHEMA_VERSION: i32 = 6;
const BUSY_TIMEOUT: Duration = Duration::from_millis(750);
const MAX_COMPLETED_RUNS: usize = 100;
const MAX_EVENTS_PER_RUN: usize = 1_000;
const MAX_CHECKPOINTS_PER_RUN: usize = 25;
const MAX_RESUME_CONTEXTS_PER_RUN: usize = 25;
const MAX_TOUCHED_RESOURCES_PER_RUN: usize = 500;
const MAX_VERIFICATION_RESULTS_PER_RUN: usize = 500;
const MAX_MEMORY_PROMOTIONS_PER_RUN: usize = 200;
const MAX_CONTEXT_ASSET_BYTES: usize = 1_000_000;
const MAX_CONTEXT_ASSETS_PER_PROJECT: usize = 100;
const MAX_CONTEXT_SEARCH_RESULTS: usize = 6;

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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct AgentStateMaintenanceResult {
    pub deleted_runs: usize,
    pub deleted_rows: usize,
    pub size_before: u64,
    pub size_after: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ChatSessionSummary {
    pub session_id: String,
    pub title: String,
    pub preview: String,
    pub message_count: usize,
    pub source: String,
    pub source_path: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ChatSessionRecord {
    #[serde(flatten)]
    pub summary: ChatSessionSummary,
    pub messages: Vec<serde_json::Value>,
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ChatSessionPage {
    pub sessions: Vec<ChatSessionSummary>,
    pub has_more: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ContextAssetInput {
    pub name: String,
    pub origin: String,
    pub source: String,
    pub kind: String,
    pub content: String,
    pub content_type: String,
    pub scope: ContextAssetScope,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextAssetScope {
    Session,
    Project,
}

impl ContextAssetScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ContextAsset {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub source: String,
    pub kind: String,
    pub content_type: String,
    pub scope: ContextAssetScope,
    pub bytes: usize,
    pub hash: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ContextAssetExcerpt {
    pub asset: ContextAsset,
    pub excerpt: String,
}

struct AgentStateCleanupResult {
    deleted_runs: usize,
    deleted_rows: usize,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryCleanupLedgerOperation {
    Apply,
    Undo,
}

impl HistoryCleanupLedgerOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Apply => "apply",
            Self::Undo => "undo",
        }
    }
}

impl AgentStateStore {
    pub fn for_project(
        repo_root: &Path,
        project_root: &Path,
        run_id: impl Into<String>,
    ) -> Result<Self, String> {
        let db_path = Self::ensure_database_for_project(repo_root, project_root)?;

        let store = Self {
            db_path: Arc::new(db_path),
            run_id: Arc::from(run_id.into()),
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn database_path_for_project(repo_root: &Path, project_root: &Path) -> PathBuf {
        crate::engine::project::git_state_dir(&repo_root, project_root).join(AGENT_STATE_FILENAME)
    }

    pub fn prepare_database_path_for_project(
        repo_root: &Path,
        project_root: &Path,
    ) -> Result<PathBuf, String> {
        let state_dir = validate_agent_state_directory(repo_root, project_root)?;
        std::fs::create_dir_all(&state_dir)
            .map_err(|e| format!("Could not create CutReady agent state directory: {e}"))?;
        let state_dir = validate_agent_state_directory(repo_root, project_root)?;
        let db_path = state_dir.join(AGENT_STATE_FILENAME);
        migrate_legacy_project_database(repo_root, project_root, &db_path)?;
        Ok(db_path)
    }

    pub fn ensure_database_for_project(
        repo_root: &Path,
        project_root: &Path,
    ) -> Result<PathBuf, String> {
        let db_path = Self::prepare_database_path_for_project(repo_root, project_root)?;
        let state_dir = validate_agent_state_directory(repo_root, project_root)?;
        if db_path != state_dir.join(AGENT_STATE_FILENAME) {
            return Err(
                "Refusing to open an agent state database outside the validated state directory"
                    .into(),
            );
        }
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Could not open CutReady agent state database: {e}"))?;
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(|e| format!("Could not configure agent state database timeout: {e}"))?;
        initialize_schema(&conn)?;
        import_legacy_chat_sessions(&conn, repo_root, project_root)?;
        Ok(db_path)
    }

    pub fn store_context_asset(&self, input: ContextAssetInput) -> Result<ContextAsset, String> {
        let normalized = input.content.trim().to_string();
        if normalized.is_empty() {
            return Err("Cannot store empty context".into());
        }
        if normalized.len() > MAX_CONTEXT_ASSET_BYTES {
            return Err(format!(
                "Context is too large to store locally (maximum {MAX_CONTEXT_ASSET_BYTES} characters)"
            ));
        }

        let now = Utc::now();
        let hash = format!("{:x}", Sha256::digest(normalized.as_bytes()));
        let id = uuid::Uuid::new_v4().to_string();
        let expires_at = match input.scope {
            ContextAssetScope::Session => Some(now + chrono::Duration::hours(24)),
            ContextAssetScope::Project => None,
        };
        let asset = ContextAsset {
            id,
            name: input.name,
            origin: input.origin,
            source: input.source,
            kind: input.kind,
            content_type: input.content_type,
            scope: input.scope,
            bytes: normalized.len(),
            hash,
            created_at: now,
            expires_at,
        };

        let conn = self.connect()?;
        conn.execute(
            "INSERT INTO context_assets
                (id, owner_run_id, name, origin, source, kind, content_type, scope, bytes, hash, content, created_at, expires_at, last_accessed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?12)",
            params![
                asset.id,
                self.run_id(),
                asset.name,
                asset.origin,
                asset.source,
                asset.kind,
                asset.content_type,
                asset.scope.as_str(),
                asset.bytes,
                asset.hash,
                normalized,
                asset.created_at.to_rfc3339(),
                asset.expires_at.map(|value| value.to_rfc3339()),
            ],
        )
        .map_err(|e| format!("Could not store context asset: {e}"))?;
        prune_context_assets(&conn)?;
        Ok(asset)
    }

    pub fn read_context_asset(
        &self,
        asset_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<ContextAssetExcerpt, String> {
        let conn = self.connect()?;
        let row = query_context_asset(&conn, asset_id)?
            .ok_or_else(|| "Context reference is unavailable or expired".to_string())?;
        if row.owner_run_id != self.run_id() && row.asset.scope != ContextAssetScope::Project {
            return Err("Context reference is outside this agent run".into());
        }

        let safe_limit = limit.clamp(1, 12_000);
        let start = floor_char_boundary(&row.content, offset.min(row.content.len()));
        let end = floor_char_boundary(
            &row.content,
            start.saturating_add(safe_limit).min(row.content.len()),
        );
        let excerpt = row.content[start..end].to_string();
        conn.execute(
            "UPDATE context_assets SET last_accessed_at = ?2 WHERE id = ?1",
            params![asset_id, Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Could not update context asset access time: {e}"))?;
        Ok(ContextAssetExcerpt {
            asset: row.asset,
            excerpt,
        })
    }

    pub fn search_context_assets(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ContextAssetExcerpt>, String> {
        let conn = self.connect()?;
        let now = Utc::now().to_rfc3339();
        let terms = query
            .split_whitespace()
            .filter(|term| term.len() >= 3)
            .take(6)
            .collect::<Vec<_>>();
        if terms.is_empty() {
            return Ok(Vec::new());
        }

        let mut conditions = Vec::new();
        let mut params = Vec::new();
        for term in terms {
            conditions.push("(name LIKE ? OR origin LIKE ? OR content LIKE ?)");
            let pattern = format!("%{term}%");
            params.push(pattern.clone());
            params.push(pattern.clone());
            params.push(pattern);
        }
        let sql = format!(
            "SELECT id, owner_run_id, name, origin, source, kind, content_type, scope, bytes, hash, content, created_at, expires_at
             FROM context_assets
             WHERE (expires_at IS NULL OR expires_at > ?)
             AND (scope = 'project' OR owner_run_id = ?)
             AND ({})
             ORDER BY CASE scope WHEN 'project' THEN 0 ELSE 1 END, last_accessed_at DESC
             LIMIT ?",
            conditions.join(" OR ")
        );
        let mut values = vec![
            rusqlite::types::Value::Text(now),
            rusqlite::types::Value::Text(self.run_id().to_string()),
        ];
        values.extend(params.into_iter().map(rusqlite::types::Value::Text));
        values.push(rusqlite::types::Value::Integer(
            limit.clamp(1, MAX_CONTEXT_SEARCH_RESULTS) as i64,
        ));
        let mut statement = conn
            .prepare(&sql)
            .map_err(|e| format!("Could not prepare context search: {e}"))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(values), context_asset_row)
            .map_err(|e| format!("Could not search context assets: {e}"))?;
        rows.map(|row| {
            let row = row.map_err(|e| format!("Could not read context search result: {e}"))?;
            Ok(ContextAssetExcerpt {
                excerpt: bounded_context_excerpt(&row.content, 4_000),
                asset: row.asset,
            })
        })
        .collect()
    }

    pub fn record_history_cleanup_result(
        repo_root: &Path,
        project_root: &Path,
        operation: HistoryCleanupLedgerOperation,
        result: &draftline::TimelineCleanupResult,
    ) -> Result<(), String> {
        let db_path = Self::ensure_database_for_project(repo_root, project_root)?;
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Could not open CutReady agent state database: {e}"))?;
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(|e| format!("Could not configure agent state database timeout: {e}"))?;
        let ledger_json = serde_json::to_string(result).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO history_cleanup_ledgers
                (plan_id, operation, created_at, old_head, new_head, ledger_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                result.plan_id.to_string(),
                operation.as_str(),
                Utc::now().to_rfc3339(),
                result.old_head.to_string(),
                result.new_head.to_string(),
                ledger_json,
            ],
        )
        .map_err(|e| format!("Could not record history cleanup ledger: {e}"))?;
        Ok(())
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
        repo_root: &Path,
        project_root: &Path,
        limit: usize,
    ) -> Result<Vec<AgentRunSummary>, String> {
        let Some(conn) = Self::connect_existing_project_database(repo_root, project_root)? else {
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

    pub fn list_chat_sessions(
        repo_root: &Path,
        project_root: &Path,
        limit: usize,
        offset: usize,
    ) -> Result<ChatSessionPage, String> {
        let Some(conn) = Self::connect_existing_project_database(repo_root, project_root)? else {
            return Ok(ChatSessionPage {
                sessions: Vec::new(),
                has_more: false,
            });
        };
        let page_size = limit.clamp(1, 100);
        let mut stmt = conn
            .prepare(
                "SELECT session_id, title, preview, message_count, source, source_path, created_at, updated_at
                 FROM chat_sessions
                 ORDER BY datetime(updated_at) DESC, session_id DESC
                 LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| format!("Could not prepare chat session query: {e}"))?;
        let rows = stmt
            .query_map(
                params![page_size.saturating_add(1) as i64, offset as i64],
                Self::read_chat_session_summary,
            )
            .map_err(|e| format!("Could not query chat sessions: {e}"))?;
        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row.map_err(|e| format!("Could not read chat session row: {e}"))?);
        }
        let has_more = sessions.len() > page_size;
        sessions.truncate(page_size);
        Ok(ChatSessionPage { sessions, has_more })
    }

    pub fn get_chat_session(
        repo_root: &Path,
        project_root: &Path,
        session_id: &str,
    ) -> Result<Option<ChatSessionRecord>, String> {
        let Some(conn) = Self::connect_existing_project_database(repo_root, project_root)? else {
            return Ok(None);
        };
        conn.query_row(
            "SELECT session_id, title, preview, message_count, source, source_path, created_at, updated_at,
                    messages_json, metadata_json
             FROM chat_sessions WHERE session_id = ?1",
            params![session_id],
            |row| {
                let summary = Self::read_chat_session_summary(row)?;
                let messages_json: String = row.get(8)?;
                let metadata_json: String = row.get(9)?;
                let messages = serde_json::from_str(&messages_json).map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(
                        8,
                        rusqlite::types::Type::Text,
                        Box::new(err),
                    )
                })?;
                let metadata = serde_json::from_str(&metadata_json).map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(
                        9,
                        rusqlite::types::Type::Text,
                        Box::new(err),
                    )
                })?;
                Ok(ChatSessionRecord {
                    summary,
                    messages,
                    metadata,
                })
            },
        )
        .optional()
        .map_err(|e| format!("Could not read chat session: {e}"))
    }

    pub fn save_chat_session(
        repo_root: &Path,
        project_root: &Path,
        session_id: &str,
        title: &str,
        messages: &[serde_json::Value],
        metadata: serde_json::Value,
    ) -> Result<ChatSessionSummary, String> {
        let conn = Self::connect_project_database_for_write(repo_root, project_root)?;
        let messages_json = serde_json::to_string(messages)
            .map_err(|e| format!("Could not serialize chat transcript: {e}"))?;
        let metadata_json = serde_json::to_string(&metadata)
            .map_err(|e| format!("Could not serialize chat metadata: {e}"))?;
        let now = Utc::now().to_rfc3339();
        let normalized_title = nonempty_title(title, messages);
        let preview = transcript_preview(messages);
        let content_hash = format!("{:x}", Sha256::digest(messages_json.as_bytes()));
        conn.execute(
            "INSERT INTO chat_sessions
                (session_id, title, preview, message_count, source, source_path, content_hash, messages_json, metadata_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'chat_panel', NULL, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(session_id) DO UPDATE SET
                title = excluded.title,
                preview = excluded.preview,
                message_count = excluded.message_count,
                content_hash = excluded.content_hash,
                messages_json = excluded.messages_json,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at",
            params![
                session_id,
                normalized_title,
                preview,
                messages.len() as i64,
                content_hash,
                messages_json,
                metadata_json,
                now,
            ],
        )
        .map_err(|e| format!("Could not save chat session: {e}"))?;
        Self::get_chat_session(repo_root, project_root, session_id)?
            .map(|record| record.summary)
            .ok_or_else(|| "Saved chat session could not be reloaded".to_string())
    }

    pub fn clear_project_context_assets(
        repo_root: &Path,
        project_root: &Path,
    ) -> Result<usize, String> {
        let conn = Self::connect_project_database_for_write(repo_root, project_root)?;
        clear_project_context_assets_in(&conn)
    }

    pub fn get_run_detail(
        repo_root: &Path,
        project_root: &Path,
        run_id: &str,
    ) -> Result<Option<AgentRunDetail>, String> {
        let Some(conn) = Self::connect_existing_project_database(repo_root, project_root)? else {
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

    pub fn delete_run(
        repo_root: &Path,
        project_root: &Path,
        run_id: &str,
    ) -> Result<AgentStateMaintenanceResult, String> {
        let db_path = Self::ensure_database_for_project(repo_root, project_root)?;
        let size_before = database_size(&db_path);
        let conn = Self::connect_project_database_for_write(repo_root, project_root)?;
        let status = conn
            .query_row(
                "SELECT status FROM agent_runs WHERE run_id = ?1",
                params![run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("Could not inspect agent run before deletion: {e}"))?;
        if status
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("running"))
        {
            return Err("Cannot delete an agent run while it is still running".into());
        }
        let deleted_rows = delete_runs_matching(
            &conn,
            "SELECT run_id FROM agent_runs WHERE run_id = ?1",
            params![run_id],
        )?;
        Ok(AgentStateMaintenanceResult {
            deleted_runs: deleted_rows.deleted_runs,
            deleted_rows: deleted_rows.deleted_rows,
            size_before,
            size_after: database_size(&db_path),
        })
    }

    pub fn prune_completed_runs_for_project(
        repo_root: &Path,
        project_root: &Path,
        keep_recent: usize,
    ) -> Result<AgentStateMaintenanceResult, String> {
        let db_path = Self::ensure_database_for_project(repo_root, project_root)?;
        let size_before = database_size(&db_path);
        let conn = Self::connect_project_database_for_write(repo_root, project_root)?;
        let keep_recent = keep_recent.clamp(1, MAX_COMPLETED_RUNS);
        let cleanup = prune_completed_runs_keep(&conn, keep_recent)?;
        Ok(AgentStateMaintenanceResult {
            deleted_runs: cleanup.deleted_runs,
            deleted_rows: cleanup.deleted_rows,
            size_before,
            size_after: database_size(&db_path),
        })
    }

    pub fn compact_project_database(
        repo_root: &Path,
        project_root: &Path,
    ) -> Result<AgentStateMaintenanceResult, String> {
        let db_path = Self::ensure_database_for_project(repo_root, project_root)?;
        let size_before = database_size(&db_path);
        let conn = Self::connect_project_database_for_write(repo_root, project_root)?;
        conn.execute_batch("VACUUM;")
            .map_err(|e| format!("Could not compact agent state database: {e}"))?;
        Ok(AgentStateMaintenanceResult {
            deleted_runs: 0,
            deleted_rows: 0,
            size_before,
            size_after: database_size(&db_path),
        })
    }

    pub fn reconcile_abandoned_runs_for_project(
        repo_root: &Path,
        project_root: &Path,
        active_run_ids: &[String],
    ) -> Result<usize, String> {
        let conn = Self::connect_project_database_for_write(repo_root, project_root)?;
        let now = Utc::now().to_rfc3339();
        let mut sql =
            "UPDATE agent_runs SET status = 'interrupted', completed_at = ?1 WHERE status = 'running'"
                .to_string();
        let mut values = vec![now];
        if !active_run_ids.is_empty() {
            let placeholders = (0..active_run_ids.len())
                .map(|index| format!("?{}", index + 2))
                .collect::<Vec<_>>()
                .join(", ");
            sql.push_str(" AND run_id NOT IN (");
            sql.push_str(&placeholders);
            sql.push(')');
            values.extend(active_run_ids.iter().cloned());
        }

        conn.execute(&sql, rusqlite::params_from_iter(values.iter()))
            .map_err(|e| format!("Could not reconcile abandoned agent runs: {e}"))
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
        repo_root: &Path,
        project_root: &Path,
    ) -> Result<Option<Connection>, String> {
        Self::connect_project_database_for_write(repo_root, project_root).map(Some)
    }

    fn connect_project_database_for_write(
        repo_root: &Path,
        project_root: &Path,
    ) -> Result<Connection, String> {
        let db_path = Self::ensure_database_for_project(repo_root, project_root)?;
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Could not open CutReady agent state database: {e}"))?;
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(|e| format!("Could not configure agent state database timeout: {e}"))?;
        initialize_schema(&conn)?;
        Ok(conn)
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

    fn read_chat_session_summary(row: &Row<'_>) -> rusqlite::Result<ChatSessionSummary> {
        Ok(ChatSessionSummary {
            session_id: row.get(0)?,
            title: row.get(1)?,
            preview: row.get(2)?,
            message_count: row.get::<_, i64>(3)? as usize,
            source: row.get(4)?,
            source_path: row.get(5)?,
            created_at: parse_rfc3339_row(row.get::<_, String>(6)?, 6)?,
            updated_at: parse_rfc3339_row(row.get::<_, String>(7)?, 7)?,
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

    /// Append one canonical Prompty engine event to this run's trajectory.
    pub fn append_prompty_event(&self, event: &prompty::EngineEvent) -> Result<(), String> {
        self.validate_prompty_run(&event.session_id)?;
        let conn = self.connect()?;
        insert_prompty_event(&conn, self.run_id(), event)?;
        prune_by_run_limit(
            &conn,
            "trajectory_events",
            self.run_id(),
            MAX_EVENTS_PER_RUN,
        )
    }

    /// Atomically append canonical events and the checkpoint that contains them.
    pub fn append_prompty_events_with_checkpoint(
        &self,
        events: &[prompty::EngineEvent],
        checkpoint: &prompty::EngineCheckpoint,
    ) -> Result<(), String> {
        self.validate_prompty_run(&checkpoint.session_id)?;
        for event in events {
            self.validate_prompty_run(&event.session_id)?;
        }

        let mut conn = self.connect()?;
        let transaction = conn
            .transaction()
            .map_err(|e| format!("Could not begin Prompty durability transaction: {e}"))?;
        for event in events {
            insert_prompty_event(&transaction, self.run_id(), event)?;
        }
        let checkpoint_json = serde_json::to_string(checkpoint).map_err(|e| e.to_string())?;
        let created_at = events
            .last()
            .map(|event| event.timestamp.clone())
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        transaction
            .execute(
                "INSERT OR REPLACE INTO checkpoints
                    (id, run_id, created_at, checkpoint_json)
                 VALUES (?1, ?2, ?3, ?4)",
                params![checkpoint.id, self.run_id(), created_at, checkpoint_json],
            )
            .map_err(|e| format!("Could not save Prompty checkpoint: {e}"))?;
        prune_by_run_limit(
            &transaction,
            "trajectory_events",
            self.run_id(),
            MAX_EVENTS_PER_RUN,
        )?;
        prune_checkpoints_for_run(&transaction, self.run_id())?;
        transaction
            .commit()
            .map_err(|e| format!("Could not commit Prompty durability transaction: {e}"))
    }

    fn validate_prompty_run(&self, session_id: &str) -> Result<(), String> {
        if session_id == self.run_id() {
            Ok(())
        } else {
            Err(format!(
                "Prompty durability session '{}' does not match CutReady run '{}'",
                session_id,
                self.run_id()
            ))
        }
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

struct ContextAssetRow {
    owner_run_id: String,
    asset: ContextAsset,
    content: String,
}

fn query_context_asset(
    conn: &Connection,
    asset_id: &str,
) -> Result<Option<ContextAssetRow>, String> {
    conn.query_row(
        "SELECT id, owner_run_id, name, origin, source, kind, content_type, scope, bytes, hash, content, created_at, expires_at
         FROM context_assets
         WHERE id = ?1 AND (expires_at IS NULL OR expires_at > ?2)",
        params![asset_id, Utc::now().to_rfc3339()],
        context_asset_row,
    )
    .optional()
    .map_err(|e| format!("Could not read context asset: {e}"))
}

fn context_asset_row(row: &Row<'_>) -> rusqlite::Result<ContextAssetRow> {
    let scope = match row.get::<_, String>(7)?.as_str() {
        "project" => ContextAssetScope::Project,
        _ => ContextAssetScope::Session,
    };
    let created_at = parse_rfc3339_row(row.get::<_, String>(11)?, 11).map_err(|message| {
        rusqlite::Error::FromSqlConversionFailure(11, rusqlite::types::Type::Text, message.into())
    })?;
    let expires_at = row
        .get::<_, Option<String>>(12)?
        .map(|value| parse_rfc3339_row(value, 12))
        .transpose()
        .map_err(|message| {
            rusqlite::Error::FromSqlConversionFailure(
                12,
                rusqlite::types::Type::Text,
                message.into(),
            )
        })?;
    Ok(ContextAssetRow {
        owner_run_id: row.get(1)?,
        asset: ContextAsset {
            id: row.get(0)?,
            name: row.get(2)?,
            origin: row.get(3)?,
            source: row.get(4)?,
            kind: row.get(5)?,
            content_type: row.get(6)?,
            scope,
            bytes: row.get(8)?,
            hash: row.get(9)?,
            created_at,
            expires_at,
        },
        content: row.get(10)?,
    })
}

fn bounded_context_excerpt(content: &str, max_chars: usize) -> String {
    if content.len() <= max_chars {
        return content.to_string();
    }
    let end = floor_char_boundary(content, max_chars);
    format!(
        "{}\n\n[Stored context excerpt truncated. Use read_context_asset for more.]",
        &content[..end]
    )
}

fn floor_char_boundary(content: &str, offset: usize) -> usize {
    let mut index = offset.min(content.len());
    while index > 0 && !content.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn prune_context_assets(conn: &Connection) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "DELETE FROM context_assets WHERE expires_at IS NOT NULL AND expires_at <= ?1",
        params![now],
    )
    .map_err(|e| format!("Could not delete expired context assets: {e}"))?;
    conn.execute(
        "DELETE FROM context_assets
         WHERE id IN (
             SELECT id FROM context_assets
             WHERE scope = 'session'
             ORDER BY last_accessed_at DESC
             LIMIT -1 OFFSET ?1
         )",
        params![MAX_CONTEXT_ASSETS_PER_PROJECT as i64],
    )
    .map_err(|e| format!("Could not prune context assets: {e}"))?;
    Ok(())
}

fn clear_project_context_assets_in(conn: &Connection) -> Result<usize, String> {
    conn.execute("DELETE FROM context_assets WHERE scope = 'project'", [])
        .map_err(|e| format!("Could not clear saved context: {e}"))
}

fn nonempty_title(title: &str, messages: &[serde_json::Value]) -> String {
    let trimmed = title.trim();
    if !trimmed.is_empty() {
        return trimmed.chars().take(120).collect();
    }
    transcript_preview(messages)
        .chars()
        .take(120)
        .collect::<String>()
        .trim()
        .to_string()
}

fn transcript_preview(messages: &[serde_json::Value]) -> String {
    for message in messages {
        if message.get("role").and_then(serde_json::Value::as_str) != Some("user") {
            continue;
        }
        let Some(content) = message.get("content") else {
            continue;
        };
        let text = match content {
            serde_json::Value::String(value) => value.clone(),
            serde_json::Value::Array(parts) => parts
                .iter()
                .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                .collect::<Vec<_>>()
                .join(" "),
            _ => String::new(),
        };
        let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !normalized.is_empty() {
            return normalized.chars().take(240).collect();
        }
    }
    "Untitled conversation".into()
}

fn validate_agent_state_directory(
    repo_root: &Path,
    project_root: &Path,
) -> Result<PathBuf, String> {
    let canonical_repo_root = fs::canonicalize(repo_root)
        .map_err(|err| format!("Could not canonicalize repository root for agent state: {err}"))?;
    if !canonical_repo_root.is_dir() {
        return Err(format!(
            "Repository root for agent state is not a directory: {}",
            repo_root.display()
        ));
    }

    let configured_state_dir = crate::engine::project::git_state_dir(repo_root, project_root);
    let relative_state_dir = configured_state_dir.strip_prefix(repo_root).map_err(|_| {
        format!(
            "Agent state directory is not contained by repository root: {}",
            configured_state_dir.display()
        )
    })?;
    let state_components = relative_state_dir
        .components()
        .map(|component| match component {
            std::path::Component::Normal(component) => Ok(component.to_owned()),
            _ => Err(format!(
                "Agent state directory contains an unsafe path component: {}",
                configured_state_dir.display()
            )),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut state_dir = canonical_repo_root.clone();
    for component in state_components {
        state_dir.push(component);
        match fs::symlink_metadata(&state_dir) {
            Ok(metadata) => {
                if is_reparse_point(&metadata) {
                    return Err(format!(
                        "Refusing reparse-point agent state directory ancestor: {}",
                        state_dir.display()
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "Agent state directory ancestor is not a directory: {}",
                        state_dir.display()
                    ));
                }
                let canonical_ancestor = fs::canonicalize(&state_dir).map_err(|err| {
                    format!(
                        "Could not canonicalize agent state directory ancestor {}: {err}",
                        state_dir.display()
                    )
                })?;
                if !canonical_ancestor.starts_with(&canonical_repo_root) {
                    return Err(format!(
                        "Agent state directory ancestor resolves outside repository root: {}",
                        state_dir.display()
                    ));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
            Err(err) => {
                return Err(format!(
                    "Could not inspect agent state directory ancestor {}: {err}",
                    state_dir.display()
                ));
            }
        }
    }
    Ok(configured_state_dir)
}

fn migrate_legacy_project_database(
    repo_root: &Path,
    project_root: &Path,
    db_path: &Path,
) -> Result<(), String> {
    let state_dir = validate_agent_state_directory(repo_root, project_root)?;
    if db_path != state_dir.join(AGENT_STATE_FILENAME) {
        return Err(
            "Refusing to migrate an agent state database outside the validated state directory"
                .into(),
        );
    }
    match fs::symlink_metadata(db_path) {
        Ok(metadata) if is_reparse_point(&metadata) => {
            return Err(format!(
                "Refusing to use reparse-point CutReady agent state database destination: {}",
                db_path.display()
            ));
        }
        Ok(_) => return Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(format!(
                "Could not inspect CutReady agent state database destination: {err}"
            ));
        }
    }

    let legacy_path = project_root.join(".cutready").join(AGENT_STATE_FILENAME);
    let legacy_metadata = match fs::symlink_metadata(&legacy_path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(format!(
                "Could not inspect legacy CutReady agent state database: {err}"
            ));
        }
    };
    if is_reparse_point(&legacy_metadata) {
        return Err(format!(
            "Refusing to migrate reparse-point legacy CutReady agent state database: {}",
            legacy_path.display()
        ));
    }
    if !legacy_metadata.is_file() {
        return Err(format!(
            "Legacy CutReady agent state database is not a regular file: {}",
            legacy_path.display()
        ));
    }

    let canonical_project_root = fs::canonicalize(project_root).map_err(|err| {
        format!("Could not canonicalize project root for database migration: {err}")
    })?;
    let canonical_legacy_path = fs::canonicalize(&legacy_path).map_err(|err| {
        format!("Could not canonicalize legacy CutReady agent state database: {err}")
    })?;
    if !canonical_legacy_path.starts_with(&canonical_project_root) {
        return Err(format!(
            "Legacy CutReady agent state database resolves outside the project: {}",
            legacy_path.display()
        ));
    }

    std::fs::rename(&legacy_path, db_path)
        .or_else(|_| {
            std::fs::copy(&legacy_path, db_path)?;
            std::fs::remove_file(&legacy_path)
        })
        .map_err(|e| format!("Could not migrate legacy CutReady agent state database: {e}"))?;
    let destination_metadata = fs::symlink_metadata(db_path).map_err(|err| {
        format!("Could not inspect migrated CutReady agent state database: {err}")
    })?;
    if is_reparse_point(&destination_metadata) || !destination_metadata.is_file() {
        return Err(format!(
            "Migrated CutReady agent state database is not a regular non-reparse file: {}",
            db_path.display()
        ));
    }
    Ok(())
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

struct LegacyChatSourceDir {
    directory: PathBuf,
    provenance_root: PathBuf,
    failure_key: String,
}

fn import_legacy_chat_sessions(
    conn: &Connection,
    repo_root: &Path,
    project_root: &Path,
) -> Result<(), String> {
    let canonical_project_root = fs::canonicalize(project_root)
        .map_err(|err| format!("Could not canonicalize project root for chat migration: {err}"))?;
    let canonical_repo_root = fs::canonicalize(repo_root).map_err(|err| {
        format!("Could not canonicalize repository root for chat migration: {err}")
    })?;
    let state_dir = validate_agent_state_directory(repo_root, project_root)?;
    let canonical_state_dir = fs::canonicalize(&state_dir)
        .map_err(|err| format!("Could not canonicalize repository state directory: {err}"))?;

    let configured_sources = [
        (
            project_root.join(".chats"),
            canonical_project_root.clone(),
            canonical_project_root,
            ".chats",
        ),
        (
            state_dir.join("legacy-chats"),
            canonical_state_dir,
            canonical_repo_root,
            ".git/cutready/legacy-chats",
        ),
    ];
    let mut source_dirs = Vec::new();
    let mut seen_dirs = HashSet::new();
    for (configured_dir, containment_root, provenance_root, failure_key) in configured_sources {
        let configured_metadata = match fs::symlink_metadata(&configured_dir) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                let message = format!("Could not inspect configured chat directory: {err}");
                record_legacy_chat_import_failure(conn, failure_key, &message);
                log::warn!("[agent-state] {message}: {}", configured_dir.display());
                continue;
            }
        };
        if is_reparse_point(&configured_metadata) {
            let message = "Configured chat directory is a reparse point";
            record_legacy_chat_import_failure(conn, failure_key, message);
            log::warn!("[agent-state] {message}: {}", configured_dir.display());
            continue;
        }
        let canonical_dir = match fs::canonicalize(&configured_dir) {
            Ok(path) if path.starts_with(&containment_root) => path,
            Ok(_) => {
                let message = "Configured chat directory resolves outside its allowed state";
                record_legacy_chat_import_failure(conn, failure_key, message);
                log::warn!("[agent-state] {message}: {}", configured_dir.display());
                continue;
            }
            Err(err) => {
                let message = format!("Could not canonicalize configured chat directory: {err}");
                record_legacy_chat_import_failure(conn, failure_key, &message);
                log::warn!("[agent-state] {message}: {}", configured_dir.display());
                continue;
            }
        };
        if !canonical_dir.is_dir() {
            let message = "Configured chat source is not a directory";
            record_legacy_chat_import_failure(conn, failure_key, message);
            log::warn!("[agent-state] {message}: {}", configured_dir.display());
            continue;
        }
        if seen_dirs.insert(canonical_dir.clone()) {
            source_dirs.push(LegacyChatSourceDir {
                directory: canonical_dir,
                provenance_root,
                failure_key: failure_key.to_string(),
            });
        }
    }

    let mut seen_files = HashSet::new();
    for source_dir in source_dirs {
        import_legacy_chat_source_dir(conn, &source_dir, &mut seen_files)?;
    }
    Ok(())
}

fn import_legacy_chat_source_dir(
    conn: &Connection,
    source_dir: &LegacyChatSourceDir,
    seen_files: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(&source_dir.directory)
        .map_err(|err| format!("Could not read chat migration directory: {err}"))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                log::warn!("[agent-state] could not inspect chat migration file: {err}");
                continue;
            }
        };
        let source = entry.path();
        if !source
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("chat"))
        {
            continue;
        }

        let canonical_source = match fs::canonicalize(&source) {
            Ok(path) if path.starts_with(&source_dir.directory) && path.is_file() => path,
            Ok(_) => {
                let source_path =
                    normalized_legacy_source_path(&source_dir.provenance_root, &source)
                        .unwrap_or_else(|_| source_dir.failure_key.clone());
                let message = "Chat source is not a regular file within its configured directory";
                record_legacy_chat_import_failure(conn, &source_path, message);
                log::warn!("[agent-state] {message}: {}", source.display());
                continue;
            }
            Err(err) => {
                let source_path =
                    normalized_legacy_source_path(&source_dir.provenance_root, &source)
                        .unwrap_or_else(|_| source_dir.failure_key.clone());
                let message = format!("Could not canonicalize chat source: {err}");
                record_legacy_chat_import_failure(conn, &source_path, &message);
                log::warn!("[agent-state] {message}: {}", source.display());
                continue;
            }
        };
        if !seen_files.insert(canonical_source.clone()) {
            continue;
        }

        let source_path =
            normalized_legacy_source_path(&source_dir.provenance_root, &canonical_source)?;
        let data = match fs::read_to_string(&canonical_source) {
            Ok(data) => data,
            Err(err) => {
                record_legacy_chat_import_failure(
                    conn,
                    &source_path,
                    &format!("Could not read file: {err}"),
                );
                log::warn!("[agent-state] could not import chat {source_path}: {err}");
                continue;
            }
        };
        let session = match serde_json::from_str::<crate::engine::project::ChatSession>(&data) {
            Ok(session) => session,
            Err(err) => {
                record_legacy_chat_import_failure(
                    conn,
                    &source_path,
                    &format!("Invalid chat session JSON: {err}"),
                );
                log::warn!("[agent-state] could not import malformed chat {source_path}: {err}");
                continue;
            }
        };
        let content_hash = format!("{:x}", Sha256::digest(data.as_bytes()));
        if legacy_chat_import_is_verified(
            conn,
            &source_path,
            &content_hash,
            session.messages.len(),
        )? {
            remove_verified_legacy_chat_file(
                conn,
                &source,
                &source_path,
                &content_hash,
                &source_dir.directory,
            )?;
            continue;
        }

        let source_identity = format!("{source_path}\0{content_hash}");
        let run_id = format!(
            "legacy-chat-{}",
            &format!("{:x}", Sha256::digest(source_identity.as_bytes()))[..32]
        );
        import_legacy_chat_session(conn, &run_id, &source_path, &content_hash, &session)?;
        if !legacy_chat_import_is_verified(
            conn,
            &source_path,
            &content_hash,
            session.messages.len(),
        )? {
            return Err(format!(
                "Chat import verification failed for {source_path}; the original file was retained"
            ));
        }
        remove_verified_legacy_chat_file(
            conn,
            &source,
            &source_path,
            &content_hash,
            &source_dir.directory,
        )?;
    }
    Ok(())
}

fn normalized_legacy_source_path(root: &Path, source: &Path) -> Result<String, String> {
    let relative = source
        .strip_prefix(root)
        .map_err(|err| format!("Could not normalize legacy chat source path: {err}"))?;
    let components = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            std::path::Component::CurDir => None,
            _ => None,
        })
        .collect::<Vec<_>>();
    if components.is_empty() {
        return Err("Could not normalize empty legacy chat source path".into());
    }
    Ok(components.join("/"))
}

fn import_legacy_chat_session(
    conn: &Connection,
    run_id: &str,
    source_path: &str,
    content_hash: &str,
    session: &crate::engine::project::ChatSession,
) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|err| format!("Could not begin legacy chat import: {err}"))?;
    let result = (|| {
        let metadata = serde_json::json!({
            "legacy_import": true,
            "legacy_source_path": source_path,
            "legacy_content_hash": content_hash,
            "title": session.title,
            "author_name": session.author_name,
            "author_email": session.author_email,
            "original_created_at": session.created_at,
            "original_updated_at": session.updated_at,
            "message_count": session.messages.len(),
        });
        conn.execute(
            "INSERT OR REPLACE INTO agent_runs
                (run_id, parent_run_id, provider, model, status, started_at, completed_at, metadata_json)
             VALUES (?1, NULL, 'legacy_chat', ?2, 'imported_legacy', ?3, ?4, ?5)",
            params![
                run_id,
                session.title,
                session.created_at.to_rfc3339(),
                session.updated_at.to_rfc3339(),
                serde_json::to_string(&metadata).map_err(|err| err.to_string())?,
            ],
        )
        .map_err(|err| format!("Could not create imported legacy chat run: {err}"))?;
        conn.execute(
            "DELETE FROM trajectory_events WHERE run_id = ?1",
            params![run_id],
        )
        .map_err(|err| format!("Could not replace imported legacy transcript: {err}"))?;
        let transcript_json =
            serde_json::to_string(&session.messages).map_err(|err| err.to_string())?;
        let legacy_metadata = serde_json::json!({
            "legacy_import": true,
            "legacy_source_path": source_path,
            "legacy_content_hash": content_hash,
            "author_name": session.author_name,
            "author_email": session.author_email,
            "original_created_at": session.created_at,
            "original_updated_at": session.updated_at,
        });
        conn.execute(
            "INSERT INTO chat_sessions
                (session_id, title, preview, message_count, source, source_path, content_hash, messages_json, metadata_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'legacy_import', ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(session_id) DO UPDATE SET
                title = excluded.title,
                preview = excluded.preview,
                message_count = excluded.message_count,
                source = excluded.source,
                source_path = excluded.source_path,
                content_hash = excluded.content_hash,
                messages_json = excluded.messages_json,
                metadata_json = excluded.metadata_json,
                updated_at = excluded.updated_at",
            params![
                run_id,
                session.title,
                transcript_preview(&session.messages),
                session.messages.len() as i64,
                source_path,
                content_hash,
                transcript_json,
                serde_json::to_string(&legacy_metadata).map_err(|err| err.to_string())?,
                session.created_at.to_rfc3339(),
                session.updated_at.to_rfc3339(),
            ],
        )
        .map_err(|err| format!("Could not store imported legacy chat transcript: {err}"))?;
        conn.execute(
            "INSERT INTO trajectory_events
                (run_id, event_id, parent_event_id, iteration, event_type, event_json, created_at)
             VALUES (?1, NULL, NULL, NULL, 'turn_started', ?2, ?3)",
            params![
                run_id,
                serde_json::to_string(&serde_json::json!({
                    "goal": session.title,
                    "legacy_import": true,
                    "source_path": source_path,
                }))
                .map_err(|err| err.to_string())?,
                session.created_at.to_rfc3339(),
            ],
        )
        .map_err(|err| format!("Could not create imported legacy chat header: {err}"))?;
        for (index, message) in session.messages.iter().enumerate() {
            conn.execute(
                "INSERT INTO trajectory_events
                    (run_id, event_id, parent_event_id, iteration, event_type, event_json, created_at)
                 VALUES (?1, NULL, NULL, ?2, 'legacy_chat_message', ?3, ?4)",
                params![
                    run_id,
                    index as i64,
                    serde_json::to_string(&serde_json::json!({
                        "legacy_import": true,
                        "source_path": source_path,
                        "message_index": index,
                        "message": message,
                    }))
                    .map_err(|err| err.to_string())?,
                    session.updated_at.to_rfc3339(),
                ],
            )
            .map_err(|err| format!("Could not store imported legacy chat message: {err}"))?;
        }
        conn.execute(
            "INSERT INTO legacy_chat_imports
                (source_path, content_hash, run_id, original_created_at, original_updated_at, imported_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(source_path) DO UPDATE SET
                content_hash = excluded.content_hash,
                run_id = excluded.run_id,
                original_created_at = excluded.original_created_at,
                original_updated_at = excluded.original_updated_at,
                imported_at = excluded.imported_at",
            params![
                source_path,
                content_hash,
                run_id,
                session.created_at.to_rfc3339(),
                session.updated_at.to_rfc3339(),
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|err| format!("Could not record legacy chat import: {err}"))?;
        conn.execute(
            "DELETE FROM legacy_chat_import_failures WHERE source_path = ?1",
            params![source_path],
        )
        .map_err(|err| format!("Could not clear legacy chat import failure: {err}"))?;
        Ok::<(), String>(())
    })();
    match result {
        Ok(()) => conn
            .execute("COMMIT", [])
            .map(|_| ())
            .map_err(|err| format!("Could not commit legacy chat import: {err}")),
        Err(err) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(err)
        }
    }
}

fn legacy_chat_import_is_verified(
    conn: &Connection,
    source_path: &str,
    content_hash: &str,
    message_count: usize,
) -> Result<bool, String> {
    let expected_events = message_count + 1;
    conn.query_row(
        "SELECT COUNT(*)
         FROM legacy_chat_imports imports
         JOIN agent_runs runs ON runs.run_id = imports.run_id
         JOIN chat_sessions sessions ON sessions.session_id = imports.run_id
         WHERE imports.source_path = ?1
           AND imports.content_hash = ?2
           AND runs.status = 'imported_legacy'
           AND sessions.source = 'legacy_import'
           AND sessions.content_hash = ?2
           AND (SELECT COUNT(*) FROM trajectory_events events WHERE events.run_id = imports.run_id) = ?3",
        params![source_path, content_hash, expected_events as i64],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count == 1)
    .map_err(|err| format!("Could not verify legacy chat import: {err}"))
}

fn remove_verified_legacy_chat_file(
    conn: &Connection,
    source: &Path,
    source_path: &str,
    expected_content_hash: &str,
    containment_root: &Path,
) -> Result<(), String> {
    let quarantine = match quarantine_legacy_chat_file(source) {
        Ok(path) => path,
        Err(err) => {
            record_legacy_chat_import_failure(
                conn,
                source_path,
                &format!(
                    "Imported successfully but could not quarantine source before removal: {err}"
                ),
            );
            log::warn!(
                "[agent-state] imported chat {source_path} but retained its source file because it could not be quarantined: {err}"
            );
            return Ok(());
        }
    };

    let quarantined_path = match fs::canonicalize(&quarantine) {
        Ok(path) if path.starts_with(containment_root) && path.is_file() => path,
        Ok(_) => {
            restore_quarantined_legacy_chat_file(
                conn,
                source,
                &quarantine,
                source_path,
                "Quarantined chat source resolved outside its allowed state; retained it",
            );
            return Ok(());
        }
        Err(err) => {
            restore_quarantined_legacy_chat_file(
                conn,
                source,
                &quarantine,
                source_path,
                &format!("Could not canonicalize quarantined chat source: {err}"),
            );
            return Ok(());
        }
    };
    let current_data = match fs::read_to_string(&quarantined_path) {
        Ok(data) => data,
        Err(err) => {
            restore_quarantined_legacy_chat_file(
                conn,
                source,
                &quarantine,
                source_path,
                &format!("Could not re-read quarantined chat source: {err}"),
            );
            return Ok(());
        }
    };
    let current_hash = format!("{:x}", Sha256::digest(current_data.as_bytes()));
    if current_hash != expected_content_hash {
        restore_quarantined_legacy_chat_file(
            conn,
            source,
            &quarantine,
            source_path,
            "Imported successfully but source content changed before removal; retained the changed source file",
        );
        return Ok(());
    }
    if let Err(err) = fs::remove_file(&quarantine) {
        record_legacy_chat_import_failure(
            conn,
            source_path,
            &format!("Imported successfully but could not remove quarantined source file: {err}"),
        );
        log::warn!(
            "[agent-state] imported chat {source_path} but retained its quarantined source file: {err}"
        );
    }
    Ok(())
}

fn quarantine_legacy_chat_file(source: &Path) -> Result<PathBuf, std::io::Error> {
    let parent = source.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "chat source has no parent directory",
        )
    })?;
    let filename = source.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "chat source has no file name",
        )
    })?;
    for _ in 0..8 {
        let quarantine = parent.join(format!(
            ".{}.cutready-import-{}.quarantine",
            filename.to_string_lossy(),
            uuid::Uuid::new_v4()
        ));
        if quarantine.exists() {
            continue;
        }
        match fs::rename(source, &quarantine) {
            Ok(()) => return Ok(quarantine),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not create a unique quarantine path",
    ))
}

fn restore_quarantined_legacy_chat_file(
    conn: &Connection,
    source: &Path,
    quarantine: &Path,
    source_path: &str,
    failure: &str,
) {
    if source.exists() {
        record_legacy_chat_import_failure(
            conn,
            source_path,
            &format!(
                "{failure}; quarantined source retained at {}",
                quarantine.display()
            ),
        );
        return;
    }
    match fs::hard_link(quarantine, source).and_then(|_| fs::remove_file(quarantine)) {
        Ok(()) => record_legacy_chat_import_failure(conn, source_path, failure),
        Err(err) => record_legacy_chat_import_failure(
            conn,
            source_path,
            &format!(
                "{failure}; quarantined source retained at {} because it could not be restored: {err}",
                quarantine.display()
            ),
        ),
    }
}

fn record_legacy_chat_import_failure(conn: &Connection, source_path: &str, error: &str) {
    if let Err(record_error) = conn.execute(
        "INSERT INTO legacy_chat_import_failures (source_path, error, last_attempted_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(source_path) DO UPDATE SET
            error = excluded.error,
            last_attempted_at = excluded.last_attempted_at",
        params![source_path, error, Utc::now().to_rfc3339()],
    ) {
        log::warn!(
            "[agent-state] could not record legacy chat migration failure for {source_path}: {record_error}"
        );
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
        CREATE TABLE IF NOT EXISTS agent_memories (
            position INTEGER PRIMARY KEY,
            category TEXT NOT NULL,
            content TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            entry_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_memories_category
            ON agent_memories (category, position);
        CREATE TABLE IF NOT EXISTS history_cleanup_ledgers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id TEXT NOT NULL,
            operation TEXT NOT NULL,
            created_at TEXT NOT NULL,
            old_head TEXT NOT NULL,
            new_head TEXT NOT NULL,
            ledger_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_history_cleanup_ledgers_plan_id
            ON history_cleanup_ledgers (plan_id);
        CREATE INDEX IF NOT EXISTS idx_history_cleanup_ledgers_old_head
            ON history_cleanup_ledgers (old_head);
        CREATE TABLE IF NOT EXISTS context_assets (
            id TEXT PRIMARY KEY,
            owner_run_id TEXT NOT NULL,
            name TEXT NOT NULL,
            origin TEXT NOT NULL,
            source TEXT NOT NULL,
            kind TEXT NOT NULL,
            content_type TEXT NOT NULL,
            scope TEXT NOT NULL CHECK(scope IN ('session', 'project')),
            bytes INTEGER NOT NULL,
            hash TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            last_accessed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_assets_scope_access
            ON context_assets (scope, last_accessed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_context_assets_expiry
            ON context_assets (expires_at);
        CREATE TABLE IF NOT EXISTS legacy_chat_imports (
            source_path TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL,
            run_id TEXT NOT NULL,
            original_created_at TEXT NOT NULL,
            original_updated_at TEXT NOT NULL,
            imported_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_legacy_chat_imports_run
            ON legacy_chat_imports (run_id);
        CREATE TABLE IF NOT EXISTS legacy_chat_import_failures (
            source_path TEXT PRIMARY KEY,
            error TEXT NOT NULL,
            last_attempted_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_sessions (
            session_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            preview TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            source TEXT NOT NULL,
            source_path TEXT,
            content_hash TEXT NOT NULL,
            messages_json TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
            ON chat_sessions (updated_at DESC, session_id DESC);
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

fn insert_prompty_event(
    conn: &Connection,
    run_id: &str,
    event: &prompty::EngineEvent,
) -> Result<(), String> {
    let event_json = serde_json::to_string(event).map_err(|e| e.to_string())?;
    let event_type = serde_json::to_value(event.kind)
        .map_err(|e| e.to_string())?
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    conn.execute(
        "INSERT INTO trajectory_events
            (run_id, event_id, parent_event_id, iteration, event_type, event_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            run_id,
            event.id,
            event.invocation_id,
            event.iteration.map(|value| value as i64),
            event_type,
            event_json,
            event.timestamp,
        ],
    )
    .map_err(|e| format!("Could not insert Prompty trajectory event: {e}"))?;
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
    prune_completed_runs_keep(conn, MAX_COMPLETED_RUNS)?;
    Ok(())
}

fn prune_completed_runs_keep(
    conn: &Connection,
    keep_recent: usize,
) -> Result<AgentStateCleanupResult, String> {
    delete_runs_matching(
        conn,
        "SELECT run_id FROM agent_runs
         WHERE status != 'running'
           AND status != 'imported_legacy'
           AND completed_at IS NOT NULL
         ORDER BY datetime(completed_at) DESC, started_at DESC
         LIMIT -1 OFFSET ?1",
        params![keep_recent as i64],
    )
}

fn delete_runs_matching<P: rusqlite::Params>(
    conn: &Connection,
    run_id_query: &str,
    params: P,
) -> Result<AgentStateCleanupResult, String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| format!("Could not begin agent state cleanup: {e}"))?;
    let result = (|| {
        let mut stmt = conn
            .prepare(run_id_query)
            .map_err(|e| format!("Could not prepare run cleanup query: {e}"))?;
        let rows = stmt
            .query_map(params, |row| row.get::<_, String>(0))
            .map_err(|e| format!("Could not query runs for cleanup: {e}"))?;
        let mut run_ids = Vec::new();
        for row in rows {
            run_ids.push(row.map_err(|e| format!("Could not read run cleanup row: {e}"))?);
        }
        drop(stmt);

        let mut deleted_rows = 0usize;
        for run_id in &run_ids {
            for table in [
                "trajectory_events",
                "checkpoints",
                "resume_contexts",
                "touched_resources",
                "verification_results",
                "memory_promotions",
                "agent_runs",
            ] {
                deleted_rows += conn
                    .execute(
                        &format!("DELETE FROM {table} WHERE run_id = ?1"),
                        params![run_id],
                    )
                    .map_err(|e| format!("Could not delete {table} rows for run {run_id}: {e}"))?;
            }
        }
        Ok::<AgentStateCleanupResult, String>(AgentStateCleanupResult {
            deleted_runs: run_ids.len(),
            deleted_rows,
        })
    })();

    match result {
        Ok(cleanup) => {
            conn.execute("COMMIT", [])
                .map_err(|e| format!("Could not commit agent state cleanup: {e}"))?;
            Ok(cleanup)
        }
        Err(err) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(err)
        }
    }
}

fn database_size(path: &Path) -> u64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
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

    #[cfg(unix)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[cfg(unix)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    fn test_store(run_id: &str) -> AgentStateStore {
        let dir = tempfile::tempdir().unwrap().keep();
        AgentStateStore::for_database_path(dir.join(".cutready").join("agent-state.db"), run_id)
            .unwrap()
    }

    fn context_input(scope: ContextAssetScope, content: &str) -> ContextAssetInput {
        ContextAssetInput {
            name: "Reference".into(),
            origin: "https://example.com/reference".into(),
            source: "user_attachment".into(),
            kind: "web_excerpt".into(),
            content: content.into(),
            content_type: "text/plain".into(),
            scope,
        }
    }

    #[test]
    fn context_asset_round_trip_uses_bounded_character_safe_excerpts() {
        let store = test_store("run-context");
        let asset = store
            .store_context_asset(context_input(
                ContextAssetScope::Session,
                "alpha 🦀 beta gamma delta",
            ))
            .unwrap();

        let excerpt = store.read_context_asset(&asset.id, 6, 8).unwrap();

        assert_eq!(excerpt.asset.id, asset.id);
        assert!(excerpt.excerpt.is_char_boundary(excerpt.excerpt.len()));
        assert!(!excerpt.excerpt.is_empty());
    }

    #[test]
    fn transient_context_assets_are_isolated_between_runs() {
        let dir = tempfile::tempdir().unwrap().keep();
        let db_path = dir.join(".cutready").join("agent-state.db");
        let first = AgentStateStore::for_database_path(db_path.clone(), "run-one").unwrap();
        let second = AgentStateStore::for_database_path(db_path, "run-two").unwrap();
        let transient = first
            .store_context_asset(context_input(
                ContextAssetScope::Session,
                "isolated reference",
            ))
            .unwrap();
        let project = first
            .store_context_asset(context_input(
                ContextAssetScope::Project,
                "shared reference",
            ))
            .unwrap();

        assert!(second.read_context_asset(&transient.id, 0, 100).is_err());
        assert!(second.read_context_asset(&project.id, 0, 100).is_ok());
        let recalled = second
            .search_context_assets("please show the shared reference", 6)
            .unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].asset.id, project.id);
    }

    #[test]
    fn clearing_saved_context_preserves_transient_context() {
        let store = test_store("run-clear-context");
        let transient = store
            .store_context_asset(context_input(ContextAssetScope::Session, "keep transient"))
            .unwrap();
        store
            .store_context_asset(context_input(ContextAssetScope::Project, "forget project"))
            .unwrap();
        let conn = Connection::open(store.db_path()).unwrap();

        assert_eq!(clear_project_context_assets_in(&conn).unwrap(), 1);
        assert!(store.read_context_asset(&transient.id, 0, 100).is_ok());
        assert!(store
            .search_context_assets("project", 6)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn expired_context_assets_are_unavailable() {
        let store = test_store("run-expired-context");
        let asset = store
            .store_context_asset(context_input(ContextAssetScope::Session, "expires soon"))
            .unwrap();
        let conn = Connection::open(store.db_path()).unwrap();
        conn.execute(
            "UPDATE context_assets SET expires_at = ?2 WHERE id = ?1",
            params![
                asset.id,
                (Utc::now() - chrono::Duration::seconds(1)).to_rfc3339()
            ],
        )
        .unwrap();

        assert!(store.read_context_asset(&asset.id, 0, 100).is_err());
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
    fn history_cleanup_ledger_is_recorded_for_stale_resolution() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let old_head =
            draftline::VersionId::from_canonical_string("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                .unwrap();
        let new_head =
            draftline::VersionId::from_canonical_string("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
                .unwrap();
        let result = draftline::TimelineCleanupResult {
            plan_id: draftline::CleanupPlanId::from_string("cleanup-test-plan").unwrap(),
            old_head: old_head.clone(),
            new_head: new_head.clone(),
            backup_refs: vec![draftline::RefName::from(
                "refs/draftline/backups/history-cleanup/main/cleanup-test-plan",
            )],
            ref_updates: Vec::new(),
            commit_map: Vec::new(),
            snapshot_map: Vec::new(),
            warnings: Vec::new(),
        };

        AgentStateStore::record_history_cleanup_result(
            &project_root,
            &project_root,
            HistoryCleanupLedgerOperation::Apply,
            &result,
        )
        .unwrap();

        let db_path = AgentStateStore::database_path_for_project(&project_root, &project_root);
        let conn = Connection::open(db_path).unwrap();
        let (operation, old_head_recorded, new_head_recorded, ledger_json): (
            String,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT operation, old_head, new_head, ledger_json
                 FROM history_cleanup_ledgers
                 WHERE plan_id = ?1",
                params!["cleanup-test-plan"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(operation, "apply");
        assert_eq!(old_head_recorded, old_head.to_string());
        assert_eq!(new_head_recorded, new_head.to_string());
        let stored: draftline::TimelineCleanupResult = serde_json::from_str(&ledger_json).unwrap();
        assert_eq!(stored, result);
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
    fn for_project_uses_explicit_repo_local_state_and_migrates_legacy_database() {
        let project_root = tempfile::tempdir().unwrap().keep();

        let legacy_path = project_root.join(".cutready").join("agent-state.db");
        std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        drop(Connection::open(&legacy_path).unwrap());

        let store =
            AgentStateStore::for_project(&project_root, &project_root, "run-local-state").unwrap();

        assert_eq!(
            store.db_path(),
            AgentStateStore::database_path_for_project(&project_root, &project_root)
        );
        assert!(store.db_path().exists());
        assert!(!legacy_path.exists());
    }

    #[test]
    fn legacy_database_reparse_point_is_rejected_when_supported() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let external_root = tempfile::tempdir().unwrap().keep();
        let external_database = external_root.join(AGENT_STATE_FILENAME);
        fs::write(&external_database, "not a database").unwrap();
        let legacy_path = project_root.join(".cutready").join(AGENT_STATE_FILENAME);
        fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        if create_file_symlink(&external_database, &legacy_path).is_err() {
            return;
        }

        let err =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap_err();

        assert!(err.contains("reparse-point legacy"));
        assert!(legacy_path.exists());
    }

    #[test]
    fn legacy_database_must_resolve_within_project_when_supported() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let external_root = tempfile::tempdir().unwrap().keep();
        let external_state_dir = external_root.join(".cutready");
        fs::create_dir_all(&external_state_dir).unwrap();
        fs::write(
            external_state_dir.join(AGENT_STATE_FILENAME),
            "not a database",
        )
        .unwrap();
        let legacy_dir = project_root.join(".cutready");
        if create_dir_symlink(&external_state_dir, &legacy_dir).is_err() {
            return;
        }

        let err =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap_err();

        assert!(err.contains("resolves outside the project"));
    }

    #[test]
    fn destination_database_reparse_point_is_rejected_when_supported() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let external_root = tempfile::tempdir().unwrap().keep();
        let destination = AgentStateStore::database_path_for_project(&project_root, &project_root);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let external_database = external_root.join(AGENT_STATE_FILENAME);
        fs::write(&external_database, "not a database").unwrap();
        if create_file_symlink(&external_database, &destination).is_err() {
            return;
        }

        let err =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap_err();

        assert!(err.contains("reparse-point CutReady agent state database destination"));
    }

    #[test]
    fn reparse_point_state_directory_is_rejected_before_chat_source_removal_when_supported() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let external_root = tempfile::tempdir().unwrap().keep();
        let external_state_dir = external_root.join("cutready");
        fs::create_dir_all(&external_state_dir).unwrap();
        fs::create_dir_all(project_root.join(".git")).unwrap();
        let state_dir = project_root.join(".git/cutready");
        if create_dir_symlink(&external_state_dir, &state_dir).is_err() {
            return;
        }

        let chats_dir = project_root.join(".chats");
        fs::create_dir_all(&chats_dir).unwrap();
        let source = chats_dir.join("planning.chat");
        fs::write(
            &source,
            serde_json::to_string(&crate::engine::project::ChatSession {
                title: "Keep source safe".into(),
                messages: vec![serde_json::json!({"role":"user","content":"Do not delete"})],
                created_at: "2025-06-01T10:00:00Z".parse().unwrap(),
                updated_at: "2025-06-01T10:01:00Z".parse().unwrap(),
                author_name: None,
                author_email: None,
            })
            .unwrap(),
        )
        .unwrap();

        let err =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap_err();

        assert!(err.contains("reparse-point agent state directory ancestor"));
        assert!(source.exists());
        assert!(!external_state_dir.join(AGENT_STATE_FILENAME).exists());
    }

    #[test]
    fn legacy_chat_import_preserves_transcript_provenance_and_removes_verified_source() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let chats_dir = project_root.join(".chats");
        fs::create_dir_all(&chats_dir).unwrap();
        let source = chats_dir.join("planning.chat");
        let created_at = "2025-06-01T10:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let updated_at = "2025-06-01T10:05:00Z".parse::<DateTime<Utc>>().unwrap();
        let session = crate::engine::project::ChatSession {
            title: "Plan the launch".into(),
            messages: vec![
                serde_json::json!({"role":"user","content":"Draft a launch plan"}),
                serde_json::json!({"role":"assistant","content":"Here is a plan"}),
            ],
            created_at,
            updated_at,
            author_name: Some("Ada".into()),
            author_email: Some("ada@example.test".into()),
        };
        fs::write(&source, serde_json::to_string(&session).unwrap()).unwrap();

        let db_path =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();

        assert!(!source.exists());
        let conn = Connection::open(&db_path).unwrap();
        let (run_id, status, started_at, completed_at, metadata): (
            String,
            String,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT run_id, status, started_at, completed_at, metadata_json
                 FROM agent_runs WHERE provider = 'legacy_chat'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(status, "imported_legacy");
        assert_eq!(started_at, created_at.to_rfc3339());
        assert_eq!(completed_at, updated_at.to_rfc3339());
        let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(metadata["title"], "Plan the launch");
        assert_eq!(metadata["legacy_source_path"], ".chats/planning.chat");
        assert_eq!(metadata["author_name"], "Ada");
        assert_eq!(
            metadata["original_created_at"],
            created_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        );
        let event_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM trajectory_events WHERE run_id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 3);
        let transcript: String = conn
            .query_row(
                "SELECT event_json FROM trajectory_events
                 WHERE run_id = ?1 AND event_type = 'legacy_chat_message'
                 ORDER BY id ASC LIMIT 1",
                params![run_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&transcript).unwrap()["message"]["content"],
            "Draft a launch plan"
        );

        AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();
        let imported_runs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE provider = 'legacy_chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(imported_runs, 1);
    }

    #[test]
    fn archived_chat_imports_before_workspace_cleanup_and_keeps_source_identities() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let chats_dir = project_root.join(".chats");
        let archived_dir = project_root.join(".git/cutready/legacy-chats");
        fs::create_dir_all(&chats_dir).unwrap();
        fs::create_dir_all(&archived_dir).unwrap();
        let session = crate::engine::project::ChatSession {
            title: "Imported".into(),
            messages: vec![serde_json::json!({"role":"user","content":"Keep both sources"})],
            created_at: "2025-06-01T10:00:00Z".parse().unwrap(),
            updated_at: "2025-06-01T10:01:00Z".parse().unwrap(),
            author_name: None,
            author_email: None,
        };
        let serialized = serde_json::to_string(&session).unwrap();
        let project_source = chats_dir.join("project.chat");
        let archived_source = archived_dir.join("archived.chat");
        fs::write(&project_source, &serialized).unwrap();
        fs::write(&archived_source, &serialized).unwrap();

        let db_path =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();

        assert!(!project_source.exists());
        assert!(!archived_source.exists());
        let conn = Connection::open(db_path).unwrap();
        let sources = conn
            .prepare(
                "SELECT source_path FROM legacy_chat_imports
                 ORDER BY source_path",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            sources,
            vec![
                ".chats/project.chat".to_string(),
                ".git/cutready/legacy-chats/archived.chat".to_string(),
            ]
        );
    }

    #[test]
    fn chat_import_rejects_external_symlink_when_supported() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let external_root = tempfile::tempdir().unwrap().keep();
        let chats_dir = project_root.join(".chats");
        fs::create_dir_all(&chats_dir).unwrap();
        let external_source = external_root.join("outside.chat");
        fs::write(
            &external_source,
            serde_json::to_string(&crate::engine::project::ChatSession {
                title: "Outside".into(),
                messages: vec![serde_json::json!({"role":"user","content":"Do not import"})],
                created_at: "2025-06-01T10:00:00Z".parse().unwrap(),
                updated_at: "2025-06-01T10:01:00Z".parse().unwrap(),
                author_name: None,
                author_email: None,
            })
            .unwrap(),
        )
        .unwrap();
        let source_link = chats_dir.join("escape.chat");
        if create_file_symlink(&external_source, &source_link).is_err() {
            return;
        }

        let db_path =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();

        assert!(source_link.exists());
        assert!(external_source.exists());
        let conn = Connection::open(db_path).unwrap();
        let runs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE provider = 'legacy_chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(runs, 0);
        let failure: String = conn
            .query_row(
                "SELECT error FROM legacy_chat_import_failures WHERE source_path = '.chats/escape.chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(failure.contains("configured directory"));
    }

    #[test]
    fn chat_import_rejects_reparse_source_directories_when_supported() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let external_root = tempfile::tempdir().unwrap().keep();
        let external_chats = external_root.join("chats");
        let external_archived = external_root.join("archived");
        fs::create_dir_all(&external_chats).unwrap();
        fs::create_dir_all(&external_archived).unwrap();
        let session = serde_json::to_string(&crate::engine::project::ChatSession {
            title: "Outside".into(),
            messages: vec![serde_json::json!({"role":"user","content":"Do not import"})],
            created_at: "2025-06-01T10:00:00Z".parse().unwrap(),
            updated_at: "2025-06-01T10:01:00Z".parse().unwrap(),
            author_name: None,
            author_email: None,
        })
        .unwrap();
        fs::write(external_chats.join("project.chat"), &session).unwrap();
        fs::write(external_archived.join("archived.chat"), session).unwrap();

        let db_path =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();
        let chats_dir = project_root.join(".chats");
        let archived_dir = project_root.join(".git/cutready/legacy-chats");
        if create_dir_symlink(&external_chats, &chats_dir).is_err()
            || create_dir_symlink(&external_archived, &archived_dir).is_err()
        {
            return;
        }

        AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();

        let conn = Connection::open(db_path).unwrap();
        for source_path in [".chats", ".git/cutready/legacy-chats"] {
            let failure: String = conn
                .query_row(
                    "SELECT error FROM legacy_chat_import_failures WHERE source_path = ?1",
                    params![source_path],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(failure.contains("reparse point"));
        }
        let runs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE provider = 'legacy_chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(runs, 0);
        assert!(chats_dir.exists());
        assert!(archived_dir.exists());
    }

    #[test]
    fn chat_import_requires_sources_to_remain_within_configured_directory_when_supported() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let chats_dir = project_root.join(".chats");
        fs::create_dir_all(&chats_dir).unwrap();
        let external_source = project_root.join("outside.chat");
        fs::write(
            &external_source,
            serde_json::to_string(&crate::engine::project::ChatSession {
                title: "Outside configured directory".into(),
                messages: vec![serde_json::json!({"role":"user","content":"Do not import"})],
                created_at: "2025-06-01T10:00:00Z".parse().unwrap(),
                updated_at: "2025-06-01T10:01:00Z".parse().unwrap(),
                author_name: None,
                author_email: None,
            })
            .unwrap(),
        )
        .unwrap();
        let source_link = chats_dir.join("inside-link.chat");
        if create_file_symlink(&external_source, &source_link).is_err() {
            return;
        }

        let db_path =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();

        assert!(source_link.exists());
        assert!(external_source.exists());
        let conn = Connection::open(db_path).unwrap();
        let runs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_runs WHERE provider = 'legacy_chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(runs, 0);
        let failure: String = conn
            .query_row(
                "SELECT error FROM legacy_chat_import_failures WHERE source_path = '.chats/inside-link.chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(failure.contains("configured directory"));
    }

    #[test]
    fn malformed_legacy_chat_is_retained_and_failure_is_recorded() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let chats_dir = project_root.join(".chats");
        fs::create_dir_all(&chats_dir).unwrap();
        let source = chats_dir.join("broken.chat");
        fs::write(&source, "{ not valid JSON").unwrap();

        let db_path =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();

        assert!(source.exists());
        let conn = Connection::open(db_path).unwrap();
        let failure: String = conn
            .query_row(
                "SELECT error FROM legacy_chat_import_failures WHERE source_path = '.chats/broken.chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(failure.contains("Invalid chat session JSON"));
    }

    #[test]
    fn legacy_chat_imports_with_identical_content_keep_distinct_source_identities() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let chats_dir = project_root.join(".chats");
        fs::create_dir_all(&chats_dir).unwrap();
        let session = crate::engine::project::ChatSession {
            title: "Same content".into(),
            messages: vec![serde_json::json!({"role":"user","content":"Same transcript"})],
            created_at: "2025-06-01T10:00:00Z".parse().unwrap(),
            updated_at: "2025-06-01T10:01:00Z".parse().unwrap(),
            author_name: None,
            author_email: None,
        };
        let serialized = serde_json::to_string(&session).unwrap();
        fs::write(chats_dir.join("first.chat"), &serialized).unwrap();
        fs::write(chats_dir.join("second.chat"), &serialized).unwrap();

        let db_path =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();
        let conn = Connection::open(db_path).unwrap();
        let runs = conn
            .prepare("SELECT run_id FROM agent_runs WHERE provider = 'legacy_chat' ORDER BY run_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(runs.len(), 2);
        assert_ne!(runs[0], runs[1]);
        let source_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM chat_sessions WHERE source = 'legacy_import'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_count, 2);
    }

    #[test]
    fn legacy_chat_source_changed_after_import_is_retained_and_reported() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let chats_dir = project_root.join(".chats");
        fs::create_dir_all(&chats_dir).unwrap();
        let db_path =
            AgentStateStore::ensure_database_for_project(&project_root, &project_root).unwrap();
        let source = chats_dir.join("race.chat");
        let session = crate::engine::project::ChatSession {
            title: "Race".into(),
            messages: vec![serde_json::json!({"role":"user","content":"Original"})],
            created_at: "2025-06-01T10:00:00Z".parse().unwrap(),
            updated_at: "2025-06-01T10:01:00Z".parse().unwrap(),
            author_name: None,
            author_email: None,
        };
        let original = serde_json::to_string(&session).unwrap();
        let hash = format!("{:x}", Sha256::digest(original.as_bytes()));
        fs::write(&source, &original).unwrap();
        let conn = Connection::open(db_path).unwrap();
        import_legacy_chat_session(
            &conn,
            "legacy-chat-race",
            ".chats/race.chat",
            &hash,
            &session,
        )
        .unwrap();
        fs::write(&source, "{\"changed\":true}").unwrap();

        remove_verified_legacy_chat_file(
            &conn,
            &source,
            ".chats/race.chat",
            &hash,
            &fs::canonicalize(&project_root).unwrap(),
        )
        .unwrap();

        assert!(source.exists());
        assert_eq!(fs::read_to_string(&source).unwrap(), "{\"changed\":true}");
        assert!(fs::read_dir(&chats_dir).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".quarantine")));
        let failure: String = conn
            .query_row(
                "SELECT error FROM legacy_chat_import_failures WHERE source_path = '.chats/race.chat'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(failure.contains("changed before removal"));
    }

    #[test]
    fn chat_session_round_trip_preserves_full_transcript_and_paginates() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let messages = vec![
            serde_json::json!({"role":"user","content":"Plan the launch"}),
            serde_json::json!({"role":"assistant","content":"Draft ready","tool_calls":[{"id":"call-1","function":{"name":"read_sketch","arguments":"{}"}}]}),
        ];
        AgentStateStore::save_chat_session(
            &project_root,
            &project_root,
            "session-one",
            "Launch planning",
            &messages,
            serde_json::json!({"source":"chat_panel","agent":"planner"}),
        )
        .unwrap();
        AgentStateStore::save_chat_session(
            &project_root,
            &project_root,
            "session-two",
            "Later conversation",
            &[serde_json::json!({"role":"user","content":"Second"})],
            serde_json::json!({}),
        )
        .unwrap();

        let first_page =
            AgentStateStore::list_chat_sessions(&project_root, &project_root, 1, 0).unwrap();
        assert_eq!(first_page.sessions.len(), 1);
        assert!(first_page.has_more);
        let second_page =
            AgentStateStore::list_chat_sessions(&project_root, &project_root, 1, 1).unwrap();
        assert_eq!(second_page.sessions.len(), 1);
        let restored =
            AgentStateStore::get_chat_session(&project_root, &project_root, "session-one")
                .unwrap()
                .unwrap();
        assert_eq!(restored.messages, messages);
        assert_eq!(restored.metadata["agent"], "planner");
        assert_eq!(restored.summary.preview, "Plan the launch");
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
        let store =
            AgentStateStore::for_project(&project_root, &project_root, "run-query").unwrap();
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

        let runs = AgentStateStore::list_recent_runs(&project_root, &project_root, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "run-query");
        assert_eq!(
            runs[0].initial_goal.as_deref(),
            Some("Summarize the first sketch")
        );
        assert_eq!(runs[0].trajectory_event_count, 2);
        assert_eq!(runs[0].verification_result_count, 1);

        let detail = AgentStateStore::get_run_detail(&project_root, &project_root, "run-query")
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
        assert!(
            AgentStateStore::list_recent_runs(&project_root, &project_root, 10)
                .unwrap()
                .is_empty()
        );
        assert!(
            AgentStateStore::get_run_detail(&project_root, &project_root, "missing")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn delete_run_removes_associated_runtime_rows() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let store =
            AgentStateStore::for_project(&project_root, &project_root, "run-delete").unwrap();
        store
            .insert_run(None, "openai", "gpt-4o", serde_json::json!({}))
            .unwrap();
        store
            .record(TrajectoryEvent::TurnStarted {
                metadata: TrajectoryMetadata::new().with_run_id("run-delete"),
                goal: "Delete this run".into(),
            })
            .unwrap();
        store
            .record_verification_result(&VerificationResult::new(
                "delete check",
                VerificationStatus::Passed,
                "ok",
            ))
            .unwrap();
        store.finish_run("completed").unwrap();

        let result =
            AgentStateStore::delete_run(&project_root, &project_root, "run-delete").unwrap();

        assert_eq!(result.deleted_runs, 1);
        assert!(result.deleted_rows >= 3);
        assert!(
            AgentStateStore::get_run_detail(&project_root, &project_root, "run-delete")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn delete_run_rejects_running_run() {
        let project_root = tempfile::tempdir().unwrap().keep();
        let store =
            AgentStateStore::for_project(&project_root, &project_root, "run-active").unwrap();
        store
            .insert_run(None, "openai", "gpt-4o", serde_json::json!({}))
            .unwrap();

        let err =
            AgentStateStore::delete_run(&project_root, &project_root, "run-active").unwrap_err();

        assert!(err.contains("still running"));
        assert!(
            AgentStateStore::get_run_detail(&project_root, &project_root, "run-active")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn prune_completed_runs_keeps_recent_and_running_runs() {
        let project_root = tempfile::tempdir().unwrap().keep();
        for (run_id, should_finish) in [
            ("run-old-1", true),
            ("run-old-2", true),
            ("run-keep", true),
            ("run-running", false),
        ] {
            let store = AgentStateStore::for_project(&project_root, &project_root, run_id).unwrap();
            store
                .insert_run(None, "openai", "gpt-4o", serde_json::json!({}))
                .unwrap();
            store
                .record(TrajectoryEvent::TurnStarted {
                    metadata: TrajectoryMetadata::new().with_run_id(run_id),
                    goal: run_id.into(),
                })
                .unwrap();
            if should_finish {
                store.finish_run("completed").unwrap();
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let imported =
            AgentStateStore::for_project(&project_root, &project_root, "legacy-history").unwrap();
        imported
            .insert_run(
                None,
                "legacy_chat",
                "Imported transcript",
                serde_json::json!({}),
            )
            .unwrap();
        imported.finish_run("completed").unwrap();
        Connection::open(imported.db_path())
            .unwrap()
            .execute(
                "UPDATE agent_runs SET status = 'imported_legacy' WHERE run_id = 'legacy-history'",
                [],
            )
            .unwrap();

        let result =
            AgentStateStore::prune_completed_runs_for_project(&project_root, &project_root, 1)
                .unwrap();
        let remaining =
            AgentStateStore::list_recent_runs(&project_root, &project_root, 10).unwrap();
        let remaining_ids: Vec<_> = remaining.iter().map(|run| run.run_id.as_str()).collect();

        assert_eq!(result.deleted_runs, 2);
        assert!(remaining_ids.contains(&"run-keep"));
        assert!(remaining_ids.contains(&"run-running"));
        assert!(remaining_ids.contains(&"legacy-history"));
        assert!(!remaining_ids.contains(&"run-old-1"));
        assert!(!remaining_ids.contains(&"run-old-2"));
    }

    #[test]
    fn reconcile_abandoned_runs_interrupts_only_inactive_running_runs() {
        let project_root = tempfile::tempdir().unwrap().keep();
        for run_id in ["run-stale", "run-active"] {
            let store = AgentStateStore::for_project(&project_root, &project_root, run_id).unwrap();
            store
                .insert_run(None, "openai", "gpt-4o", serde_json::json!({}))
                .unwrap();
        }

        let reconciled = AgentStateStore::reconcile_abandoned_runs_for_project(
            &project_root,
            &project_root,
            &[String::from("run-active")],
        )
        .unwrap();

        let stale_store =
            AgentStateStore::for_project(&project_root, &project_root, "reader").unwrap();
        let stale = stale_store.get_run("run-stale").unwrap().unwrap();
        let active = stale_store.get_run("run-active").unwrap().unwrap();
        assert_eq!(reconciled, 1);
        assert_eq!(stale.status, "interrupted");
        assert!(stale.completed_at.is_some());
        assert_eq!(active.status, "running");
        assert!(active.completed_at.is_none());
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
