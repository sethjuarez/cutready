import { type ReactNode, useCallback } from "react";
import { House, Clapperboard, FolderOpen, Monitor, SlidersHorizontal, Bot, SquarePen, NotebookPen, Images, LayoutList } from "lucide-react";
import type { AppView } from "../stores/appStore";
import { useAppStore } from "../stores/appStore";
import { usePopover } from "../hooks/usePopover";

const navItems: { id: AppView; label: string; icon: ReactNode }[] = [
  {
    id: "home",
    label: "Home",
    icon: <House className="w-4 h-4" />,
  },
  {
    id: "project",
    label: "Project",
    icon: <LayoutList className="w-4 h-4" />,
  },
  {
    id: "storyboards",
    label: "Storyboards",
    icon: <Clapperboard className="w-4 h-4" />,
  },
  {
    id: "sketches",
    label: "Sketches",
    icon: <SquarePen className="w-4 h-4" />,
  },
  {
    id: "notes",
    label: "Notes",
    icon: <NotebookPen className="w-4 h-4" />,
  },
  {
    id: "assets",
    label: "Assets",
    icon: <Images className="w-4 h-4" />,
  },
  {
    id: "explorer",
    label: "Explorer",
    icon: <FolderOpen className="w-4 h-4" />,
  },
  {
    id: "workspace",
    label: "Workspace",
    icon: <Monitor className="w-4 h-4" />,
  },
];

export function Sidebar() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const currentProject = useAppStore((s) => s.currentProject);

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
        className={`no-select flex flex-col w-12 bg-[rgb(var(--color-surface))] items-center py-3 gap-1.5 ${
          isRight ? "border-l border-[rgb(var(--color-border))]" : "border-r border-[rgb(var(--color-border))]"
        }`}
        onContextMenu={handleContextMenu}
      >
        {navItems.map((item) => {
          const isActive = view === item.id;
          const requiresProject = item.id === "project" || item.id === "storyboards" || item.id === "sketches" || item.id === "notes" || item.id === "assets" || item.id === "explorer" || item.id === "workspace";
          const isDisabled = requiresProject && !currentProject;

          return (
            <button
              key={item.id}
              onClick={() => !isDisabled && setView(item.id)}
              disabled={isDisabled}
              className={`
                flex items-center justify-center w-10 h-10 rounded-lg transition-colors relative
                ${
                  isActive
                    ? "bg-[rgb(var(--color-accent))]/15 text-[rgb(var(--color-accent))]"
                    : isDisabled
                      ? "text-[rgb(var(--color-text-secondary))]/40 cursor-not-allowed"
                      : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                }
              `}
              title={item.label}
            >
              {item.icon}
              {/* Active indicator bar */}
              {isActive && (
                <span className={`absolute top-1/4 h-1/2 w-[2px] rounded-full bg-[rgb(var(--color-accent))] ${
                  isRight ? "right-[-6px]" : "left-[-6px]"
                }`} />
              )}

            </button>
          );
        })}

        {/* Spacer pushes chat + settings gear to bottom */}
        <div className="flex-1" />

        {/* Zen Chat Mode — pinned above settings */}
        {(() => {
          const isActive = view === "chat";
          const isDisabled = !currentProject;
          return (
            <button
              onClick={() => !isDisabled && setView("chat")}
              disabled={isDisabled}
              className={`
                flex items-center justify-center w-10 h-10 rounded-lg transition-colors relative
                ${
                  isActive
                    ? "bg-[rgb(var(--color-accent))]/15 text-[rgb(var(--color-accent))]"
                    : isDisabled
                      ? "text-[rgb(var(--color-text-secondary))]/40 cursor-not-allowed"
                      : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                }
              `}
              title="Chat"
            >
              <Bot className="w-4 h-4" />
              {isActive && (
                <span className={`absolute top-1/4 h-1/2 w-[2px] rounded-full bg-[rgb(var(--color-accent))] ${
                  isRight ? "right-[-6px]" : "left-[-6px]"
                }`} />
              )}
            </button>
          );
        })()}

        {/* Global settings gear — pinned to bottom */}
        {(() => {
          const isActive = view === "settings";
          return (
            <button
              onClick={() => setView("settings")}
              className={`
                flex items-center justify-center w-10 h-10 rounded-lg transition-colors relative
                ${
                  isActive
                    ? "bg-[rgb(var(--color-accent))]/15 text-[rgb(var(--color-accent))]"
                    : "text-[rgb(var(--color-text-secondary))] hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
                }
              `}
              title="Settings"
            >
              <SlidersHorizontal className="w-4 h-4" />
              {isActive && (
                <span className={`absolute top-1/4 h-1/2 w-[2px] rounded-full bg-[rgb(var(--color-accent))] ${
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

