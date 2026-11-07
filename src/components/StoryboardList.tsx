import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { invoke } from "../services/tauri";
import { ArrowRight, Copy, FolderOpen, History, Pencil, SquareTerminal } from "lucide-react";
import { openDocumentHistory } from "../hooks/useVersioningLifecycle";
import {
  clearSuppressedEditorFlush,
  makeMainTabId,
  makeSplitTabId,
  suppressEditorFlush,
  useAppStore,
  type SidebarOrder,
} from "../stores/appStore";
import type { ProjectEntry } from "../types/project";
import { DeleteAssetDialog, TransferConflictDialog, TransferWarningDialog, type PendingDelete, type TransferConflict, type TransferWarning } from "./docTree/ExplorerDialogs";
import { commandErrorText, transferConflictPath } from "../services/commandErrors";
import { documentRenamed, settleBeforeRename } from "../services/documentSaves";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { useToastStore } from "../stores/toastStore";
import { useStoryboardMembership } from "../hooks/useStoryboardMembership";
import { SortableTreeRow, TreeMiniButton, TreeRow, TreeSection, TreeSectionBody } from "./docTree/TreeRow";
import { TreeCreateForm } from "./docTree/TreeCreateForm";
import { applySidebarOrder } from "../utils/sidebarOrder";
import { sketchUsage, usageLabel } from "../utils/navigation";

interface RenameProjectAssetPlan {
  oldPath: string;
  newPath: string;
  updatedReferences: { path: string; count: number }[];
}

interface RenameConfirmation {
  message: string;
  resolve: (confirmed: boolean) => void;
}


/** StoryboardList: the Documents tree (storyboards with their sketches, loose sketches, notes, chats). */
export function StoryboardList() {
  const storyboards = useAppStore((s) => s.storyboards);
  const sketches = useAppStore((s) => s.sketches);
  const notes = useAppStore((s) => s.notes);
  const chatArtifacts = useAppStore((s) => s.chatArtifacts);
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
  const activeChatArtifactPath = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.type === "chat-artifact" ? tab.path : null;
  });
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const loadChatArtifacts = useAppStore((s) => s.loadChatArtifacts);
  const createStoryboard = useAppStore((s) => s.createStoryboard);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const deleteStoryboard = useAppStore((s) => s.deleteStoryboard);
  const createSketch = useAppStore((s) => s.createSketch);
  const openSketch = useAppStore((s) => s.openSketch);
  const deleteSketch = useAppStore((s) => s.deleteSketch);
  const createNote = useAppStore((s) => s.createNote);
  const openNote = useAppStore((s) => s.openNote);
  const openChatArtifact = useAppStore((s) => s.openChatArtifact);
  const deleteNote = useAppStore((s) => s.deleteNote);
  const deleteChatArtifact = useAppStore((s) => s.deleteChatArtifact);
  const closeStoryboard = useAppStore((s) => s.closeStoryboard);
  const sidebarOrder = useAppStore((s) => s.sidebarOrder);
  const saveSidebarOrder = useAppStore((s) => s.saveSidebarOrder);
  const projects = useAppStore((s) => s.projects);
  const isMultiProject = useAppStore((s) => s.isMultiProject);
  const currentProject = useAppStore((s) => s.currentProject);
  const closeTab = useAppStore((s) => s.closeTab);

  // Derive the current project's manifest key to filter it from the "move to" list
  const currentProjectEntryPath = currentProject
    ? (currentProject.root.replace(/\\/g, "/") === currentProject.repo_root.replace(/\\/g, "/")
        ? "."
        : currentProject.root.replace(/\\/g, "/").replace(currentProject.repo_root.replace(/\\/g, "/") + "/", ""))
    : null;
  const otherProjects = projects.filter((p) => p.path !== currentProjectEntryPath);

  const [isCreatingSb, setIsCreatingSb] = useState(false);
  const [newSbTitle, setNewSbTitle] = useState("");
  const [isCreatingSk, setIsCreatingSk] = useState(false);
  const [newSkTitle, setNewSkTitle] = useState("");
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [newNoteTitle, setNewNoteTitle] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [renameConfirm, setRenameConfirm] = useState<RenameConfirmation | null>(null);
  const showToast = useToastStore((s) => s.show);

  // ── Transfer (move/copy to project) state ───────────────────────
  const [contextMenu, setContextMenu] = useState<{
    type: "sketch" | "note" | "storyboard";
    path: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);

  const [transferWarning, setTransferWarning] = useState<TransferWarning | null>(null);
  const [transferConflict, setTransferConflict] = useState<TransferConflict | null>(null);

  // ── Inline rename state ──────────────────────────────────────────
  const [renamingItem, setRenamingItem] = useState<{ type: "storyboard" | "sketch" | "note" | "chat-artifact"; path: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameInFlightRef = useRef(false);

  /** Derive a safe filename from user-entered text. */
  const slugify = (text: string) => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  /** Enter rename mode for a sidebar item. */
  const startRename = useCallback((type: "storyboard" | "sketch" | "note" | "chat-artifact", path: string) => {
    // Extract current stem from the path for the initial value
    const filename = path.split("/").pop() ?? path;
    const stem = filename.replace(/\.(sk|sb|md|cv)$/, "");
    setRenamingItem({ type, path });
    setRenameValue(stem);
  }, []);

  /** Commit the rename — call backend, update tabs, reload lists. */
  const commitRename = useCallback(async () => {
    if (!renamingItem) return;
    if (renameInFlightRef.current) return;
    renameInFlightRef.current = true;
    const newStem = renameValue.trim();
    const slug = newStem ? slugify(newStem) : "";
    if (!slug) {
      renameInFlightRef.current = false;
      setRenamingItem(null);
      return;
    }

    const { type, path: oldPath } = renamingItem;
    const ext = type === "sketch" ? ".sk" : type === "storyboard" ? ".sb" : type === "chat-artifact" ? ".cv" : ".md";
    const dir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/") + 1) : "";
    const newPath = `${dir}${slug}${ext}`;

    if (newPath === oldPath) {
      renameInFlightRef.current = false;
      setRenamingItem(null);
      return;
    }

    let suppressedPaths = Array.from(new Set([oldPath, newPath]));
    try {
      // Pending edits reach the old file before it moves; editors stay quiet until the rename lands.
      await settleBeforeRename();
      for (const path of suppressedPaths) suppressEditorFlush(path);
      const preview = await invoke<RenameProjectAssetPlan>("preview_rename_project_asset", { oldPath, newPath });
      suppressedPaths = Array.from(new Set([...suppressedPaths, ...preview.updatedReferences.map((ref) => ref.path)]));
      for (const path of suppressedPaths) suppressEditorFlush(path);
      const referenceCount = preview.updatedReferences.reduce((sum, ref) => sum + ref.count, 0);
      if (referenceCount > 0) {
        const fileCount = preview.updatedReferences.length;
        const confirmed = await new Promise<boolean>((resolve) => {
          setRenameConfirm({
            message: `Rename ${oldPath.split("/").pop() ?? oldPath} to ${newPath.split("/").pop() ?? newPath}?\n\nThis will update ${referenceCount} reference${referenceCount === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
            resolve,
          });
        });
        if (!confirmed) return;
      }

      const result = await invoke<RenameProjectAssetPlan>("rename_project_asset", { oldPath, newPath });
      documentRenamed(result.oldPath, result.newPath);
      suppressedPaths = Array.from(new Set([...suppressedPaths, ...result.updatedReferences.map((ref) => ref.path)]));
      for (const path of suppressedPaths) suppressEditorFlush(path);

      // Update any open tab that references the old path
      const store = useAppStore.getState();
      const oldMainId = makeMainTabId(type, oldPath);
      const newMainId = makeMainTabId(type, newPath);
      const oldSplitId = makeSplitTabId(type, oldPath);
      const newSplitId = makeSplitTabId(type, newPath);
      const updatedTabs = store.openTabs.map((t) =>
        t.type === type && t.path === oldPath ? { ...t, path: newPath, id: newMainId } : t,
      );
      const updatedSplitTabs = store.splitTabs.map((t) =>
        t.type === type && t.path === oldPath ? { ...t, path: newPath, id: newSplitId } : t,
      );
      useAppStore.setState({
        openTabs: updatedTabs,
        activeTabId: store.activeTabId === oldMainId ? newMainId : store.activeTabId,
        splitTabs: updatedSplitTabs,
        splitActiveTabId: store.splitActiveTabId === oldSplitId ? newSplitId : store.splitActiveTabId,
        ...(type === "chat-artifact" && store.activeChatArtifactPath === oldPath ? { activeChatArtifactPath: newPath } : {}),
      });

      // Reload file lists
      if (type === "storyboard") await loadStoryboards();
      else if (type === "sketch") {
        await loadSketches();
        if (result.updatedReferences.length > 0) await loadStoryboards();
      }
      else if (type === "chat-artifact") await loadChatArtifacts();
      else await loadNotes();

      const updated = result.updatedReferences.reduce((sum, ref) => sum + ref.count, 0);
      showToast(
        updated > 0
          ? `Renamed and updated ${updated} reference${updated === 1 ? "" : "s"}.`
          : "Renamed file.",
        3500,
        "success",
      );
    } catch (err) {
      showToast(`Rename failed: ${commandErrorText(err)}`, 4000, "error");
    } finally {
      renameInFlightRef.current = false;
      window.setTimeout(() => suppressedPaths.forEach(clearSuppressedEditorFlush), 150);
      setRenamingItem(null);
    }
  }, [renamingItem, renameValue, loadStoryboards, loadSketches, loadNotes, loadChatArtifacts, showToast]);

  const cancelRename = useCallback(() => setRenamingItem(null), []);

  // Auto-focus rename input when entering rename mode
  useEffect(() => {
    if (renamingItem) {
      requestAnimationFrame(() => renameInputRef.current?.select());
    }
  }, [renamingItem]);

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

  const requestDelete = useCallback(async (type: "storyboard" | "sketch" | "note" | "chat-artifact", path: string, title: string) => {
    let usedBy: string[] | undefined;
    if (type === "sketch") {
      try {
        usedBy = await invoke<string[]>("sketch_used_by_storyboards", { relativePath: path });
      } catch { /* ignore */ }
    }
    setPendingDelete({ type, path, title, usedBy });
  }, []);

  const doTransfer = useCallback(async (
    action: "move" | "copy",
    type: "sketch" | "note" | "storyboard",
    sourcePath: string,
    sourceTitle: string,
    destProject: ProjectEntry,
    destRel: string,
  ) => {
    try {
      await invoke("transfer_asset", {
        sourceRel: sourcePath,
        destProjectPath: destProject.path,
        destRel,
        removeSource: action === "move",
      });
      await Promise.all([loadSketches(), loadNotes(), loadStoryboards()]);
      if (action === "move") {
        const tab = useAppStore.getState().openTabs.find((t) => t.path === sourcePath);
        if (tab) closeTab(tab.id);
      }
      showToast(`${action === "move" ? "Moved" : "Copied"} "${sourceTitle}" to ${destProject.name}`, 3000, "success");
    } catch (err) {
      const destRelExisting = transferConflictPath(err);
      if (destRelExisting !== null) {
        const filename = destRelExisting.split("/").pop() ?? sourceTitle;
        const dotIdx = filename.lastIndexOf(".");
        const ext = dotIdx >= 0 ? filename.slice(dotIdx) : "";
        const stem = dotIdx >= 0 ? filename.slice(0, dotIdx) : filename;
        setTransferConflict({ action, type, sourcePath, sourceTitle, destProject, ext, stem });
      } else {
        showToast(`Failed to ${action}: ${commandErrorText(err)}`, 4000, "error");
      }
    }
  }, [loadSketches, loadNotes, loadStoryboards, closeTab, showToast]);

  const handleTransfer = useCallback(async (
    action: "move" | "copy",
    type: "sketch" | "note" | "storyboard",
    path: string,
    title: string,
    destProject: ProjectEntry,
  ) => {
    // Warn if moving a sketch that's referenced by storyboards
    if (action === "move" && type === "sketch") {
      let usedBy: string[] = [];
      try { usedBy = await invoke<string[]>("sketch_used_by_storyboards", { relativePath: path }); } catch { /* ignore */ }
      if (usedBy.length > 0) {
        setTransferWarning({ action, type, sourcePath: path, sourceTitle: title, destProject, usedBy });
        return;
      }
    }
    doTransfer(action, type, path, title, destProject, path);
  }, [doTransfer]);

  const buildContextMenuItems = useCallback((
    type: "sketch" | "note" | "storyboard",
    path: string,
    title: string,
  ): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: "Rename File...", icon: <Pencil className="w-3.5 h-3.5" />, action: () => startRename(type, path) },
      { label: "View history", icon: <History className="w-3.5 h-3.5" />, action: () => openDocumentHistory(path, title) },
    ];

    if (currentProject) {
      items.push({ separator: true });
      items.push({
        label: "Open in Terminal",
        icon: <SquareTerminal className="w-3.5 h-3.5" />,
        action: () => invoke("open_in_terminal", { path: currentProject.root }),
      });
    }

    if (isMultiProject && otherProjects.length > 0) {
      if (items.length > 0) items.push({ separator: true });
      const projectItems = (action: "move" | "copy"): ContextMenuItem[] =>
        otherProjects.map((p) => ({
          label: p.name,
          icon: <FolderOpen className="w-3.5 h-3.5" />,
          action: () => handleTransfer(action, type, path, title, p),
        }));
      items.push(
        { label: "Move to", icon: <ArrowRight className="w-3.5 h-3.5" />, submenu: projectItems("move") },
        { label: "Copy to", icon: <Copy className="w-3.5 h-3.5" />, submenu: projectItems("copy") },
      );
    }

    return items;
  }, [currentProject, isMultiProject, otherProjects, handleTransfer, startRename]);

  useEffect(() => {
    loadStoryboards();
    loadSketches();
    loadNotes();
    loadChatArtifacts();
  }, [loadStoryboards, loadSketches, loadNotes, loadChatArtifacts]);

  // Apply sidebar order
  const orderedStoryboards = applySidebarOrder(storyboards, sidebarOrder?.storyboards ?? []);
  const orderedSketches = applySidebarOrder(sketches, sidebarOrder?.sketches ?? []);
  const orderedNotes = applySidebarOrder(notes, sidebarOrder?.notes ?? []);
  const membership = useStoryboardMembership(orderedStoryboards);
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

  const renameInput = (label: string) => (
    <input
      ref={renameInputRef}
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commitRename();
        if (e.key === "Escape") cancelRename();
      }}
      onBlur={commitRename}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      title="Rename file. Spaces become hyphens."
      className="rename"
    />
  );

  const openContextMenu = (type: "storyboard" | "sketch" | "note", path: string, title: string) =>
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (buildContextMenuItems(type, path, title).length === 0) return;
      e.preventDefault();
      setContextMenu({ type, path, title, x: e.clientX, y: e.clientY });
    };

  const isRenaming = (path: string) => renamingItem?.path === path;
  const usage = sketchUsage(membership);

  const sectionOpen = (id: string) => !collapsedSections.has(id);
  const setSectionOpen = (id: string, open: boolean) =>
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  const section = (id: string, label: string) => ({
    label,
    collapsed: !sectionOpen(id),
    onToggle: () => setSectionOpen(id, !sectionOpen(id)),
  });

  return (
    <div className="cr-tree" role="group" aria-label="Documents">
      <div className="cr-sec">
      <TreeSection {...section("storyboards", "Storyboards")}>
        <TreeMiniButton label="New storyboard" onClick={() => { setSectionOpen("storyboards", true); setIsCreatingSb(true); }} />
      </TreeSection>
      <TreeSectionBody open={sectionOpen("storyboards")}>
      {isCreatingSb && (
        <TreeCreateForm
          id="new-storyboard-title"
          label="Storyboard name"
          value={newSbTitle}
          onChange={setNewSbTitle}
          onCreate={() => void handleCreateSb()}
          onCancel={() => { setIsCreatingSb(false); setNewSbTitle(""); }}
        />
      )}
      {orderedStoryboards.length === 0 && !isCreatingSb && <div className="cr-tempty">No storyboards yet</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("storyboards")}>
        <SortableContext items={orderedStoryboards.map((sb) => sb.path)} strategy={verticalListSortingStrategy}>
          {orderedStoryboards.map((sb) => (
            <SortableTreeRow
              key={sb.path}
              id={sb.path}
              icon="clapper"
              label={sb.title}
              kind="storyboard"
              selected={sb.path === activeStoryboardPath}
              onOpen={() => openStoryboard(sb.path)}
              onRename={() => startRename("storyboard", sb.path)}
              onDelete={() => requestDelete("storyboard", sb.path, sb.title)}
              onContextMenu={openContextMenu("storyboard", sb.path, sb.title)}
              renameInput={isRenaming(sb.path) ? renameInput("Rename storyboard file") : undefined}
              testId={`explorer-item-${sb.path}`}
            />
          ))}
        </SortableContext>
      </DndContext>

      </TreeSectionBody>
      </div>

      <div className="cr-sec">
      <TreeSection {...section("sketches", "Sketches")}>
        <TreeMiniButton label="New sketch" onClick={() => { setSectionOpen("sketches", true); setIsCreatingSk(true); }} />
      </TreeSection>
      <TreeSectionBody open={sectionOpen("sketches")}>
      {isCreatingSk && (
        <TreeCreateForm
          id="new-sketch-title"
          label="Sketch name"
          value={newSkTitle}
          onChange={setNewSkTitle}
          onCreate={() => void handleCreateSk()}
          onCancel={() => { setIsCreatingSk(false); setNewSkTitle(""); }}
        />
      )}
      {orderedSketches.length === 0 && !isCreatingSk && <div className="cr-tempty">No sketches yet</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("sketches")}>
        <SortableContext items={orderedSketches.map((sk) => sk.path)} strategy={verticalListSortingStrategy}>
          {orderedSketches.map((sk) => (
            <SortableTreeRow
              key={sk.path}
              id={sk.path}
              icon="sketch"
              label={sk.title}
              kind="sketch"
              selected={sk.path === activeSketchPath}
              meta={usageLabel(usage.get(sk.path) ?? 0)}
              onOpen={() => void handleOpenSketchStandalone(sk.path)}
              onRename={() => startRename("sketch", sk.path)}
              onDelete={() => requestDelete("sketch", sk.path, sk.title)}
              onContextMenu={openContextMenu("sketch", sk.path, sk.title)}
              renameInput={isRenaming(sk.path) ? renameInput("Rename sketch file") : undefined}
              testId={`explorer-item-${sk.path}`}
            />
          ))}
        </SortableContext>
      </DndContext>

      </TreeSectionBody>
      </div>

      <div className="cr-sec">
      <TreeSection {...section("notes", "Notes")}>
        <TreeMiniButton label="New note" onClick={() => { setSectionOpen("notes", true); setIsCreatingNote(true); }} />
      </TreeSection>
      <TreeSectionBody open={sectionOpen("notes")}>
      {isCreatingNote && (
        <TreeCreateForm
          id="new-note-title"
          label="Note name"
          value={newNoteTitle}
          onChange={setNewNoteTitle}
          onCreate={() => void handleCreateNote()}
          onCancel={() => { setIsCreatingNote(false); setNewNoteTitle(""); }}
        />
      )}
      {orderedNotes.length === 0 && !isCreatingNote && <div className="cr-tempty">No notes yet</div>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd("notes")}>
        <SortableContext items={orderedNotes.map((n) => n.path)} strategy={verticalListSortingStrategy}>
          {orderedNotes.map((note) => (
            <SortableTreeRow
              key={note.path}
              id={note.path}
              icon="note"
              label={note.title}
              kind="note"
              selected={note.path === activeNotePath}
              onOpen={() => openNote(note.path)}
              onRename={() => startRename("note", note.path)}
              onDelete={() => requestDelete("note", note.path, note.title)}
              onContextMenu={openContextMenu("note", note.path, note.title)}
              renameInput={isRenaming(note.path) ? renameInput("Rename note file") : undefined}
              testId={`explorer-item-${note.path}`}
            />
          ))}
        </SortableContext>
      </DndContext>

      </TreeSectionBody>
      </div>

      {chatArtifacts.length > 0 && (
        <div className="cr-sec">
          <TreeSection {...section("chats", "Promoted chats")} />
          <TreeSectionBody open={sectionOpen("chats")}>
          {chatArtifacts.map((artifact) => (
            <TreeRow
              key={artifact.path}
              icon="chat"
              label={artifact.title}
              kind="chat"
              selected={artifact.path === activeChatArtifactPath}
              onOpen={() => openChatArtifact(artifact.path)}
              onRename={() => startRename("chat-artifact", artifact.path)}
              onDelete={() => requestDelete("chat-artifact", artifact.path, artifact.title)}
              renameInput={isRenaming(artifact.path) ? renameInput("Rename chat") : undefined}
            />
          ))}
          </TreeSectionBody>
        </div>
      )}

      <DeleteAssetDialog
        pending={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={({ type, path }) => {
          setPendingDelete(null);
          if (type === "sketch") deleteSketch(path);
          else if (type === "storyboard") deleteStoryboard(path);
          else if (type === "chat-artifact") deleteChatArtifact(path);
          else deleteNote(path);
        }}
      />

      <ConfirmDialog
        open={!!renameConfirm}
        title="Rename and update references?"
        message={renameConfirm?.message ?? ""}
        confirmLabel="Rename and update"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => { renameConfirm?.resolve(true); setRenameConfirm(null); }}
        onCancel={() => { renameConfirm?.resolve(false); setRenameConfirm(null); }}
      />
      {/* Context menu (portal — rendered above DnD layer) */}
      {contextMenu && (
        <ContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          items={buildContextMenuItems(contextMenu.type, contextMenu.path, contextMenu.title)}
          onClose={() => setContextMenu(null)}
        />
      )}

      <TransferWarningDialog
        warning={transferWarning}
        onCancel={() => setTransferWarning(null)}
        onConfirm={({ action, type, sourcePath, sourceTitle, destProject }) => {
          setTransferWarning(null);
          doTransfer(action, type, sourcePath, sourceTitle, destProject, sourcePath);
        }}
      />
      <TransferConflictDialog
        conflict={transferConflict}
        onCancel={() => setTransferConflict(null)}
        onSubmit={({ action, type, sourcePath, sourceTitle, destProject }, destRel) => {
          setTransferConflict(null);
          doTransfer(action, type, sourcePath, sourceTitle, destProject, destRel);
        }}
      />
    </div>
  );
}
