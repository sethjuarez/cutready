import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { Search, X, Download } from "lucide-react";
import { useUpdateStore } from "../stores/updateStore";
import { useAppStore } from "../stores/appStore";
import { usePopover } from "../hooks/usePopover";
import { relaunch } from "@tauri-apps/plugin-process";

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
  const projectName = useAppStore((s) => s.currentProject?.name);
  const workspaceName = useAppStore((s) => {
    const repoRoot = s.currentProject?.repo_root;
    if (!repoRoot) return null;
    // Extract folder name from path (last segment)
    return repoRoot.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? null;
  });
  const isMultiProject = useAppStore((s) => s.isMultiProject);

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
      className="no-select fixed top-0 left-0 right-0 z-chrome flex items-center justify-between bg-[rgb(var(--color-surface))] border-b border-[rgb(var(--color-border))]"
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
          <circle cx="14" cy="48" r="5" fill="rgb(var(--color-accent))" />
          <path d="M48 68 L88 84 L48 100Z" fill="rgb(var(--color-accent))" />
        </svg>
        <span
          data-tauri-drag-region
          className="text-sm font-semibold tracking-tight"
        >
          CutReady
        </span>
        {workspaceName && (
          <span
            data-tauri-drag-region
            className="text-sm text-[rgb(var(--color-text-secondary))] font-normal ml-1.5"
          >
            / {workspaceName}
            {isMultiProject && projectName && (
              <span className="text-[rgb(var(--color-text-secondary))]/60"> / {projectName}</span>
            )}
          </span>
        )}
      </div>

      {/* Center: Command center */}
      <div data-tauri-drag-region className="flex-1 flex items-center justify-center min-w-0 px-4">
        <button
          className="flex items-center gap-1.5 w-full max-w-[380px] h-[22px] px-2.5 bg-[rgb(var(--color-surface-alt))] border border-[rgb(var(--color-border))] rounded-md text-[rgb(var(--color-text-secondary))] text-[12px] cursor-pointer hover:border-[rgb(var(--color-text-secondary))] transition-colors"
          onClick={onCommandPaletteOpen}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title="Command Palette (Ctrl+Shift+P)"
        >
          <Search className="w-3.5 h-3.5" />
          <span className="flex-1 text-left truncate">Search commands…</span>
          <kbd className="text-[10px] px-1 py-px rounded bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text-secondary))] font-[inherit]">
            Ctrl+Shift+P
          </kbd>
        </button>
      </div>

      {/* Right: Panel toggles + update indicator + window controls */}
      <div className="flex items-center h-full shrink-0">
        {/* Panel layout toggles */}
        <div className="flex items-center gap-0.5 px-2" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {/* Left panel (sidebar) */}
          <button
            className={`flex items-center justify-center w-6 h-5 rounded transition-colors ${
              (sidebarPosition === "left" ? sidebarVisible : secondaryVisible)
                ? "text-[rgb(var(--color-accent))]"
                : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
            } hover:bg-[rgb(var(--color-surface-alt))]`}
            onClick={sidebarPosition === "left" ? onToggleSidebar : onToggleSecondary}
            title={sidebarPosition === "left" ? "Toggle Sidebar (Ctrl+B)" : "Toggle Secondary Panel (Ctrl+Shift+B)"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          {/* Bottom panel (output/activity) */}
          <button
            className={`flex items-center justify-center w-6 h-5 rounded transition-colors ${
              outputVisible
                ? "text-[rgb(var(--color-accent))]"
                : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
            } hover:bg-[rgb(var(--color-surface-alt))]`}
            onClick={onToggleOutput}
            title="Toggle Activity Panel (Ctrl+`)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="15" x2="21" y2="15" />
            </svg>
          </button>
          {/* Right panel (secondary/version history) */}
          <button
            className={`flex items-center justify-center w-6 h-5 rounded transition-colors ${
              (sidebarPosition === "right" ? sidebarVisible : secondaryVisible)
                ? "text-[rgb(var(--color-accent))]"
                : "text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
            } hover:bg-[rgb(var(--color-surface-alt))]`}
            onClick={sidebarPosition === "right" ? onToggleSidebar : onToggleSecondary}
            title={sidebarPosition === "right" ? "Toggle Sidebar (Ctrl+B)" : "Toggle Secondary Panel (Ctrl+Shift+B)"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
          {/* Move sidebar to other side */}
          <button
            className="flex items-center justify-center w-6 h-5 rounded transition-colors text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
            onClick={onToggleSidebarPosition}
            title={`Move Sidebar to the ${sidebarPosition === "left" ? "Right" : "Left"}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1={sidebarPosition === "left" ? "15" : "9"} y1="3" x2={sidebarPosition === "left" ? "15" : "9"} y2="21" />
            </svg>
          </button>
          <div className="w-px h-3 bg-[rgb(var(--color-border))] mx-0.5 shrink-0" />
        </div>

        {/* Update indicator */}
        <UpdateIndicator />

        {/* Window controls */}
        <button
          onClick={handleMinimize}
          className="inline-flex items-center justify-center w-11 h-full hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
          aria-label="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="inline-flex items-center justify-center w-11 h-full hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
          aria-label="Maximize"
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="3.5" y="0.5" width="7" height="7" rx="0.5" />
              <rect x="0.5" y="3.5" width="7" height="7" rx="0.5" fill="rgb(var(--color-surface-toolbar))" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
            </svg>
          )}
        </button>
        <button
          onClick={handleClose}
          className="inline-flex items-center justify-center w-11 h-full hover:bg-error hover:text-white transition-colors"
          aria-label="Close"
        >
          <X className="w-2.5 h-2.5" />
        </button>
      </div>
    </div>
  );
}

function UpdateIndicator() {
  const update = useUpdateStore((s) => s.update);
  const { state: open, ref, toggle } = usePopover();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState("");

  if (!update) return null;

  const handleInstall = async () => {
    setInstalling(true);
    try {
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            setProgress("Downloading...");
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(`${(downloaded / 1024 / 1024).toFixed(1)} MB`);
            break;
          case "Finished":
            setProgress("Installing...");
            break;
        }
      });
      await relaunch();
    } catch {
      setProgress("Failed");
      setInstalling(false);
    }
  };

  return (
    <div
      ref={ref}
      className="relative flex items-center px-1"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        className="relative flex items-center justify-center w-7 h-[22px] rounded text-accent hover:text-accent-hover hover:bg-[rgb(var(--color-surface-alt))] transition-colors"
        onClick={() => toggle()}
        title={`Update available: v${update.version}${update.body ? `\n${update.body.slice(0, 200)}` : ""}`}
      >
        <Download className="w-3.5 h-3.5" />
        {/* Notification dot */}
        <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-accent animate-pulse" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-dropdown w-[240px] py-2.5 px-3 bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-lg shadow-lg">
          <div className="text-[10px] font-medium text-[rgb(var(--color-text-secondary))] uppercase tracking-wider mb-1.5">
            Update Available
          </div>
          <div className="text-xs text-[rgb(var(--color-text))] mb-2">
            <span className="font-semibold">v{update.version}</span>
            {update.body && (
              <p className="mt-1 text-[rgb(var(--color-text-secondary))] line-clamp-3">
                {update.body}
              </p>
            )}
          </div>
          {installing ? (
            <div className="text-[11px] text-accent">{progress}</div>
          ) : (
            <button
              onClick={handleInstall}
              className="w-full h-[26px] rounded text-[11px] font-medium bg-accent hover:bg-accent-hover text-white transition-colors"
            >
              Download &amp; Install
            </button>
          )}
        </div>
      )}
    </div>
  );
}



