import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore, type AppView } from "../stores/appStore";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../stores/sidebarLayout";
import { useChatStore } from "../stores/chatStore";
import { useVersioningStore } from "../stores/versioningStore";
import { useToastStore } from "../stores/toastStore";
import { useSettings } from "../hooks/useSettings";
import { useContributorIdentity } from "../hooks/useContributorIdentity";
import { HomePanel } from "./HomePanel";
import { RecordingPanel } from "./RecordingPanel";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import { useExitChatFocusOnNavigate } from "../hooks/useExitChatFocusOnNavigate";
import { panelOwner } from "../utils/navigation";
import { StoryboardPanel } from "./StoryboardPanel";
import { CompanionPane } from "./CompanionPane";
import { StoryboardList } from "./StoryboardList";
import { AssetList } from "./AssetList";
import { NarrationList } from "./NarrationList";
import { ResizeHandle } from "./ResizeHandle";
import { OutputPanel } from "./OutputPanel";
import { CommandPalette } from "./CommandPalette";
import { TitleBar } from "./TitleBar";
import { SnapshotDialog } from "./SnapshotDialog";
import { SendForReviewDialog } from "./SendForReviewDialog";
import { AiApplyGateDialog } from "./AiApplyGateDialog";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { MergeConflictPanel } from "./MergeConflictPanel";
import { ChatPanel } from "./ChatPanel";
import { ChangesPanel } from "./ChangesPanel";
import { FeedbackDialog } from "./FeedbackDialog";
import { ProjectHealthBanner } from "./ProjectHealthBanner";
import { AdoptFolderDialog } from "./AdoptFolderDialog";
import { MoveProjectFolderDialog } from "./MoveProjectFolderDialog";
import { commandRegistry, useCommands } from "../services/commandRegistry";
import { invoke } from "../services/tauri";
import { useTheme } from "../hooks/useTheme";
import { isMac } from "../utils/platform";
import { useApplyDisplaySettings } from "../hooks/useApplyDisplaySettings";
import { useApplyAccessibility } from "../accessibility/useApplyAccessibility";
import { shortcutsEnabled } from "../stores/accessibilityStore";
import {
  House,
  Layers,
  Clapperboard,
  Mic2,
  Settings,
  Search,
  Columns2,
  MessageSquare,
  MessageSquareMore,
  Sun,
  Download,
  Terminal,
  Bookmark,
  AlertCircle,
  UserRound,
  X,
  FolderInput,
} from "lucide-react";

const REQUESTED_SETTINGS_TAB_KEY = "cutready:requested-settings-tab";
const PROFILE_NUDGE_DISMISSED_KEY = "cutready:profile-nudge-dismissed-v1";
const PROFILE_NUDGE_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

export function AppLayout() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const outputVisible = useAppStore((s) => s.outputVisible);
  const outputHeight = useAppStore((s) => s.outputHeight);
  const setOutputHeight = useAppStore((s) => s.setOutputHeight);
  const toggleOutput = useAppStore((s) => s.toggleOutput);
  const showOutputTab = useAppStore((s) => s.showOutputTab);
  const toggleSecondaryPanel = useAppStore((s) => s.toggleSecondaryPanel);
  const setSecondaryPanelVisible = useAppStore((s) => s.setSecondaryPanelVisible);
  const showSecondaryPanel = useAppStore((s) => s.showSecondaryPanel);
  const chatFocusMode = useChatStore((s) => s.chatFocusMode);
  const setChatFocusMode = useChatStore((s) => s.setChatFocusMode);
  const isMerging = useVersioningStore((s) => s.isMerging);
  const projectSwitching = useAppStore((s) => s.projectSwitching);
  const currentProject = useAppStore((s) => s.currentProject);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const [settingsBackgroundView, setSettingsBackgroundView] = useState<AppView>("home");
  const [chatTogglePhase, setChatTogglePhase] = useState<"hidden" | "side" | "focus" | "after-focus">("hidden");

  const { theme: resolvedTheme, toggle: toggleTheme } = useTheme();
  const commands = useCommands();
  const mainRef = useRef<HTMLDivElement>(null);
  useExitChatFocusOnNavigate();
  const lastWorkspaceViewRef = useRef<AppView>("project");

  useEffect(() => {
    if (view !== "settings") {
      setSettingsBackgroundView(view);
    }
  }, [view]);

  useEffect(() => {
    if (view === "project" || view === "assets" || view === "narrations" || view === "changes") {
      lastWorkspaceViewRef.current = view;
    }
  }, [view]);

  useEffect(() => {
    if (!chatFocusMode && !showSecondaryPanel && view !== "chat") {
      setChatTogglePhase("hidden");
    }
  }, [chatFocusMode, showSecondaryPanel, view]);

  const toggleChatSurface = useCallback(() => {
    const restoreWorkspaceView = () => {
      if (view === "chat") {
        setView(currentProject ? lastWorkspaceViewRef.current : "home");
      }
    };

    if (chatFocusMode || view === "chat") {
      setChatFocusMode(false);
      restoreWorkspaceView();
      if (currentProject && !showSecondaryPanel) {
        setSecondaryPanelVisible(true);
      }
      setChatTogglePhase("after-focus");
      return;
    }

    if (showSecondaryPanel) {
      if (chatTogglePhase === "after-focus") {
        setSecondaryPanelVisible(false);
        setChatTogglePhase("hidden");
        return;
      }
      setChatFocusMode(true);
      setChatTogglePhase("focus");
      return;
    }

    if (currentProject && view === "home") {
      setView(lastWorkspaceViewRef.current);
    }
    if (currentProject) {
      setSecondaryPanelVisible(true);
      setChatTogglePhase("side");
      return;
    }

    setView("chat");
    setChatTogglePhase("focus");
  }, [chatFocusMode, chatTogglePhase, currentProject, setChatFocusMode, setSecondaryPanelVisible, setView, showSecondaryPanel, view]);

  // Register built-in commands
  useEffect(() => {
    return commandRegistry.registerMany([
      {
        id: "view.commandPalette",
        title: "Command Palette",
        category: "View",
        keybinding: "Ctrl+Shift+P",
        icon: <Search className="w-4 h-4" />,
        handler: () => setCommandPaletteOpen(true),
      },
      {
        id: "view.toggleSidebar",
        title: "Toggle Sidebar",
        category: "View",
        keybinding: "Ctrl+B",
        icon: <Columns2 className="w-4 h-4" />,
        handler: () => toggleSidebar(),
      },
      {
        id: "view.toggleOutput",
        title: "Toggle Output Panel",
        category: "View",
        keybinding: "Ctrl+`",
        icon: <Terminal className="w-4 h-4" />,
        handler: () => toggleOutput(),
      },
      {
        id: "terminal.openWorkspace",
        title: "Open Workspace Terminal",
        category: "View",
        icon: <Terminal className="w-4 h-4" />,
        handler: () => {
          const { currentProject } = useAppStore.getState();
          if (currentProject) setView("project");
          showOutputTab("terminal");
        },
      },
      {
        id: "view.toggleSecondary",
        title: "Toggle Secondary Panel",
        category: "View",
        keybinding: "Ctrl+Shift+B",
        icon: <Columns2 className="w-4 h-4" />,
        handler: () => toggleSecondaryPanel(),
      },
      {
        id: "nav.chat",
        title: "Open Chat",
        category: "Navigate",
        keybinding: "Ctrl+Shift+C",
        icon: <MessageSquareMore className="w-4 h-4" />,
        handler: () => toggleChatSurface(),
      },
      {
        id: "view.sendFeedback",
        title: "Send Feedback",
        category: "View",
        icon: <MessageSquare className="w-4 h-4" />,
        handler: async () => {
          setFeedbackOpen(true);
        },
      },
      {
        id: "nav.home",
        title: "Go to Home",
        category: "Navigate",
        icon: <House className="w-4 h-4" />,
        handler: () => setView("home"),
      },
      {
        id: "nav.sketch",
        title: "Go to Documents",
        category: "Navigate",
        icon: <Layers className="w-4 h-4" />,
        handler: () => setView("project"),
      },
      {
        id: "nav.assets",
        title: "Go to Visuals",
        category: "Navigate",
        icon: <Clapperboard className="w-4 h-4" />,
        handler: () => setView("assets"),
      },
      {
        id: "nav.narrations",
        title: "Go to Narrations",
        category: "Navigate",
        icon: <Mic2 className="w-4 h-4" />,
        handler: () => setView("narrations"),
      },
      {
        id: "nav.settings",
        title: "Go to Settings",
        category: "Navigate",
        icon: <Settings className="w-4 h-4" />,
        handler: () => setView("settings"),
      },
      {
        id: "snapshot.quickSave",
        title: "Save Snapshot",
        category: "Snapshot",
        keybinding: "Ctrl+S",
        icon: <Bookmark className="w-4 h-4" />,
        handler: () => {
          const { currentProject } = useAppStore.getState();
          if (currentProject) useVersioningStore.getState().promptSnapshot();
        },
      },
      {
        id: "project.moveFolder",
        title: "Move Project Folder…",
        category: "Project",
        icon: <FolderInput className="w-4 h-4" />,
        handler: () => {
          const { currentProject, setMoveFolderDialogOpen } = useAppStore.getState();
          if (currentProject) setMoveFolderDialogOpen(true);
        },
      },
      {
        id: "help.keyboardShortcuts",
        title: "Keyboard Shortcuts",
        category: "Help",
        keybinding: "Ctrl+/",
        handler: () => setShortcutsOpen(true),
      },
      {
        id: "view.toggleTheme",
        title: "Toggle Theme (Light/Dark)",
        category: "View",
        keybinding: "Ctrl+Shift+T",
        icon: <Sun className="w-4 h-4" />,
        handler: () => toggleTheme(),
      },
      {
        id: "debug.exportLogs",
        title: "Export Logs",
        category: "Debug",
        icon: <Download className="w-4 h-4" />,
        handler: async () => {
          try {
            const { save } = await import("../dialogs");
            const dest = await save({
              defaultPath: `cutready-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
              filters: [{ name: "Zip Archive", extensions: ["zip"] }],
            });
            if (!dest) return;
            const debugLog = await invoke<unknown>("get_auditaur_diagnostics")
              .then((diagnostics) => JSON.stringify(diagnostics, null, 2))
              .catch((error) => JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }, null, 2));
            await invoke("export_logs", { dest, debugLog });
            useToastStore.getState().show("Logs exported", 3000);
          } catch (err) {
            console.error("Export logs failed:", err);
            useToastStore.getState().show(`Export failed: ${err}`, 5000, "error");
          }
        },
      },
    ]);
  }, [setView, showOutputTab, toggleChatSurface, toggleSidebar, toggleOutput, toggleSecondaryPanel, toggleTheme]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Use metaKey on macOS, ctrlKey on Windows/Linux
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape" && chatFocusMode) {
        const target = e.target as HTMLElement | null;
        const interactiveTarget =
          target?.closest("textarea, input, select, [contenteditable='true']");

        if (interactiveTarget) return;

        e.preventDefault();
        setChatFocusMode(false);
        return;
      }

      if (!shortcutsEnabled()) return;

      // Mod+Shift+P toggles the command palette even while it is open
      if (mod && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
        return;
      }
      // Skip all other shortcuts when command palette is open
      if (commandPaletteOpen) return;

      if (mod && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((prev) => !prev);
        return;
      }
      if (mod && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        toggleTheme();
        return;
      }
      if (mod && e.shiftKey && (e.key === "B" || e.key === "b")) {
        e.preventDefault();
        toggleSecondaryPanel();
        return;
      }
      if (mod && e.shiftKey && (e.key === "C" || e.key === "c")) {
        e.preventDefault();
        toggleChatSurface();
        return;
      }
      if (mod && e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
      if (mod && e.key === "`") {
        e.preventDefault();
        toggleOutput();
      }
      if (mod && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        const { currentProject } = useAppStore.getState();
        if (currentProject) {
          useVersioningStore.getState().promptSnapshot();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    chatFocusMode,
    commandPaletteOpen,
    setChatFocusMode,
    toggleChatSurface,
    toggleOutput,
    toggleSecondaryPanel,
    toggleSidebar,
    toggleTheme,
  ]);

  useApplyAccessibility();

  // Apply display settings as CSS variables
  const { settings: displaySettings, loaded: displaySettingsLoaded } = useSettings();
  useApplyDisplaySettings(displaySettings, displaySettingsLoaded, resolvedTheme);

  // Redirect away from recording view if feature flag is off
  useEffect(() => {
    if (displaySettingsLoaded && view === "recording" && !displaySettings.featureRecording) {
      setView("home");
    }
  }, [displaySettingsLoaded, displaySettings.featureRecording, view, setView]);

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
  const contentView = view === "settings" ? settingsBackgroundView : view;
  const openProfileSettings = useCallback(() => {
    localStorage.setItem(REQUESTED_SETTINGS_TAB_KEY, "profile");
    setSettingsBackgroundView(contentView);
    setView("settings");
  }, [contentView, setView]);
  const outputPanelAvailable = contentView !== "home" && contentView !== "chat" && !projectSwitching;
  const outputPanelVisible = outputPanelAvailable && outputVisible;
  const documentView = !projectSwitching && (contentView === "project" || contentView === "assets" || contentView === "narrations" || contentView === "changes");
  const companionVisible = documentView && !isMerging && showSecondaryPanel;

  return (
    <div className="cr-mica flex flex-col h-full">
      <TitleBar
        onCommandPaletteOpen={() => setCommandPaletteOpen(true)}
        sidebarVisible={sidebarVisible}
        outputVisible={outputVisible}
        secondaryVisible={showSecondaryPanel}
        onToggleSidebar={toggleSidebar}
        onToggleOutput={toggleOutput}
        onToggleSecondary={toggleSecondaryPanel}
      />
      <div
        data-testid="app-content-shell"
        className="flex flex-col w-full flex-1 min-h-0"
        style={{
          paddingTop: isMac ? undefined : "var(--titlebar-height)",
          paddingBottom: "var(--statusbar-height)",
        }}
      >
        <div className="flex flex-1 overflow-hidden" ref={mainRef}>
          {/* Navigation pane: labelled tree with the active panel, or an icon rail */}
          <NavPane
            contentView={contentView}
            showPanel={!projectSwitching}
            onFeedback={() => setFeedbackOpen(true)}
            onProfile={openProfileSettings}
            onChatToggle={toggleChatSurface}
            chatActive={chatFocusMode || companionVisible || view === "chat"}
          />

          {/* Editor layer: content + output panel, raised over the base surface */}
          <div
            data-testid="editor-layer"
            className={`flex flex-1 flex-col min-w-0 overflow-hidden border-t border-l border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] shadow-layer ${
              companionVisible ? "rounded-t-card border-r" : "rounded-tl-card"
            }`}
          >
            {contentView !== "home" && !projectSwitching && <ProjectHealthBanner />}
            <AdoptFolderDialog />
            <MoveProjectFolderDialog />
            {/* Upper: main content */}
            <div className="relative flex-1 min-h-0">
              {contentView === "home" && <div className="h-full overflow-y-auto"><HomePanel /></div>}
              {projectSwitching && <ProjectSwitchingState />}
              {documentView && (isMerging ? <MergeConflictPanel /> : <StoryboardPanel />)}
              {!projectSwitching && contentView === "recording" && displaySettings.featureRecording && <div className="h-full overflow-y-auto"><RecordingPanel /></div>}
              {contentView === "chat" && <div className="h-full overflow-hidden"><ChatPanel /></div>}
            </div>

            {/* Lower: output panel. Keep it mounted so terminal sessions survive navigation. */}
            {outputPanelAvailable && outputVisible && (
              <ResizeHandle direction="vertical" onResize={handleOutputResize} />
            )}
            <div
              className={outputPanelVisible ? "shrink-0 overflow-hidden" : "h-0 shrink-0 overflow-hidden"}
              style={{ height: outputPanelVisible ? outputHeight : 0 }}
              aria-hidden={!outputPanelVisible}
            >
              <OutputPanel
                onCollapse={toggleOutput}
              />
            </div>
          </div>

          {companionVisible && <CompanionPane />}
        </div>
      </div>

      {view === "settings" && (
        <div className="fixed inset-0 z-modal">
          <SettingsPanel onClose={() => setView(settingsBackgroundView)} />
        </div>
      )}

      <ProfileSetupNudge
        visible={view !== "settings"}
        onOpenProfile={openProfileSettings}
      />

      {chatFocusMode && (
        <div
          data-testid="chat-focus-shell"
          className="fixed left-0 right-0 z-20 overflow-hidden border-y border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-inset))] shadow-2xl"
          style={{
            top: "var(--titlebar-height)",
            bottom: "var(--statusbar-height)",
            left: sidebarVisible ? sidebarWidth : 0,
            right: 0,
          }}
          role="dialog"
          aria-label="Chat focus mode"
          aria-modal="true"
        >
          <ChatPanel focusMode />
        </div>
      )}

      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commands}
        onExecute={handleExecuteCommand}
        recentCommands={recentCommands}
      />
      <SnapshotDialog />
      <SendForReviewDialog />
      <AiApplyGateDialog />
      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <FeedbackDialog isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  );
}

function ProfileSetupNudge({
  visible,
  onOpenProfile,
}: {
  visible: boolean;
  onOpenProfile: () => void;
}) {
  const { identity, error } = useContributorIdentity(visible);
  const [dismissed, setDismissed] = useState(() => isProfileNudgeDismissed());
  const dismiss = useCallback(() => {
    localStorage.setItem(PROFILE_NUDGE_DISMISSED_KEY, Date.now().toString());
    setDismissed(true);
  }, []);

  if (!visible || dismissed || error || !identity?.needs_setup) return null;

  return (
    <div
      className="fixed left-1/2 z-dropdown w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-[rgb(var(--color-accent))]/25 bg-[rgb(var(--color-surface))]/95 p-3 shadow-xl shadow-[rgb(var(--color-overlay-scrim))]/10 backdrop-blur-md"
      style={{ top: "calc(var(--titlebar-height) + 0.75rem)" }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--color-accent))]/10 text-[rgb(var(--color-accent))]">
          <UserRound className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-[rgb(var(--color-text))]">
            <AlertCircle className="h-3.5 w-3.5 text-[rgb(var(--color-accent))]" />
            Set your profile
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
            Add your name and email so snapshots, generated docs, and saved chats are attributed correctly.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={onOpenProfile}
              className="rounded-lg bg-[rgb(var(--color-accent))] px-3 py-1.5 text-xs font-medium text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))]"
            >
              Set profile
            </button>
            <button
              onClick={dismiss}
              className="rounded-lg px-2.5 py-1.5 text-xs text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
            >
              Not now
            </button>
          </div>
        </div>
        <button
          onClick={dismiss}
          className="rounded-lg p-1 text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))]"
          aria-label="Dismiss profile reminder"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function isProfileNudgeDismissed() {
  const dismissedAt = Number(localStorage.getItem(PROFILE_NUDGE_DISMISSED_KEY));
  return Number.isFinite(dismissedAt) && Date.now() - dismissedAt < PROFILE_NUDGE_DISMISS_MS;
}

function ProjectSwitchingState() {
  return (
    <div className="flex h-full items-center justify-center bg-[rgb(var(--color-surface))] px-6 text-center">
      <div className="max-w-sm border-l border-[rgb(var(--color-border))] pl-4 text-left">
        <p className="text-sm font-medium text-[rgb(var(--color-text))]">Switching project</p>
        <p className="mt-1 text-xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
          Loading the selected project workspace...
        </p>
      </div>
    </div>
  );
}

interface NavPaneProps {
  contentView: AppView;
  showPanel: boolean;
  onFeedback: () => void;
  onProfile: () => void;
  onChatToggle: () => void;
  chatActive: boolean;
}

/** Dragging the sidebar narrower than this collapses it. */
const SIDEBAR_COLLAPSE_WIDTH = 55;

/** Navigation pane with resize handle. Document sections stay put; list panels nest under their row. */
function NavPane({ contentView, showPanel, ...navProps }: NavPaneProps) {
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const hasProject = useAppStore((s) => s.currentProject !== null);
  const [resizing, setResizing] = useState(false);
  // Unclamped width during a drag, and the width it started from. Dragging below the collapse
  // width collapses on release (the handle must stay mounted until then) and restores the start width.
  const drag = useRef<{ width: number; start: number } | null>(null);

  const handleResize = useCallback(
    (delta: number) => {
      setResizing(true);
      const current = useAppStore.getState().sidebarWidth;
      const state = drag.current ?? { width: current, start: current };
      state.width += delta;
      drag.current = state;
      setSidebarWidth(state.width);
    },
    [setSidebarWidth],
  );
  const handleResizeEnd = useCallback(() => {
    const state = drag.current;
    drag.current = null;
    setResizing(false);
    if (state && state.width < SIDEBAR_COLLAPSE_WIDTH && useAppStore.getState().sidebarVisible) {
      setSidebarWidth(state.start);
      toggleSidebar();
    }
  }, [setSidebarWidth, toggleSidebar]);

  const owner = panelOwner(contentView);
  const panel = !showPanel ? null
    : owner === "assets" ? <AssetList />
    : owner === "narrations" ? <NarrationList />
    : owner === "changes" ? <ChangesPanel />
    : null;

  return (
    <>
      <Sidebar
        {...navProps}
        panelView={contentView}
        expanded={sidebarVisible}
        documents={showPanel && hasProject ? <StoryboardList /> : null}
        panel={panel}
        width={sidebarWidth}
        resizing={resizing}
      />
      {sidebarVisible && (
        <ResizeHandle
          direction="horizontal"
          onResize={handleResize}
          onResizeEnd={handleResizeEnd}
          onStep={(delta) => setSidebarWidth((width) => width + delta)}
          onReset={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
          ariaLabel="Resize sidebar"
          value={{ now: sidebarWidth, min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH }}
          controls="app-sidebar"
          subtle
        />
      )}
    </>
  );
}
