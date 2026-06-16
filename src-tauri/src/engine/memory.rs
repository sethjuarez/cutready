//! Memory system for the AI assistant — thin wrapper around `agentive::memory`.
//!
//! Delegates all data model, scoring, and formatting to agentive.
//! This module adds CutReady-specific persistence via `.git/cutready/memory.json`.

use std::path::Path;

// Re-export agentive types so callers don't need to import from two places.
pub use agentive::memory::{MemoryBackend, MemoryCategory, MemoryEntry, MemoryStore};

// ---------------------------------------------------------------------------
// File-based persistence backend
// ---------------------------------------------------------------------------

const MEMORY_FILENAME: &str = "memory.json";
const LEGACY_MEMORY_PATH: &str = ".cutready/memory.json";

/// Persists the memory store as local git metadata outside the project tree.
struct FileBackend {
    path: std::path::PathBuf,
    legacy_path: std::path::PathBuf,
}

impl FileBackend {
    fn new(project_root: &Path) -> Self {
        let repo_root = git2::Repository::discover(project_root)
            .ok()
            .and_then(|repo| repo.workdir().map(Path::to_path_buf))
            .unwrap_or_else(|| project_root.to_path_buf());

        Self {
            path: crate::engine::project::git_state_dir(&repo_root, project_root)
                .join(MEMORY_FILENAME),
            legacy_path: project_root.join(LEGACY_MEMORY_PATH),
        }
    }

    fn migrate_legacy(&self) {
        if !self.legacy_path.exists() || self.legacy_path == self.path {
            return;
        }

        if let Some(parent) = self.path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!("[memory] could not create local memory directory: {e}");
                return;
            }
        }

        if !self.path.exists() {
            match std::fs::rename(&self.legacy_path, &self.path) {
                Ok(()) => {
                    log::info!(
                        "[memory] migrated legacy memory store from {:?} to {:?}",
                        self.legacy_path,
                        self.path
                    );
                    return;
                }
                Err(rename_error) => {
                    if let Err(copy_error) = std::fs::copy(&self.legacy_path, &self.path) {
                        log::warn!(
                            "[memory] could not migrate legacy memory store: rename failed ({rename_error}); copy failed ({copy_error})"
                        );
                        return;
                    }
                }
            }
        }

        if let Err(e) = std::fs::remove_file(&self.legacy_path) {
            log::warn!("[memory] could not remove legacy memory store: {e}");
        }
    }
}

impl MemoryBackend for FileBackend {
    fn load(&self) -> MemoryStore {
        self.migrate_legacy();
        if !self.path.exists() {
            return MemoryStore::default();
        }
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    }

    fn save(&self, store: &MemoryStore) -> Result<(), String> {
        self.migrate_legacy();
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Convenience functions (same signatures as before for call-site compatibility)
// ---------------------------------------------------------------------------

/// Load the memory store from disk.
pub fn load(project_root: &Path) -> MemoryStore {
    FileBackend::new(project_root).load()
}

/// Save a memory entry with dedup + capacity management, then persist.
pub fn save_memory(
    project_root: &Path,
    category: MemoryCategory,
    content: &str,
    tags: Vec<String>,
) -> Result<(), String> {
    let backend = FileBackend::new(project_root);
    let mut store = backend.load();
    store.save(category, content, tags);
    backend.save(&store)
}

/// Search memories by keyword.
pub fn recall(project_root: &Path, query: &str) -> Vec<MemoryEntry> {
    let store = load(project_root);
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
pub fn format_for_system_prompt(project_root: &Path) -> String {
    load(project_root).format_for_system_prompt()
}

/// Format recall results for the agent.
pub fn format_recall_results(results: &[MemoryEntry]) -> String {
    let refs: Vec<&MemoryEntry> = results.iter().collect();
    MemoryStore::format_recall_results(&refs)
}

/// Save an archival session summary.
pub fn archive_session(project_root: &Path, summary: &str, session_id: &str) -> Result<(), String> {
    let backend = FileBackend::new(project_root);
    let mut store = backend.load();
    store.archive_session(summary, session_id);
    backend.save(&store)
}

/// Delete a memory by index.
pub fn delete_memory(project_root: &Path, index: usize) -> Result<(), String> {
    let backend = FileBackend::new(project_root);
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
pub fn update_memory(project_root: &Path, index: usize, content: &str) -> Result<(), String> {
    let backend = FileBackend::new(project_root);
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
    project_root: &Path,
    category: Option<MemoryCategory>,
) -> Result<usize, String> {
    let backend = FileBackend::new(project_root);
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

    #[test]
    fn save_and_load_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        save_memory(
            root,
            MemoryCategory::Core,
            "User prefers short narration",
            vec!["preference".into()],
        )
        .unwrap();
        save_memory(
            root,
            MemoryCategory::Insight,
            "Dashboard demo needs more detail",
            vec!["demo".into()],
        )
        .unwrap();

        let store = load(root);
        assert_eq!(store.memories.len(), 2);
        assert_eq!(store.memories[0].content, "User prefers short narration");
        assert!(root.join(".git/cutready/memory.json").exists());
        assert!(!root.join(".cutready/memory.json").exists());
    }

    #[test]
    fn recall_finds_by_keyword() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        save_memory(
            root,
            MemoryCategory::Core,
            "User prefers TypeScript",
            vec!["language".into()],
        )
        .unwrap();
        save_memory(
            root,
            MemoryCategory::Insight,
            "Dashboard needs chart builder",
            vec!["dashboard".into()],
        )
        .unwrap();
        save_memory(
            root,
            MemoryCategory::Archival,
            "Session discussed login flow",
            vec!["session:1".into()],
        )
        .unwrap();

        let results = recall(root, "dashboard chart");
        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("Dashboard"));

        let results = recall(root, "TypeScript language");
        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("TypeScript"));
    }

    #[test]
    fn core_memories_dedup_by_tags() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        save_memory(
            root,
            MemoryCategory::Core,
            "User likes blue",
            vec!["color-pref".into()],
        )
        .unwrap();
        save_memory(
            root,
            MemoryCategory::Core,
            "User likes purple",
            vec!["color-pref".into()],
        )
        .unwrap();

        let store = load(root);
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
        let result = format_for_system_prompt(tmp.path());
        assert!(result.is_empty());
    }

    #[test]
    fn archive_session_creates_archival_memory() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();

        archive_session(
            root,
            "Discussed login flow demo with 5 steps",
            "chat-2026-01-01",
        )
        .unwrap();

        let store = load(root);
        assert_eq!(store.memories.len(), 1);
        assert_eq!(store.memories[0].category, MemoryCategory::Archival);
        assert!(store.memories[0]
            .tags
            .contains(&"session:chat-2026-01-01".to_string()));
    }

    #[test]
    fn load_migrates_legacy_memory_store() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let legacy_path = root.join(".cutready/memory.json");
        std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        std::fs::write(
            &legacy_path,
            r#"{"memories":[{"category":"core","content":"Use concise narration","tags":["style"],"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","access_count":0}]}"#,
        )
        .unwrap();

        let store = load(root);

        assert_eq!(store.memories.len(), 1);
        assert_eq!(store.memories[0].content, "Use concise narration");
        assert!(!legacy_path.exists());
        assert!(root.join(".git/cutready/memory.json").exists());
    }
}
