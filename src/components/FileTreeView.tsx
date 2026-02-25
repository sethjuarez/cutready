import { useCallback, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { SketchSummary, StoryboardSummary } from "../types/sketch";

interface TreeNode {
  name: string;
  /** Full relative path (for files only). */
  path?: string;
  type: "folder" | "sketch" | "storyboard";
  children: TreeNode[];
  /** Title from metadata (for files). */
  title?: string;
  /** Extra info line. */
  detail?: string;
}

/** Build a tree from flat lists of sketch and storyboard summaries. */
function buildTree(
  sketches: SketchSummary[],
  storyboards: StoryboardSummary[],
): TreeNode[] {
  const root: TreeNode = { name: "", type: "folder", children: [] };

  const ensureFolder = (parts: string[]): TreeNode => {
    let current = root;
    for (const part of parts) {
      let child = current.children.find(
        (c) => c.type === "folder" && c.name === part,
      );
      if (!child) {
        child = { name: part, type: "folder", children: [] };
        current.children.push(child);
      }
      current = child;
    }
    return current;
  };

  for (const sk of sketches) {
    const segments = sk.path.split("/");
    const fileName = segments.pop()!;
    const parent = ensureFolder(segments);
    parent.children.push({
      name: fileName,
      path: sk.path,
      type: "sketch",
      title: sk.title,
      detail: `${sk.row_count} ${sk.row_count === 1 ? "row" : "rows"}`,
      children: [],
    });
  }

  for (const sb of storyboards) {
    const segments = sb.path.split("/");
    const fileName = segments.pop()!;
    const parent = ensureFolder(segments);
    parent.children.push({
      name: fileName,
      path: sb.path,
      type: "storyboard",
      title: sb.title,
      detail: `${sb.sketch_count} ${sb.sketch_count === 1 ? "sketch" : "sketches"}`,
      children: [],
    });
  }

  // Sort: folders first, then alphabetically
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type === "folder" && b.type !== "folder") return -1;
      if (a.type !== "folder" && b.type === "folder") return 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children.length > 0) sortNodes(n.children);
    }
  };
  sortNodes(root.children);

  return root.children;
}

/**
 * FileTreeView — shows project files as a folder hierarchy.
 */
export function FileTreeView() {
  const sketches = useAppStore((s) => s.sketches);
  const storyboards = useAppStore((s) => s.storyboards);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);
  const openSketch = useAppStore((s) => s.openSketch);
  const openStoryboard = useAppStore((s) => s.openStoryboard);
  const closeStoryboard = useAppStore((s) => s.closeStoryboard);

  const tree = buildTree(sketches, storyboards);

  const handleClick = useCallback(
    (node: TreeNode) => {
      if (node.type === "sketch" && node.path) {
        closeStoryboard();
        openSketch(node.path);
      } else if (node.type === "storyboard" && node.path) {
        openStoryboard(node.path);
      }
    },
    [openSketch, openStoryboard, closeStoryboard],
  );

  if (tree.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-3">
        <p className="text-xs text-[var(--color-text-secondary)] text-center">
          No files yet. Create a sketch or storyboard to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path ?? node.name}
          node={node}
          depth={0}
          activeSketchPath={activeSketchPath}
          activeStoryboardPath={activeStoryboardPath}
          onClick={handleClick}
        />
      ))}
    </div>
  );
}

function TreeNodeRow({
  node,
  depth,
  activeSketchPath,
  activeStoryboardPath,
  onClick,
}: {
  node: TreeNode;
  depth: number;
  activeSketchPath: string | null;
  activeStoryboardPath: string | null;
  onClick: (node: TreeNode) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const isActive =
    (node.type === "sketch" && node.path === activeSketchPath && !activeStoryboardPath) ||
    (node.type === "storyboard" && node.path === activeStoryboardPath);

  if (node.type === "folder") {
    return (
      <>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)] transition-colors"
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            {expanded ? (
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            ) : (
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            )}
          </svg>
          <span className="text-xs font-medium truncate">{node.name}</span>
        </button>
        {expanded &&
          node.children.map((child) => (
            <TreeNodeRow
              key={child.path ?? child.name}
              node={child}
              depth={depth + 1}
              activeSketchPath={activeSketchPath}
              activeStoryboardPath={activeStoryboardPath}
              onClick={onClick}
            />
          ))}
      </>
    );
  }

  // File node (sketch or storyboard)
  return (
    <button
      onClick={() => onClick(node)}
      className={`w-full flex items-center gap-1.5 px-3 py-1.5 text-left transition-colors ${
        isActive
          ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
          : "text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]"
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
      title={node.title ?? node.name}
    >
      {/* Spacer to align with chevron above */}
      <span className="w-3 shrink-0" />
      {node.type === "sketch" ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <rect x="2" y="3" width="20" height="18" rx="2" />
          <line x1="8" y1="3" x2="8" y2="21" />
        </svg>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs truncate">{node.name}</div>
      </div>
    </button>
  );
}
