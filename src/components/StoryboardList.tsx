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
import { ArrowDownTrayIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useAppStore, type SidebarOrder } from "../stores/appStore";
import { SketchIcon, StoryboardIcon, NoteIcon } from "./Icons";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToastStore } from "../stores/toastStore";

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
    <div ref={setNodeRef} style={style} {...attributes} className="group/item">
      <div className="flex items-center">
        {/* Drag handle */}
        <div
          {...listeners}
          className="shrink-0 w-4 flex items-center justify-center cursor-grab opacity-0 group-hover/item:opacity-50 hover:!opacity-100 transition-opacity"
          title="Drag to reorder"
        >
          <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" className="text-[rgb(var(--color-text-secondary))]">
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
 * StoryboardList — Documents pane: Storyboards, Sketches, and Notes.
 * File tree view is now in the separate Explorer pane.
 */
export function StoryboardList() {
  const storyboards = useAppStore((s) => s.storyboards);
  const sketches = useAppStore((s) => s.sketches);
  const notes = useAppStore((s) => s.notes);
  const activeStoryboardPath = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.type === "storyboard" ? tab.path : null;
  });
  const activeSketchPath = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.type === "sketch" ? tab.path : null;
  });
  const activeNotePath = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.type === "note" ? tab.path : null;
  });
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
  const [drmConfirm, setDrmConfirm] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const [importing, setImporting] = useState(false);
  const showToast = useToastStore((s) => s.show);

  const showDrmConfirm = useCallback(() => {
    return new Promise<boolean>((resolve) => {
      setDrmConfirm({ resolve });
    });
  }, []);

  // Global Escape to cancel any active creation
  useEffect(() => {
    const anyCreating = isCreatingSb || isCreatingSk || isCreatingNote;
    if (!anyCreating) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsCreatingSb(false); setNewSbTitle("");
        setIsCreatingSk(false); setNewSkTitle("");
        setIsCreatingNote(false); setNewNoteTitle("");
      }
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isCreatingSb, isCreatingSk, isCreatingNote]);

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

  const handleImport = useCallback(async () => {
    try {
      const { open: openDialog, message: showMessage } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        title: "Import Files",
        multiple: true,
        filters: [
          { name: "All supported", extensions: ["sk", "sb", "md", "docx", "doc", "pdf", "pptx"] },
          { name: "Sketches (.sk)", extensions: ["sk"] },
          { name: "Storyboards (.sb)", extensions: ["sb"] },
          { name: "Markdown (.md)", extensions: ["md"] },
          { name: "Documents (.docx, .pdf, .pptx)", extensions: ["docx", "doc", "pdf", "pptx"] },
        ],
      });
      if (!selected) return;
      setImporting(true);

      // Helper: invoke an import command, handling file-exists conflicts.
      async function importWithConflict(
        command: string,
        filePath: string,
      ): Promise<string> {
        try {
          return await invoke<string>(command, { filePath });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith("FILE_EXISTS:")) {
            const existing = msg.slice("FILE_EXISTS:".length);
            const result = await showMessage(
              `"${existing}" already exists in this workspace.\n\nOverwrite will replace the file and its images.`,
              {
                title: "File Already Exists",
                buttons: { yes: "Overwrite", no: "Keep Both", cancel: "Cancel" },
              },
            );
            if (result === "Yes") {
              return await invoke<string>(command, { filePath, conflict: "overwrite" });
            } else if (result === "No") {
              return await invoke<string>(command, { filePath, conflict: "rename" });
            }
            return ""; // Cancel
          }
          throw err;
        }
      }

      const paths = Array.isArray(selected) ? selected : [selected];
      let importedNote = "";
      for (const raw of paths) {
        const filePath = typeof raw === "string" ? raw : String(raw);
        const ext = filePath.split(".").pop()?.toLowerCase();
        if (ext === "sk") {
          await importWithConflict("import_sketch", filePath);
        } else if (ext === "sb") {
          await importWithConflict("import_storyboard", filePath);
        } else if (ext === "md") {
          const result = await importWithConflict("import_markdown", filePath);
          if (result) importedNote = result;
        } else if (ext === "docx" || ext === "doc") {
          const result = await importWithConflict("import_docx", filePath);
          if (result) importedNote = result;
        } else if (ext === "pdf") {
          const result = await importWithConflict("import_pdf", filePath);
          if (result) importedNote = result;
        } else if (ext === "pptx") {
          const result = await importWithConflict("import_pptx", filePath);
          if (result) importedNote = result;
        }
      }
      await loadSketches();
      await loadStoryboards();
      await loadNotes();
      if (importedNote) openNote(importedNote);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] Import failed:", errMsg);

      // DRM-protected document? Offer clipboard fallback
      if (errMsg.includes("DRM-protected") || errMsg.includes("protected or encrypted")) {
        const ok = await showDrmConfirm();
        if (ok) {
          try {
            const text = await navigator.clipboard.readText();
            if (text && text.trim().length > 0) {
              const notePath = "imported-clipboard.md";
              await invoke("create_note", { relativePath: notePath });
              await invoke("update_note", { relativePath: notePath, content: text.trim() });
              await loadNotes();
              openNote(notePath);
            } else {
              showToast("Clipboard is empty — please copy the text from Word first", 5000, "warning");
            }
          } catch {
            showToast("Could not read clipboard — please make sure you copied text from Word", 5000, "warning");
          }
        }
      }
    } finally {
      setImporting(false);
    }
  }, [loadSketches, loadStoryboards, loadNotes, openNote, showDrmConfirm, showToast]);

  return (
    <div
      className="flex flex-col h-full bg-[rgb(var(--color-surface-inset))]"
    >
      {/* ── Project switcher ── */}
      <ProjectSwitcher />

      {/* ── Documents header ──────────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[rgb(var(--color-border-subtle))]">
        <span className="text-[12px] font-medium text-[rgb(var(--color-text-secondary))]">
          Documents
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleImport}
            className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors disabled:opacity-50 disabled:pointer-events-none"
            title="Import .sk, .sb, or document"
            disabled={importing}
          >
            {importing ? (
              <svg className="w-3 h-3 animate-spin text-[rgb(var(--color-text-secondary))]" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <ArrowDownTrayIcon className="w-3 h-3" />
            )}
          </button>
        </div>
      </div>

      {/* ── Storyboards section ────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-b border-[rgb(var(--color-border-subtle))]">
        <span className="text-[12px] font-medium text-[rgb(var(--color-text-secondary))]">
          Storyboards
        </span>
        <button
          onClick={() => setIsCreatingSb(true)}
          className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
          title="New storyboard"
        >
          <PlusIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {isCreatingSb && (
        <div className="px-3 py-2 border-b border-[rgb(var(--color-border))]">
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
            className="w-full px-2 py-1.5 rounded-md bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40"
          />
        </div>
      )}

      <div className="overflow-y-auto py-1" style={{ maxHeight: "40%" }}>
        {orderedStoryboards.length === 0 && !isCreatingSb ? (
          <button
            onClick={() => setIsCreatingSb(true)}
            className="w-full px-3 py-4 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors"
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
                    className={`group/item w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors cursor-pointer ${
                      sb.path === activeStoryboardPath
                        ? "bg-success/10 text-success"
                        : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
                    }`}
                  >
                    <StoryboardIcon className="shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{sb.title}</div>
                      <div className="text-[10px] text-[rgb(var(--color-text-secondary))]">
                        {sb.sketch_count} {sb.sketch_count === 1 ? "sketch" : "sketches"}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDelete("storyboard", sb.path, sb.title);
                      }}
                      className="opacity-0 group-hover/item:opacity-100 p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-all"
                      title="Delete storyboard"
                    >
                      <TrashIcon className="w-3 h-3" />
                    </button>
                  </div>
                </SortableSidebarItem>
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* ── Sketches section──────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-y border-[rgb(var(--color-border-subtle))]">
        <span className="text-[12px] font-medium text-[rgb(var(--color-text-secondary))]">
          Sketches
        </span>
        <button
          onClick={() => setIsCreatingSk(true)}
          className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
          title="New sketch"
        >
          <PlusIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {isCreatingSk && (
        <div className="px-3 py-2 border-b border-[rgb(var(--color-border))]">
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
            className="w-full px-2 py-1.5 rounded-md bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {orderedSketches.length === 0 && !isCreatingSk ? (
          <button
            onClick={() => setIsCreatingSk(true)}
            className="w-full px-3 py-4 text-xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] transition-colors"
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
                    className={`group/item w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors cursor-pointer ${
                      sk.path === activeSketchPath
                        ? "bg-violet-500/10 text-[rgb(var(--color-accent))]"
                        : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
                    }`}
                  >
                    <SketchIcon className="shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{sk.title}</div>
                      <div className="text-[10px] text-[rgb(var(--color-text-secondary))]">
                        {sk.row_count} {sk.row_count === 1 ? "row" : "rows"}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDelete("sketch", sk.path, sk.title);
                      }}
                      className="opacity-0 group-hover/item:opacity-100 p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-all"
                      title="Delete sketch"
                    >
                      <TrashIcon className="w-3 h-3" />
                    </button>
                  </div>
                </SortableSidebarItem>
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* ── Notes section─────────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-9 shrink-0 border-y border-[rgb(var(--color-border-subtle))]">
        <span className="text-[12px] font-medium text-[rgb(var(--color-text-secondary))]">
          Notes
        </span>
        <button
          onClick={() => setIsCreatingNote(true)}
          className="p-1 rounded-md text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-colors"
          title="New note"
        >
          <PlusIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {isCreatingNote && (
        <div className="px-3 py-2 border-b border-[rgb(var(--color-border))]">
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
            className="w-full px-2 py-1.5 rounded-md bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:outline-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {orderedNotes.length === 0 && !isCreatingNote ? (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <p className="text-xs text-[rgb(var(--color-text-secondary))] mb-3 leading-relaxed">
              Import a document or create a new note
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setIsCreatingNote(true)}
                className="px-3 py-1.5 text-[11px] rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))] transition-colors"
              >
                + New note
              </button>
              <button
                onClick={handleImport}
                className="px-3 py-1.5 text-[11px] rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:border-[rgb(var(--color-accent))] transition-colors"
              >
                Import
              </button>
            </div>
          </div>
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
                    className={`group/item w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors cursor-pointer ${
                      note.path === activeNotePath
                        ? "bg-rose-500/10 text-rose-500"
                        : "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
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
                      className="opacity-0 group-hover/item:opacity-100 p-0.5 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-all"
                      title="Delete note"
                    >
                      <TrashIcon className="w-3 h-3" />
                    </button>
                  </div>
                </SortableSidebarItem>
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* Delete confirmation overlay */}
      {pendingDelete && (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40">
          <div className="bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-xl shadow-xl p-5 max-w-sm mx-4">
            <p className="text-sm text-[rgb(var(--color-text))] mb-1 font-medium">Delete {pendingDelete.type}?</p>
            <p className="text-xs text-[rgb(var(--color-text-secondary))] mb-2">
              "{pendingDelete.title}" will be permanently deleted.
            </p>
            {pendingDelete.usedBy && pendingDelete.usedBy.length > 0 && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-warning/10 border border-warning/30">
                <p className="text-xs text-warning font-medium mb-1">⚠ Used in {pendingDelete.usedBy.length === 1 ? "a storyboard" : `${pendingDelete.usedBy.length} storyboards`}:</p>
                <ul className="text-[11px] text-amber-300/80 list-disc list-inside">
                  {pendingDelete.usedBy.map((t) => <li key={t}>{t}</li>)}
                </ul>
                <p className="text-[11px] text-amber-300/80 mt-1">Deleting will leave broken references.</p>
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 text-xs rounded-lg border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-colors"
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
                className="px-3 py-1.5 text-xs rounded-lg bg-error text-accent-fg hover:bg-error/80 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!drmConfirm}
        title="Protected Document"
        message={"This document is protected. To import it:\n\n1. Open the file in Word\n2. Select all text (Ctrl+A)\n3. Copy it (Ctrl+C)\n4. Click Import below\n\nThe note will be created from your clipboard."}
        confirmLabel="Import from Clipboard"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => { drmConfirm?.resolve(true); setDrmConfirm(null); }}
        onCancel={() => { drmConfirm?.resolve(false); setDrmConfirm(null); }}
      />
    </div>
  );
}
