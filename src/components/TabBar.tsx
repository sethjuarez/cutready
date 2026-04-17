import { useAppStore } from "../stores/appStore";
import type { EditorTab } from "../stores/appStore";
import { SketchIcon, StoryboardIcon, NoteIcon, HistoryIcon, ImageIcon, VisualIcon } from "./Icons";
import { usePopover } from "../hooks/usePopover";
import React, { useCallback, useRef } from "react";
import { LayoutGrid, X } from "lucide-react";

/**
 * TabBar — horizontal row of open document tabs.
 * Active tab has a raised look with accent bottom border and primary background.
 * Inactive tabs are visually recessed with muted colors.
 */
export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const splitTabs = useAppStore((s) => s.splitTabs);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const closeOtherTabs = useAppStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useAppStore((s) => s.closeTabsToRight);
  const closeTabsToLeft = useAppStore((s) => s.closeTabsToLeft);
  const closeAllTabs = useAppStore((s) => s.closeAllTabs);
  const openTabInSplit = useAppStore((s) => s.openTabInSplit);

  const { state: contextMenu, ref: menuRef, openAt: openContextMenu, close: closeContextMenu, position: menuPos } = usePopover();
  const contextTabIdRef = useRef<string>("");

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    contextTabIdRef.current = tabId;
    openContextMenu({ x: e.clientX, y: e.clientY });
  }, [openContextMenu]);

  if (openTabs.length === 0) return null;

  const contextTab = openTabs.find((t) => t.id === contextTabIdRef.current);
  const canSplit = contextTab && contextTab.type !== "history" && contextTab.type !== "asset";
  const isAlreadyInSplit = contextTab
    ? splitTabs.some((st) => st.path === contextTab.path && st.type === contextTab.type)
    : false;

  return (
    <div
      className="no-select flex items-stretch bg-[rgb(var(--color-surface-alt))] shrink-0 overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
    >
      {openTabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          isSplit={splitTabs.some((st) => st.path === tab.path && st.type === tab.type)}
          onSelect={() => setActiveTab(tab.id)}
          onClose={() => closeTab(tab.id)}
          onContextMenu={(e) => handleTabContextMenu(e, tab.id)}
        />
      ))}
      {/* Fill remaining space with border-bottom */}
      <div className="flex-1 border-b border-[rgb(var(--color-border))]" />

      {/* Close All Tabs button */}
      {openTabs.length > 0 && (
        <button
          className="flex items-center justify-center w-8 h-full border-b border-l border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))] transition-colors shrink-0"
          title="Close All Tabs"
          onClick={() => closeAllTabs()}
        >
          <X className="w-3 h-3" />
        </button>
      )}

      {/* Tab context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-dropdown py-1 min-w-[200px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg"
          style={{ left: menuPos?.x, top: menuPos?.y }}
        >
          {canSplit && (
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
              onClick={() => { openTabInSplit(contextTabIdRef.current); closeContextMenu(); }}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              {isAlreadyInSplit ? "Focus in Split" : "Open to the Side"}
            </button>
          )}
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
        </div>
      )}
    </div>
  );
}

function Tab({
  tab,
  isActive,
  isSplit,
  onSelect,
  onClose,
  onContextMenu,
}: {
  tab: EditorTab;
  isActive: boolean;
  isSplit: boolean;
  onSelect: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const isImage = tab.type === "asset" && tab.path.includes("/screenshots/");
  const isVisual = tab.type === "asset" && !isImage;

  const typeLabel =
    tab.type === "sketch" ? "Sketch"
    : tab.type === "storyboard" ? "Storyboard"
    : tab.type === "history" ? "History"
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
          ? { bar: "bg-sky-500", icon: "text-sky-500", tint: "bg-sky-500" }
          : isImage
            ? { bar: "bg-violet-500", icon: "text-violet-500", tint: "bg-violet-500" }
            : isVisual
              ? { bar: "bg-amber-500", icon: "text-amber-500", tint: "bg-amber-500" }
              : { bar: "bg-rose-500", icon: "text-rose-500", tint: "bg-rose-500" };

  const TabIcon =
    tab.type === "sketch" ? SketchIcon
    : tab.type === "storyboard" ? StoryboardIcon
    : tab.type === "history" ? HistoryIcon
    : isImage ? ImageIcon
    : isVisual ? VisualIcon
    : NoteIcon;

  return (
    <div
      className={`group relative flex items-center gap-1.5 px-3 h-[36px] text-[12px] cursor-pointer shrink-0 select-none transition-colors ${
        isActive
          ? "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]"
          : isSplit
            ? "bg-[rgb(var(--color-surface-inset))] text-[rgb(var(--color-text))]"
            : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] border-b border-[rgb(var(--color-border))]"
      }`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={`${typeLabel}: ${tab.path}`}
    >
      {/* Active tab: colored bar on top */}
      {isActive && (
        <span className={`absolute top-0 left-0 right-0 h-[2px] ${typeClasses.bar}`} />
      )}
      {/* Split tab: dotted bar on top */}
      {isSplit && !isActive && (
        <span className={`absolute top-0 left-0 right-0 h-[2px] ${typeClasses.bar} opacity-50`} />
      )}

      {/* Hover tint for inactive tabs — type-colored wash */}
      {!isActive && !isSplit && (
        <span className={`absolute inset-0 opacity-0 group-hover:opacity-[0.06] transition-opacity pointer-events-none ${typeClasses.tint}`} />
      )}

      {/* Separator between tabs */}
      <span className={`absolute top-[6px] bottom-[6px] right-0 w-px ${
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
        className={`flex items-center justify-center w-[18px] h-[18px] rounded transition-all shrink-0 ${
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
