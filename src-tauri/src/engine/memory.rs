//! Memory system for the AI assistant — thin wrapper around `agentive::memory`.
//!
//! Delegates all data model, scoring, and formatting to agentive.
//! This module adds CutReady-specific persistence via `.cutready/memory.json`.

use std::path::Path;

// Re-export agentive types so callers don't need to import from two places.
pub use agentive::memory::{MemoryBackend, MemoryCategory, MemoryEntry, MemoryStore};

// ---------------------------------------------------------------------------
// File-based persistence backend
// ---------------------------------------------------------------------------

/// Persists the memory store as `.cutready/memory.json` inside the project.
struct FileBackend {
    path: std::path::PathBuf,
}

impl FileBackend {
    fn new(project_root: &Path) -> Self {
        Self {
            path: project_root.join(".cutready").join("memory.json"),
        }
    }
}

impl MemoryBackend for FileBackend {
    fn load(&self) -> MemoryStore {
        if !self.path.exists() {
            return MemoryStore::default();
        }
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default()
    }

    fn save(&self, store: &MemoryStore) -> Result<(), String> {
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
        std::fs::create_dir_all(root.join(".cutready")).unwrap();

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
    }

    #[test]
    fn recall_finds_by_keyword() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".cutready")).unwrap();

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
        std::fs::create_dir_all(root.join(".cutready")).unwrap();

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
        std::fs::create_dir_all(root.join(".cutready")).unwrap();

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
}
