import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

interface TitleBarProps {
  sidebarVisible?: boolean;
  sidebarPosition?: "left" | "right";
  outputVisible?: boolean;
  secondaryVisible?: boolean;
  onToggleSidebar?: () => void;
  onToggleSidebarPosition?: () => void;
  onToggleOutput?: () => void;
  onToggleSecondary?: () => void;
  onCommandPaletteOpen?: () => void;
}

export function TitleBar({
  sidebarVisible = true,
  sidebarPosition = "left",
  outputVisible = false,
  secondaryVisible = false,
  onToggleSidebar,
  onToggleSidebarPosition,
  onToggleOutput,
  onToggleSecondary,
  onCommandPaletteOpen,
}: TitleBarProps) {
  const appWindow = (() => {
    try { return getCurrentWindow(); } catch { return null; }
  })();
  const [maximized, setMaximized] = useState(false);

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

  return (
    <div
      data-tauri-drag-region
      className="no-select fixed top-0 left-0 right-0 z-50 flex items-center justify-between bg-[var(--color-surface)]/80 backdrop-blur-md border-b border-[var(--color-border)]"
      style={{ height: "var(--titlebar-height)" }}
    >
      {/* Left: App branding */}
      <div data-tauri-drag-region className="flex items-center gap-2 pl-3 shrink-0">
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
          <circle cx="14" cy="48" r="5" fill="var(--color-accent)" />
          <path d="M48 68 L88 84 L48 100Z" fill="var(--color-accent)" />
        </svg>
        <span
          data-tauri-drag-region
          className="text-sm font-semibold tracking-tight"
        >
          CutReady
        </span>
      </div>

      {/* Center: Command center */}
      <div data-tauri-drag-region className="flex-1 flex items-center justify-center min-w-0 px-4">
        <button
          className="flex items-center gap-1.5 w-full max-w-[380px] h-[22px] px-2.5 bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded-md text-[var(--color-text-secondary)] text-[12px] cursor-pointer hover:border-[var(--color-text-secondary)] transition-colors"
          onClick={onCommandPaletteOpen}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title="Command Palette (Ctrl+Shift+P)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <span className="flex-1 text-left truncate">Search commands…</span>
          <kbd className="text-[10px] px-1 py-px rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-secondary)] font-[inherit]">
            Ctrl+Shift+P
          </kbd>
        </button>
      </div>

      {/* Right: Layout toggles + window controls */}
      <div className="flex items-center h-full shrink-0">
        {/* Layout toggles — icon-only, matching Confluo */}
        <div className="flex items-center gap-0.5 px-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {/* Primary sidebar toggle */}
          <button
            className={`flex items-center justify-center w-7 h-[22px] rounded transition-colors ${
              sidebarVisible
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            } hover:bg-[var(--color-surface-alt)]`}
            onClick={onToggleSidebar}
            title="Toggle Sidebar (Ctrl+B)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1={sidebarPosition === "left" ? "9" : "15"} y1="3" x2={sidebarPosition === "left" ? "9" : "15"} y2="21" />
            </svg>
          </button>
          {/* Output panel toggle */}
          <button
            className={`flex items-center justify-center w-7 h-[22px] rounded transition-colors ${
              outputVisible
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            } hover:bg-[var(--color-surface-alt)]`}
            onClick={onToggleOutput}
            title="Toggle Panel (Ctrl+`)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="15" x2="21" y2="15" />
            </svg>
          </button>
          {/* Secondary panel toggle (version history — opposite side of sidebar) */}
          <button
            className={`flex items-center justify-center w-7 h-[22px] rounded transition-colors ${
              secondaryVisible
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            } hover:bg-[var(--color-surface-alt)]`}
            onClick={onToggleSecondary}
            title="Toggle Secondary Panel"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1={sidebarPosition === "left" ? "15" : "9"} y1="3" x2={sidebarPosition === "left" ? "15" : "9"} y2="21" />
            </svg>
          </button>
          {/* Layout config dropdown */}
          <LayoutDropdown
            sidebarPosition={sidebarPosition}
            onToggleSidebarPosition={onToggleSidebarPosition}
          />
        </div>

        {/* Window controls */}
        <button
          onClick={handleMinimize}
          className="inline-flex items-center justify-center w-11 h-full hover:bg-[var(--color-surface-alt)] transition-colors"
          aria-label="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="inline-flex items-center justify-center w-11 h-full hover:bg-[var(--color-surface-alt)] transition-colors"
          aria-label="Maximize"
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="2" y="0" width="8" height="8" rx="0.5" />
              <rect x="0" y="2" width="8" height="8" rx="0.5" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
            </svg>
          )}
        </button>
        <button
          onClick={handleClose}
          className="inline-flex items-center justify-center w-11 h-full hover:bg-red-500 hover:text-white transition-colors"
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function LayoutDropdown({
  sidebarPosition,
  onToggleSidebarPosition,
}: {
  sidebarPosition: "left" | "right";
  onToggleSidebarPosition?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClose = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleClose);
    window.addEventListener("keydown", handleEsc);
    return () => {
      window.removeEventListener("mousedown", handleClose);
      window.removeEventListener("keydown", handleEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        className={`flex items-center justify-center w-7 h-[22px] rounded transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] ${
          open ? "bg-[var(--color-surface-alt)] text-[var(--color-text)]" : ""
        }`}
        onClick={() => setOpen(!open)}
        title="Customize Layout"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-[100] w-[200px] py-2 px-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg">
          <div className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
            Sidebar Position
          </div>
          <div className="flex gap-1">
            <button
              className={`flex-1 flex items-center justify-center gap-1 h-[26px] rounded text-[11px] transition-colors ${
                sidebarPosition === "left"
                  ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)] font-medium"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
              }`}
              onClick={() => {
                if (sidebarPosition !== "left") onToggleSidebarPosition?.();
                setOpen(false);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
              Left
            </button>
            <button
              className={`flex-1 flex items-center justify-center gap-1 h-[26px] rounded text-[11px] transition-colors ${
                sidebarPosition === "right"
                  ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)] font-medium"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-alt)] hover:text-[var(--color-text)]"
              }`}
              onClick={() => {
                if (sidebarPosition !== "right") onToggleSidebarPosition?.();
                setOpen(false);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="15" y1="3" x2="15" y2="21" />
              </svg>
              Right
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

