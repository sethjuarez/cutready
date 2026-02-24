import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";

export function TitleBar() {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
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

  const handleMinimize = useCallback(() => appWindow.minimize(), [appWindow]);
  const handleMaximize = useCallback(
    () => appWindow.toggleMaximize(),
    [appWindow],
  );
  const handleClose = useCallback(() => appWindow.close(), [appWindow]);

  return (
    <div
      data-tauri-drag-region
      className="no-select fixed top-0 left-0 right-0 z-50 flex items-center justify-between bg-[var(--color-surface)]/80 backdrop-blur-md border-b border-[var(--color-border)]"
      style={{ height: "var(--titlebar-height)" }}
    >
      {/* Left: App branding */}
      <div data-tauri-drag-region className="flex items-center gap-2 pl-3">
        <svg
          width="18"
          height="18"
          viewBox="0 0 128 128"
          fill="none"
          className="shrink-0"
        >
          {/* Board */}
          <rect x="14" y="52" width="100" height="64" rx="4" fill="#574bb8" />
          {/* Arm hinged at left, rotated open */}
          <rect
            x="14"
            y="26"
            width="100"
            height="16"
            rx="3"
            fill="#7c6fdb"
            transform="rotate(-14 14 42)"
          />
          {/* Hinge dot */}
          <circle cx="14" cy="48" r="5" fill="var(--color-accent)" />
          {/* Play */}
          <path d="M48 68 L88 84 L48 100Z" fill="var(--color-accent)" />
        </svg>
        <span
          data-tauri-drag-region
          className="text-sm font-semibold tracking-tight"
        >
          CutReady
        </span>
      </div>

      {/* Right: Window controls */}
      <div className="flex items-center h-full">
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
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            >
              <rect x="2" y="0" width="8" height="8" rx="0.5" />
              <rect x="0" y="2" width="8" height="8" rx="0.5" />
            </svg>
          ) : (
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            >
              <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
            </svg>
          )}
        </button>
        <button
          onClick={handleClose}
          className="inline-flex items-center justify-center w-11 h-full hover:bg-red-500 hover:text-white transition-colors"
          aria-label="Close"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          >
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      </div>
    </div>
  );
}

