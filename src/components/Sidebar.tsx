import { type ReactNode, useCallback } from "react";
import { HomeIcon, PencilIcon, DocumentIcon, ComputerDesktopIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import type { AppView } from "../stores/appStore";
import { useAppStore } from "../stores/appStore";
import { usePopover } from "../hooks/usePopover";

const navItems: { id: AppView; label: string; icon: ReactNode }[] = [
  {
    id: "home",
    label: "Home",
    icon: <HomeIcon className="w-4 h-4" />,
  },
  {
    id: "sketch",
    label: "Sketch",
    icon: <PencilIcon className="w-4 h-4" />,
  },
  {
    id: "recording",
    label: "Record",
    icon: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="4" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "editor",
    label: "Script",
    icon: <DocumentIcon className="w-4 h-4" />,
  },
  {
    id: "workspace",
    label: "Workspace",
    icon: <ComputerDesktopIcon className="w-4 h-4" />,
  },
];

export function Sidebar() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const currentProject = useAppStore((s) => s.currentProject);
  const isRecording = useAppStore((s) => s.isRecording);
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
        className={`no-select flex flex-col w-12 bg-[var(--color-surface-toolbar)] items-center py-3 gap-1 ${
          isRight ? "border-l border-[var(--color-border)]" : "border-r border-[var(--color-border)]"
        }`}
        onContextMenu={handleContextMenu}
      >
        {navItems
          .filter((item) => item.id !== "recording" && item.id !== "editor")
          .map((item) => {
          const isActive = view === item.id;
          const requiresProject = item.id === "sketch" || item.id === "editor" || item.id === "recording" || item.id === "workspace";
          const isDisabled = requiresProject && !currentProject;

          return (
            <button
              key={item.id}
              onClick={() => !isDisabled && setView(item.id)}
              disabled={isDisabled}
              className={`
                flex items-center justify-center w-9 h-9 rounded-lg transition-colors relative
                ${
                  isActive
                    ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                    : isDisabled
                      ? "text-[var(--color-text-secondary)]/40 cursor-not-allowed"
                      : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                }
              `}
              title={item.label}
            >
              {item.icon}
              {/* Active indicator bar */}
              {isActive && (
                <span className={`absolute top-1/4 h-1/2 w-[2px] rounded-full bg-[var(--color-accent)] ${
                  isRight ? "right-[-6px]" : "left-[-6px]"
                }`} />
              )}
              {/* Recording indicator dot */}
              {item.id === "recording" && isRecording && (
                <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-error animate-pulse" />
              )}
            </button>
          );
        })}

        {/* Spacer pushes settings gear to bottom */}
        <div className="flex-1" />

        {/* Global settings gear — pinned to bottom */}
        {(() => {
          const isActive = view === "settings";
          return (
            <button
              onClick={() => setView("settings")}
              className={`
                flex items-center justify-center w-9 h-9 rounded-lg transition-colors relative
                ${
                  isActive
                    ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
                    : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                }
              `}
              title="Settings"
            >
              <Cog6ToothIcon className="w-4 h-4" />
              {isActive && (
                <span className={`absolute top-1/4 h-1/2 w-[2px] rounded-full bg-[var(--color-accent)] ${
                  isRight ? "right-[-6px]" : "left-[-6px]"
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
          className="fixed z-[100] py-1 min-w-[200px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg"
          style={{ left: menuPos?.x, top: menuPos?.y }}
        >
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[var(--color-text)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] transition-colors"
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

