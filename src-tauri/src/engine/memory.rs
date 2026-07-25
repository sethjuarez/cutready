//! Memory system — CutReady persistence + DTO over Prompty's canonical memory contract.
//!
//! The data model (`MemoryEntry`, `MemoryCategory`, `MemoryStore`), deterministic recall
//! (including the core-tier boost), core-only system-prompt formatting, tiered eviction, and
//! all store mutations are owned by Prompty (`prompty::memory`). CutReady owns only:
//!   * persistence of the whole-store snapshot — `SqliteBackend` implements `prompty::MemoryPort`
//!     over `.git/cutready/agent-state.db`.
//!   * a flat `MemoryDto` at the command boundary so the frontend Memory tab stays insulated
//!     from the canonical wire form.
//!   * a one-time read migration of agentive-era snake_case `created_at` rows.
//!
//! `MemoryCategory` is the canonical closed tier enum (`Core`/`Archival`/`Insight`, MemGPT-style).
//! The `session:{id}` archival tag is a host convention expressed through the general `tags` field.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

// Canonical data model + deterministic logic come from Prompty.
pub use prompty::{MemoryCategory, MemoryEntry, MemoryPort, MemoryStore, ScoredMemory};

// ---------------------------------------------------------------------------
// Host policy constants
// ---------------------------------------------------------------------------

/// Hard cap on stored memories; archival entries are evicted first (enforced by
/// `MemoryStore::remember` / `evict_to_cap`).
const MAX_MEMORIES: usize = 200;
/// Number of recall results surfaced to the agent.
const RECALL_LIMIT: usize = 10;

const AGENT_MEMORIES_TABLE: &str = "agent_memories";
const LEGACY_MEMORY_PATH: &str = ".cutready/memory.json";
static MEMORY_BACKEND_LOCK: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------
// Frontend DTO — stable host command contract
// ---------------------------------------------------------------------------

/// Flat memory shape returned to the frontend Memory tab. Preserves the stable host command
/// contract (`category` as a lowercase tier string, snake_case `created_at`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryDto {
    pub category: String,
    pub content: String,
    pub created_at: String,
    pub tags: Vec<String>,
}

impl From<&MemoryEntry> for MemoryDto {
    fn from(entry: &MemoryEntry) -> Self {
        Self {
            category: entry.category.as_str().to_string(),
            content: entry.content.clone(),
            created_at: entry.created_at.clone().unwrap_or_default(),
            tags: entry.tags.clone().unwrap_or_default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

fn make_entry(category: MemoryCategory, content: &str, tags: Vec<String>) -> MemoryEntry {
    MemoryEntry {
        content: content.to_string(),
        category,
        created_at: Some(chrono::Utc::now().to_rfc3339()),
        tags: if tags.is_empty() { None } else { Some(tags) },
    }
}

// ---------------------------------------------------------------------------
// Legacy read migration (agentive-era snake_case / `memories` JSON key)
// ---------------------------------------------------------------------------

/// One-time read migration for agentive-era rows. Renames snake_case `created_at` to the
/// canonical camelCase `createdAt`, and normalizes any interim object-form category
/// (`{"kind":"core"}`) back to the canonical bare string. No-op for already-canonical rows; the
/// next whole-store save rewrites the row in canonical form.
fn migrate_entry_value(value: &mut serde_json::Value) {
    let Some(obj) = value.as_object_mut() else {
        return;
    };
    if !obj.contains_key("createdAt") {
        if let Some(ts) = obj.remove("created_at") {
            obj.insert("createdAt".to_string(), ts);
        }
    }
    // Normalize a never-shipped interim object category back to the canonical bare string.
    if let Some(kind) = obj
        .get("category")
        .and_then(|c| c.get("kind"))
        .and_then(|k| k.as_str())
        .map(str::to_string)
    {
        obj.insert("category".to_string(), serde_json::Value::String(kind));
    }
}

fn parse_entry(json: &str) -> Result<MemoryEntry, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("Could not parse memory row: {e}"))?;
    migrate_entry_value(&mut value);
    serde_json::from_value(value).map_err(|e| format!("Could not hydrate memory row: {e}"))
}

/// Parse a whole-store JSON snapshot, tolerating both the canonical `entries` key and the
/// agentive-era `memories` key, and migrating each entry.
fn parse_store(data: &str) -> Result<MemoryStore, String> {
    let value: serde_json::Value =
        serde_json::from_str(data).map_err(|e| format!("Could not parse memory store: {e}"))?;
    let array = value
        .get("entries")
        .or_else(|| value.get("memories"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut entries = Vec::with_capacity(array.len());
    for mut item in array {
        migrate_entry_value(&mut item);
        entries.push(
            serde_json::from_value(item)
                .map_err(|e| format!("Could not hydrate memory entry: {e}"))?,
        );
    }
    Ok(MemoryStore { entries })
}

// ---------------------------------------------------------------------------
// SQLite persistence backend (host-owned MemoryPort)
// ---------------------------------------------------------------------------

/// Persists the whole memory store snapshot in the local agent-state database.
struct SqliteBackend {
    db_path: PathBuf,
    local_json_path: PathBuf,
    legacy_json_path: PathBuf,
}

impl SqliteBackend {
    fn new(repo_root: &Path, project_root: &Path) -> Result<Self, String> {
        let db_path = crate::engine::agent_state::AgentStateStore::ensure_database_for_project(
            repo_root,
            project_root,
        )?;
        Ok(Self {
            local_json_path: db_path.with_file_name("memory.json"),
            db_path,
            legacy_json_path: project_root.join(LEGACY_MEMORY_PATH),
        })
    }

    fn connect(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path)
            .map_err(|e| format!("Could not open CutReady agent state database: {e}"))
    }

    fn migrate_json_files(&self, conn: &Connection) -> Result<(), String> {
        self.migrate_json_file(conn, &self.local_json_path, "local memory store", true)?;
        self.migrate_json_file(conn, &self.legacy_json_path, "legacy memory store", false)
    }

    fn migrate_json_file(
        &self,
        conn: &Connection,
        path: &Path,
        label: &str,
        remove_after_import: bool,
    ) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }

        let data = std::fs::read_to_string(path)
            .map_err(|e| format!("Could not read {label} for migration: {e}"))?;
        let incoming = parse_store(&data)
            .map_err(|e| format!("Could not parse {label} for migration: {e}"))?;
        if !incoming.entries.is_empty() {
            let mut merged = load_store_from_conn(conn)?;
            for memory in incoming.entries {
                if !merged.entries.iter().any(|existing| {
                    existing.category == memory.category
                        && existing.content == memory.content
                        && existing.tags == memory.tags
                }) {
                    merged.entries.push(memory);
                }
            }
            save_store_to_conn(conn, &merged)?;
        }

        if remove_after_import {
            std::fs::remove_file(path)
                .map_err(|e| format!("Could not remove migrated {label}: {e}"))?;
        }
        log::info!(
            "[memory] imported {label} from {:?} into agent-state.db",
            path
        );
        Ok(())
    }
}

impl MemoryPort for SqliteBackend {
    fn load(&self) -> MemoryStore {
        let conn = match self.connect() {
            Ok(conn) => conn,
            Err(err) => {
                log::warn!("[memory] could not open memory database: {err}");
                return MemoryStore::default();
            }
        };
        if let Err(err) = self.migrate_json_files(&conn) {
            log::warn!("[memory] could not migrate memory JSON store: {err}");
        }
        load_store_from_conn(&conn).unwrap_or_else(|err| {
            log::warn!("[memory] could not load memory store: {err}");
            MemoryStore::default()
        })
    }

    fn save(&self, store: &MemoryStore) -> Result<(), String> {
        let conn = self.connect()?;
        self.migrate_json_files(&conn)?;
        save_store_to_conn(&conn, store)
    }
}

fn load_store_from_conn(conn: &Connection) -> Result<MemoryStore, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT entry_json FROM {AGENT_MEMORIES_TABLE} ORDER BY position ASC"
        ))
        .map_err(|e| format!("Could not prepare memory load query: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Could not query memories: {e}"))?;

    let mut entries = Vec::new();
    for row in rows {
        let json = row.map_err(|e| format!("Could not read memory row: {e}"))?;
        entries.push(parse_entry(&json)?);
    }
    Ok(MemoryStore { entries })
}

fn save_store_to_conn(conn: &Connection, store: &MemoryStore) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| format!("Could not begin memory save transaction: {e}"))?;
    let result = (|| {
        conn.execute(&format!("DELETE FROM {AGENT_MEMORIES_TABLE}"), [])
            .map_err(|e| format!("Could not clear existing memories: {e}"))?;
        for (position, memory) in store.entries.iter().enumerate() {
            insert_memory_row(conn, position, memory)?;
        }
        Ok::<(), String>(())
    })();

    match result {
        Ok(()) => conn
            .execute("COMMIT", [])
            .map(|_| ())
            .map_err(|e| format!("Could not commit memory save transaction: {e}")),
        Err(err) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(err)
        }
    }
}

fn insert_memory_row(
    conn: &Connection,
    position: usize,
    memory: &MemoryEntry,
) -> Result<(), String> {
    let tags: Vec<String> = memory.tags.clone().unwrap_or_default();
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;
    let entry_json = serde_json::to_string(memory).map_err(|e| e.to_string())?;
    let created_at = memory.created_at.clone().unwrap_or_default();
    conn.execute(
        &format!(
            "INSERT INTO {AGENT_MEMORIES_TABLE}
                (position, category, content, tags_json, created_at, entry_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        ),
        params![
            position as i64,
            memory.category.as_str(),
            memory.content,
            tags_json,
            created_at,
            entry_json,
        ],
    )
    .map_err(|e| format!("Could not insert memory row: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Convenience functions (public module surface)
// ---------------------------------------------------------------------------

/// Load the whole memory store from disk.
pub fn load(repo_root: &Path, project_root: &Path) -> MemoryStore {
    let Ok(_guard) = MEMORY_BACKEND_LOCK.lock() else {
        log::warn!("[memory] memory backend lock is poisoned");
        return MemoryStore::default();
    };
    match SqliteBackend::new(repo_root, project_root) {
        Ok(backend) => backend.load(),
        Err(err) => {
            log::warn!("[memory] could not initialize memory backend: {err}");
            MemoryStore::default()
        }
    }
}

/// List all memories as flat DTOs for the frontend Memory tab.
pub fn list(repo_root: &Path, project_root: &Path) -> Vec<MemoryDto> {
    load(repo_root, project_root)
        .entries
        .iter()
        .map(MemoryDto::from)
        .collect()
}

/// Save a memory entry. Core dedup + archival-preferred cap eviction are applied by
/// `MemoryStore::remember`, then the whole store is persisted.
pub fn save_memory(
    repo_root: &Path,
    project_root: &Path,
    category: MemoryCategory,
    content: &str,
    tags: Vec<String>,
) -> Result<(), String> {
    let _guard = MEMORY_BACKEND_LOCK
        .lock()
        .map_err(|e| format!("Could not lock memory backend: {e}"))?;
    let backend = SqliteBackend::new(repo_root, project_root)?;
    let mut store = backend.load();
    store.remember(make_entry(category, content, tags), MAX_MEMORIES);
    backend.save(&store)
}

/// Search memories by keyword. Returns up to `RECALL_LIMIT` deterministically scored results.
pub fn recall(repo_root: &Path, project_root: &Path, query: &str) -> Vec<ScoredMemory> {
    let store = load(repo_root, project_root);
    log::debug!(
        "[memory] recall query='{}' across {} memories",
        query,
        store.len()
    );
    let results = store.recall(query, RECALL_LIMIT);
    log::debug!("[memory] recall returned {} results", results.len());
    results
}

/// Format core memories for injection into the system prompt (engine-owned, core-only).
pub fn format_for_system_prompt(repo_root: &Path, project_root: &Path) -> String {
    load(repo_root, project_root).format_for_system_prompt()
}

/// Format recall results for the agent. Preserves the host "no results" message; otherwise
/// delegates to the canonical formatter.
pub fn format_recall_results(results: &[ScoredMemory]) -> String {
    if results.is_empty() {
        return "No memories found matching that query.".to_string();
    }
    prompty::format_recall_results(results)
}

/// Save a session summary as an archival memory tagged `session:{session_id}`.
pub fn archive_session(
    repo_root: &Path,
    project_root: &Path,
    summary: &str,
    session_id: &str,
) -> Result<(), String> {
    save_memory(
        repo_root,
        project_root,
        MemoryCategory::Archival,
        summary,
        vec![format!("session:{session_id}")],
    )
}

/// Delete a memory by index.
pub fn delete_memory(repo_root: &Path, project_root: &Path, index: usize) -> Result<(), String> {
    let _guard = MEMORY_BACKEND_LOCK
        .lock()
        .map_err(|e| format!("Could not lock memory backend: {e}"))?;
    let backend = SqliteBackend::new(repo_root, project_root)?;
    let mut store = backend.load();
    store.remove(index)?;
    backend.save(&store)
}

/// Update a memory's content by index, preserving its category, timestamp, and tags.
pub fn update_memory(
    repo_root: &Path,
    project_root: &Path,
    index: usize,
    content: &str,
) -> Result<(), String> {
    let _guard = MEMORY_BACKEND_LOCK
        .lock()
        .map_err(|e| format!("Could not lock memory backend: {e}"))?;
    let backend = SqliteBackend::new(repo_root, project_root)?;
    let mut store = backend.load();
    store.update_content(index, content)?;
    backend.save(&store)
}

/// Delete all memories of a given tier, or all if `category` is `None`. Returns the number removed.
pub fn clear_memories(
    repo_root: &Path,
    project_root: &Path,
    category: Option<MemoryCategory>,
) -> Result<usize, String> {
    let _guard = MEMORY_BACKEND_LOCK
        .lock()
        .map_err(|e| format!("Could not lock memory backend: {e}"))?;
    let backend = SqliteBackend::new(repo_root, project_root)?;
    let mut store = backend.load();
    let removed = store.clear(category);
    backend.save(&store)?;
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn memory_row_count(root: &Path) -> usize {
        let db_path =
            crate::engine::agent_state::AgentStateStore::database_path_for_project(root, root);
        let conn = Connection::open(db_path).unwrap();
        conn.query_row("SELECT COUNT(*) FROM agent_memories", [], |row| {
            row.get::<_, usize>(0)
        })
        .unwrap()
    }

    fn raw_entry_json(root: &Path, position: usize) -> String {
        let db_path =
            crate::engine::agent_state::AgentStateStore::database_path_for_project(root, root);
        let conn = Connection::open(db_path).unwrap();
        conn.query_row(
            "SELECT entry_json FROM agent_memories WHERE position = ?1",
            params![position as i64],
            |row| row.get::<_, String>(0),
        )
        .unwrap()
    }

    #[test]
    fn save_and_load_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        save_memory(
            root,
            root,
            MemoryCategory::Core,
            "User prefers short narration",
            vec!["preference".into()],
        )
        .unwrap();
        save_memory(
            root,
            root,
            MemoryCategory::Insight,
            "Dashboard demo needs more detail",
            vec!["demo".into()],
        )
        .unwrap();

        let store = load(root, root);
        assert_eq!(store.len(), 2);
        assert_eq!(store.entries[0].content, "User prefers short narration");
        assert_eq!(store.entries[0].category, MemoryCategory::Core);
        assert!(root.join(".git/cutready/agent-state.db").exists());
        assert_eq!(memory_row_count(root), 2);
        assert!(!root.join(".git/cutready/memory.json").exists());
        assert!(!root.join(".cutready/memory.json").exists());
    }

    #[test]
    fn persisted_rows_are_canonical_camelcase_bare_category() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        save_memory(
            root,
            root,
            MemoryCategory::Core,
            "Use concise narration",
            vec!["style".into()],
        )
        .unwrap();

        let json = raw_entry_json(root, 0);
        assert!(
            json.contains("\"createdAt\""),
            "expected camelCase createdAt: {json}"
        );
        assert!(
            !json.contains("\"created_at\""),
            "snake_case must not persist: {json}"
        );
        // Category serializes as a bare lowercase string (no {kind,label} object).
        assert!(
            json.contains("\"category\": \"core\"") || json.contains("\"category\":\"core\""),
            "category must be a bare string: {json}"
        );
        assert!(
            !json.contains("\"kind\""),
            "no object-form category: {json}"
        );
        assert!(
            !json.contains("\"importance\""),
            "importance is not a canonical field: {json}"
        );
    }

    #[test]
    fn legacy_snake_case_row_migrates_on_load() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Ensure the database + table exist, then plant a legacy agentive-era row directly.
        let _ = load(root, root);
        let db_path =
            crate::engine::agent_state::AgentStateStore::database_path_for_project(root, root);
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO agent_memories (position, category, content, tags_json, created_at, entry_json)
             VALUES (0, 'core', 'Legacy fact', '[\"t\"]', '2026-01-01T00:00:00Z',
                 '{\"category\":\"core\",\"content\":\"Legacy fact\",\"created_at\":\"2026-01-01T00:00:00Z\",\"tags\":[\"t\"]}')",
            [],
        )
        .unwrap();

        let store = load(root, root);
        assert_eq!(store.len(), 1);
        let entry = &store.entries[0];
        assert_eq!(entry.category, MemoryCategory::Core);
        assert_eq!(
            entry.created_at.as_deref(),
            Some("2026-01-01T00:00:00Z"),
            "snake_case created_at must survive migration"
        );
        assert_eq!(entry.tags.as_deref(), Some(&["t".to_string()][..]));
    }

    #[test]
    fn recall_finds_by_keyword() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        save_memory(
            root,
            root,
            MemoryCategory::Core,
            "User prefers TypeScript",
            vec!["language".into()],
        )
        .unwrap();
        save_memory(
            root,
            root,
            MemoryCategory::Insight,
            "Dashboard needs chart builder",
            vec!["dashboard".into()],
        )
        .unwrap();
        save_memory(
            root,
            root,
            MemoryCategory::Archival,
            "Session discussed login flow",
            vec!["session:1".into()],
        )
        .unwrap();

        let results = recall(root, root, "dashboard chart");
        assert_eq!(results.len(), 1);
        assert!(results[0].entry.content.contains("Dashboard"));

        let results = recall(root, root, "TypeScript language");
        assert_eq!(results.len(), 1);
        assert!(results[0].entry.content.contains("TypeScript"));
    }

    #[test]
    fn recall_prioritizes_core_via_tier_boost() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        // Both match "dashboard" once in content: equal keyword score. Core wins via the +1 boost.
        save_memory(
            root,
            root,
            MemoryCategory::Insight,
            "dashboard insight note",
            vec![],
        )
        .unwrap();
        save_memory(
            root,
            root,
            MemoryCategory::Core,
            "dashboard core fact",
            vec![],
        )
        .unwrap();

        let results = recall(root, root, "dashboard");
        assert_eq!(results.len(), 2);
        assert_eq!(
            results[0].entry.category,
            MemoryCategory::Core,
            "core outranks insight at equal keyword score via the core tier boost"
        );
    }

    #[test]
    fn core_memories_dedup_by_tags() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        save_memory(
            root,
            root,
            MemoryCategory::Core,
            "User likes blue",
            vec!["color-pref".into()],
        )
        .unwrap();
        save_memory(
            root,
            root,
            MemoryCategory::Core,
            "User likes purple",
            vec!["color-pref".into()],
        )
        .unwrap();

        let store = load(root, root);
        let cores = store.core_memories();
        assert_eq!(cores.len(), 1, "Should dedup core memories with same tags");
        assert!(
            cores[0].content.contains("purple"),
            "Should keep the latest value"
        );
    }

    #[test]
    fn format_system_prompt_injects_only_core() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        save_memory(
            root,
            root,
            MemoryCategory::Core,
            "Core fact injected",
            vec!["k".into()],
        )
        .unwrap();
        save_memory(
            root,
            root,
            MemoryCategory::Archival,
            "Archival summary hidden",
            vec!["session:1".into()],
        )
        .unwrap();
        save_memory(
            root,
            root,
            MemoryCategory::Insight,
            "Insight hidden",
            vec![],
        )
        .unwrap();

        let out = format_for_system_prompt(root, root);
        assert!(out.contains("Core fact injected"));
        assert!(!out.contains("Archival summary hidden"));
        assert!(!out.contains("Insight hidden"));
    }

    #[test]
    fn format_system_prompt_empty_when_no_core() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        save_memory(
            root,
            root,
            MemoryCategory::Insight,
            "just an insight",
            vec![],
        )
        .unwrap();
        assert!(format_for_system_prompt(root, root).is_empty());
    }

    #[test]
    fn format_recall_results_reports_empty() {
        let empty: Vec<ScoredMemory> = Vec::new();
        assert_eq!(
            format_recall_results(&empty),
            "No memories found matching that query."
        );
    }

    #[test]
    fn archive_session_creates_archival_memory() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        archive_session(
            root,
            root,
            "Discussed login flow demo with 5 steps",
            "chat-2026-01-01",
        )
        .unwrap();

        let store = load(root, root);
        assert_eq!(store.len(), 1);
        assert_eq!(store.entries[0].category, MemoryCategory::Archival);
        assert_eq!(
            store.entries[0].tags.as_deref(),
            Some(&["session:chat-2026-01-01".to_string()][..])
        );
    }

    #[test]
    fn update_delete_and_clear_preserve_memory_crud_behavior() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        save_memory(
            root,
            root,
            MemoryCategory::Core,
            "Use precise narration",
            vec!["style".into()],
        )
        .unwrap();
        save_memory(
            root,
            root,
            MemoryCategory::Insight,
            "Dashboard demo needs charts",
            vec!["dashboard".into()],
        )
        .unwrap();

        update_memory(root, root, 0, "Use concise narration").unwrap();
        let store = load(root, root);
        assert_eq!(store.entries[0].content, "Use concise narration");
        // update_content preserves category + tags.
        assert_eq!(store.entries[0].category, MemoryCategory::Core);
        assert_eq!(
            store.entries[0].tags.as_deref(),
            Some(&["style".to_string()][..])
        );

        delete_memory(root, root, 1).unwrap();
        let store = load(root, root);
        assert_eq!(store.len(), 1);
        assert_eq!(store.entries[0].content, "Use concise narration");

        let removed = clear_memories(root, root, Some(MemoryCategory::Core)).unwrap();
        assert_eq!(removed, 1);
        assert!(load(root, root).is_empty());
        assert_eq!(memory_row_count(root), 0);
    }

    #[test]
    fn load_migrates_legacy_project_memory_store_into_database() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let legacy_path = root.join(".cutready/memory.json");
        std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        std::fs::write(
            &legacy_path,
            r#"{"memories":[{"category":"core","content":"Use concise narration","tags":["style"],"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","access_count":0}]}"#,
        )
        .unwrap();

        let store = load(root, root);

        assert_eq!(store.len(), 1);
        assert_eq!(store.entries[0].content, "Use concise narration");
        assert_eq!(store.entries[0].category, MemoryCategory::Core);
        assert_eq!(
            store.entries[0].created_at.as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert!(legacy_path.exists());
        assert!(root.join(".git/cutready/agent-state.db").exists());
        assert!(!root.join(".git/cutready/memory.json").exists());
        assert_eq!(memory_row_count(root), 1);
    }

    #[test]
    fn load_migrates_current_local_memory_store_into_database() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let local_path = root.join(".git/cutready/memory.json");
        std::fs::create_dir_all(local_path.parent().unwrap()).unwrap();
        std::fs::write(
            &local_path,
            r#"{"memories":[{"category":"insight","content":"Charts should animate in","tags":["visual"],"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","access_count":2}]}"#,
        )
        .unwrap();

        let store = load(root, root);

        assert_eq!(store.len(), 1);
        assert_eq!(store.entries[0].content, "Charts should animate in");
        assert_eq!(store.entries[0].category, MemoryCategory::Insight);
        assert!(!local_path.exists());
        assert!(root.join(".git/cutready/agent-state.db").exists());
        assert_eq!(memory_row_count(root), 1);
    }
}
