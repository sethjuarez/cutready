import { useAppStore } from "../stores/appStore";
import type { EditorTab } from "../stores/appStore";

/**
 * TabBar — horizontal row of open document tabs.
 * Active tab has a raised look with accent bottom border and primary background.
 * Inactive tabs are visually recessed with muted colors.
 */
export function TabBar() {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const closeTab = useAppStore((s) => s.closeTab);

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
          onSelect={() => setActiveTab(tab.id)}
          onClose={() => closeTab(tab.id)}
        />
      ))}
      {/* Fill remaining space with border-bottom */}
      <div className="flex-1 border-b border-[var(--color-border)]" />
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
  const typeLabel = tab.type === "sketch" ? "Sketch" : "Storyboard";

  return (
    <div
      className={`group relative flex items-center gap-1.5 px-3 h-[36px] text-[12px] cursor-pointer shrink-0 select-none transition-colors ${
        isActive
          ? "bg-[var(--color-surface)] text-[var(--color-text)]"
          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border-b border-[var(--color-border)]"
      }`}
      onClick={onSelect}
      title={`${typeLabel}: ${tab.path}`}
    >
      {/* Active tab: accent bar on top, no bottom border (connected to content) */}
      {isActive && (
        <span className="absolute top-0 left-0 right-0 h-[2px] bg-[var(--color-accent)]" />
      )}

      {/* Separator between tabs */}
      <span className={`absolute top-[6px] bottom-[6px] right-0 w-px ${
        isActive ? "bg-transparent" : "bg-[var(--color-border)]"
      }`} />

      {/* Type badge */}
      <span className={`shrink-0 text-[9px] font-semibold uppercase tracking-wider px-1 py-px rounded ${
        isActive
          ? tab.type === "sketch"
            ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
            : "bg-emerald-500/15 text-emerald-500"
          : "bg-[var(--color-border)]/50 text-[var(--color-text-secondary)]"
      }`}>
        {tab.type === "sketch" ? "SK" : "SB"}
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
