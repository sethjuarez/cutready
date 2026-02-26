import { useAppStore } from "../stores/appStore";
import type { EditorTab } from "../stores/appStore";

/**
 * TabBar — horizontal row of open document tabs.
 * Shows sketch/storyboard tabs with close buttons and active indicator.
 */
export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);

  if (openTabs.length === 0) return null;

  return (
    <div className="no-select flex items-end bg-[var(--color-surface-alt)] border-b border-[var(--color-border)] overflow-x-auto shrink-0"
      style={{ scrollbarWidth: "none" }}
    >
      {openTabs.map((tab) => (
        <Tab
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          onSelect={() => setActiveTab(tab.id)}
          onClose={() => closeTab(tab.id)}
        />
      ))}
    </div>
  );
}

function Tab({
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
  return (
    <div
      className={`group flex items-center gap-1.5 px-3 h-[34px] text-[12px] cursor-pointer shrink-0 select-none border-r border-[var(--color-border)] transition-colors ${
        isActive
          ? "bg-[var(--color-surface)] text-[var(--color-text)] border-b-2 border-b-[var(--color-accent)]"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      }`}
      onClick={onSelect}
      title={tab.path}
    >
      {/* Icon */}
      {tab.type === "sketch" ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${isActive ? "text-[var(--color-accent)]" : "opacity-50"}`}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${isActive ? "text-[var(--color-accent)]" : "opacity-50"}`}>
          <rect x="2" y="3" width="20" height="18" rx="2" />
          <line x1="8" y1="3" x2="8" y2="21" />
        </svg>
      )}

      {/* Title */}
      <span className="truncate max-w-[120px]">{tab.title}</span>

      {/* Close button */}
      <button
        className="flex items-center justify-center w-[18px] h-[18px] rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-surface-alt)] transition-all shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
