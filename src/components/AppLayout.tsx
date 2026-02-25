import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { HomePanel } from "./HomePanel";
import { RecordingPanel } from "./RecordingPanel";
import { ScriptEditorPanel } from "./ScriptEditorPanel";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import { StoryboardPanel } from "./StoryboardPanel";
import { ResizeHandle } from "./ResizeHandle";
import { OutputPanel } from "./OutputPanel";
import type { OutputEntry } from "./OutputPanel";
import { CommandPalette } from "./CommandPalette";
import { TitleBar } from "./TitleBar";
import { commandRegistry, useCommands } from "../services/commandRegistry";

export function AppLayout() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const outputVisible = useAppStore((s) => s.outputVisible);
  const outputHeight = useAppStore((s) => s.outputHeight);
  const setOutputHeight = useAppStore((s) => s.setOutputHeight);
  const toggleOutput = useAppStore((s) => s.toggleOutput);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<OutputEntry[]>([]);

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
    ]);
  }, [setView, toggleSidebar, toggleOutput]);

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
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar, toggleOutput]);

  const handleExecuteCommand = useCallback((commandId: string) => {
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
        outputVisible={outputVisible}
        onToggleSidebar={toggleSidebar}
        onToggleOutput={toggleOutput}
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
          {/* Activity bar (icon sidebar) */}
          <Sidebar />

          {/* Main content area + output panel */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Upper: main content */}
            <div className="flex-1 overflow-hidden">
              {view === "home" && <HomePanel />}
              {view === "sketch" && <StoryboardPanel />}
              {view === "editor" && <ScriptEditorPanel />}
              {view === "recording" && <RecordingPanel />}
              {view === "settings" && <SettingsPanel />}
            </div>

            {/* Lower: output panel */}
            {outputVisible && (
              <>
                <ResizeHandle direction="vertical" onResize={handleOutputResize} />
                <div className="shrink-0 overflow-hidden" style={{ height: outputHeight }}>
                  <OutputPanel
                    outputs={outputs}
                    onClear={() => setOutputs([])}
                    onCollapse={toggleOutput}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commands}
        onExecute={handleExecuteCommand}
        recentCommands={recentCommands}
      />
    </>
  );
}

