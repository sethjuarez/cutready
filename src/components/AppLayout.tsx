import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { useToastStore } from "../stores/toastStore";
import { useSettings } from "../hooks/useSettings";
import { HomePanel } from "./HomePanel";
import { RecordingPanel } from "./RecordingPanel";
import { ScriptEditorPanel } from "./ScriptEditorPanel";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import { StoryboardPanel } from "./StoryboardPanel";
import { StoryboardList } from "./StoryboardList";
import { ResizeHandle } from "./ResizeHandle";
import { OutputPanel } from "./OutputPanel";
import { CommandPalette } from "./CommandPalette";
import { TitleBar } from "./TitleBar";
import { SnapshotDialog } from "./SnapshotDialog";
import { MergeConflictPanel } from "./MergeConflictPanel";
import { commandRegistry, useCommands } from "../services/commandRegistry";

export function AppLayout() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleSidebarPosition = useAppStore((s) => s.toggleSidebarPosition);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const outputVisible = useAppStore((s) => s.outputVisible);
  const outputHeight = useAppStore((s) => s.outputHeight);
  const setOutputHeight = useAppStore((s) => s.setOutputHeight);
  const toggleOutput = useAppStore((s) => s.toggleOutput);
  const showVersionHistory = useAppStore((s) => s.showVersionHistory);
  const toggleVersionHistory = useAppStore((s) => s.toggleVersionHistory);
  const isMerging = useAppStore((s) => s.isMerging);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);

  const commands = useCommands();
  const mainRef = useRef<HTMLDivElement>(null);

  // Register built-in commands
  useEffect(() => {
    return commandRegistry.registerMany([
      {
        id: "view.commandPalette",
        title: "Command Palette",
        category: "View",
        keybinding: "Ctrl+Shift+P",
        handler: () => setCommandPaletteOpen(true),
      },
      {
        id: "view.toggleSidebar",
        title: "Toggle Sidebar",
        category: "View",
        keybinding: "Ctrl+B",
        handler: () => toggleSidebar(),
      },
      {
        id: "view.toggleOutput",
        title: "Toggle Output Panel",
        category: "View",
        keybinding: "Ctrl+`",
        handler: () => toggleOutput(),
      },
      {
        id: "view.toggleSidebarPosition",
        title: "Move Sidebar to Other Side",
        category: "View",
        handler: () => toggleSidebarPosition(),
      },
      {
        id: "nav.home",
        title: "Go to Home",
        category: "Navigate",
        handler: () => setView("home"),
      },
      {
        id: "nav.sketch",
        title: "Go to Sketch Editor",
        category: "Navigate",
        handler: () => setView("sketch"),
      },
      {
        id: "nav.editor",
        title: "Go to Script Editor",
        category: "Navigate",
        handler: () => setView("editor"),
      },
      {
        id: "nav.recording",
        title: "Go to Recording",
        category: "Navigate",
        handler: () => setView("recording"),
      },
      {
        id: "nav.settings",
        title: "Go to Settings",
        category: "Navigate",
        handler: () => setView("settings"),
      },
      {
        id: "debug.exportLogs",
        title: "Export Logs",
        category: "Debug",
        handler: async () => {
          try {
            const { save } = await import("@tauri-apps/plugin-dialog");
            const { invoke } = await import("@tauri-apps/api/core");
            const dest = await save({
              defaultPath: `cutready-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
              filters: [{ name: "Zip Archive", extensions: ["zip"] }],
            });
            if (!dest) return;
            // Collect frontend debug log
            const debugEntries = useAppStore.getState().debugLog;
            const debugText = debugEntries.length > 0
              ? debugEntries.map(
                  (e) => `[${e.timestamp.toISOString()}] [${e.level.toUpperCase().padEnd(7)}] [${e.source}] ${e.content}`
                ).join("\n")
              : null;
            await invoke("export_logs", { dest, debugLog: debugText });
            useToastStore.getState().show("Logs exported", 3000);
          } catch (err) {
            console.error("Export logs failed:", err);
            useToastStore.getState().show(`Export failed: ${err}`, 5000);
          }
        },
      },
    ]);
  }, [setView, toggleSidebar, toggleSidebarPosition, toggleOutput]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        toggleOutput();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        const { currentProject, promptSnapshot } = useAppStore.getState();
        if (currentProject) {
          promptSnapshot();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar, toggleOutput]);

  // Apply display settings as CSS variables
  const { settings: displaySettings } = useSettings();
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--editor-font-size", `${displaySettings.displayFontSize}px`);
    root.style.setProperty("--chat-font-size", `${displaySettings.displayChatFontSize}px`);
    const densityMap: Record<string, { padding: string; lineHeight: string }> = {
      compact: { padding: "0.25rem 0.5rem", lineHeight: "1.4" },
      comfortable: { padding: "0.5rem 0.75rem", lineHeight: "1.5" },
      spacious: { padding: "0.75rem 1rem", lineHeight: "1.75" },
    };
    const density = densityMap[displaySettings.displayRowDensity] ?? densityMap.comfortable;
    root.style.setProperty("--row-padding", density.padding);
    root.style.setProperty("--row-line-height", density.lineHeight);
    root.style.setProperty("--row-color-palette", displaySettings.displayRowColors);
    root.style.setProperty("--editor-max-width", displaySettings.displayEditorWidth === "full" ? "100%" : "56rem");
    const fontMap: Record<string, string> = {
      system: '"Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      sans: '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif',
      serif: '"Lora", "Georgia", "Times New Roman", serif',
      mono: '"Geist Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
    };
    root.style.setProperty("--app-font-family", fontMap[displaySettings.displayFontFamily] ?? fontMap.system);
  }, [displaySettings]);

  const handleExecuteCommand= useCallback((commandId: string) => {
    commandRegistry.execute(commandId);
    setRecentCommands((prev) => [
      commandId,
      ...prev.filter((id) => id !== commandId).slice(0, 9),
    ]);
  }, []);

  const handleOutputResize = useCallback(
    (delta: number) => setOutputHeight(outputHeight - delta),
    [outputHeight, setOutputHeight],
  );

  return (
    <>
      <TitleBar
        sidebarVisible={sidebarVisible}
        sidebarPosition={sidebarPosition}
        outputVisible={outputVisible}
        secondaryVisible={showVersionHistory}
        onToggleSidebar={toggleSidebar}
        onToggleSidebarPosition={toggleSidebarPosition}
        onToggleOutput={toggleOutput}
        onToggleSecondary={toggleVersionHistory}
        onCommandPaletteOpen={() => setCommandPaletteOpen(true)}
      />
      <div
        className="flex flex-col w-full"
        style={{
          paddingTop: "var(--titlebar-height)",
          paddingBottom: "var(--statusbar-height)",
          height: "100vh",
        }}
      >
        <div className="flex flex-1 overflow-hidden" ref={mainRef}>
          {/* Activity bar on left (hidden on home) */}
          {view !== "home" && sidebarPosition === "left" && <Sidebar />}

          {/* Primary sidebar (hidden on home, global settings, workspace settings) */}
          {view !== "home" && view !== "settings" && view !== "workspace" && sidebarVisible && sidebarPosition === "left" && <PrimarySidebar />}

          {/* Center column: content + output panel */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Upper: main content */}
            <div className="flex-1 min-h-0">
              {view === "home" && <div className="h-full overflow-y-auto"><HomePanel /></div>}
              {view === "sketch" && (isMerging ? <MergeConflictPanel /> : <StoryboardPanel />)}
              {view === "editor" && <div className="h-full overflow-y-auto"><ScriptEditorPanel /></div>}
              {view === "recording" && <div className="h-full overflow-y-auto"><RecordingPanel /></div>}
              {view === "settings" && <div className="h-full overflow-y-auto"><SettingsPanel mode="global" /></div>}
              {view === "workspace" && <div className="h-full overflow-y-auto"><SettingsPanel mode="workspace" /></div>}
            </div>

            {/* Lower: output panel (hidden on home and settings views) */}
            {view !== "home" && view !== "settings" && view !== "workspace" && outputVisible && (
              <>
                <ResizeHandle direction="vertical" onResize={handleOutputResize} />
                <div className="shrink-0 overflow-hidden" style={{ height: outputHeight }}>
                  <OutputPanel
                    onCollapse={toggleOutput}
                  />
                </div>
              </>
            )}
          </div>

          {/* Primary sidebar on right (hidden on home and settings views) */}
          {view !== "home" && view !== "settings" && view !== "workspace" && sidebarVisible && sidebarPosition === "right" && <PrimarySidebar />}

          {/* Activity bar on right (hidden on home) */}
          {view !== "home" && sidebarPosition === "right" && <Sidebar />}
        </div>
      </div>

      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commands}
        onExecute={handleExecuteCommand}
        recentCommands={recentCommands}
      />

      <SnapshotDialog />
    </>
  );
}

/** Primary sidebar (StoryboardList) with resize handle. Rendered full-height. */
function PrimarySidebar() {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);

  const handleResize = useCallback(
    (delta: number) => {
      const adjusted = sidebarPosition === "right" ? -delta : delta;
      setSidebarWidth(sidebarWidth + adjusted);
    },
    [sidebarWidth, setSidebarWidth, sidebarPosition],
  );

  return (
    <>
      {sidebarPosition === "right" && <ResizeHandle direction="horizontal" onResize={handleResize} />}
      <div className="h-full shrink-0" style={{ width: sidebarWidth }}>
        <StoryboardList />
      </div>
      {sidebarPosition === "left" && <ResizeHandle direction="horizontal" onResize={handleResize} />}
    </>
  );
}

