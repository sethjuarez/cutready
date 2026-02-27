import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { FileTreeView } from "./FileTreeView";
import { SketchIcon, StoryboardIcon } from "./Icons";

/**
 * StoryboardList — sidebar with two modes:
 * 1. List mode: Storyboards + Sketch Library (categorized)
 * 2. Tree mode: File hierarchy view
 */
export function StoryboardList() {
  const sidebarMode = useAppStore((s) => s.sidebarMode);
  const setSidebarMode = useAppStore((s) => s.setSidebarMode);
  const storyboards = useAppStore((s) => s.storyboards);
  const sketches = useAppStore((s) => s.sketches);
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const createStoryboard = useAppStore((s) => s.createStoryboard);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const deleteStoryboard = useAppStore((s) => s.deleteStoryboard);
  const createSketch = useAppStore((s) => s.createSketch);
  const openSketch = useAppStore((s) => s.openSketch);
  const deleteSketch = useAppStore((s) => s.deleteSketch);
  const closeStoryboard = useAppStore((s) => s.closeStoryboard);

  const [isCreatingSb, setIsCreatingSb] = useState(false);
  const [newSbTitle, setNewSbTitle] = useState("");
  const [isCreatingSk, setIsCreatingSk] = useState(false);
  const [newSkTitle, setNewSkTitle] = useState("");

  useEffect(() => {
    loadStoryboards();
    loadSketches();
  }, [loadStoryboards, loadSketches]);

  const handleCreateSb = useCallback(async () => {
    const title = newSbTitle.trim();
    if (!title) return;
    await createStoryboard(title);
    setNewSbTitle("");
    setIsCreatingSb(false);
  }, [newSbTitle, createStoryboard]);

  const handleCreateSk = useCallback(async () => {
    const title = newSkTitle.trim();
    if (!title) return;
    // Clear storyboard context so we edit the sketch standalone
    closeStoryboard();
    await createSketch(title);
    setNewSkTitle("");
    setIsCreatingSk(false);
  }, [newSkTitle, createSketch, closeStoryboard]);

  const handleOpenSketchStandalone = useCallback(
    async (sketchPath: string) => {
      closeStoryboard();
      await openSketch(sketchPath);
    },
    [closeStoryboard, openSketch],
  );

  return (
    <div
      className="flex flex-col h-full bg-[var(--color-surface-inset)]"
    >
      {/* ── Mode toggle ──────────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[var(--color-border)]">
        <span className="text-[11px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Explorer
        </span>
        <div className="flex items-center gap-0.5 bg-[var(--color-surface)] rounded-md p-0.5">
          <button
            onClick={() => setSidebarMode("list")}
            className={`p-1 rounded transition-colors ${
              sidebarMode === "list"
                ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
            title="Categorized list"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
          <button
            onClick={() => setSidebarMode("tree")}
            className={`p-1 rounded transition-colors ${
              sidebarMode === "tree"
                ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            }`}
            title="File tree"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        </div>
      </div>

      {sidebarMode === "tree" ? (
        <FileTreeView />
      ) : (
      <>
      {/* ── Storyboards section ────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[var(--color-border)]">
        <span className="text-[11px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Storyboards
        </span>
        <button
          onClick={() => setIsCreatingSb(true)}
          className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          title="New storyboard"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {isCreatingSb && (
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
          <input
            type="text"
            value={newSbTitle}
            onChange={(e) => setNewSbTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateSb();
              if (e.key === "Escape") { setIsCreatingSb(false); setNewSbTitle(""); }
            }}
            placeholder="Storyboard name..."
            autoFocus
            className="w-full px-2 py-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
          />
        </div>
      )}

      <div className="overflow-y-auto py-1" style={{ maxHeight: "40%" }}>
        {storyboards.length === 0 && !isCreatingSb ? (
          <button
            onClick={() => setIsCreatingSb(true)}
            className="w-full px-3 py-4 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
          >
            + New storyboard
          </button>
        ) : (
          storyboards.map((sb) => (
            <div
              key={sb.path}
              role="button"
              tabIndex={0}
              onClick={() => openStoryboard(sb.path)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openStoryboard(sb.path); }}
              className={`group w-full flex items-center gap-2 px-3 py-2 text-left transition-colors cursor-pointer ${
                sb.path === activeStoryboardPath
                  ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                  : "text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]"
              }`}
            >
              <StoryboardIcon className="shrink-0" />
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
                    deleteStoryboard(sb.path);
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
            </div>
          ))
        )}
      </div>

      {/* ── Sketches section ──────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-y border-[var(--color-border)]">
        <span className="text-[11px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Sketches
        </span>
        <button
          onClick={() => setIsCreatingSk(true)}
          className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          title="New sketch"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {isCreatingSk && (
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
          <input
            type="text"
            value={newSkTitle}
            onChange={(e) => setNewSkTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateSk();
              if (e.key === "Escape") { setIsCreatingSk(false); setNewSkTitle(""); }
            }}
            placeholder="Sketch name..."
            autoFocus
            className="w-full px-2 py-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {sketches.length === 0 && !isCreatingSk ? (
          <button
            onClick={() => setIsCreatingSk(true)}
            className="w-full px-3 py-4 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
          >
            + New sketch
          </button>
        ) : (
          sketches.map((sk) => (
            <div
              key={sk.path}
              role="button"
              tabIndex={0}
              onClick={() => handleOpenSketchStandalone(sk.path)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleOpenSketchStandalone(sk.path); }}
              className={`group w-full flex items-center gap-2 px-3 py-2 text-left transition-colors cursor-pointer ${
                sk.path === activeSketchPath && !activeStoryboardPath
                  ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                  : "text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]"
              }`}
            >
              <SketchIcon className="shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{sk.title}</div>
                <div className="text-[10px] text-[var(--color-text-secondary)]">
                  {sk.row_count} {sk.row_count === 1 ? "row" : "rows"}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${sk.title}"?`)) {
                    deleteSketch(sk.path);
                  }
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all"
                title="Delete sketch"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
      </>
      )}
    </div>
  );
}
