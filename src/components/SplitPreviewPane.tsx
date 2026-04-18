import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Sparkles, Pencil } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import type { EditorTab } from "../stores/appStore";
import type { Sketch, Storyboard } from "../types/sketch";
import type { PlanningRow } from "../types/sketch";
import { ScriptTable } from "./ScriptTable";
import { MarkdownEditor } from "./MarkdownEditor";
import { SketchIcon, StoryboardIcon, NoteIcon } from "./Icons";
import { SketchForm } from "./SketchForm";
import { NoteEditor } from "./NoteEditor";
import { StoryboardView } from "./StoryboardView";

/**
 * SplitTabBar — compact tab bar for the split pane, rendered beside the main TabBar.
 * Exported so StoryboardPanel can place it in the same horizontal row as TabBar.
 */
export function SplitTabBar() {
  const splitTabs = useAppStore((s) => s.splitTabs);
  const splitActiveTabId = useAppStore((s) => s.splitActiveTabId);
  const setActiveSplitTab = useAppStore((s) => s.setActiveSplitTab);
  const closeTabInSplit = useAppStore((s) => s.closeTabInSplit);
  const setActiveEditorGroup = useAppStore((s) => s.setActiveEditorGroup);
  const moveTabToSplit = useAppStore((s) => s.moveTabToSplit);
  const closeSplit = useAppStore((s) => s.closeSplit);
  const [isDragOver, setIsDragOver] = useState(false);

  if (splitTabs.length === 0) return null;

  return (
    <div
      className={`no-select flex items-stretch bg-[rgb(var(--color-surface-alt))] border-b border-[rgb(var(--color-border))] border-l shrink-0 overflow-x-auto ${
        isDragOver ? "border-b-[2px] border-b-[rgb(var(--color-accent))]" : ""
      }`}
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
      <div className="flex-1" />
      <button
        className="flex items-center justify-center w-8 h-full text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors shrink-0"
        title="Close Split Pane"
        onClick={closeSplit}
      >
        <X className="w-3 h-3" />
      </button>
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
  const setActiveEditorGroup = useAppStore((s) => s.setActiveEditorGroup);
  const activeSketchPath = useAppStore((s) => s.activeSketchPath);
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const activeStoryboardPath = useAppStore((s) => s.activeStoryboardPath);

  if (splitTabs.length === 0) return null;

  return (
    <div className="flex flex-col h-full min-w-0" onMouseDown={() => setActiveEditorGroup("split")}>
      {/* Content — all tabs mounted, inactive hidden to preserve pending saves */}
      <div className="flex-1 min-h-0 relative">
        {splitTabs.map((tab) => {
          // When the split tab shows the same file as the main pane, render the real
          // component so it has identical functionality (reads same global store state).
          const isActiveMain =
            (tab.type === "sketch" && tab.path === activeSketchPath) ||
            (tab.type === "note" && tab.path === activeNotePath) ||
            (tab.type === "storyboard" && tab.path === activeStoryboardPath);

          return (
            <div
              key={tab.id}
              className={`absolute inset-0 overflow-y-auto ${tab.id !== splitActiveTabId ? "hidden" : ""}`}
            >
              {tab.type === "sketch" && (isActiveMain ? <SketchForm /> : <SketchSplitEditor path={tab.path} />)}
              {tab.type === "note" && (isActiveMain ? <NoteEditor /> : <NoteSplitEditor path={tab.path} />)}
              {tab.type === "storyboard" && (isActiveMain ? <StoryboardView /> : <StoryboardPreviewContent path={tab.path} />)}
            </div>
          );
        })}
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
      className={`group relative flex items-center gap-1.5 pl-2.5 pr-1.5 h-[32px] text-[11px] cursor-pointer shrink-0 select-none transition-colors ${
        isActive
          ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]"
          : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
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
  const [localTitle, setLocalTitle] = useState("");
  const [localDesc, setLocalDesc] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [error, setError] = useState(false);
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? "");
  const sendChatPrompt = useAppStore((s) => s.sendChatPrompt);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const descTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRowsRef = useRef<PlanningRow[] | null>(null);
  const pendingTitleRef = useRef<string | null>(null);
  const pendingDescRef = useRef<string | null>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingDesc && descRef.current) {
      descRef.current.focus();
      descRef.current.selectionStart = descRef.current.value.length;
    }
  }, [editingDesc]);

  useEffect(() => {
    let cancelled = false;
    invoke<Sketch>("get_sketch", { relativePath: path })
      .then((s) => {
        if (!cancelled) {
          setSketch(s);
          setLocalRows(s.rows ?? []);
          setLocalTitle(s.title ?? "");
          setLocalDesc(typeof s.description === "string" ? s.description : "");
        }
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      if (titleTimerRef.current && pendingTitleRef.current !== null) {
        clearTimeout(titleTimerRef.current);
        invoke("update_sketch_title", { relativePath: path, title: pendingTitleRef.current }).catch(() => {});
      }
      if (descTimerRef.current && pendingDescRef.current !== null) {
        clearTimeout(descTimerRef.current);
        invoke("update_sketch", { relativePath: path, description: pendingDescRef.current }).catch(() => {});
      }
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
        .then((s) => {
          setSketch(s);
          setLocalRows(s.rows ?? []);
          setLocalTitle(s.title ?? "");
          setLocalDesc(typeof s.description === "string" ? s.description : "");
        })
        .catch(() => {});
    };
    window.addEventListener("cutready:sketch-saved", handler);
    window.addEventListener("cutready:ai-sketch-updated", handler);
    return () => {
      window.removeEventListener("cutready:sketch-saved", handler);
      window.removeEventListener("cutready:ai-sketch-updated", handler);
    };
  }, [path]);

  const handleTitleChange = (title: string) => {
    setLocalTitle(title);
    pendingTitleRef.current = title;
    if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(() => {
      invoke("update_sketch_title", { relativePath: path, title }).catch(() => {});
      window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
      pendingTitleRef.current = null;
    }, 500);
  };

  const handleDescChange = (desc: string) => {
    setLocalDesc(desc);
    pendingDescRef.current = desc;
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    descTimerRef.current = setTimeout(() => {
      invoke("update_sketch", { relativePath: path, description: desc }).catch(() => {});
      pendingDescRef.current = null;
    }, 500);
  };

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
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--editor-max-width, 56rem)" }}>
        {/* Title */}
        <div className="flex items-center gap-3 mb-4">
          <div className="relative flex-1 group/title">
            <input
              type="text"
              value={localTitle}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Sketch title..."
              className="w-full text-2xl font-semibold bg-transparent text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/40 outline-none border-none"
            />
            {localTitle && (
              <button
                onClick={() => sendChatPrompt(
                  `Improve the title of sketch "${path}". Current title: "${localTitle}". Suggest a more compelling, concise title. IMPORTANT: Only update the title — do NOT change the description or any rows.`,
                  { silent: true }
                )}
                className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover/title:opacity-100 p-1 rounded text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/10 transition-all"
                title="Improve title with AI"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span className="text-[10px]">Improve</span>
              </button>
            )}
          </div>
        </div>

        {/* Description — click to edit */}
        <div className="relative group/desc mb-8">
          {editingDesc ? (
            <textarea
              ref={descRef}
              value={localDesc}
              onChange={(e) => handleDescChange(e.target.value)}
              onBlur={() => setEditingDesc(false)}
              placeholder="Describe what this sketch covers..."
              rows={4}
              className="w-full text-sm bg-transparent text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))]/40 outline-none border border-[rgb(var(--color-border))] rounded-lg px-3 py-2 resize-none focus:ring-1 focus:ring-[rgb(var(--color-accent))]/40 transition-colors"
            />
          ) : (
            <div
              className="text-sm text-[rgb(var(--color-text-secondary))] cursor-text min-h-[1.5rem]"
              onClick={() => setEditingDesc(true)}
            >
              {localDesc || <span className="text-[rgb(var(--color-text-secondary))]/40">Describe what this sketch covers...</span>}
            </div>
          )}
          {!editingDesc && (
            <button
              className="absolute right-0 top-0 opacity-0 group-hover/desc:opacity-100 p-1 rounded text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] transition-all"
              onClick={() => setEditingDesc(true)}
              title="Edit description"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
        </div>

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
