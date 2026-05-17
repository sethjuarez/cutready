import { useCallback, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { StoryboardView } from "./StoryboardView";
import { SketchForm } from "./SketchForm";
import { NoteEditor } from "./NoteEditor";
import { AssetViewer } from "./AssetViewer";
import { ChatPanel } from "./ChatPanel";
import { ResizeHandle } from "./ResizeHandle";
import { TabBar } from "./TabBar";
import { HistoryGraphTab } from "./HistoryGraphTab";
import { SplitTabBar, SplitPaneContent } from "./SplitPreviewPane";
import { ErrorBoundary } from "./ErrorBoundary";

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
  const setActiveEditorGroup = useAppStore((s) => s.setActiveEditorGroup);
  const secondaryWidth = useAppStore((s) => s.secondaryWidth);
  const setSecondaryWidth = useAppStore((s) => s.setSecondaryWidth);
  const hasSplit = splitTabs.length > 0;

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const isHistoryTab = activeTab?.type === "history";
  const isAssetTab = activeTab?.type === "asset";

  const [splitWidth, setSplitWidth] = useState<number | null>(null);
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
      setSplitWidth((w) => Math.max(200, (w ?? 400) - delta));
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
    <div className="flex h-full">
      {/* Secondary panel on left when sidebar is right */}
      {secondaryOnLeft && secondaryPanel}

      {/* Editor area */}
      <div className="flex-1 flex flex-col min-w-0">
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
        <div className="flex-1 flex min-h-0">
          {/* Primary pane */}
          <div className="flex-1 flex flex-col min-w-0" onMouseDown={() => setActiveEditorGroup("main")}>
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
            ) : isAssetTab && activeTab ? (
              <AssetViewer assetPath={activeTab.path} />
            ) : activeSketch ? (
              <SketchForm />
            ) : activeStoryboard ? (
              <StoryboardView />
            ) : activeNotePath ? (
              <NoteEditor />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="relative w-12 h-12">
                    <div
                      className="absolute inset-0 rounded-xl blur-xl opacity-30"
                      style={{ background: "linear-gradient(135deg, rgb(var(--color-accent)), #e879a8)" }}
                    />
                    <img
                      src="/cutready.svg"
                      alt=""
                      className="relative w-12 h-12 drop-shadow-md opacity-50"
                      draggable={false}
                    />
                  </div>
                  <p className="text-sm text-[rgb(var(--color-text-secondary))]">
                    Create a sketch or storyboard to get started
                  </p>
                </div>
              </div>
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
