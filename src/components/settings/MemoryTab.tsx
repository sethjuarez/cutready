import { useEffect, useState } from "react";
import { invoke } from "../../services/tauri";

interface MemoryItem {
  category: string;
  content: string;
  created_at: string;
  tags: string[];
}

export function MemoryTab() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "core" | "archival" | "insight">("all");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");

  const loadMemories = async () => {
    setLoading(true);
    try {
      const result = await invoke<MemoryItem[]>("list_memories");
      setMemories(result);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMemories(); }, []);

  const filtered = filter === "all"
    ? memories
    : memories.filter((m) => m.category === filter);

  const handleDelete = async (globalIndex: number) => {
    try {
      await invoke("delete_memory", { index: globalIndex });
      await loadMemories();
    } catch (e) {
      console.error("Failed to delete memory:", e);
    }
  };

  const handleUpdate = async (globalIndex: number) => {
    try {
      await invoke("update_memory", { index: globalIndex, content: editContent });
      setEditingIndex(null);
      setEditContent("");
      await loadMemories();
    } catch (e) {
      console.error("Failed to update memory:", e);
    }
  };

  const handleClear = async (category?: string) => {
    try {
      await invoke("clear_memories", { category: category || null });
      await loadMemories();
    } catch (e) {
      console.error("Failed to clear memories:", e);
    }
  };

  const categoryBadge = (cat: string) => {
    const colors: Record<string, string> = {
      core: "bg-[rgb(var(--color-secondary))]/20 text-[rgb(var(--color-secondary))]",
      archival: "bg-accent/20 text-accent",
      insight: "bg-warning/20 text-warning",
    };
    return colors[cat] || "bg-[rgb(var(--color-text-secondary))]/20 text-[rgb(var(--color-text-secondary))]";
  };

  const globalIndex = (item: MemoryItem) => memories.indexOf(item);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">
          {memories.length} {memories.length === 1 ? "memory" : "memories"} stored
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={loadMemories}
            className="px-2 py-1 text-xs rounded border border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
            title="Refresh"
          >
            ↻
          </button>
          {memories.length > 0 && (
            <button
              onClick={() => handleClear()}
              className="px-2 py-1 text-xs rounded border border-error/30 text-error hover:bg-error/10 transition-colors"
            >
              Clear All
            </button>
          )}
        </div>
      </div>

      {/* Category filter */}
      <div className="flex gap-1">
        {(["all", "core", "archival", "insight"] as const).map((cat) => {
          const count = cat === "all" ? memories.length : memories.filter((m) => m.category === cat).length;
          return (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                filter === cat
                  ? "bg-[rgb(var(--color-accent))]/20 text-[rgb(var(--color-accent))]"
                  : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))]"
              }`}
            >
              {cat === "all" ? "All" : cat.charAt(0).toUpperCase() + cat.slice(1)} ({count})
            </button>
          );
        })}
      </div>

      {/* Memory list */}
      {loading ? (
        <p className="text-xs text-[rgb(var(--color-text-secondary))] py-4 text-center">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-8 text-[rgb(var(--color-text-secondary))]">
          <p className="text-sm">No memories yet</p>
          <p className="text-xs mt-1">The AI assistant will save memories as you chat.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {filtered.map((m) => {
            const idx = globalIndex(m);
            const isEditing = editingIndex === idx;
            return (
              <div
                key={idx}
                className="group flex flex-col gap-1 p-2.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] hover:border-[rgb(var(--color-text-secondary))]/30 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${categoryBadge(m.category)}`}>
                      {m.category}
                    </span>
                    {m.tags.length > 0 && (
                      <span className="text-[10px] text-[rgb(var(--color-text-secondary))] truncate">
                        {m.tags.join(", ")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => {
                        if (isEditing) {
                          setEditingIndex(null);
                        } else {
                          setEditingIndex(idx);
                          setEditContent(m.content);
                        }
                      }}
                      className="px-1.5 py-0.5 text-[10px] rounded hover:bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-text-secondary))]"
                    >
                      {isEditing ? "Cancel" : "Edit"}
                    </button>
                    <button
                      onClick={() => handleDelete(idx)}
                      className="px-1.5 py-0.5 text-[10px] rounded hover:bg-error/10 text-error"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {isEditing ? (
                  <div className="flex gap-1.5 mt-1">
                    <input
                      type="text"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleUpdate(idx); if (e.key === "Escape") setEditingIndex(null); }}
                      className="flex-1 px-2 py-1 text-xs rounded bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40"
                      autoFocus
                    />
                    <button
                      onClick={() => handleUpdate(idx)}
                      className="px-2 py-1 text-xs rounded bg-[rgb(var(--color-accent))]/20 text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/30"
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[rgb(var(--color-text))]">{m.content}</p>
                )}
                <span className="text-[10px] text-[rgb(var(--color-text-secondary))]/50">
                  {new Date(m.created_at).toLocaleDateString()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
