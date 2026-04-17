import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, AlertTriangle } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import type { EditorTab } from "../stores/appStore";
import type { Sketch, Storyboard } from "../types/sketch";
import type { PlanningRow } from "../types/sketch";
import { ScriptTable } from "./ScriptTable";
import { MarkdownEditor } from "./MarkdownEditor";
import { SketchIcon, StoryboardIcon, NoteIcon } from "./Icons";

/**
 * SplitTabBar — compact tab bar for the split pane, rendered beside the main TabBar.
 * Exported so StoryboardPanel can place it in the same horizontal row as TabBar.
 */
export function SplitTabBar() {
  const splitTabs = useAppStore((s) => s.splitTabs);
  const splitActiveTabId = useAppStore((s) => s.splitActiveTabId);
  const setActiveSplitTab = useAppStore((s) => s.setActiveSplitTab);
  const closeTabInSplit = useAppStore((s) => s.closeTabInSplit);
  const activeEditorGroup = useAppStore((s) => s.activeEditorGroup);
  const setActiveEditorGroup = useAppStore((s) => s.setActiveEditorGroup);
  const moveTabToSplit = useAppStore((s) => s.moveTabToSplit);
  const isActiveGroup = activeEditorGroup === "split";
  const [isDragOver, setIsDragOver] = useState(false);

  if (splitTabs.length === 0) return null;

  return (
    <div
      className={`no-select flex items-stretch bg-[rgb(var(--color-surface-alt))] border-b border-[rgb(var(--color-border))] border-l shrink-0 overflow-x-auto border-t-[2px] transition-colors ${
        isActiveGroup ? "border-t-[rgb(var(--color-accent))]" : "border-t-transparent"
      } ${isDragOver ? "border-b-[2px] border-b-[rgb(var(--color-accent))]" : ""}`}
      style={{ scrollbarWidth: "none" }}
      onMouseDown={() => setActiveEditorGroup("split")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-cutready-tab")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setIsDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        try {
          const data = JSON.parse(e.dataTransfer.getData("application/x-cutready-tab")) as { tabId: string; source: "main" | "split" };
          if (data.source === "main") {
            moveTabToSplit(data.tabId);
          }
          // within-split reorder: drop at end (no-op for now, already in split)
        } catch { /* ignore */ }
      }}
    >
      {splitTabs.map((tab) => (
        <SplitTab
          key={tab.id}
          tab={tab}
          isActive={tab.id === splitActiveTabId}
          onSelect={() => { setActiveSplitTab(tab.id); setActiveEditorGroup("split"); }}
          onClose={() => closeTabInSplit(tab.id)}
        />
      ))}
      <div className="flex-1 border-b border-[rgb(var(--color-border))]" />
    </div>
  );
}

/**
 * SplitPaneContent — the editor content area of the split pane (no tab bar).
 * Exported so StoryboardPanel can compose it below the shared tab bar row.
 */
export function SplitPaneContent() {
  const splitTabs = useAppStore((s) => s.splitTabs);
  const splitActiveTabId = useAppStore((s) => s.splitActiveTabId);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const openTabs = useAppStore((s) => s.openTabs);
  const setActiveEditorGroup = useAppStore((s) => s.setActiveEditorGroup);

  const activeMainTab = openTabs.find((t) => t.id === activeTabId);
  const activeSplitTab = splitTabs.find((t) => t.id === splitActiveTabId);
  const sameFile =
    activeMainTab &&
    activeSplitTab &&
    activeMainTab.path === activeSplitTab.path &&
    activeMainTab.type === activeSplitTab.type;

  if (splitTabs.length === 0) return null;

  return (
    <div className="flex flex-col h-full min-w-0" onMouseDown={() => setActiveEditorGroup("split")}>
      {/* Same-file warning */}
      {sameFile && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-warning/10 border-b border-warning/30 text-[11px] text-warning shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Same file open in both panes — last save wins
        </div>
      )}

      {/* Content — all tabs mounted, inactive hidden to preserve pending saves */}
      <div className="flex-1 min-h-0 relative">
        {splitTabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 overflow-y-auto ${tab.id !== splitActiveTabId ? "hidden" : ""}`}
          >
            {tab.type === "sketch" && <SketchSplitEditor path={tab.path} />}
            {tab.type === "note" && <NoteSplitEditor path={tab.path} />}
            {tab.type === "storyboard" && <StoryboardPreviewContent path={tab.path} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** @deprecated Use SplitTabBar + SplitPaneContent separately via StoryboardPanel. */
export function SplitPreviewPane() {
  return null;
}

/** Compact tab for the split pane tab bar. */
function SplitTab({
  tab,
  isActive,
  onSelect,
  onClose,
}: {
  tab: EditorTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const typeClasses =
    tab.type === "sketch"
      ? { bar: "bg-[rgb(var(--color-accent))]", icon: "text-[rgb(var(--color-accent))]" }
      : tab.type === "storyboard"
        ? { bar: "bg-success", icon: "text-success" }
        : { bar: "bg-rose-500", icon: "text-rose-500" };

  const TabIcon =
    tab.type === "sketch" ? SketchIcon
    : tab.type === "storyboard" ? StoryboardIcon
    : NoteIcon;

  return (
    <div
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-cutready-tab", JSON.stringify({ tabId: tab.id, source: "split" }));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`group relative flex items-center gap-1.5 px-2.5 h-[32px] text-[11px] cursor-pointer shrink-0 select-none transition-colors ${
        isActive
          ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]"
          : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] border-b border-[rgb(var(--color-border))]"
      }`}
      onClick={onSelect}
      title={`${tab.type}: ${tab.path}`}
    >
      {isActive && (
        <span className={`absolute top-0 left-0 right-0 h-[2px] ${typeClasses.bar}`} />
      )}
      <span className={`shrink-0 ${isActive ? typeClasses.icon : "opacity-60"}`}>
        <TabIcon size={11} />
      </span>
      <span className={`truncate max-w-[120px] ${isActive ? "font-medium" : ""}`}>
        {tab.title}
      </span>
      <button
        className={`flex items-center justify-center w-[16px] h-[16px] rounded transition-all shrink-0 ${
          isActive
            ? "opacity-60 hover:opacity-100 hover:bg-[rgb(var(--color-surface-alt))]"
            : "opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-[rgb(var(--color-surface))]"
        }`}
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X className="w-2 h-2" />
      </button>
    </div>
  );
}

/** Fully editable sketch editor for the split pane — loads/saves independently. */
function SketchSplitEditor({ path }: { path: string }) {
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const [localRows, setLocalRows] = useState<PlanningRow[]>([]);
  const [error, setError] = useState(false);
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRowsRef = useRef<PlanningRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<Sketch>("get_sketch", { relativePath: path })
      .then((s) => {
        if (!cancelled) {
          setSketch(s);
          setLocalRows(s.rows ?? []);
        }
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      // Flush any pending save on unmount
      if (saveTimerRef.current && pendingRowsRef.current) {
        clearTimeout(saveTimerRef.current);
        invoke("update_sketch", { relativePath: path, rows: pendingRowsRef.current }).catch(() => {});
      }
    };
  }, [path]);

  // Re-load when primary pane saves (so split stays in sync if primary edits)
  useEffect(() => {
    const handler = () => {
      invoke<Sketch>("get_sketch", { relativePath: path })
        .then((s) => { setSketch(s); setLocalRows(s.rows ?? []); })
        .catch(() => {});
    };
    window.addEventListener("cutready:sketch-saved", handler);
    window.addEventListener("cutready:ai-sketch-updated", handler);
    return () => {
      window.removeEventListener("cutready:sketch-saved", handler);
      window.removeEventListener("cutready:ai-sketch-updated", handler);
    };
  }, [path]);

  const handleRowsChange = (rows: PlanningRow[]) => {
    setLocalRows(rows);
    pendingRowsRef.current = rows;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      invoke("update_sketch", { relativePath: path, rows }).catch(() => {});
      window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
      pendingRowsRef.current = null;
    }, 800);
  };

  if (error) return <div className="p-4 text-sm text-[rgb(var(--color-error))]">Failed to load sketch</div>;
  if (!sketch) return <LoadingSpinner />;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2 shrink-0">
        <h2 className="text-base font-semibold text-[rgb(var(--color-text))] truncate">{sketch.title || "Untitled"}</h2>
        {sketch.description ? (
          <p className="text-xs text-[rgb(var(--color-text-secondary))] mt-1 line-clamp-2">{String(sketch.description)}</p>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto px-2 pb-4">
        <ScriptTable
          rows={localRows}
          onChange={handleRowsChange}
          projectRoot={projectRoot}
          sketchPath={path}
        />
      </div>
    </div>
  );
}

/** Fully editable note editor for the split pane — loads/saves independently. */
function NoteSplitEditor({ path }: { path: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContentRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_note", { relativePath: path })
      .then((c) => { if (!cancelled) setContent(c); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      // Flush any pending save on unmount
      if (saveTimerRef.current && pendingContentRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        invoke("update_note", { relativePath: path, content: pendingContentRef.current }).catch(() => {});
      }
    };
  }, [path]);

  // Re-load when AI updates
  useEffect(() => {
    const handler = () => {
      invoke<string>("get_note", { relativePath: path })
        .then((c) => setContent(c))
        .catch(() => {});
    };
    window.addEventListener("cutready:ai-note-updated", handler);
    return () => window.removeEventListener("cutready:ai-note-updated", handler);
  }, [path]);

  const handleChange = (value: string) => {
    setContent(value);
    pendingContentRef.current = value;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      invoke("update_note", { relativePath: path, content: value }).catch(() => {});
      pendingContentRef.current = null;
    }, 800);
  };

  if (error) return <div className="p-4 text-sm text-[rgb(var(--color-error))]">Failed to load note</div>;
  if (content === null) return <LoadingSpinner />;

  return (
    <div className="px-4 h-full">
      <MarkdownEditor
        key={path}
        editorKey={path}
        value={content}
        onChange={handleChange}
        placeholder="Start writing..."
        saveImages={!!projectRoot}
      />
    </div>
  );
}

function StoryboardPreviewContent({ path }: { path: string }) {
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<Storyboard>("get_storyboard", { relativePath: path })
      .then((s) => { if (!cancelled) setStoryboard(s); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path]);

  if (error) return <div className="p-4 text-sm text-[rgb(var(--color-error))]">Failed to load storyboard</div>;
  if (!storyboard) return <LoadingSpinner />;

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold text-[rgb(var(--color-text))] mb-3">{storyboard.title || "Untitled"}</h2>
      <div className="flex flex-col gap-2">
        {storyboard.items.map((item, i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] text-sm"
          >
            <span className="text-[rgb(var(--color-text-secondary))] text-xs w-5">{i + 1}</span>
            <span className="text-[rgb(var(--color-text))]">
              {item.type === "section" ? item.title : item.path}
            </span>
            {item.type === "section" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
                Section · {item.sketches.length} sketches
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}


function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-32 text-[rgb(var(--color-text-secondary))]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="animate-spin">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    </div>
  );
}
