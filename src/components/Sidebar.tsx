import type { ReactNode } from "react";
import { GitCompareArrows, House, Images, LayoutList, Menu, MessageSquare, MessageSquareMore, Mic2, Settings } from "lucide-react";
import type { AppView } from "../stores/appStore";
import { useAppStore } from "../stores/appStore";
import { useVersioningStore } from "../stores/versioningStore";
import { formatKeybinding } from "../utils/platform";
import { UpdateAvailableButton } from "./UpdateAvailableButton";
import { activityButtonClass } from "./shellStyles";
import { panelOwner, type NavId } from "../utils/navigation";

const navItems: { id: NavId; label: string; icon: ReactNode }[] = [
  { id: "project", label: "Documents", icon: <LayoutList className="h-[18px] w-[18px]" aria-hidden="true" /> },
  { id: "assets", label: "Visuals", icon: <Images className="h-[18px] w-[18px]" aria-hidden="true" /> },
  { id: "narrations", label: "Narrations", icon: <Mic2 className="h-[18px] w-[18px]" aria-hidden="true" /> },
  { id: "changes", label: "Changes", icon: <GitCompareArrows className="h-[18px] w-[18px]" aria-hidden="true" /> },
  { id: "chat", label: "Chat", icon: <MessageSquareMore className="h-[18px] w-[18px]" aria-hidden="true" /> },
];

interface SidebarProps {
  onFeedback?: () => void;
  onChatToggle?: () => void;
  chatActive?: boolean;
  /** Labelled nav with the active view's panel; false renders the icon rail. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** Panel for the active view, shown under its nav row when expanded. */
  panel?: ReactNode;
  /** View whose panel is shown; defaults to the current view (differs while Settings is open). */
  panelView?: AppView;
  width?: number;
}

/** Left navigation: a labelled accordion (Direction C) that collapses to an icon rail. */
export function Sidebar({
  onFeedback,
  onChatToggle,
  chatActive = false,
  expanded = false,
  onToggleExpanded,
  panel,
  panelView,
  width,
}: SidebarProps) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const currentProject = useAppStore((s) => s.currentProject);
  const changedFilesCount = useVersioningStore((s) => s.changedFiles.length);
  const owner = panelOwner(panelView ?? view);
  const toggleLabel = `${expanded ? "Collapse" : "Expand"} navigation (${formatKeybinding("Ctrl+B")})`;

  const renderItem = (item: (typeof navItems)[number]) => {
    const isChat = item.id === "chat";
    const isActive = isChat ? chatActive : view === item.id;
    const isDisabled = !isChat && !currentProject;
    const ownsPanel = expanded && !isChat && owner === item.id && panel != null;
    const badge = item.id === "changes" && changedFilesCount > 0 ? (changedFilesCount > 99 ? "99+" : String(changedFilesCount)) : null;
    return (
      <div key={item.id} className={ownsPanel ? "flex min-h-0 flex-1 flex-col" : "shrink-0"}>
        <button
          type="button"
          onClick={() => {
            if (isDisabled) return;
            if (isChat) onChatToggle?.();
            else setView(item.id);
          }}
          disabled={isDisabled}
          data-testid={`activity-${item.id}`}
          className={expanded ? navRowClass(isActive || owner === item.id, isDisabled) : activityButtonClass(isActive, isDisabled)}
          title={badge ? `${item.label} · ${badge} unsaved` : item.label}
          aria-label={item.label}
          aria-current={!isChat && isActive ? "page" : undefined}
          aria-pressed={isChat ? isActive : undefined}
          aria-expanded={expanded && !isChat ? ownsPanel : undefined}
        >
          {item.icon}
          {expanded && <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>}
          {badge && (
            <span
              className={
                expanded
                  ? "min-w-[18px] rounded-pill bg-accent px-1.5 text-center text-2xs font-semibold text-accent-fg"
                  : "absolute -right-0.5 -top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-bold leading-none text-accent-fg"
              }
              aria-hidden="true"
            >
              {badge}
            </span>
          )}
          {!expanded && isActive && <ActiveIndicator />}
        </button>
        {ownsPanel && (
          <div className="mt-0.5 min-h-0 flex-1 overflow-hidden rounded-control" data-testid="nav-panel">
            {panel}
          </div>
        )}
      </div>
    );
  };

  const bottomButton = (id: "home" | "settings", label: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => setView(id)}
      className={activityButtonClass(view === id)}
      title={label}
      aria-label={label}
      aria-current={view === id ? "page" : undefined}
      data-testid={`activity-${id}`}
    >
      {icon}
      {!expanded && view === id && <ActiveIndicator />}
    </button>
  );

  return (
    <nav
      aria-label="Main"
      data-testid="app-nav"
      data-expanded={expanded ? "true" : "false"}
      className={`no-select flex h-full shrink-0 flex-col ${
        expanded ? "gap-0.5 px-1.5 pb-2 pt-1.5" : "w-12 items-center gap-1.5 px-1.5 py-2"
      }`}
      style={expanded && width ? { width } : undefined}
    >
      {onToggleExpanded && (
        <button
          type="button"
          onClick={onToggleExpanded}
          className={activityButtonClass(false)}
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={expanded}
          data-testid="nav-toggle"
        >
          <Menu className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      )}

      {navItems.map(renderItem)}

      {!(expanded && owner && panel != null) && <div className="flex-1" />}

      <div className={`flex shrink-0 ${expanded ? "flex-wrap items-center gap-0.5 border-t border-[rgb(var(--color-border-subtle))] pt-1.5" : "flex-col items-center gap-1.5"}`}>
        <UpdateAvailableButton />
        {bottomButton("home", "Home", <House className="h-[18px] w-[18px]" aria-hidden="true" />)}
        {onFeedback && (
          <button
            type="button"
            onClick={onFeedback}
            className={activityButtonClass(false)}
            title="Send feedback"
            aria-label="Send feedback"
            data-testid="activity-feedback"
          >
            <MessageSquare className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        )}
        {bottomButton("settings", "Settings", <Settings className="h-[18px] w-[18px]" aria-hidden="true" />)}
      </div>
    </nav>
  );
}

function navRowClass(selected: boolean, disabled = false): string {
  return [
    "relative flex h-nav-row w-full shrink-0 items-center gap-3 rounded-control pl-3 pr-2.5 text-sm transition-colors duration-fast ease-fluent",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[rgb(var(--color-accent))]",
    disabled
      ? "cursor-not-allowed text-[rgb(var(--color-text-secondary))]/45"
      : selected
        ? "bg-fill-selected font-medium text-[rgb(var(--color-text))] before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-accent"
        : "text-[rgb(var(--color-text))] hover:bg-fill-hover",
  ].join(" ");
}

function ActiveIndicator() {
  return <span aria-hidden="true" className="absolute left-[-8px] top-1/2 h-4 w-[2px] -translate-y-1/2 bg-accent" />;
}