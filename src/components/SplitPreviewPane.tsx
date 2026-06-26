import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../services/tauri";
import { X, MoreHorizontal, Search } from "lucide-react";
import { shouldSuppressEditorFlush, useAppStore } from "../stores/appStore";
import type { EditorTab } from "../stores/appStore";
import type { Sketch, Storyboard } from "../types/sketch";
import type { PlanningRow } from "../types/sketch";
import { ScriptTable } from "./ScriptTable";
import { MarkdownEditor } from "./MarkdownEditor";
import { SafeMarkdown } from "./SafeMarkdown";
import { SketchIcon, StoryboardIcon, NoteIcon } from "./Icons";
import { usePopover } from "../hooks/usePopover";
import { getClampedPopoverPosition } from "./TabBar";
import { DocumentHeader } from "./DocumentHeader";
import { FieldAiButton } from "./FieldAiButton";
import { LockedDocumentBanner } from "./LockedDocumentBanner";
import { useBackgroundAgentAction } from "../hooks/useBackgroundAgentAction";

/**
 * SplitTabBar — compact tab bar for the split pane, rendered beside the main TabBar.
 * Exported so StoryboardPanel can place it in the same horizontal row as TabBar.
 */
export function SplitTabBar() {
  const splitTabs = useAppStore((s) => s.splitTabs);
  const splitActiveTabId = useAppStore((s) => s.splitActiveTabId);
  const openTabs = useAppStore((s) => s.openTabs);
  const activeEditorGroup = useAppStore((s) => s.activeEditorGroup);
  const setActiveSplitTab = useAppStore((s) => s.setActiveSplitTab);
  const closeTabInSplit = useAppStore((s) => s.closeTabInSplit);
  const setActiveEditorGroup = useAppStore((s) => s.setActiveEditorGroup);
  const moveTabToSplit = useAppStore((s) => s.moveTabToSplit);
  const closeSplit = useAppStore((s) => s.closeSplit);
  const [isDragOver, setIsDragOver] = useState(false);
  const [tabSearch, setTabSearch] = useState("");
  const { state: tabMenu, ref: tabMenuRef, openAt: openTabMenu, close: closeTabMenu, position: tabMenuPos } = usePopover();

  const filteredTabs = tabSearch.trim()
    ? splitTabs.filter((tab) => `${tab.title} ${tab.path} ${tab.type}`.toLowerCase().includes(tabSearch.trim().toLowerCase()))
    : splitTabs;

  const closeOtherSplitTabs = (tabId: string) => {
    splitTabs.filter((tab) => tab.id !== tabId).forEach((tab) => closeTabInSplit(tab.id));
    setActiveSplitTab(tabId);
    setActiveEditorGroup("split");
  };

  if (splitTabs.length === 0) return null;

  return (
    <div
      className={`no-select flex items-stretch bg-[rgb(var(--color-surface-alt))] border-b border-[rgb(var(--color-border))] border-l shrink-0 ${
        isDragOver ? "border-b-[2px] border-b-[rgb(var(--color-accent))]" : ""
      }`}
      onMouseDown={() => setActiveEditorGroup("split")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-cutready-tab")) {
          if (openTabs.length < 2) {
            e.dataTransfer.dropEffect = "none";
            setIsDragOver(false);
            return;
          }
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
      <div className="flex min-w-0 flex-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        {splitTabs.map((tab) => (
          <SplitTab
            key={tab.id}
            tab={tab}
            isActive={tab.id === splitActiveTabId}
            isGroupFocused={activeEditorGroup === "split"}
            onSelect={() => { setActiveSplitTab(tab.id); setActiveEditorGroup("split"); }}
            onClose={() => closeTabInSplit(tab.id)}
          />
        ))}
        <div className="min-w-6 flex-1" />
      </div>
      <div className="relative z-sticky self-stretch flex shrink-0 items-center border-l border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] shadow-[-12px_0_18px_-18px_rgb(var(--color-text))]">
        <button
          className="flex items-center justify-center w-8 h-full text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface))] transition-colors"
          title="Show split tabs"
          onClick={(e) => {
            setTabSearch("");
            const rect = e.currentTarget.getBoundingClientRect();
            openTabMenu(getClampedPopoverPosition({ x: rect.right - 280, y: rect.bottom + 4 }, 280));
          }}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>
      {tabMenu && createPortal(
        <div
          ref={tabMenuRef}
          className="fixed z-dropdown flex max-h-[70vh] w-[280px] flex-col rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-xl"
          style={{ left: tabMenuPos?.x, top: tabMenuPos?.y }}
        >
          <div className="border-b border-[rgb(var(--color-border))] p-2">
            <div className="flex items-center gap-2 rounded-lg border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))] px-2 py-1.5">
              <Search className="h-3.5 w-3.5 text-[rgb(var(--color-text-secondary))]" />
              <input
                autoFocus
                value={tabSearch}
                onChange={(e) => setTabSearch(e.target.value)}
                placeholder="Find split tab..."
                className="min-w-0 flex-1 bg-transparent text-[12px] text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {filteredTabs.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-[rgb(var(--color-text-secondary))]">No matching tabs.</div>
            ) : (
              filteredTabs.map((tab) => (
                <SplitTabMenuItem
                  key={tab.id}
                  tab={tab}
                  active={tab.id === splitActiveTabId}
                  onSelect={() => {
                    setActiveSplitTab(tab.id);
                    setActiveEditorGroup("split");
                    closeTabMenu();
                  }}
                  onClose={() => closeTabInSplit(tab.id)}
                />
              ))
            )}
          </div>
          <div className="flex gap-1 border-t border-[rgb(var(--color-border))] p-1">
            <button
              className="flex-1 rounded-lg px-2 py-1.5 text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              onClick={() => {
                if (splitActiveTabId) closeOtherSplitTabs(splitActiveTabId);
                closeTabMenu();
              }}
            >
              Close others
            </button>
            <button
              className="flex-1 rounded-lg px-2 py-1.5 text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              onClick={() => {
                closeSplit();
                closeTabMenu();
              }}
            >
              Close all
            </button>
          </div>
        </div>,
        document.body
      )}
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
  const editorReloadKey = useAppStore((s) => s.editorReloadKey);
  const editorReloadPath = useAppStore((s) => s.editorReloadPath);

  if (splitTabs.length === 0) return null;

  return (
    <div className="flex flex-col h-full min-w-0" onMouseDown={() => setActiveEditorGroup("split")}>
      {/* Content — all tabs mounted, inactive hidden to preserve pending saves */}
      <div className="flex-1 min-h-0 relative">
        {splitTabs.map((tab) => {
          return (
            <div
              key={`${tab.id}:${tab.path === editorReloadPath ? editorReloadKey : 0}`}
              className={`absolute inset-0 overflow-y-auto ${tab.id !== splitActiveTabId ? "hidden" : ""}`}
            >
              {tab.type === "sketch" && <SketchSplitEditor path={tab.path} />}
              {tab.type === "note" && <NoteSplitEditor path={tab.path} />}
              {tab.type === "storyboard" && <StoryboardPreviewContent path={tab.path} />}
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
  isGroupFocused,
  onSelect,
  onClose,
}: {
  tab: EditorTab;
  isActive: boolean;
  isGroupFocused: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const tabRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!isActive) return;
    tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isActive]);

  return (
    <div
      ref={tabRef}
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-cutready-tab", JSON.stringify({ tabId: tab.id, source: "split" }));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`group relative flex items-center gap-1.5 pl-3 pr-2 h-[40px] text-[12px] cursor-pointer shrink-0 select-none transition-colors ${
        isActive
          ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]"
          : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
      }`}
      onClick={onSelect}
      title={`${tab.type}: ${tab.path}`}
    >
      {isActive && (
        <span className={`absolute top-0 left-0 right-0 h-[2px] ${typeClasses.bar} ${isGroupFocused ? "" : "opacity-40"}`} />
      )}
      <span className={`shrink-0 ${isActive ? typeClasses.icon : "opacity-60"}`}>
        <TabIcon size={13} />
      </span>
      <span className={`truncate max-w-[140px] ${isActive ? "font-medium" : ""}`}>
        {tab.title}
      </span>
      <button
        className={`flex items-center justify-center w-[20px] h-[20px] rounded transition-all shrink-0 ${
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
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

function SplitTabMenuItem({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: EditorTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
        active ? "bg-[rgb(var(--color-accent))]/10" : "hover:bg-[rgb(var(--color-surface-alt))]"
      }`}
    >
      <button className="min-w-0 flex-1 text-left" onClick={onSelect}>
        <div className="truncate text-[12px] font-medium text-[rgb(var(--color-text))]">{tab.title}</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-[rgb(var(--color-text-secondary))]">{tab.path}</div>
      </button>
      <span className="rounded-full bg-[rgb(var(--color-surface-alt))] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[rgb(var(--color-text-secondary))]">
        {tab.type}
      </span>
      <button
        className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-text-secondary))] opacity-60 transition-colors hover:bg-[rgb(var(--color-surface))] hover:text-[rgb(var(--color-text))] group-hover:opacity-100"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X className="h-3 w-3" />
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
  const runBackgroundAgentAction = useBackgroundAgentAction();
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
        if (!shouldSuppressEditorFlush(path)) {
          invoke("update_sketch_title", { relativePath: path, title: pendingTitleRef.current }).catch(() => {});
        }
      }
      if (descTimerRef.current && pendingDescRef.current !== null) {
        clearTimeout(descTimerRef.current);
        if (!shouldSuppressEditorFlush(path)) {
          invoke("update_sketch", { relativePath: path, description: pendingDescRef.current }).catch(() => {});
        }
      }
      if (saveTimerRef.current && pendingRowsRef.current) {
        clearTimeout(saveTimerRef.current);
        if (!shouldSuppressEditorFlush(path)) {
          invoke("update_sketch", { relativePath: path, rows: pendingRowsRef.current }).catch(() => {});
        }
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
    if (sketch?.locked) return;
    setLocalTitle(title);
    pendingTitleRef.current = title;
    if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(() => {
      pendingTitleRef.current = null;
      if (shouldSuppressEditorFlush(path)) return;
      invoke("update_sketch_title", { relativePath: path, title }).catch(() => {});
      window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
    }, 500);
  };

  const handleDescChange = (desc: string) => {
    if (sketch?.locked) return;
    setLocalDesc(desc);
    pendingDescRef.current = desc;
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    descTimerRef.current = setTimeout(() => {
      pendingDescRef.current = null;
      if (shouldSuppressEditorFlush(path)) return;
      invoke("update_sketch", { relativePath: path, description: desc }).catch(() => {});
    }, 500);
  };

  const handleRowsChange = (rows: PlanningRow[]) => {
    if (sketch?.locked) return;
    setLocalRows(rows);
    pendingRowsRef.current = rows;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      pendingRowsRef.current = null;
      if (shouldSuppressEditorFlush(path)) return;
      invoke("update_sketch", { relativePath: path, rows }).catch(() => {});
      window.dispatchEvent(new CustomEvent("cutready:sketch-saved"));
    }, 800);
  };

  if (error) return <div className="p-4 text-sm text-[rgb(var(--color-error))]">Failed to load sketch</div>;
  if (!sketch) return <LoadingSpinner />;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--editor-max-width, 56rem)" }}>
        <DocumentHeader
          icon={<SketchIcon size={20} />}
          title={
          <div className="relative min-w-0 group/title">
            <input
              type="text"
              value={localTitle}
              onChange={(e) => handleTitleChange(e.target.value)}
              readOnly={sketch.locked}
              placeholder="Sketch title..."
              title={localTitle}
              className={`min-w-0 w-full truncate border-none bg-transparent text-2xl font-semibold text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/40 ${localTitle && !sketch.locked ? "pr-8" : ""} ${sketch.locked ? "cursor-default" : ""}`}
            />
            {localTitle && !sketch.locked && (
              <FieldAiButton
                onClick={() => void runBackgroundAgentAction(
                  `Improve the title of sketch "${path}". Current title: "${localTitle}". Suggest a more compelling, concise title. IMPORTANT: Only update the title — do NOT change the description or any rows.`,
                  { label: "Improve sketch title" }
                )}
                className="absolute right-0 top-1/2 -translate-y-1/2 group-hover/title:opacity-100"
                label="Improve title with AI"
                title="Improve title with AI"
              />
            )}
          </div>
          }
        />

        {sketch.locked && (
          <LockedDocumentBanner message="Sketch is locked. Unlock it to edit fields, rows, media, or AI suggestions." />
        )}

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
              tabIndex={0}
              className={`min-h-[2rem] rounded-lg border border-transparent px-3 py-2 text-sm transition-colors hover:border-[rgb(var(--color-border))] ${!sketch.locked ? "cursor-text pr-10" : "cursor-default"}`}
              onClick={() => { if (!sketch.locked) setEditingDesc(true); }}
              onFocus={() => { if (!sketch.locked) setEditingDesc(true); }}
            >
              {localDesc ? (
                <div className="prose-desc leading-relaxed text-[rgb(var(--color-text))]">
                  <SafeMarkdown>{localDesc}</SafeMarkdown>
                </div>
              ) : (
                <span className="text-[rgb(var(--color-text-secondary))]/40">Describe what this sketch covers...</span>
              )}
            </div>
          )}
          {!editingDesc && !sketch.locked && (
            <FieldAiButton
              onClick={() => void runBackgroundAgentAction(
                localDesc
                  ? `Improve the description of sketch "${path}". Current description: "${localDesc}". Make it clearer and more informative. IMPORTANT: Only update the description — do NOT change the title or any rows.`
                  : `Write a description for sketch "${path}" titled "${localTitle}". Look at the planning rows to understand what the sketch covers and write a concise description. IMPORTANT: Only update the description — do NOT change the title or any rows.`,
                { label: localDesc ? "Improve sketch description" : "Generate sketch description" },
              )}
              className="absolute right-2 top-2 group-hover/desc:opacity-100 group-focus-within/desc:opacity-100"
              label={localDesc ? "Improve description with AI" : "Generate description with AI"}
              title={localDesc ? "Improve description with AI" : "Generate description with AI"}
              iconClassName="h-3 w-3"
            />
          )}
        </div>

        <ScriptTable
          rows={localRows}
          onChange={handleRowsChange}
          readOnly={sketch.locked}
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
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState(false);
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingContentRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      invoke<string>("get_note", { relativePath: path }),
      invoke<{ locked: boolean }>("get_note_lock", { relativePath: path }),
    ])
      .then(([c, lock]) => {
        if (!cancelled) {
          setContent(c);
          setLocked(lock.locked);
        }
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      // Flush any pending save on unmount
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        if (!locked && pendingContentRef.current !== null && !shouldSuppressEditorFlush(path)) {
          invoke("update_note", { relativePath: path, content: pendingContentRef.current }).catch(() => {});
        }
      }
    };
  }, [path, locked]);

  // Re-load when AI updates
  useEffect(() => {
    const handler = (event: Event) => {
      const updatedPath = (event as CustomEvent<{ path?: string | null }>).detail?.path;
      if (updatedPath && updatedPath !== path) return;
      if (pendingContentRef.current !== null) return;
      invoke<string>("get_note", { relativePath: path })
        .then((c) => setContent(c))
        .catch(() => {});
    };
    window.addEventListener("cutready:ai-note-updated", handler);
    return () => window.removeEventListener("cutready:ai-note-updated", handler);
  }, [path]);

  const handleChange = (value: string) => {
    if (locked) return;
    setContent(value);
    pendingContentRef.current = value;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      pendingContentRef.current = null;
      if (shouldSuppressEditorFlush(path)) return;
      invoke("update_note", { relativePath: path, content: value }).catch(() => {});
    }, 800);
  };

  if (error) return <div className="p-4 text-sm text-[rgb(var(--color-error))]">Failed to load note</div>;
  if (content === null) return <LoadingSpinner />;

  return (
    <div className="px-4 h-full">
      {locked ? (
        <div className="py-4">
          <LockedDocumentBanner message="Note is locked. Unlock it to edit this note." />
          <div className="prose-desc text-sm text-[rgb(var(--color-text))] leading-relaxed">
            <SafeMarkdown>{content}</SafeMarkdown>
          </div>
        </div>
      ) : (
        <MarkdownEditor
          key={path}
          editorKey={path}
          value={content}
          onChange={handleChange}
          placeholder="Start writing..."
          saveImages={!!projectRoot}
        />
      )}
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
            {item.type === "section" && item.description && (
              <span className="text-xs text-[rgb(var(--color-text-secondary))] truncate">
                {item.description}
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
