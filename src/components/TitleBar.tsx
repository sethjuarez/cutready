import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useUpdateStore } from "../stores/updateStore";
import { useAppStore } from "../stores/appStore";
import { usePopover } from "../hooks/usePopover";
import { relaunch } from "@tauri-apps/plugin-process";

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
        {/* Update indicator */}
        <UpdateIndicator />
        {/* Layout toggles — icons match spatial positions, actions swap with sidebar position */}
        <div className="flex items-center gap-0.5 px-1.5" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          {/* Feedback button */}
          <FeedbackPopover />
          {/* Separator between feedback and panel toggles */}
          <div className="w-px h-3 bg-[var(--color-border)] mx-0.5 shrink-0" />
          {/* Left panel icon — toggles whichever panel is on the left */}
          <button
            className={`flex items-center justify-center w-6 h-[20px] rounded transition-colors ${
              (sidebarPosition === "left" ? sidebarVisible : secondaryVisible)
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            } hover:bg-[var(--color-surface-alt)]`}
            onClick={sidebarPosition === "left" ? onToggleSidebar : onToggleSecondary}
            title={sidebarPosition === "left" ? "Toggle Sidebar (Ctrl+B)" : "Toggle Secondary Panel"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          {/* Bottom panel icon */}
          <button
            className={`flex items-center justify-center w-6 h-[20px] rounded transition-colors ${
              outputVisible
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            } hover:bg-[var(--color-surface-alt)]`}
            onClick={onToggleOutput}
            title="Toggle Panel (Ctrl+`)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="15" x2="21" y2="15" />
            </svg>
          </button>
          {/* Right panel icon — toggles whichever panel is on the right */}
          <button
            className={`flex items-center justify-center w-6 h-[20px] rounded transition-colors ${
              (sidebarPosition === "right" ? sidebarVisible : secondaryVisible)
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            } hover:bg-[var(--color-surface-alt)]`}
            onClick={sidebarPosition === "right" ? onToggleSidebar : onToggleSecondary}
            title={sidebarPosition === "right" ? "Toggle Sidebar (Ctrl+B)" : "Toggle Secondary Panel"}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
          {/* Layout config dropdown */}
          <LayoutDropdown
            sidebarPosition={sidebarPosition}
            onToggleSidebarPosition={onToggleSidebarPosition}
          />
        </div>

        {/* Separator between layout toggles and window controls */}
        <div className="w-px h-4 bg-[var(--color-border)] mx-1 shrink-0" />

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
  const { state: open, ref, toggle, close } = usePopover();

  return (
    <div ref={ref} className="relative">
      <button
        className={`flex items-center justify-center w-6 h-[20px] rounded transition-colors text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)] ${
          open ? "bg-[var(--color-surface-alt)] text-[var(--color-text)]" : ""
        }`}
        onClick={() => toggle()}
        title="Customize Layout"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                close();
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
                close();
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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
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

function FeedbackPopover() {
  const { state: open, ref, toggle, close } = usePopover();
  const [feedback, setFeedback] = useState("");
  const [category, setCategory] = useState<"general" | "bug" | "feature" | "ux">("general");
  const [includeDebug, setIncludeDebug] = useState(false);
  const [copied, setCopied] = useState(false);

  const categoryLabels: Record<string, { label: string; icon: string }> = {
    general: { label: "General", icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
    bug: { label: "Bug", icon: "M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M17.47 9c1.93-.2 3.53-1.9 3.53-4M12 11h.01" },
    feature: { label: "Feature", icon: "M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" },
    ux: { label: "Design", icon: "M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586M11 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" },
  };

  const handleSubmit = async () => {
    if (!feedback.trim()) return;
    // Snapshot debug log if toggle is on
    let debugLogText: string | undefined;
    if (includeDebug) {
      const entries = useAppStore.getState().debugLog;
      if (entries.length > 0) {
        debugLogText = entries
          .map((e) => `[${e.timestamp.toISOString()}] [${e.level.toUpperCase().padEnd(7)}] [${e.source}] ${e.content}`)
          .join("\n");
      }
    }
    const entry = {
      category: categoryLabels[category].label,
      feedback: feedback.trim(),
      date: new Date().toISOString(),
      ...(debugLogText ? { debug_log: debugLogText } : {}),
    };
    // Always persist to app data directory
    await invoke("save_feedback", { entry }).catch(() => {});
    // Also copy to clipboard
    const text = [
      `## CutReady Feedback`,
      `**Category:** ${entry.category}`,
      `**Date:** ${entry.date.split("T")[0]}`,
      ``,
      entry.feedback,
      ...(debugLogText ? [``, `---`, `### Debug Log`, `\`\`\``, debugLogText, `\`\`\``] : []),
    ].join("\n");
    await navigator.clipboard.writeText(text).catch(() => {});
    setFeedback("");
    setIncludeDebug(false);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      close();
    }, 1200);
  };

  return (
    <div ref={ref} className="relative">
      <button
        className={`flex items-center justify-center w-6 h-[20px] rounded transition-colors ${
          open
            ? "text-[var(--color-accent)] bg-[var(--color-surface-alt)]"
            : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-alt)]"
        }`}
        onClick={() => toggle()}
        title="Send Feedback"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-[100] w-[280px] py-3 px-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg space-y-2.5">
          <div className="text-[10px] font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
            Send Feedback
          </div>

          {/* Category pills */}
          <div className="flex gap-1">
            {(Object.keys(categoryLabels) as Array<keyof typeof categoryLabels>).map((key) => {
              const cat = categoryLabels[key];
              return (
                <button
                  key={key}
                  onClick={() => setCategory(key as typeof category)}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md border transition-colors ${
                    category === key
                      ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)] border-[var(--color-accent)]/30"
                      : "bg-[var(--color-surface-alt)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:text-[var(--color-text)]"
                  }`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={cat.icon} />
                  </svg>
                  {cat.label}
                </button>
              );
            })}
          </div>

          {/* Text */}
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What's on your mind?"
            rows={3}
            className="w-full px-2.5 py-2 rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40 resize-none"
            autoFocus
          />

          {/* Debug toggle + submit on same row */}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 cursor-pointer group">
              <button
                type="button"
                role="switch"
                aria-checked={includeDebug}
                onClick={() => setIncludeDebug(!includeDebug)}
                className={`relative inline-flex h-[14px] w-[26px] shrink-0 rounded-full border transition-colors ${
                  includeDebug
                    ? "bg-[var(--color-accent)] border-[var(--color-accent)]"
                    : "bg-[var(--color-surface-alt)] border-[var(--color-border)]"
                }`}
              >
                <span
                  className={`pointer-events-none block h-[10px] w-[10px] rounded-full bg-white shadow-sm transition-transform mt-[1px] ${
                    includeDebug ? "translate-x-[13px]" : "translate-x-[1px]"
                  }`}
                />
              </button>
              <span className="text-[10px] text-[var(--color-text-secondary)] group-hover:text-[var(--color-text)] transition-colors select-none">
                Include debug log
              </span>
            </label>
            <button
              onClick={handleSubmit}
              disabled={!feedback.trim()}
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                !feedback.trim()
                  ? "text-[var(--color-text-secondary)]/30 cursor-not-allowed"
                  : copied
                    ? "text-emerald-500 bg-emerald-500/15"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-surface-alt)]"
              }`}
              title="Add Feedback"
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

