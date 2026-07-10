import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { invoke } from "../services/tauri";
import {
  clearSuppressedEditorFlush,
  makeMainTabId,
  makeSplitTabId,
  suppressEditorFlush,
  useAppStore,
  type EditorTab,
} from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { DatabaseIcon, NoteIcon, SketchIcon, StoryboardIcon } from "./Icons";
import { ChevronRight, Folder, FileText, Pencil } from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { useConfirmDialog } from "./ConfirmDialog";

// ── Types ────────────────────────────────────────────────────────

interface FileEntry {
  path: string;
  ext: string;
  size: number;
  is_dir: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  ext: string;
  is_dir: boolean;
  size: number;
  children: TreeNode[];
}

interface RenameReferenceUpdate {
  path: string;
  count: number;
}

interface RenameProjectAssetPlan {
  oldPath: string;
  newPath: string;
  kind: string;
  updatedReferences: RenameReferenceUpdate[];
}

// ── Tree building ────────────────────────────────────────────────

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", ext: "", is_dir: true, size: 0, children: [] };

  for (const f of files) {
    const segments = f.path.split("/");
    let current = root;

    // Walk/create intermediate folders
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let child = current.children.find((c) => c.is_dir && c.name === seg);
      if (!child) {
        child = {
          name: seg,
          path: segments.slice(0, i + 1).join("/"),
          ext: "",
          is_dir: true,
          size: 0,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }

    // Add file/leaf (directories are already created above)
    if (!f.is_dir) {
      current.children.push({
        name: segments[segments.length - 1],
        path: f.path,
        ext: f.ext,
        is_dir: false,
        size: f.size,
        children: [],
      });
    }
  }

  // Sort: folders first, then alphabetically
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const n of nodes) if (n.children.length > 0) sortNodes(n.children);
  };
  sortNodes(root.children);

  return root.children;
}

// ── Icon helpers ─────────────────────────────────────────────────

function fileIcon(ext: string) {
  switch (ext) {
    case "sk":
      return <SketchIcon className="shrink-0" />;
    case "sb":
      return <StoryboardIcon className="shrink-0" />;
    case "md":
      return <NoteIcon className="shrink-0" />;
    case "db":
    case "sqlite":
    case "sqlite3":
      return <DatabaseIcon className="shrink-0" />;
    default:
      return (
        <FileText className="w-3.5 h-3.5 shrink-0 opacity-50" />
      );
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isRenameableFile(node: TreeNode): boolean {
  if (node.is_dir) return false;
  if (["sk", "sb", "md"].includes(node.ext)) return true;
  const lower = node.path.toLowerCase();
  return lower.startsWith(".cutready/screenshots/")
    || (lower.startsWith(".cutready/visuals/") && lower.endsWith(".json"));
}

function splitPath(path: string) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = file.lastIndexOf(".");
  return {
    dir,
    file,
    stem: dot > 0 ? file.slice(0, dot) : file,
    ext: dot > 0 ? file.slice(dot) : "",
  };
}

function sanitizeFileStem(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-").replace(/^-+|-+$/g, "");
}

function tabTypeForPath(path: string): EditorTab["type"] | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".sk")) return "sketch";
  if (lower.endsWith(".sb")) return "storyboard";
  if (lower.endsWith(".md")) return "note";
  if (lower.startsWith(".cutready/screenshots/") || lower.startsWith(".cutready/visuals/")) return "asset";
  return null;
}

// ── Component ────────────────────────────────────────────────────

export function FileTreeView() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameInFlightRef = useRef(false);
  const { confirm, confirmationDialog } = useConfirmDialog();
  const showToast = useToastStore((s) => s.show);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const openSketch = useAppStore((s) => s.openSketch);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const closeStoryboard = useAppStore((s) => s.closeStoryboard);
  const openNote = useAppStore((s) => s.openNote);
  const openAsset = useAppStore((s) => s.openAsset);
  const openDatabase = useAppStore((s) => s.openDatabase);
  const loadSketches = useAppStore((s) => s.loadSketches);
  const loadStoryboards = useAppStore((s) => s.loadStoryboards);
  const loadNotes = useAppStore((s) => s.loadNotes);
  const loadAssets = useAppStore((s) => s.loadAssets);

  // Reload whenever the categorized lists change (signals a file was created/deleted)
  const sketchCount = useAppStore((s) => s.sketches.length);
  const noteCount = useAppStore((s) => s.notes.length);
  const storyboardCount = useAppStore((s) => s.storyboards.length);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    invoke<FileEntry[]>("list_all_files")
      .then((result) => { if (!cancelled) setFiles(result); })
      .catch((err) => console.error("list_all_files:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sketchCount, noteCount, storyboardCount]);

  const handleClick = useCallback(
    (node: TreeNode) => {
      if (node.is_dir) return;
      setSelectedPath(node.path);
      if (node.ext === "sk") {
        closeStoryboard();
        openSketch(node.path);
      } else if (node.ext === "sb") {
        openStoryboard(node.path);
      } else if (node.ext === "md") {
        openNote(node.path);
      } else if (isRenameableFile(node)) {
        openAsset(node.path, node.path.includes("/visuals/") ? "visual" : "screenshot");
      } else if (["db", "sqlite", "sqlite3"].includes(node.ext)) {
        openDatabase(node.path);
      }
    },
    [openSketch, openStoryboard, closeStoryboard, openNote, openAsset, openDatabase],
  );

  const refreshFileTree = useCallback(async () => {
    const result = await invoke<FileEntry[]>("list_all_files");
    setFiles(result);
  }, []);

  const startRename = useCallback((node: TreeNode) => {
    if (!isRenameableFile(node)) {
      showToast("This file type cannot be renamed from CutReady.", 3000, "warning");
      return;
    }
    const { stem } = splitPath(node.path);
    setSelectedPath(node.path);
    setRenamingPath(node.path);
    setRenameValue(stem);
  }, [showToast]);

  const applySuccessfulRename = useCallback(async (plan: RenameProjectAssetPlan) => {
    const oldType = tabTypeForPath(plan.oldPath);
    const newType = tabTypeForPath(plan.newPath);
    const renamedTitle = splitPath(plan.newPath).file;
    const suppressed = Array.from(new Set([
      plan.oldPath,
      plan.newPath,
      ...plan.updatedReferences.map((ref) => ref.path),
    ]));
    for (const path of suppressed) suppressEditorFlush(path);

    const store = useAppStore.getState();
    const remapTab = (tab: EditorTab, split: boolean): EditorTab => {
      if (!oldType || !newType || tab.type !== oldType || tab.path !== plan.oldPath) return tab;
      return {
        ...tab,
        id: split ? makeSplitTabId(newType, plan.newPath) : makeMainTabId(newType, plan.newPath),
        type: newType,
        path: plan.newPath,
        title: renamedTitle,
      };
    };
    const oldMainId = oldType ? makeMainTabId(oldType, plan.oldPath) : null;
    const newMainId = newType ? makeMainTabId(newType, plan.newPath) : null;
    const oldSplitId = oldType ? makeSplitTabId(oldType, plan.oldPath) : null;
    const newSplitId = newType ? makeSplitTabId(newType, plan.newPath) : null;

    useAppStore.setState({
      openTabs: store.openTabs.map((tab) => remapTab(tab, false)),
      splitTabs: store.splitTabs.map((tab) => remapTab(tab, true)),
      activeTabId: store.activeTabId === oldMainId ? newMainId : store.activeTabId,
      splitActiveTabId: store.splitActiveTabId === oldSplitId ? newSplitId : store.splitActiveTabId,
      activeSketchPath: store.activeSketchPath === plan.oldPath ? plan.newPath : store.activeSketchPath,
      activeStoryboardPath: store.activeStoryboardPath === plan.oldPath ? plan.newPath : store.activeStoryboardPath,
      activeNotePath: store.activeNotePath === plan.oldPath ? plan.newPath : store.activeNotePath,
    });

    await Promise.all([loadSketches(), loadStoryboards(), loadNotes(), loadAssets(), refreshFileTree()]);
    const nextStore = useAppStore.getState();
    if (nextStore.activeSketchPath && [plan.newPath, ...plan.updatedReferences.map((ref) => ref.path)].includes(nextStore.activeSketchPath)) {
      await nextStore.openSketch(nextStore.activeSketchPath);
    } else if (nextStore.activeStoryboardPath && [plan.newPath, ...plan.updatedReferences.map((ref) => ref.path)].includes(nextStore.activeStoryboardPath)) {
      await nextStore.openStoryboard(nextStore.activeStoryboardPath);
    } else if (nextStore.activeNotePath && [plan.newPath, ...plan.updatedReferences.map((ref) => ref.path)].includes(nextStore.activeNotePath)) {
      await nextStore.openNote(nextStore.activeNotePath);
    }
    useAppStore.getState()._persistTabs();
    window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
    window.setTimeout(() => suppressed.forEach(clearSuppressedEditorFlush), 150);
  }, [loadAssets, loadNotes, loadSketches, loadStoryboards, refreshFileTree]);

  const commitRename = useCallback(async () => {
    if (!renamingPath) return;
    if (renameInFlightRef.current) return;
    renameInFlightRef.current = true;
    const { dir, ext } = splitPath(renamingPath);
    const stem = sanitizeFileStem(renameValue);
    if (!stem) {
      renameInFlightRef.current = false;
      setRenamingPath(null);
      return;
    }
    const newPath = `${dir}${stem}${ext}`;
    if (newPath === renamingPath) {
      renameInFlightRef.current = false;
      setRenamingPath(null);
      return;
    }
    const suppressed = [renamingPath, newPath];
    for (const path of suppressed) suppressEditorFlush(path);
    try {
      const preview = await invoke<RenameProjectAssetPlan>("preview_rename_project_asset", {
        oldPath: renamingPath,
        newPath,
      });
      const referenceCount = preview.updatedReferences.reduce((sum, ref) => sum + ref.count, 0);
      if (referenceCount > 0) {
        const fileCount = preview.updatedReferences.length;
        const confirmed = await confirm({
          title: "Rename and update references?",
          message: `Rename ${splitPath(preview.oldPath).file} to ${splitPath(preview.newPath).file}?\n\nThis will update ${referenceCount} reference${referenceCount === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
          confirmLabel: "Rename and update",
          variant: "warning",
        });
        if (!confirmed) return;
      }
      const result = await invoke<RenameProjectAssetPlan>("rename_project_asset", {
        oldPath: renamingPath,
        newPath,
      });
      await applySuccessfulRename(result);
      const updated = result.updatedReferences.reduce((sum, ref) => sum + ref.count, 0);
      showToast(updated > 0 ? `Renamed and updated ${updated} reference${updated === 1 ? "" : "s"}.` : "Renamed file.", 3500, "success");
    } catch (err) {
      showToast(`Rename failed: ${err}`, 5000, "error");
    } finally {
      renameInFlightRef.current = false;
      suppressed.forEach(clearSuppressedEditorFlush);
      setRenamingPath(null);
    }
  }, [applySuccessfulRename, confirm, renameValue, renamingPath, showToast]);

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  useEffect(() => {
    if (renamingPath) requestAnimationFrame(() => renameInputRef.current?.select());
  }, [renamingPath]);

  const handleTreeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "F2" || !selectedPath) return;
    const node = files.find((file) => file.path === selectedPath && !file.is_dir);
    if (!node) return;
    event.preventDefault();
    startRename({ name: splitPath(node.path).file, path: node.path, ext: node.ext, is_dir: false, size: node.size, children: [] });
  }, [files, selectedPath, startRename]);

  const buildContextMenuItems = useCallback((node: TreeNode): ContextMenuItem[] => [
    {
      label: "Rename File...",
      icon: <Pencil className="w-3.5 h-3.5" />,
      disabled: !isRenameableFile(node),
      action: () => startRename(node),
    },
  ], [startRename]);

  const tree = buildTree(files);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center px-3">
        <p className="text-xs text-[rgb(var(--color-text-secondary))]">Loading…</p>
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-3">
        <p className="text-xs text-[rgb(var(--color-text-secondary))] text-center">
          No files yet. Create a sketch or note to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1" tabIndex={0} onKeyDown={handleTreeKeyDown}>
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path || node.name}
          node={node}
          depth={0}
          activeSketchPath={activeSketchPath}
          activeStoryboardPath={activeStoryboardPath}
          activeNotePath={activeNotePath}
          selectedPath={selectedPath}
          renamingPath={renamingPath}
          renameValue={renameValue}
          renameInputRef={renameInputRef}
          onClick={handleClick}
          onContextMenu={(event, node) => {
            event.preventDefault();
            setSelectedPath(node.path);
            setContextMenu({ x: event.clientX, y: event.clientY, node });
          }}
          onStartRename={startRename}
          onRenameValueChange={setRenameValue}
          onCommitRename={commitRename}
          onCancelRename={cancelRename}
        />
      ))}
      {contextMenu && (
        <ContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          items={buildContextMenuItems(contextMenu.node)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {confirmationDialog}
    </div>
  );
}

// ── TreeNodeRow ──────────────────────────────────────────────────

function TreeNodeRow({
  node,
  depth,
  activeSketchPath,
  activeStoryboardPath,
  activeNotePath,
  selectedPath,
  renamingPath,
  renameValue,
  renameInputRef,
  onClick,
  onContextMenu,
  onStartRename,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
}: {
  node: TreeNode;
  depth: number;
  activeSketchPath: string | null;
  activeStoryboardPath: string | null;
  activeNotePath: string | null;
  selectedPath: string | null;
  renamingPath: string | null;
  renameValue: string;
  renameInputRef: RefObject<HTMLInputElement | null>;
  onClick: (node: TreeNode) => void;
  onContextMenu: (event: MouseEvent, node: TreeNode) => void;
  onStartRename: (node: TreeNode) => void;
  onRenameValueChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1 && !node.name.startsWith("."));

  const isActive =
    (node.ext === "sk" && node.path === activeSketchPath && !activeStoryboardPath) ||
    (node.ext === "sb" && node.path === activeStoryboardPath) ||
    (node.ext === "md" && node.path === activeNotePath);

  const isClickable = !node.is_dir && (["sk", "sb", "md", "db", "sqlite", "sqlite3"].includes(node.ext) || isRenameableFile(node));
  const isSelected = node.path === selectedPath;

  if (node.is_dir) {
    return (
      <>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center gap-1.5 px-3 py-1 text-left text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
          <Folder className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs font-medium truncate">{node.name}</span>
          <span className="text-[10px] text-[rgb(var(--color-text-secondary))]/50 ml-auto shrink-0">
            {node.children.length}
          </span>
        </button>
        {expanded &&
          node.children.map((child) => (
            <TreeNodeRow
              key={child.path || child.name}
              node={child}
              depth={depth + 1}
              activeSketchPath={activeSketchPath}
              activeStoryboardPath={activeStoryboardPath}
              activeNotePath={activeNotePath}
              selectedPath={selectedPath}
              renamingPath={renamingPath}
              renameValue={renameValue}
              renameInputRef={renameInputRef}
              onClick={onClick}
              onContextMenu={onContextMenu}
              onStartRename={onStartRename}
              onRenameValueChange={onRenameValueChange}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          ))}
      </>
    );
  }

  // File node
  return (
    <button
      onClick={isClickable ? () => onClick(node) : undefined}
      onDoubleClick={isRenameableFile(node) ? () => onStartRename(node) : undefined}
      onContextMenu={(event) => onContextMenu(event, node)}
      className={`w-full flex items-center gap-1.5 px-3 py-1 text-left transition-colors ${
        isActive
          ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
          : isSelected
            ? "bg-[rgb(var(--color-surface-alt))] text-[rgb(var(--color-text))]"
          : isClickable
            ? "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
            : "text-[rgb(var(--color-text-secondary))] opacity-60"
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px`, cursor: isClickable ? "pointer" : "default" }}
      title={`${node.path} (${formatSize(node.size)})`}
    >
      <span className="w-3 shrink-0" />
      {fileIcon(node.ext)}
      {renamingPath === node.path ? (
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(event) => onRenameValueChange(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={onCommitRename}
          className="min-w-0 flex-1 rounded border border-[rgb(var(--color-accent))] bg-[rgb(var(--color-surface))] px-1 py-0.5 text-xs text-[rgb(var(--color-text))] outline-none"
        />
      ) : (
        <span className="text-xs truncate">{node.name}</span>
      )}
      <span className="text-[10px] text-[rgb(var(--color-text-secondary))]/40 ml-auto shrink-0">
        {formatSize(node.size)}
      </span>
    </button>
  );
}
