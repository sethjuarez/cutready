import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { Copy, LayoutGrid, Minus, Search, Square, X } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { isMac, formatKeybinding } from "../utils/platform";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { titlebarButtonClass, titlebarToggleClass } from "./shellStyles";

interface TitleBarProps {
  onCommandPaletteOpen?: () => void;
  sidebarVisible?: boolean;
  sidebarPosition?: "left" | "right";
  outputVisible?: boolean;
  secondaryVisible?: boolean;
  onToggleSidebar?: () => void;
  onToggleSidebarPosition?: () => void;
  onToggleOutput?: () => void;
  onToggleSecondary?: () => void;
}

export function TitleBar({
  onCommandPaletteOpen,
  sidebarVisible = true,
  sidebarPosition = "left",
  outputVisible = false,
  secondaryVisible = false,
  onToggleSidebar,
  onToggleSidebarPosition,
  onToggleOutput,
  onToggleSecondary,
}: TitleBarProps) {
  const appWindow = (() => {
    try { return getCurrentWindow(); } catch { return null; }
  })();
  const [maximized, setMaximized] = useState(false);
  const currentProject = useAppStore((s) => s.currentProject);

  useEffect(() => {
    if (!appWindow) return;
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
  const handleMaximize = useCallback(
    () => appWindow?.toggleMaximize(),
    [appWindow],
  );
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

  // macOS uses custom traffic lights so alignment is controlled by the titlebar layout.
  if (isMac) {
    return (
      <div
        className="no-select relative z-chrome flex shrink-0 items-center justify-between border-b border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] pr-3"
        style={{
          height: "var(--titlebar-height)",
          paddingLeft: "var(--macos-traffic-light-space)",
        }}
        onMouseDown={handleTitleBarMouseDown}
      >
        <MacTrafficLightControls
          onClose={handleClose}
          onMinimize={handleMinimize}
          onMaximize={handleMaximize}
        />
        {/* Left: workspace/project breadcrumb */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="flex h-[22px] items-center text-sm font-semibold leading-none tracking-tight text-[rgb(var(--color-text))]">CutReady</span>
          {currentProject && <ProjectSwitcher variant="title" />}
        </div>

        {/* Center: Command palette */}
        <div className="flex-1 flex items-center justify-center min-w-0 px-4">
          <button
            className="flex h-7 w-full max-w-[420px] cursor-pointer items-center gap-2 rounded-md border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/75 px-3 text-[12px] text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-alt))]"
            onClick={onCommandPaletteOpen}
            title={`Command Palette (${formatKeybinding("Ctrl+Shift+P")})`}
          >
            <Search className="w-3.5 h-3.5" />
            <span className="flex-1 text-left truncate">Search commands…</span>
            <kbd className="rounded border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/80 px-1.5 py-px font-[inherit] text-[10px] text-[rgb(var(--color-text-secondary))]">
              {formatKeybinding("Ctrl+Shift+P")}
            </kbd>
          </button>
        </div>

        {/* Right: Panel toggles */}
        <div className="flex items-center gap-0.5">
          <button
            className={titlebarButtonClass}
            onClick={onToggleSidebarPosition}
            title={`Move Sidebar to the ${sidebarPosition === "left" ? "Right" : "Left"}`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-3 bg-[rgb(var(--color-border))] mx-0.5 shrink-0" />
          <button
            className={titlebarToggleClass(sidebarPosition === "left" ? sidebarVisible : secondaryVisible)}
            onClick={sidebarPosition === "left" ? onToggleSidebar : onToggleSecondary}
            title={sidebarPosition === "left" ? formatKeybinding("Toggle Sidebar (Ctrl+B)") : formatKeybinding("Toggle Secondary Panel (Ctrl+Shift+B)")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <button
            className={titlebarToggleClass(outputVisible)}
            onClick={onToggleOutput}
            title={formatKeybinding("Toggle Activity Panel (Ctrl+`)")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="15" x2="21" y2="15" />
            </svg>
          </button>
          <button
            className={titlebarToggleClass(sidebarPosition === "right" ? sidebarVisible : secondaryVisible)}
            onClick={sidebarPosition === "right" ? onToggleSidebar : onToggleSecondary}
            title={sidebarPosition === "right" ? formatKeybinding("Toggle Sidebar (Ctrl+B)") : formatKeybinding("Toggle Secondary Panel (Ctrl+Shift+B)")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  function MacTrafficLightControls({
    onClose,
    onMinimize,
    onMaximize,
  }: {
    onClose: () => void;
    onMinimize: () => void;
    onMaximize: () => void;
  }) {
    const controls = [
      {
        label: "Close",
        color: "var(--macos-traffic-light-close)",
        borderColor: "var(--macos-traffic-light-close-border)",
        glyph: "M4 4l4 4m0-4L4 8",
        action: onClose,
      },
      {
        label: "Minimize",
        color: "var(--macos-traffic-light-minimize)",
        borderColor: "var(--macos-traffic-light-minimize-border)",
        glyph: "M3.5 6h5",
        action: onMinimize,
      },
      {
        label: "Maximize",
        color: "var(--macos-traffic-light-maximize)",
        borderColor: "var(--macos-traffic-light-maximize-border)",
        glyph: "M4 8l4-4M8 4v3H5",
        action: onMaximize,
      },
    ];

    return (
      <div
        className="absolute left-5 top-1/2 flex -translate-y-1/2 items-center gap-2"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {controls.map((control) => (
          <button
            key={control.label}
            type="button"
            aria-label={control.label}
            title={control.label}
            onClick={control.action}
            className="group inline-flex h-3 w-3 items-center justify-center rounded-full border transition-colors"
            style={{
              backgroundColor: control.color,
              borderColor: control.borderColor,
            }}
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 12 12"
              fill="none"
              stroke="rgba(0,0,0,0.55)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            >
              <path d={control.glyph} />
            </svg>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div
      className="no-select fixed left-0 right-0 top-0 z-chrome flex items-center justify-between border-b border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]"
      style={{ height: "var(--titlebar-height)" }}
      onMouseDown={handleTitleBarMouseDown}
    >
      {/* Left side */}
      <div className="flex items-center gap-2 shrink-0 pl-3">
        <svg
          width="18"
          height="18"
          viewBox="0 0 128 128"
          fill="none"
          className="shrink-0"
        >
          <rect x="14" y="52" width="100" height="64" rx="4" fill="#574bb8" />
          <rect
            x="14"
            y="26"
            width="100"
            height="16"
            rx="3"
            fill="#7c6fdb"
            transform="rotate(-14 14 42)"
          />
          <circle cx="14" cy="48" r="5" fill="rgb(var(--color-accent))" />
          <path d="M48 68 L88 84 L48 100Z" fill="rgb(var(--color-accent))" />
        </svg>
        <span
          className="text-sm font-semibold tracking-tight text-[rgb(var(--color-text))]"
        >
          CutReady
        </span>
        {currentProject && <ProjectSwitcher variant="title" />}
      </div>

      {/* Center: Command center */}
      <div className="flex-1 flex items-center justify-center min-w-0 px-4">
        <button
          className="flex h-7 w-full max-w-[420px] cursor-pointer items-center gap-2 rounded-md border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-alt))]/75 px-3 text-[12px] text-[rgb(var(--color-text-secondary))] transition-colors hover:border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-alt))]"
          onClick={onCommandPaletteOpen}
          title={`Command Palette (${formatKeybinding("Ctrl+Shift+P")})`}
        >
          <Search className="w-3.5 h-3.5" />
          <span className="flex-1 text-left truncate">Search commands…</span>
          <kbd className="rounded border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))]/80 px-1.5 py-px font-[inherit] text-[10px] text-[rgb(var(--color-text-secondary))]">
            {formatKeybinding("Ctrl+Shift+P")}
          </kbd>
        </button>
      </div>

      {/* Right: Panel toggles + window controls */}
      <div className="flex items-center h-full shrink-0">
        {/* Panel layout toggles */}
        <div className="flex items-center gap-0.5 px-2">
          {/* Move sidebar to other side — leftmost so it's clearly separate from the layout toggles */}
          <button
            className={titlebarButtonClass}
            onClick={onToggleSidebarPosition}
            title={`Move Sidebar to the ${sidebarPosition === "left" ? "Right" : "Left"}`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-3 bg-[rgb(var(--color-border))] mx-0.5 shrink-0" />
          {/* Left panel (sidebar) */}
          <button
            className={titlebarToggleClass(sidebarPosition === "left" ? sidebarVisible : secondaryVisible)}
            onClick={sidebarPosition === "left" ? onToggleSidebar : onToggleSecondary}
            title={sidebarPosition === "left" ? formatKeybinding("Toggle Sidebar (Ctrl+B)") : formatKeybinding("Toggle Secondary Panel (Ctrl+Shift+B)")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          {/* Bottom panel (output/activity) */}
          <button
            className={titlebarToggleClass(outputVisible)}
            onClick={onToggleOutput}
            title={formatKeybinding("Toggle Activity Panel (Ctrl+`)")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="15" x2="21" y2="15" />
            </svg>
          </button>
          {/* Right panel (secondary/version history) */}
          <button
            className={titlebarToggleClass(sidebarPosition === "right" ? sidebarVisible : secondaryVisible)}
            onClick={sidebarPosition === "right" ? onToggleSidebar : onToggleSecondary}
            title={sidebarPosition === "right" ? formatKeybinding("Toggle Sidebar (Ctrl+B)") : formatKeybinding("Toggle Secondary Panel (Ctrl+Shift+B)")}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
          <div className="w-px h-3 bg-[rgb(var(--color-border))] mx-0.5 shrink-0" />
        </div>

        {/* Window controls — Windows style on the right, hidden on macOS */}
        {!isMac && (
          <WindowsWindowControls
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

function WindowsWindowControls({
  maximized,
  onMinimize,
  onMaximize,
  onClose,
}: {
  maximized: boolean;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="flex h-full items-stretch border-l border-[rgb(var(--color-border-subtle))]"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <WindowsControlButton label="Minimize" onClick={onMinimize}>
        <Minus className="h-4 w-4" aria-hidden="true" />
      </WindowsControlButton>
      <WindowsControlButton label={maximized ? "Restore" : "Maximize"} onClick={onMaximize}>
        {maximized ? (
          <Copy className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Square className="h-4 w-4" aria-hidden="true" />
        )}
      </WindowsControlButton>
      <WindowsControlButton label="Close" onClick={onClose} danger>
        <X className="h-4 w-4" aria-hidden="true" />
      </WindowsControlButton>
    </div>
  );
}

function WindowsControlButton({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={[
        "group/window-control inline-flex h-full w-[46px] items-center justify-center",
        "text-[rgb(var(--color-text-secondary))] transition-[background-color,color,box-shadow] duration-150",
        "hover:text-[rgb(var(--color-text))] active:shadow-[inset_0_0_0_999px_rgb(var(--color-overlay-scrim)/0.04)]",
        danger
          ? "hover:bg-[rgb(var(--color-error))] hover:text-[rgb(var(--color-accent-fg))]"
          : "hover:bg-[rgb(var(--color-surface-alt))]",
      ].join(" ")}
    >
      <span className="grid h-7 w-7 place-items-center opacity-90 transition-opacity group-hover/window-control:opacity-100">
        {children}
      </span>
    </button>
  );
}
