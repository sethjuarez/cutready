import { useCallback, useEffect, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type SidebarOrder } from "../stores/appStore";
import { FileTreeView } from "./FileTreeView";
import { SketchIcon, StoryboardIcon, NoteIcon } from "./Icons";

/** Sort items by manifest order. Items not in the manifest go at the end. */
function applySidebarOrder<T extends { path: string }>(items: T[], order: string[]): T[] {
  if (!order.length) return items;
  const indexMap = new Map(order.map((p, i) => [p, i]));
  return [...items].sort((a, b) => {
    const ai = indexMap.get(a.path) ?? Infinity;
    const bi = indexMap.get(b.path) ?? Infinity;
    return ai - bi;
  });
}

/** Wrapper that makes a sidebar list item draggable. */
function SortableSidebarItem({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div className="flex items-center">
        {/* Drag handle */}
        <div
          {...listeners}
          className="shrink-0 w-4 flex items-center justify-center cursor-grab opacity-0 group-hover/item:opacity-50 hover:!opacity-100 transition-opacity"
          title="Drag to reorder"
        >
          <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" className="text-[var(--color-text-secondary)]">
            <circle cx="2" cy="2" r="1.2" />
            <circle cx="6" cy="2" r="1.2" />
            <circle cx="2" cy="7" r="1.2" />
            <circle cx="6" cy="7" r="1.2" />
            <circle cx="2" cy="12" r="1.2" />
            <circle cx="6" cy="12" r="1.2" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}

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
  const notes = useAppStore((s) => s.notes);
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const createStoryboard = useAppStore((s) => s.createStoryboard);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const deleteStoryboard = useAppStore((s) => s.deleteStoryboard);
  const createSketch = useAppStore((s) => s.createSketch);
  const openSketch = useAppStore((s) => s.openSketch);
  const deleteSketch = useAppStore((s) => s.deleteSketch);
  const createNote = useAppStore((s) => s.createNote);
  const openNote = useAppStore((s) => s.openNote);
  const deleteNote = useAppStore((s) => s.deleteNote);
  const closeStoryboard = useAppStore((s) => s.closeStoryboard);
  const sidebarOrder = useAppStore((s) => s.sidebarOrder);
  const saveSidebarOrder = useAppStore((s) => s.saveSidebarOrder);

  const [isCreatingSb, setIsCreatingSb] = useState(false);
  const [newSbTitle, setNewSbTitle] = useState("");
  const [isCreatingSk, setIsCreatingSk] = useState(false);
  const [newSkTitle, setNewSkTitle] = useState("");
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ type: "storyboard" | "sketch" | "note"; path: string; title: string; usedBy?: string[] } | null>(null);

  const requestDelete = useCallback(async (type: "storyboard" | "sketch" | "note", path: string, title: string) => {
    let usedBy: string[] | undefined;
    if (type === "sketch") {
      try {
        usedBy = await invoke<string[]>("sketch_used_by_storyboards", { relativePath: path });
      } catch { /* ignore */ }
    }
    setPendingDelete({ type, path, title, usedBy });
  }, []);

  useEffect(() => {
    loadStoryboards();
    loadSketches();
    loadNotes();
  }, [loadStoryboards, loadSketches, loadNotes]);

  // Apply sidebar order
  const orderedStoryboards = applySidebarOrder(storyboards, sidebarOrder?.storyboards ?? []);
  const orderedSketches = applySidebarOrder(sketches, sidebarOrder?.sketches ?? []);
  const orderedNotes = applySidebarOrder(notes, sidebarOrder?.notes ?? []);

  // DnD sensors — require 5px movement to start drag (avoids accidental drags on click)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = useCallback(
    (category: "storyboards" | "sketches" | "notes") =>
      (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;

        const items =
          category === "storyboards" ? orderedStoryboards :
          category === "sketches" ? orderedSketches : orderedNotes;

        const oldIdx = items.findIndex((i) => i.path === active.id);
        const newIdx = items.findIndex((i) => i.path === over.id);
        if (oldIdx < 0 || newIdx < 0) return;

        const reordered = [...items];
        const [moved] = reordered.splice(oldIdx, 1);
        reordered.splice(newIdx, 0, moved);

        const newOrder: SidebarOrder = {
          storyboards: sidebarOrder?.storyboards ?? storyboards.map((s) => s.path),
          sketches: sidebarOrder?.sketches ?? sketches.map((s) => s.path),
          notes: sidebarOrder?.notes ?? notes.map((n) => n.path),
          [category]: reordered.map((i) => i.path),
        };
        saveSidebarOrder(newOrder);
      },
    [orderedStoryboards, orderedSketches, orderedNotes, sidebarOrder, storyboards, sketches, notes, saveSidebarOrder],
  );

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

  const handleCreateNote = useCallback(async () => {
    const title = newNoteTitle.trim();
    if (!title) return;
    await createNote(title);
    setNewNoteTitle("");
    setIsCreatingNote(false);
  }, [newNoteTitle, createNote]);

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
        {orderedStoryboards.length === 0 && !isCreatingSb ? (
          <button
            onClick={() => setIsCreatingSb(true)}
            className="w-full px-3 py-4 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
          >
            + New storyboard
          </button>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("storyboards")}>
            <SortableContext items={orderedStoryboards.map((sb) => sb.path)} strategy={verticalListSortingStrategy}>
              {orderedStoryboards.map((sb) => (
                <SortableSidebarItem key={sb.path} id={sb.path}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openStoryboard(sb.path)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openStoryboard(sb.path); }}
                    className={`group/item w-full flex items-center gap-2 px-2 py-2 text-left transition-colors cursor-pointer ${
                      sb.path === activeStoryboardPath
                        ? "bg-emerald-500/10 text-emerald-500"
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
                        requestDelete("storyboard", sb.path, sb.title);
                      }}
                      className="opacity-0 group-hover/item:opacity-100 p-0.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all"
                      title="Delete storyboard"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </SortableSidebarItem>
              ))}
            </SortableContext>
          </DndContext>
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
        {orderedSketches.length === 0 && !isCreatingSk ? (
          <button
            onClick={() => setIsCreatingSk(true)}
            className="w-full px-3 py-4 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
          >
            + New sketch
          </button>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("sketches")}>
            <SortableContext items={orderedSketches.map((sk) => sk.path)} strategy={verticalListSortingStrategy}>
              {orderedSketches.map((sk) => (
                <SortableSidebarItem key={sk.path} id={sk.path}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleOpenSketchStandalone(sk.path)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleOpenSketchStandalone(sk.path); }}
                    className={`group/item w-full flex items-center gap-2 px-2 py-2 text-left transition-colors cursor-pointer ${
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
                        requestDelete("sketch", sk.path, sk.title);
                      }}
                      className="opacity-0 group-hover/item:opacity-100 p-0.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all"
                      title="Delete sketch"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </SortableSidebarItem>
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* ── Notes section ─────────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-y border-[var(--color-border)]">
        <span className="text-[11px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
          Notes
        </span>
        <button
          onClick={() => setIsCreatingNote(true)}
          className="p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 transition-colors"
          title="New note"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {isCreatingNote && (
        <div className="px-3 py-2 border-b border-[var(--color-border)]">
          <input
            type="text"
            value={newNoteTitle}
            onChange={(e) => setNewNoteTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateNote();
              if (e.key === "Escape") { setIsCreatingNote(false); setNewNoteTitle(""); }
            }}
            placeholder="Note name..."
            autoFocus
            className="w-full px-2 py-1.5 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {orderedNotes.length === 0 && !isCreatingNote ? (
          <button
            onClick={() => setIsCreatingNote(true)}
            className="w-full px-3 py-4 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] transition-colors"
          >
            + New note
          </button>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("notes")}>
            <SortableContext items={orderedNotes.map((n) => n.path)} strategy={verticalListSortingStrategy}>
              {orderedNotes.map((note) => (
                <SortableSidebarItem key={note.path} id={note.path}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openNote(note.path)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openNote(note.path); }}
                    className={`group/item w-full flex items-center gap-2 px-2 py-2 text-left transition-colors cursor-pointer ${
                      note.path === activeNotePath
                        ? "bg-amber-500/10 text-amber-500"
                        : "text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]"
                    }`}
                  >
                    <NoteIcon className="shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{note.title}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDelete("note", note.path, note.title);
                      }}
                      className="opacity-0 group-hover/item:opacity-100 p-0.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all"
                      title="Delete note"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </SortableSidebarItem>
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
      </>
      )}

      {/* Delete confirmation overlay */}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-xl p-5 max-w-sm mx-4">
            <p className="text-sm text-[var(--color-text)] mb-1 font-medium">Delete {pendingDelete.type}?</p>
            <p className="text-xs text-[var(--color-text-secondary)] mb-2">
              "{pendingDelete.title}" will be permanently deleted.
            </p>
            {pendingDelete.usedBy && pendingDelete.usedBy.length > 0 && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <p className="text-xs text-amber-400 font-medium mb-1">⚠ Used in {pendingDelete.usedBy.length === 1 ? "a storyboard" : `${pendingDelete.usedBy.length} storyboards`}:</p>
                <ul className="text-[11px] text-amber-300/80 list-disc list-inside">
                  {pendingDelete.usedBy.map((t) => <li key={t}>{t}</li>)}
                </ul>
                <p className="text-[11px] text-amber-300/80 mt-1">Deleting will leave broken references.</p>
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { type, path } = pendingDelete;
                  setPendingDelete(null);
                  if (type === "sketch") deleteSketch(path);
                  else if (type === "storyboard") deleteStoryboard(path);
                  else deleteNote(path);
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
