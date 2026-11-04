import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { PanelBottom, PanelLeft, Search, Sparkles } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { isMac, formatKeybinding } from "../utils/platform";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { TitleBarSyncStatus, TitleBarVariationChip } from "./TitleBarStatus";
import { WindowControls } from "./WindowControls";

interface TitleBarProps {
  onCommandPaletteOpen?: () => void;
  sidebarVisible?: boolean;
  outputVisible?: boolean;
  /** Chat is showing: side companion, focus mode or the chat view. */
  chatActive?: boolean;
  onToggleSidebar?: () => void;
  onToggleOutput?: () => void;
  /** Cycles chat: side companion, then focus mode, then closed. Always leaves focus mode first. */
  onToggleChat?: () => void;
}

export function TitleBar({
  onCommandPaletteOpen,
  sidebarVisible = true,
  outputVisible = false,
  chatActive = false,
  onToggleSidebar,
  onToggleOutput,
  onToggleChat,
}: TitleBarProps) {
  const appWindow = (() => {
    try { return getCurrentWindow(); } catch { return null; }
  })();
  const [maximized, setMaximized] = useState(false);
  const currentProject = useAppStore((s) => s.currentProject);

  useEffect(() => {
    if (!appWindow || isMac) return;
    const checkMaximized = async () => {
      setMaximized(await appWindow.isMaximized());
    };
    checkMaximized();
    const unlisten = appWindow.onResized(async () => {
      setMaximized(await appWindow.isMaximized());
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [appWindow]);

  const handleMinimize = useCallback(() => appWindow?.minimize(), [appWindow]);
  const handleMaximize = useCallback(() => appWindow?.toggleMaximize(), [appWindow]);
  const handleClose = useCallback(() => appWindow?.close(), [appWindow]);
  const handleTitleBarMouseDown = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || !appWindow) return;
      const target = event.target as HTMLElement;
      if (target.closest("button, input, textarea, select, a, [role='button']")) return;
      if (event.detail === 2) {
        event.preventDefault();
        void appWindow.toggleMaximize();
        return;
      }
      void appWindow.startDragging();
    },
    [appWindow],
  );

  const paletteShortcut = formatKeybinding("Ctrl+Shift+P");

  return (
    <div
      data-testid="titlebar"
      className={`no-select z-chrome grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 bg-transparent ${
        // macOS lets the native titlebar own traffic lights; the layout keeps a safe area for them.
        isMac ? "relative shrink-0 pr-3" : "fixed left-0 right-0 top-0 pl-3"
      }`}
      style={{
        height: "var(--titlebar-height)",
        ...(isMac ? { paddingLeft: "var(--macos-traffic-light-space)" } : {}),
      }}
      onMouseDown={handleTitleBarMouseDown}
    >
      <div className="flex min-w-0 items-center gap-2">
        {!isMac && (
          <img
            src="/cutready-mark.svg"
            alt=""
            aria-hidden="true"
            width={18}
            height={18}
            className="shrink-0"
            draggable={false}
          />
        )}
        <span className="shrink-0 text-sm font-semibold tracking-tight text-[rgb(var(--color-text))]">CutReady</span>
        {currentProject && (
          <>
            <span aria-hidden="true" className="h-4 w-px shrink-0 bg-[rgb(var(--color-border))] max-[1100px]:hidden" />
            <ProjectSwitcher variant="title" />
            <TitleBarVariationChip />
          </>
        )}
      </div>

      <button
        type="button"
        className="flex h-7 w-[clamp(160px,30vw,400px)] cursor-pointer items-center gap-2 rounded-control border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-inset))] px-2.5 text-xs text-[rgb(var(--color-text-secondary))] transition-colors duration-fast ease-fluent hover:border-[rgb(var(--color-border))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] max-[760px]:w-9 max-[760px]:justify-center max-[760px]:px-0"
        onClick={onCommandPaletteOpen}
        title={`Search sketches, notes and commands (${paletteShortcut})`}
        aria-label={`Search sketches, notes and commands (${paletteShortcut})`}
        data-testid="titlebar-search"
      >
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate text-left max-[760px]:hidden">Search sketches, notes and commands</span>
        <kbd className="rounded border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] px-1.5 py-px font-[inherit] text-2xs text-[rgb(var(--color-text-secondary))] max-[1000px]:hidden">
          {paletteShortcut}
        </kbd>
      </button>

      <div className="flex h-full min-w-0 items-center justify-end gap-1.5">
        {currentProject && <TitleBarSyncStatus />}
        <div className="flex items-center gap-0.5" role="group" aria-label="Layout">
          <PanelToggle
            label="Sidebar"
            shortcut="Ctrl+B"
            pressed={sidebarVisible}
            onClick={onToggleSidebar}
            className="max-[900px]:hidden"
          >
            <PanelLeft className="h-4 w-4" aria-hidden="true" />
          </PanelToggle>
          <PanelToggle
            label="Activity panel"
            shortcut="Ctrl+`"
            pressed={outputVisible}
            onClick={onToggleOutput}
            className="max-[900px]:hidden"
          >
            <PanelBottom className="h-4 w-4" aria-hidden="true" />
          </PanelToggle>
          <PanelToggle
            label="Chat"
            shortcut="Ctrl+Shift+C"
            pressed={chatActive}
            onClick={onToggleChat}
            testId="activity-chat"
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </PanelToggle>
        </div>
        {!isMac && (
          <WindowControls
            maximized={maximized}
            onMinimize={handleMinimize}
            onMaximize={handleMaximize}
            onClose={handleClose}
          />
        )}
      </div>
    </div>
  );
}

function PanelToggle({
  label,
  shortcut,
  pressed,
  onClick,
  className = "",
  testId,
  children,
}: {
  label: string;
  shortcut: string;
  pressed: boolean;
  onClick?: () => void;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const title = `${label} (${formatKeybinding(shortcut)})`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={label}
      title={title}
      data-testid={testId}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-control transition-colors duration-fast ease-fluent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] ${
        pressed
          ? "bg-fill-selected text-[rgb(var(--color-text))]"
          : "text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover hover:text-[rgb(var(--color-text))]"
      } ${className}`}
    >
      {children}
    </button>
  );
}