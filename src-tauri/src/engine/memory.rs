//! Memory system for the AI assistant.
//!
//! Five-category memory modeled after human cognition:
//!
//! - **Working memory** — active conversation context (managed by runner.rs)
//! - **Core memory** — persistent project-level facts injected into system prompt
//! - **Procedural memory** — tool definitions and system prompts (existing infra)
//! - **Archival memory** — session summaries saved when a chat session ends
//! - **Recall memory** — agent searches past memories on demand via tool call
//!
//! Storage: `.cutready/memory.json` inside the project directory.

use serde::{Deserialize, Serialize};
use std::path::Path;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/// A single memory entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    /// What category this memory belongs to.
    pub category: MemoryCategory,
    /// The content of the memory.
    pub content: String,
    /// When this memory was created.
    pub created_at: String,
    /// Optional tags for search.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Memory categories.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCategory {
    /// Persistent facts about the user or project (e.g., "user prefers concise narration").
    Core,
    /// Compacted session summaries.
    Archival,
    /// Explicitly saved insights from conversations.
    Insight,
}

/// The full memory store for a project.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryStore {
    pub memories: Vec<MemoryEntry>,
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

fn memory_path(project_root: &Path) -> std::path::PathBuf {
    project_root.join(".cutready").join("memory.json")
}

/// Load the memory store from disk. Returns empty store if file doesn't exist.
pub fn load(project_root: &Path) -> MemoryStore {
    let path = memory_path(project_root);
    if !path.exists() {
        return MemoryStore::default();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

/// Save the memory store to disk.
pub fn save(project_root: &Path, store: &MemoryStore) -> Result<(), String> {
    let path = memory_path(project_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Operations (called by agent tools)
// ---------------------------------------------------------------------------

/// Save a memory entry.
pub fn save_memory(
    project_root: &Path,
    category: MemoryCategory,
    content: &str,
    tags: Vec<String>,
) -> Result<(), String> {
    let mut store = load(project_root);
    let now = chrono::Utc::now().to_rfc3339();

    // For core memories, replace if same tags exist (dedup)
    if category == MemoryCategory::Core {
        store.memories.retain(|m| {
            !(m.category == MemoryCategory::Core && m.tags == tags && !tags.is_empty())
        });
    }

    store.memories.push(MemoryEntry {
        category,
        content: content.to_string(),
        created_at: now,
        tags,
    });

    // Cap total memories to prevent unbounded growth
    const MAX_MEMORIES: usize = 200;
    if store.memories.len() > MAX_MEMORIES {
        // Drop oldest archival memories first
        let mut archival_indices: Vec<usize> = store
            .memories
            .iter()
            .enumerate()
            .filter(|(_, m)| m.category == MemoryCategory::Archival)
            .map(|(i, _)| i)
            .collect();
        while store.memories.len() > MAX_MEMORIES && !archival_indices.is_empty() {
            let idx = archival_indices.remove(0);
            store.memories.remove(idx);
            // Adjust remaining indices
            for i in archival_indices.iter_mut() {
                if *i > idx {
                    *i -= 1;
                }
            }
        }
    }

    save(project_root, &store)
}

/// Search memories by keyword. Returns matching entries sorted by relevance.
pub fn recall(project_root: &Path, query: &str) -> Vec<MemoryEntry> {
    let store = load(project_root);
    log::debug!("[memory] recall query='{}' across {} memories", query, store.memories.len());
    let query_lower = query.to_lowercase();
    let keywords: Vec<&str> = query_lower.split_whitespace().collect();

    let mut scored: Vec<(usize, &MemoryEntry)> = store
        .memories
        .iter()
        .filter_map(|m| {
            let content_lower = m.content.to_lowercase();
            let tag_text: String = m.tags.join(" ").to_lowercase();

            let mut score = 0usize;
            for kw in &keywords {
                if content_lower.contains(kw) {
                    score += 2;
                }
                if tag_text.contains(kw) {
                    score += 3; // Tag matches are more precise
                }
            }

            // Boost core memories (only when already matched)
            if score > 0 && m.category == MemoryCategory::Core {
                score += 1;
            }

            if score > 0 {
                Some((score, m))
            } else {
                None
            }
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let results: Vec<MemoryEntry> = scored.into_iter().map(|(_, m)| m.clone()).take(10).collect();
    log::debug!("[memory] recall returned {} results", results.len());
    results
}

/// Get all core memories (for system prompt injection).
pub fn core_memories(project_root: &Path) -> Vec<MemoryEntry> {
    let store = load(project_root);
    store
        .memories
        .into_iter()
        .filter(|m| m.category == MemoryCategory::Core)
        .collect()
}

/// Save an archival session summary.
pub fn archive_session(
    project_root: &Path,
    summary: &str,
    session_id: &str,
) -> Result<(), String> {
    save_memory(
        project_root,
        MemoryCategory::Archival,
        summary,
        vec![format!("session:{session_id}")],
    )
}

// ---------------------------------------------------------------------------
// Format for system prompt
// ---------------------------------------------------------------------------

/// Format core memories for injection into the system prompt.
pub fn format_for_system_prompt(project_root: &Path) -> String {
    let cores = core_memories(project_root);
    if cores.is_empty() {
        return String::new();
    }

    let mut out = String::from("\n[Memories about this project and user]\n");
    for m in &cores {
        out.push_str(&format!("• {}\n", m.content));
    }
    out
}

/// Format recall results for the agent.
pub fn format_recall_results(results: &[MemoryEntry]) -> String {
    if results.is_empty() {
        return "No memories found matching that query.".to_string();
    }

    let mut out = String::new();
    for (i, m) in results.iter().enumerate() {
        let cat = match m.category {
            MemoryCategory::Core => "core",
            MemoryCategory::Archival => "archival",
            MemoryCategory::Insight => "insight",
        };
        out.push_str(&format!(
            "{}. [{}] {}\n",
            i + 1,
            cat,
            m.content
        ));
        if !m.tags.is_empty() {
            out.push_str(&format!("   tags: {}\n", m.tags.join(", ")));
        }
    }
    out
}

/// Delete a memory by index. Returns an error if the index is out of bounds.
pub fn delete_memory(project_root: &Path, index: usize) -> Result<(), String> {
    let mut store = load(project_root);
    if index >= store.memories.len() {
        return Err(format!("Memory index {} out of bounds ({})", index, store.memories.len()));
    }
    store.memories.remove(index);
    save(project_root, &store)
}

/// Update a memory's content by index.
pub fn update_memory(project_root: &Path, index: usize, content: &str) -> Result<(), String> {
    let mut store = load(project_root);
    if index >= store.memories.len() {
        return Err(format!("Memory index {} out of bounds ({})", index, store.memories.len()));
    }
    store.memories[index].content = content.to_string();
    save(project_root, &store)
}

/// Delete all memories of a given category, or all memories if None.
pub fn clear_memories(project_root: &Path, category: Option<MemoryCategory>) -> Result<usize, String> {
    let mut store = load(project_root);
    let before = store.memories.len();
    match category {
        Some(cat) => store.memories.retain(|m| m.category != cat),
        None => store.memories.clear(),
    }
    let removed = before - store.memories.len();
    save(project_root, &store)?;
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

        save_memory(root, MemoryCategory::Core, "User prefers short narration", vec!["preference".into()]).unwrap();
        save_memory(root, MemoryCategory::Insight, "Dashboard demo needs more detail", vec!["demo".into()]).unwrap();

        let store = load(root);
        assert_eq!(store.memories.len(), 2);
        assert_eq!(store.memories[0].content, "User prefers short narration");
    }

    #[test]
    fn recall_finds_by_keyword() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".cutready")).unwrap();

        save_memory(root, MemoryCategory::Core, "User prefers TypeScript", vec!["language".into()]).unwrap();
        save_memory(root, MemoryCategory::Insight, "Dashboard needs chart builder", vec!["dashboard".into()]).unwrap();
        save_memory(root, MemoryCategory::Archival, "Session discussed login flow", vec!["session:1".into()]).unwrap();

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

        save_memory(root, MemoryCategory::Core, "User likes blue", vec!["color-pref".into()]).unwrap();
        save_memory(root, MemoryCategory::Core, "User likes purple", vec!["color-pref".into()]).unwrap();

        let cores = core_memories(root);
        assert_eq!(cores.len(), 1, "Should dedup core memories with same tags");
        assert!(cores[0].content.contains("purple"), "Should keep the latest value");
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

        archive_session(root, "Discussed login flow demo with 5 steps", "chat-2026-01-01").unwrap();

        let store = load(root);
        assert_eq!(store.memories.len(), 1);
        assert_eq!(store.memories[0].category, MemoryCategory::Archival);
        assert!(store.memories[0].tags.contains(&"session:chat-2026-01-01".to_string()));
    }
}
