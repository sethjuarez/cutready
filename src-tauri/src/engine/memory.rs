//! Memory system for the AI assistant — thin wrapper around `agentive::memory`.
//!
//! Delegates all data model, scoring, and formatting to agentive.
//! This module adds CutReady-specific persistence in `.git/cutready/agent-state.db`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};

// Re-export agentive types so callers don't need to import from two places.
pub use agentive::memory::{MemoryBackend, MemoryCategory, MemoryEntry, MemoryStore};

// ---------------------------------------------------------------------------
// SQLite persistence backend
// ---------------------------------------------------------------------------

const AGENT_MEMORIES_TABLE: &str = "agent_memories";
const LEGACY_MEMORY_PATH: &str = ".cutready/memory.json";
static MEMORY_BACKEND_LOCK: Mutex<()> = Mutex::new(());

/// Persists the memory store in the local agent-state database.
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
        let incoming: MemoryStore = serde_json::from_str(&data)
            .map_err(|e| format!("Could not parse {label} for migration: {e}"))?;
        if !incoming.memories.is_empty() {
            let mut merged = load_store_from_conn(conn)?;
            for memory in incoming.memories {
                if !merged.memories.iter().any(|existing| {
                    existing.category == memory.category
                        && existing.content == memory.content
                        && existing.tags == memory.tags
                }) {
                    merged.memories.push(memory);
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

impl MemoryBackend for SqliteBackend {
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

    let mut memories = Vec::new();
    for row in rows {
        let json = row.map_err(|e| format!("Could not read memory row: {e}"))?;
        memories.push(
            serde_json::from_str::<MemoryEntry>(&json)
                .map_err(|e| format!("Could not parse memory row: {e}"))?,
        );
    }
    Ok(MemoryStore { memories })
}

fn save_store_to_conn(conn: &Connection, store: &MemoryStore) -> Result<(), String> {
    conn.execute("BEGIN IMMEDIATE", [])
        .map_err(|e| format!("Could not begin memory save transaction: {e}"))?;
    let result = (|| {
        conn.execute(&format!("DELETE FROM {AGENT_MEMORIES_TABLE}"), [])
            .map_err(|e| format!("Could not clear existing memories: {e}"))?;
        for (position, memory) in store.memories.iter().enumerate() {
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
    let category = memory_category_name(&memory.category)?;
    let tags_json = serde_json::to_string(&memory.tags).map_err(|e| e.to_string())?;
    let entry_json = serde_json::to_string(memory).map_err(|e| e.to_string())?;
    conn.execute(
        &format!(
            "INSERT INTO {AGENT_MEMORIES_TABLE}
                (position, category, content, tags_json, created_at, entry_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        ),
        params![
            position as i64,
            category,
            memory.content,
            tags_json,
            memory.created_at,
            entry_json,
        ],
    )
    .map_err(|e| format!("Could not insert memory row: {e}"))?;
    Ok(())
}

fn memory_category_name(category: &MemoryCategory) -> Result<String, String> {
    serde_json::to_value(category)
        .map_err(|e| e.to_string())?
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Memory category did not serialize to a string".to_string())
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

/// Load the memory store from disk.
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

/// Save a memory entry with dedup + capacity management, then persist.
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
    store.save(category, content, tags);
    backend.save(&store)
}

/// Search memories by keyword.
pub fn recall(repo_root: &Path, project_root: &Path, query: &str) -> Vec<MemoryEntry> {
    let store = load(repo_root, project_root);
    log::debug!(
        "[memory] recall query='{}' across {} memories",
        query,
        store.memories.len()
    );
    let results: Vec<MemoryEntry> = store.recall(query).into_iter().cloned().collect();
    log::debug!("[memory] recall returned {} results", results.len());
    results
}

/// Format core memories for injection into the system prompt.
pub fn format_for_system_prompt(repo_root: &Path, project_root: &Path) -> String {
    load(repo_root, project_root).format_for_system_prompt()
}

/// Format recall results for the agent.
pub fn format_recall_results(results: &[MemoryEntry]) -> String {
    let refs: Vec<&MemoryEntry> = results.iter().collect();
    MemoryStore::format_recall_results(&refs)
}

/// Save an archival session summary.
pub fn archive_session(
    repo_root: &Path,
    project_root: &Path,
    summary: &str,
    session_id: &str,
) -> Result<(), String> {
    let _guard = MEMORY_BACKEND_LOCK
        .lock()
        .map_err(|e| format!("Could not lock memory backend: {e}"))?;
    let backend = SqliteBackend::new(repo_root, project_root)?;
    let mut store = backend.load();
    store.archive_session(summary, session_id);
    backend.save(&store)
}

/// Delete a memory by index.
pub fn delete_memory(repo_root: &Path, project_root: &Path, index: usize) -> Result<(), String> {
    let _guard = MEMORY_BACKEND_LOCK
        .lock()
        .map_err(|e| format!("Could not lock memory backend: {e}"))?;
    let backend = SqliteBackend::new(repo_root, project_root)?;
    let mut store = backend.load();
    store.delete(index).ok_or_else(|| {
        format!(
            "Memory index {} out of bounds ({})",
            index,
            store.memories.len()
        )
    })?;
    backend.save(&store)
}

/// Update a memory's content by index.
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
    if !store.update(index, content) {
        return Err(format!(
            "Memory index {} out of bounds ({})",
            index,
            store.memories.len()
        ));
    }
    backend.save(&store)
}

/// Delete all memories of a given category, or all if None.
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
        assert_eq!(store.memories.len(), 2);
        assert_eq!(store.memories[0].content, "User prefers short narration");
        assert!(root.join(".git/cutready/agent-state.db").exists());
        assert_eq!(memory_row_count(root), 2);
        assert!(!root.join(".git/cutready/memory.json").exists());
        assert!(!root.join(".cutready/memory.json").exists());
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
        assert!(results[0].content.contains("Dashboard"));

        let results = recall(root, root, "TypeScript language");
        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("TypeScript"));
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
        let cores: Vec<_> = store
            .memories
            .iter()
            .filter(|m| m.category == MemoryCategory::Core)
            .collect();
        assert_eq!(cores.len(), 1, "Should dedup core memories with same tags");
        assert!(
            cores[0].content.contains("purple"),
            "Should keep the latest value"
        );
    }

    #[test]
    fn format_system_prompt_empty_when_no_memories() {
        let tmp = TempDir::new().unwrap();
        let result = format_for_system_prompt(tmp.path(), tmp.path());
        assert!(result.is_empty());
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
        assert_eq!(store.memories.len(), 1);
        assert_eq!(store.memories[0].category, MemoryCategory::Archival);
        assert!(store.memories[0]
            .tags
            .contains(&"session:chat-2026-01-01".to_string()));
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
        assert_eq!(store.memories[0].content, "Use concise narration");

        delete_memory(root, root, 1).unwrap();
        let store = load(root, root);
        assert_eq!(store.memories.len(), 1);
        assert_eq!(store.memories[0].content, "Use concise narration");

        let removed = clear_memories(root, root, Some(MemoryCategory::Core)).unwrap();
        assert_eq!(removed, 1);
        assert!(load(root, root).memories.is_empty());
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

        assert_eq!(store.memories.len(), 1);
        assert_eq!(store.memories[0].content, "Use concise narration");
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

        assert_eq!(store.memories.len(), 1);
        assert_eq!(store.memories[0].content, "Charts should animate in");
        assert!(!local_path.exists());
        assert!(root.join(".git/cutready/agent-state.db").exists());
        assert_eq!(memory_row_count(root), 1);
    }
}
