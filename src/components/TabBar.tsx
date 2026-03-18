import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import type { EditorTab } from "../stores/appStore";
import { SketchIcon, StoryboardIcon, NoteIcon, HistoryIcon } from "./Icons";

/**
 * TabBar — horizontal row of open document tabs.
 * Active tab has a raised look with accent bottom border and primary background.
 * Inactive tabs are visually recessed with muted colors.
 */
export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const splitTabId = useAppStore((s) => s.splitTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const openTabInSplit = useAppStore((s) => s.openTabInSplit);
  const closeSplit = useAppStore((s) => s.closeSplit);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setContextMenu(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [contextMenu]);

  if (openTabs.length === 0) return null;

  return (
    <div
      className="no-select flex items-stretch bg-[var(--color-surface-alt)] shrink-0 overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
    >
      {openTabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          isSplit={tab.id === splitTabId}
          onSelect={() => setActiveTab(tab.id)}
          onClose={() => closeTab(tab.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
          }}
        />
      ))}
      {/* Fill remaining space with border-bottom */}
      <div className="flex-1 border-b border-[var(--color-border)]" />

      {/* Tab context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] py-1 min-w-[200px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.tabId !== activeTabId && (
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[var(--color-text)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] transition-colors"
              onClick={() => { openTabInSplit(contextMenu.tabId); setContextMenu(null); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="12" y1="3" x2="12" y2="21" />
              </svg>
              Open to the Side
            </button>
          )}
          {splitTabId && contextMenu.tabId === splitTabId && (
            <button
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[var(--color-text)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] transition-colors"
              onClick={() => { closeSplit(); setContextMenu(null); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
              Close Split
            </button>
          )}
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[var(--color-text)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] transition-colors"
            onClick={() => { closeTab(contextMenu.tabId); setContextMenu(null); }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            Close Tab
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
  const typeLabel =
    tab.type === "sketch" ? "Sketch"
    : tab.type === "storyboard" ? "Storyboard"
    : tab.type === "history" ? "History"
    : "Note";

  /* Explicit RGB so inline styles always resolve (CSS vars don't work in all inline contexts) */
  const typeClasses =
    tab.type === "sketch"
      ? { bar: "bg-[var(--color-accent)]", icon: "text-[var(--color-accent)]", tint: "bg-[var(--color-accent)]" }
      : tab.type === "storyboard"
        ? { bar: "bg-emerald-500", icon: "text-emerald-500", tint: "bg-emerald-500" }
        : tab.type === "history"
          ? { bar: "bg-sky-500", icon: "text-sky-500", tint: "bg-sky-500" }
          : { bar: "bg-rose-500", icon: "text-rose-500", tint: "bg-rose-500" };

  const TabIcon =
    tab.type === "sketch" ? SketchIcon
    : tab.type === "storyboard" ? StoryboardIcon
    : tab.type === "history" ? HistoryIcon
    : NoteIcon;

  return (
    <div
      className={`group relative flex items-center gap-1.5 px-3 h-[36px] text-[12px] cursor-pointer shrink-0 select-none transition-colors ${
        isActive
          ? "bg-[var(--color-surface)] text-[var(--color-text)]"
          : isSplit
            ? "bg-[var(--color-surface-inset)] text-[var(--color-text)]"
            : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border-b border-[var(--color-border)]"
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
        isActive ? "bg-transparent" : "bg-[var(--color-border)]"
      }`} />

      {/* Type icon */}
      <span className={`shrink-0 transition-colors ${
        isActive
          ? typeClasses.icon
          : "text-[var(--color-text-secondary)] opacity-60"
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
            ? "opacity-60 hover:opacity-100 hover:bg-[var(--color-surface-alt)]"
            : "opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-[var(--color-surface)]"
        }`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
