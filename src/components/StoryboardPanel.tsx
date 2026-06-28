import { useCallback, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { StoryboardView } from "./StoryboardView";
import { SketchForm } from "./SketchForm";
import { NoteEditor } from "./NoteEditor";
import { AssetViewer } from "./AssetViewer";
import { DiffViewer } from "./DiffViewer";
import { ChatPanel } from "./ChatPanel";
import { DatabaseViewer } from "./DatabaseViewer";
import { ResizeHandle } from "./ResizeHandle";
import { TabBar } from "./TabBar";
import { HistoryGraphTab } from "./HistoryGraphTab";
import { SnapshotPreviewTab } from "./SnapshotPreviewTab";
import { SplitTabBar, SplitPaneContent } from "./SplitPreviewPane";
import { ErrorBoundary } from "./ErrorBoundary";
import { AgentRunTab } from "./AgentRunInspector";

/**
 * StoryboardPanel — center content area for sketch/storyboard workflow.
 *
 * TabBar + editor content + optional split pane + secondary panel (Chat).
 * The primary sidebar (StoryboardList) is now managed by AppLayout.
 */
export function StoryboardPanel() {
  const activeStoryboard = useAppStore((s) => s.activeStoryboard);
  const activeSketch = useAppStore((s) => s.activeSketch);
  const activeNotePath = useAppStore((s) => s.activeNotePath);
  const showSecondaryPanel = useAppStore((s) => s.showSecondaryPanel);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const splitTabs = useAppStore((s) => s.splitTabs);
  const editorReloadKey = useAppStore((s) => s.editorReloadKey);
  const editorReloadPath = useAppStore((s) => s.editorReloadPath);
  const setActiveEditorGroup = useAppStore((s) => s.setActiveEditorGroup);
  const secondaryWidth = useAppStore((s) => s.secondaryWidth);
  const setSecondaryWidth = useAppStore((s) => s.setSecondaryWidth);
  const hasSplit = splitTabs.length > 0;

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const isHistoryTab = activeTab?.type === "history";
  const isSnapshotPreviewTab = activeTab?.type === "snapshot-preview";
  const isAssetTab = activeTab?.type === "asset";
  const isDiffTab = activeTab?.type === "diff";
  const isAgentRunTab = activeTab?.type === "agent-run";
  const isDatabaseTab = activeTab?.type === "database";
  const activeEditorReloadKey = activeTab?.path === editorReloadPath ? editorReloadKey : 0;
  const isEditorTabLoading =
    activeTab?.type === "sketch" ||
    activeTab?.type === "storyboard" ||
    activeTab?.type === "note" ||
    (openTabs.length > 0 && !activeTab);

  const [splitWidth, setSplitWidth] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const secondaryOnLeft = sidebarPosition === "right";

  const handleSecondaryResize = useCallback(
    (delta: number) => {
      const adjusted = secondaryOnLeft ? delta : -delta;
      setSecondaryWidth((width) => width + adjusted);
    },
    [secondaryOnLeft, setSecondaryWidth],
  );

  const handleSplitResize = useCallback(
    (delta: number) => {
      const availableWidth = panelRef.current?.clientWidth ?? window.innerWidth;
      const maxSplitWidth = Math.max(180, availableWidth - 280);
      setSplitWidth((w) => Math.min(maxSplitWidth, Math.max(180, (w ?? availableWidth / 2) - delta)));
    },
    [],
  );

  const secondaryPanel = showSecondaryPanel ? (
    <>
      {!secondaryOnLeft && <ResizeHandle direction="horizontal" onResize={handleSecondaryResize} />}
      <div className="shrink-0 h-full bg-[rgb(var(--color-surface-inset))] border-l border-[rgb(var(--color-border))]" style={{ width: secondaryWidth }}>
        <ChatPanel />
      </div>
      {secondaryOnLeft && <ResizeHandle direction="horizontal" onResize={handleSecondaryResize} />}
    </>
  ) : null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Secondary panel on left when sidebar is right */}
      {secondaryOnLeft && secondaryPanel}

      {/* Editor area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Tab bar row — main + split side by side */}
        <div className="flex shrink-0 min-w-0">
          <div className="flex-1 min-w-0 overflow-hidden">
            <TabBar />
          </div>
          {hasSplit && (
            <div className="shrink-0" style={{ width: splitWidth ?? "50%" }}>
              <SplitTabBar />
            </div>
          )}
        </div>

        {/* Content row — primary + optional split */}
        <div className="flex-1 flex min-h-0" ref={panelRef}>
          {/* Primary pane */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden" onMouseDown={() => setActiveEditorGroup("main")}>
            {isHistoryTab ? (
              <ErrorBoundary
                fallback={
                  <div className="flex-1 flex items-center justify-center text-sm text-[rgb(var(--color-error))]">
                    History graph failed to render
                  </div>
                }
              >
                <HistoryGraphTab />
              </ErrorBoundary>
            ) : isSnapshotPreviewTab && activeTab ? (
              <SnapshotPreviewTab snapshotId={snapshotIdFromTabPath(activeTab.path)} />
            ) : isDiffTab && activeTab ? (
              <DiffViewer filePath={activeTab.path} />
            ) : isAgentRunTab && activeTab ? (
              <AgentRunTab runId={agentRunIdFromTabPath(activeTab.path)} />
            ) : isDatabaseTab && activeTab ? (
              <DatabaseViewer path={activeTab.path} />
            ) : isAssetTab && activeTab ? (
              <AssetViewer assetPath={activeTab.path} />
            ) : activeSketch ? (
              <SketchForm key={`sketch:${activeTab?.path ?? ""}:${activeEditorReloadKey}`} />
            ) : activeStoryboard ? (
              <StoryboardView key={`storyboard:${activeTab?.path ?? ""}:${activeEditorReloadKey}`} />
            ) : activeNotePath ? (
              <NoteEditor key={`note:${activeTab?.path ?? ""}:${activeEditorReloadKey}`} />
            ) : isEditorTabLoading ? (
              <QuietEditorState title="Loading document" description="Restoring the active tab..." />
            ) : (
              <QuietEditorState title="No document selected" description="Choose a sketch, storyboard, or note from Documents." />
            )}
          </div>

          {/* Split pane */}
          {hasSplit && (
            <>
              <ResizeHandle direction="horizontal" onResize={handleSplitResize} />
              <div className="shrink-0 h-full border-l border-[rgb(var(--color-border))]" style={{ width: splitWidth ?? "50%" }}>
                <SplitPaneContent />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Secondary panel on right when sidebar is left */}
      {!secondaryOnLeft && secondaryPanel}
    </div>
  );
}

function snapshotIdFromTabPath(path: string): string {
  return path.startsWith("snapshot:") ? path.slice("snapshot:".length) : path;
}

function agentRunIdFromTabPath(path: string): string {
  return path.startsWith("__agent_run/") ? path.slice("__agent_run/".length) : path;
}

function QuietEditorState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-[rgb(var(--color-surface))] px-6 text-center">
      <div className="max-w-sm border-l border-[rgb(var(--color-border))] pl-4 text-left">
        <p className="text-sm font-medium text-[rgb(var(--color-text))]">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-[rgb(var(--color-text-secondary))]">{description}</p>
      </div>
    </div>
  );
}
