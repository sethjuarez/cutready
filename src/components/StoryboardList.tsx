import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";

/**
 * StoryboardList — sidebar listing all storyboards in the current project.
 * Includes inline creation and delete.
 */
export function StoryboardList() {
  const storyboards = useAppStore((s) => s.storyboards);
  const activeStoryboardId = useAppStore((s) => s.activeStoryboardId);
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const createStoryboard = useAppStore((s) => s.createStoryboard);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const deleteStoryboard = useAppStore((s) => s.deleteStoryboard);

  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  useEffect(() => {
    loadStoryboards();
    loadSketches();
  }, [loadStoryboards, loadSketches]);

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim();
    if (!title) return;
    await createStoryboard(title);
    setNewTitle("");
    setIsCreating(false);
  }, [newTitle, createStoryboard]);

  return (
    <div
      className="flex flex-col h-full border-r border-[var(--color-border)]"
      style={{ width: 240 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-[var(--color-border)]">
        <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Storyboards
        </span>
        <button
          onClick={() => setIsCreating(true)}
          className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          title="New storyboard"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Inline creation */}
      {isCreating && (
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") { setIsCreating(false); setNewTitle(""); }
            }}
            placeholder="Storyboard name..."
            autoFocus
            className="w-full px-2 py-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
          />
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto py-1">
        {storyboards.length === 0 && !isCreating ? (
          <div className="px-3 py-6 text-center">
            <p className="text-xs text-[var(--color-text-secondary)] mb-3">
              No storyboards yet
            </p>
            <button
              onClick={() => setIsCreating(true)}
              className="text-xs text-[var(--color-accent)] hover:underline"
            >
              Create your first storyboard
            </button>
          </div>
        ) : (
          storyboards.map((sb) => (
            <button
              key={sb.id}
              onClick={() => openStoryboard(sb.id)}
              className={`group w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                sb.id === activeStoryboardId
                  ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                  : "text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <rect x="2" y="3" width="20" height="18" rx="2" />
                <line x1="8" y1="3" x2="8" y2="21" />
              </svg>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{sb.title}</div>
                <div className="text-[10px] text-[var(--color-text-secondary)]">
                  {sb.sketch_count} {sb.sketch_count === 1 ? "sketch" : "sketches"}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${sb.title}"?`)) {
                    deleteStoryboard(sb.id);
                  }
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all"
                title="Delete storyboard"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
