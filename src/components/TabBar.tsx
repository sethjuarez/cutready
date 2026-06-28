import { useAppStore } from "../stores/appStore";
import type { EditorTab } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { AgentRunIcon, DatabaseIcon, SketchIcon, StoryboardIcon, NoteIcon, HistoryIcon, ImageIcon, VisualIcon, DiffIcon } from "./Icons";
import { usePopover } from "../hooks/usePopover";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, LayoutGrid, MoreHorizontal, Search, X } from "lucide-react";

export function getClampedPopoverPosition(position: { x: number; y: number }, width: number) {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  return {
    x: Math.min(Math.max(margin, position.x), maxX),
    y: Math.max(margin, position.y),
  };
}

/**
 * Return the project-relative path that should be copied for a tab, or null
 * if the tab is not file-backed (e.g. the synthetic History tab).
 */
export function getTabCopyPath(tab: Pick<EditorTab, "type" | "path"> | undefined | null): string | null {
  if (!tab) return null;
  if (tab.type === "history" || tab.type === "snapshot-preview") return null;
  if (!tab.path) return null;
  if (tab.path.startsWith("__")) return null;
  if (tab.path.startsWith("cutready://")) return null;
  return tab.path;
}

/** Copy the tab's project-relative path to the clipboard and show a toast. */
export async function copyTabPath(
  tab: Pick<EditorTab, "type" | "path"> | undefined | null,
  deps: {
    writeText?: (text: string) => Promise<void>;
    showToast?: (message: string, durationMs?: number, type?: "success" | "error" | "warning" | "info") => void;
  } = {},
): Promise<boolean> {
  const path = getTabCopyPath(tab);
  if (!path) return false;
  const writeText = deps.writeText ?? ((t: string) => navigator.clipboard.writeText(t));
  const showToast = deps.showToast ?? useToastStore.getState().show;
  try {
    await writeText(path);
    showToast(`Copied path: ${path}`, 2500, "success");
    return true;
  } catch {
    showToast("Failed to copy path", 3000, "error");
    return false;
  }
}

/**
 * TabBar — horizontal row of open document tabs.
 * Active tab has a raised look with accent bottom border and primary background.
 * Inactive tabs are visually recessed with muted colors.
 */
export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const splitTabs = useAppStore((s) => s.splitTabs);
  const activeEditorGroup = useAppStore((s) => s.activeEditorGroup);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const closeOtherTabs = useAppStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useAppStore((s) => s.closeTabsToRight);
  const closeTabsToLeft = useAppStore((s) => s.closeTabsToLeft);
  const closeAllTabs = useAppStore((s) => s.closeAllTabs);
  const moveTabToSplit = useAppStore((s) => s.moveTabToSplit);

  const setActiveEditorGroup = useAppStore((s) => s.setActiveEditorGroup);
  const moveTabFromSplit = useAppStore((s) => s.moveTabFromSplit);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const [isDragOver, setIsDragOver] = useState(false);
  const [tabSearch, setTabSearch] = useState("");

  const { state: contextMenu, ref: menuRef, openAt: openContextMenu, close: closeContextMenu, position: menuPos } = usePopover();
  const { state: tabMenu, ref: tabMenuRef, openAt: openTabMenu, close: closeTabMenu, position: tabMenuPos } = usePopover();
  const contextTabIdRef = useRef<string>("");

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    contextTabIdRef.current = tabId;
    openContextMenu(getClampedPopoverPosition({ x: e.clientX, y: e.clientY }, 200));
  }, [openContextMenu]);

  if (openTabs.length === 0) return null;

  const contextTab = openTabs.find((t) => t.id === contextTabIdRef.current);
  const canSplit = contextTab && openTabs.length > 1 && contextTab.type !== "history" && contextTab.type !== "snapshot-preview" && contextTab.type !== "asset" && contextTab.type !== "agent-run" && contextTab.type !== "diff" && contextTab.type !== "database";
  const copyablePath = getTabCopyPath(contextTab);
  const isAlreadyInSplit = contextTab
    ? splitTabs.some((st) => st.path === contextTab.path && st.type === contextTab.type)
    : false;
  const filteredTabs = tabSearch.trim()
    ? openTabs.filter((tab) => `${tab.title} ${tab.path} ${tab.type}`.toLowerCase().includes(tabSearch.trim().toLowerCase()))
    : openTabs;

  return (
    <div
      className={`no-select flex items-stretch bg-[rgb(var(--color-surface-inset))] shrink-0 border-b border-[rgb(var(--color-border-subtle))] px-1 pt-1 ${
        isDragOver ? "border-b-[2px] border-b-[rgb(var(--color-accent))]" : ""
      }`}
      onMouseDown={() => setActiveEditorGroup("main")}
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
          if (data.source === "split") {
            moveTabFromSplit(data.tabId);
          } else {
            // Within-group reorder: drop at end
            const draggedIdx = openTabs.findIndex((t) => t.id === data.tabId);
            if (draggedIdx !== -1) {
              const newOrder = [...openTabs.map((t) => t.id).filter((id) => id !== data.tabId), data.tabId];
              reorderTabs(newOrder);
            }
          }
        } catch { /* ignore malformed data */ }
      }}
    >
      <div className="flex min-w-0 flex-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        {openTabs.map((tab) => (
          <Tab
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            isGroupFocused={activeEditorGroup === "main"}
            isSplit={splitTabs.some((st) => st.path === tab.path && st.type === tab.type)}
            onSelect={() => setActiveTab(tab.id)}
            onClose={() => closeTab(tab.id)}
            onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
          />
        ))}
        {/* Fill remaining space inside the scrollable tab lane. */}
        <div className="min-w-6 flex-1" />
      </div>

      {/* Tab navigator */}
      {openTabs.length > 0 && (
        <div className="relative z-sticky flex shrink-0 items-center self-stretch border-l border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-inset))] shadow-[-12px_0_18px_-18px_rgb(var(--color-text))]">
          <button
            className="flex h-full w-8 items-center justify-center text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            title="Show open tabs"
            onClick={(e) => {
              setTabSearch("");
              const rect = e.currentTarget.getBoundingClientRect();
              openTabMenu(getClampedPopoverPosition({ x: rect.right - 280, y: rect.bottom + 4 }, 280));
            }}
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

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
                placeholder="Find open tab..."
                className="min-w-0 flex-1 bg-transparent text-[12px] text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {filteredTabs.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-[rgb(var(--color-text-secondary))]">No matching tabs.</div>
            ) : (
              filteredTabs.map((tab) => (
                <TabMenuItem
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  onSelect={() => {
                    setActiveTab(tab.id);
                    closeTabMenu();
                  }}
                  onClose={() => closeTab(tab.id)}
                />
              ))
            )}
          </div>
          <div className="flex gap-1 border-t border-[rgb(var(--color-border))] p-1">
            <button
              className="flex-1 rounded-lg px-2 py-1.5 text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              onClick={() => {
                if (activeTabId) closeOtherTabs(activeTabId);
                closeTabMenu();
              }}
            >
              Close others
            </button>
            <button
              className="flex-1 rounded-lg px-2 py-1.5 text-[11px] text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
              onClick={() => {
                closeAllTabs();
                closeTabMenu();
              }}
            >
              Close all
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* Tab context menu */}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          className="fixed z-dropdown py-1 min-w-[200px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg"
          style={{ left: menuPos?.x, top: menuPos?.y }}
        >
          {canSplit && (
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
              onClick={() => { moveTabToSplit(contextTabIdRef.current); closeContextMenu(); }}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              {isAlreadyInSplit ? "Move to Split" : "Open to the Side"}
            </button>
          )}
          <button
            disabled={!copyablePath}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[rgb(var(--color-text))] disabled:cursor-not-allowed transition-colors"
            onClick={() => { void copyTabPath(contextTab); closeContextMenu(); }}
            title={copyablePath ? `Copy ${copyablePath}` : "Tab is not file-backed"}
          >
            <Copy className="w-3.5 h-3.5" />
            Copy Path
          </button>
          <div className="my-1 border-t border-[rgb(var(--color-border-subtle))]" />
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
            onClick={() => { closeTab(contextTabIdRef.current); closeContextMenu(); }}
          >
            <X className="w-3.5 h-3.5" />
            Close Tab
          </button>
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
            onClick={() => { closeOtherTabs(contextTabIdRef.current); closeContextMenu(); }}
          >
            <X className="w-3.5 h-3.5" />
            Close Others
          </button>
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
            onClick={() => { closeTabsToRight(contextTabIdRef.current); closeContextMenu(); }}
          >
            <X className="w-3.5 h-3.5" />
            Close to the Right
          </button>
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
            onClick={() => { closeTabsToLeft(contextTabIdRef.current); closeContextMenu(); }}
          >
            <X className="w-3.5 h-3.5" />
            Close to the Left
          </button>
          <div className="my-1 border-t border-[rgb(var(--color-border-subtle))]" />
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
            onClick={() => { closeAllTabs(); closeContextMenu(); }}
          >
            <X className="w-3.5 h-3.5" />
            Close All
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

function TabMenuItem({
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

function Tab({
  tab,
  isActive,
  isSplit,
  isGroupFocused,
  onSelect,
  onClose,
  onContextMenu,
}: {
  tab: EditorTab;
  isActive: boolean;
  isSplit: boolean;
  isGroupFocused: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const tabRef = useRef<HTMLDivElement>(null);
  const isImage = tab.type === "asset" && tab.path.includes("/screenshots/");
  const isVisual = tab.type === "asset" && !isImage;

  useEffect(() => {
    if (!isActive) return;
    tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [isActive]);

  const typeLabel =
    tab.type === "sketch" ? "Sketch"
    : tab.type === "storyboard" ? "Storyboard"
    : tab.type === "history" ? "History"
    : tab.type === "snapshot-preview" ? "Snapshot Preview"
    : tab.type === "diff" ? "Diff"
    : tab.type === "agent-run" ? "Agent Run"
    : tab.type === "database" ? "Database"
    : isImage ? "Image"
    : isVisual ? "Visual"
    : "Note";

  /* Explicit RGB so inline styles always resolve (CSS vars don't work in all inline contexts) */
  const typeClasses =
    tab.type === "sketch"
      ? { bar: "bg-[rgb(var(--color-accent))]", icon: "text-[rgb(var(--color-accent))]", tint: "bg-[rgb(var(--color-accent))]" }
      : tab.type === "storyboard"
        ? { bar: "bg-success", icon: "text-success", tint: "bg-success" }
        : tab.type === "history"
            ? { bar: "bg-[rgb(var(--color-accent))]", icon: "text-[rgb(var(--color-accent))]", tint: "bg-[rgb(var(--color-accent))]" }
           : tab.type === "snapshot-preview"
             ? { bar: "bg-[rgb(var(--color-accent))]", icon: "text-[rgb(var(--color-accent))]", tint: "bg-[rgb(var(--color-accent))]" }
           : tab.type === "diff"
              ? { bar: "bg-warning", icon: "text-warning", tint: "bg-warning" }
              : tab.type === "agent-run"
                ? { bar: "bg-[rgb(var(--color-accent))]", icon: "text-[rgb(var(--color-accent))]", tint: "bg-[rgb(var(--color-accent))]" }
              : tab.type === "database"
                ? { bar: "bg-[rgb(var(--color-accent))]", icon: "text-[rgb(var(--color-accent))]", tint: "bg-[rgb(var(--color-accent))]" }
              : isImage
                ? { bar: "bg-[rgb(var(--color-accent))]", icon: "text-[rgb(var(--color-accent))]", tint: "bg-[rgb(var(--color-accent))]" }
              : isVisual
                ? { bar: "bg-warning", icon: "text-warning", tint: "bg-warning" }
                : { bar: "bg-[rgb(var(--color-accent))]", icon: "text-[rgb(var(--color-accent))]", tint: "bg-[rgb(var(--color-accent))]" };

  const TabIcon =
    tab.type === "sketch" ? SketchIcon
    : tab.type === "storyboard" ? StoryboardIcon
    : tab.type === "history" ? HistoryIcon
    : tab.type === "snapshot-preview" ? DiffIcon
    : tab.type === "diff" ? DiffIcon
    : tab.type === "agent-run" ? AgentRunIcon
    : tab.type === "database" ? DatabaseIcon
    : isImage ? ImageIcon
    : isVisual ? VisualIcon
    : NoteIcon;

  return (
    <div
      ref={tabRef}
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-cutready-tab", JSON.stringify({ tabId: tab.id, source: "main" }));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`group relative mb-[-1px] flex h-[37px] shrink-0 cursor-pointer select-none items-center gap-1.5 border border-transparent pl-3 pr-2 text-[12px] transition-colors ${
        isActive
          ? "border-[rgb(var(--color-border-subtle))] border-b-[rgb(var(--color-surface))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-sm"
          : isSplit
            ? "bg-[rgb(var(--color-surface-alt))]/70 text-[rgb(var(--color-text))]"
            : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))]/65 hover:text-[rgb(var(--color-text))]"
      }`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={`${typeLabel}: ${tab.path}`}
    >
      {/* Active tab: colored bar on top — dimmed when group is not focused */}
      {isActive && (
        <span className={`absolute left-0 right-0 top-0 h-[2px] ${typeClasses.bar} ${isGroupFocused ? "" : "opacity-40"}`} />
      )}
      {/* Split tab: dotted bar on top */}
      {isSplit && !isActive && (
        <span className={`absolute left-0 right-0 top-0 h-[2px] ${typeClasses.bar} opacity-50`} />
      )}

      {/* Hover tint for inactive tabs — type-colored wash */}
      {!isActive && !isSplit && (
        <span className={`absolute inset-0 opacity-0 group-hover:opacity-[0.06] transition-opacity pointer-events-none ${typeClasses.tint}`} />
      )}

      {/* Separator between tabs */}
      <span className={`absolute bottom-[8px] right-[-1px] top-[8px] w-px ${
        isActive ? "bg-transparent" : "bg-[rgb(var(--color-border))]"
      }`} />

      {/* Type icon */}
      <span className={`shrink-0 transition-colors ${
        isActive
          ? typeClasses.icon
          : "text-[rgb(var(--color-text-secondary))] opacity-60"
      }`}>
        <TabIcon size={13} />
      </span>

      {/* Title */}
      <span className={`truncate max-w-[140px] ${isActive ? "font-medium" : ""}`}>
        {tab.title}
      </span>

      {/* Close button */}
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
