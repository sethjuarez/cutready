import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { AppView } from "../stores/appStore";
import { useAppStore } from "../stores/appStore";

const navItems: { id: AppView; label: string; icon: ReactNode }[] = [
  {
    id: "home",
    label: "Home",
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
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    id: "sketch",
    label: "Sketch",
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
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
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
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
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
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("mousedown", handleClose);
    window.addEventListener("keydown", handleEsc);
    return () => {
      window.removeEventListener("mousedown", handleClose);
      window.removeEventListener("keydown", handleEsc);
    };
  }, [contextMenu]);

  return (
    <>
      <nav
        className={`no-select flex flex-col w-12 bg-[var(--color-surface-toolbar)] items-center py-3 gap-1 ${
          isRight ? "border-l border-[var(--color-border)]" : "border-r border-[var(--color-border)]"
        }`}
        onContextMenu={handleContextMenu}
      >
        {navItems.map((item) => {
          const isActive = view === item.id;
          const requiresProject = item.id === "sketch" || item.id === "editor" || item.id === "recording";
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
                <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] py-1 min-w-[200px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-left text-[var(--color-text)] hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] transition-colors"
            onClick={() => {
              toggleSidebarPosition();
              setContextMenu(null);
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

