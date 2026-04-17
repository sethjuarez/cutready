import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";
import { NoteIcon, SketchIcon, StoryboardIcon } from "./Icons";
import { ChevronRight, Folder, FileText } from "lucide-react";

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

// ── Component ────────────────────────────────────────────────────

export function FileTreeView() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const openSketch = useAppStore((s) => s.openSketch);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const closeStoryboard = useAppStore((s) => s.closeStoryboard);
  const openNote = useAppStore((s) => s.openNote);

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
      if (node.ext === "sk") {
        closeStoryboard();
        openSketch(node.path);
      } else if (node.ext === "sb") {
        openStoryboard(node.path);
      } else if (node.ext === "md") {
        openNote(node.path);
      }
    },
    [openSketch, openStoryboard, closeStoryboard, openNote],
  );

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
    <div className="flex-1 overflow-y-auto py-1">
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path || node.name}
          node={node}
          depth={0}
          activeSketchPath={activeSketchPath}
          activeStoryboardPath={activeStoryboardPath}
          activeNotePath={activeNotePath}
          onClick={handleClick}
        />
      ))}
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
  onClick,
}: {
  node: TreeNode;
  depth: number;
  activeSketchPath: string | null;
  activeStoryboardPath: string | null;
  activeNotePath: string | null;
  onClick: (node: TreeNode) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1 && !node.name.startsWith("."));

  const isActive =
    (node.ext === "sk" && node.path === activeSketchPath && !activeStoryboardPath) ||
    (node.ext === "sb" && node.path === activeStoryboardPath) ||
    (node.ext === "md" && node.path === activeNotePath);

  const isClickable = !node.is_dir && ["sk", "sb", "md"].includes(node.ext);

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
              onClick={onClick}
            />
          ))}
      </>
    );
  }

  // File node
  return (
    <button
      onClick={isClickable ? () => onClick(node) : undefined}
      className={`w-full flex items-center gap-1.5 px-3 py-1 text-left transition-colors ${
        isActive
          ? "bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]"
          : isClickable
            ? "text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
            : "text-[rgb(var(--color-text-secondary))] opacity-60"
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px`, cursor: isClickable ? "pointer" : "default" }}
      title={`${node.path} (${formatSize(node.size)})`}
    >
      <span className="w-3 shrink-0" />
      {fileIcon(node.ext)}
      <span className="text-xs truncate">{node.name}</span>
      <span className="text-[10px] text-[rgb(var(--color-text-secondary))]/40 ml-auto shrink-0">
        {formatSize(node.size)}
      </span>
    </button>
  );
}
