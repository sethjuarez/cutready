import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { MagnifyingGlassIcon, XMarkIcon, ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import { useUpdateStore } from "../stores/updateStore";
import { useAppStore } from "../stores/appStore";
import { usePopover } from "../hooks/usePopover";
import { relaunch } from "@tauri-apps/plugin-process";

interface TitleBarProps {
  onCommandPaletteOpen?: () => void;
}

export function TitleBar({
  onCommandPaletteOpen,
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
      className="no-select fixed top-0 left-0 right-0 z-50 flex items-center justify-between bg-[var(--color-surface)] border-b border-[var(--color-border)]"
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
        {workspaceName && (
          <span
            data-tauri-drag-region
            className="text-sm text-[var(--color-text-secondary)] font-normal ml-1.5"
          >
            / {workspaceName}
            {isMultiProject && projectName && (
              <span className="text-[var(--color-text-secondary)]/60"> / {projectName}</span>
            )}
          </span>
        )}
      </div>

      {/* Center: Command center */}
      <div data-tauri-drag-region className="flex-1 flex items-center justify-center min-w-0 px-4">
        <button
          className="flex items-center gap-1.5 w-full max-w-[380px] h-[22px] px-2.5 bg-[var(--color-surface-alt)] border border-[var(--color-border)] rounded-md text-[var(--color-text-secondary)] text-[12px] cursor-pointer hover:border-[var(--color-text-secondary)] transition-colors"
          onClick={onCommandPaletteOpen}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title="Command Palette (Ctrl+Shift+P)"
        >
          <MagnifyingGlassIcon className="w-3.5 h-3.5" />
          <span className="flex-1 text-left truncate">Search commands…</span>
          <kbd className="text-[10px] px-1 py-px rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-secondary)] font-[inherit]">
            Ctrl+Shift+P
          </kbd>
        </button>
      </div>

      {/* Right: Update indicator + window controls */}
      <div className="flex items-center h-full shrink-0">
        {/* Update indicator */}
        <UpdateIndicator />

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
            <svg width="10" height="10" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="3.5" y="0.5" width="7" height="7" rx="0.5" />
              <rect x="0.5" y="3.5" width="7" height="7" rx="0.5" fill="var(--color-surface-toolbar)" />
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
          <XMarkIcon className="w-2.5 h-2.5" />
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
        className="relative flex items-center justify-center w-7 h-[22px] rounded text-indigo-400 hover:text-indigo-300 hover:bg-[var(--color-surface-alt)] transition-colors"
        onClick={() => toggle()}
        title={`Update available: v${update.version}${update.body ? `\n${update.body.slice(0, 200)}` : ""}`}
      >
        <ArrowDownTrayIcon className="w-3.5 h-3.5" />
        {/* Notification dot */}
        <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-[100] w-[240px] py-2.5 px-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg">
          <div className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider mb-1.5">
            Update Available
          </div>
          <div className="text-xs text-[var(--color-text)] mb-2">
            <span className="font-semibold">v{update.version}</span>
            {update.body && (
              <p className="mt-1 text-[var(--color-text-secondary)] line-clamp-3">
                {update.body}
              </p>
            )}
          </div>
          {installing ? (
            <div className="text-[11px] text-indigo-400">{progress}</div>
          ) : (
            <button
              onClick={handleInstall}
              className="w-full h-[26px] rounded text-[11px] font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            >
              Download &amp; Install
            </button>
          )}
        </div>
      )}
    </div>
  );
}



