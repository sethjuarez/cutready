import { type ReactNode, useCallback } from "react";
import { House, Settings, Images, LayoutList, MessageSquare, GitCompareArrows } from "lucide-react";
import type { AppView } from "../stores/appStore";
import { useAppStore } from "../stores/appStore";
import { usePopover } from "../hooks/usePopover";
import { UpdateAvailableButton } from "./UpdateAvailableButton";
import { activityButtonClass } from "./shellStyles";

const navItems: { id: AppView; label: string; icon: ReactNode }[] = [
  {
    id: "project",
    label: "Project",
    icon: <LayoutList className="w-4 h-4" />,
  },
  {
    id: "assets",
    label: "Assets",
    icon: <Images className="w-4 h-4" />,
  },
  {
    id: "changes",
    label: "Changes",
    icon: <GitCompareArrows className="w-4 h-4" />,
  },
];

export function Sidebar({ onFeedback }: { onFeedback?: () => void }) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const currentProject = useAppStore((s) => s.currentProject);
  const changedFilesCount = useAppStore((s) => s.changedFiles.length);

  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const toggleSidebarPosition = useAppStore((s) => s.toggleSidebarPosition);

  const isRight = sidebarPosition === "right";

  // Context menu state
  const { state: contextMenu, ref: menuRef, openAt: openContextMenu, close: closeContextMenu, position: menuPos } = usePopover();

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    openContextMenu({ x: e.clientX, y: e.clientY });
  }, [openContextMenu]);

  return (
    <>
      <nav
        className={`no-select flex w-12 flex-col items-center gap-1.5 bg-[rgb(var(--color-surface))] px-1.5 py-3 ${
          isRight ? "border-l border-[rgb(var(--color-border-subtle))]" : "border-r border-[rgb(var(--color-border-subtle))]"
        }`}
        onContextMenu={handleContextMenu}
      >
        {navItems.map((item) => {
          const isActive = view === item.id;
          const requiresProject = item.id === "project" || item.id === "assets" || item.id === "changes";
          const isDisabled = requiresProject && !currentProject;

          return (
            <button
              key={item.id}
              onClick={() => !isDisabled && setView(item.id)}
              disabled={isDisabled}
              data-testid={`activity-${item.id}`}
              className={activityButtonClass(isActive, isDisabled)}
              title={item.label}
            >
              {item.icon}
              {/* Badge for changes count */}
              {item.id === "changes" && changedFilesCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] text-[8px] font-bold leading-none px-0.5">
                  {changedFilesCount > 99 ? "99+" : changedFilesCount}
                </span>
              )}
              {/* Active indicator bar */}
              {isActive && (
                <span className={`absolute top-1/2 h-4 w-[2px] -translate-y-1/2 bg-[rgb(var(--color-accent))] ${
                  isRight ? "right-[-8px]" : "left-[-8px]"
                }`} />
              )}

            </button>
          );
        })}

        {/* Spacer pushes bottom items down */}
        <div className="flex-1" />

        <UpdateAvailableButton />

        {/* Home — pinned to bottom */}
        {(() => {
          const isActive = view === "home";
          return (
            <button
              onClick={() => setView("home")}
              className={activityButtonClass(isActive)}
              title="Home"
              data-testid="activity-home"
            >
              <House className="w-4 h-4" />
              {isActive && (
                <span className={`absolute top-1/2 h-4 w-[2px] -translate-y-1/2 bg-[rgb(var(--color-accent))] ${
                  isRight ? "right-[-8px]" : "left-[-8px]"
                }`} />
              )}
            </button>
          );
        })()}

        {/* Feedback */}
        {onFeedback && (
          <button
            onClick={onFeedback}
            className={activityButtonClass(false)}
            title="Send Feedback"
            data-testid="activity-feedback"
          >
            <MessageSquare className="w-4 h-4" />
          </button>
        )}

        {/* Global settings gear — pinned to bottom */}
        {(() => {
          const isActive = view === "settings";
          return (
            <button
              onClick={() => setView("settings")}
              className={activityButtonClass(isActive)}
              title="Settings"
              data-testid="activity-settings"
            >
              <Settings className="w-4 h-4" />
              {isActive && (
                <span className={`absolute top-1/2 h-4 w-[2px] -translate-y-1/2 bg-[rgb(var(--color-accent))] ${
                  isRight ? "right-[-8px]" : "left-[-8px]"
                }`} />
              )}
            </button>
          );
        })()}
      </nav>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-dropdown py-1 min-w-[200px] bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg"
          style={{ left: menuPos?.x, top: menuPos?.y }}
        >
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent))]/10 hover:text-[rgb(var(--color-accent))] transition-colors"
            onClick={() => {
              toggleSidebarPosition();
              closeContextMenu();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1={isRight ? "9" : "15"} y1="3" x2={isRight ? "9" : "15"} y2="21" />
            </svg>
            Move Sidebar to {isRight ? "Left" : "Right"}
          </button>
        </div>
      )}
    </>
  );
}
