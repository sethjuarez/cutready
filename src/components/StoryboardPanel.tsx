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
import { SplitPreviewPane } from "./SplitPreviewPane";
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
  const showVersionHistory = useAppStore((s) => s.showVersionHistory);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const splitTabs = useAppStore((s) => s.splitTabs);
  const hasSplit = splitTabs.length > 0;

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const isHistoryTab = activeTab?.type === "history";
  const isAssetTab = activeTab?.type === "asset";

  const [secondaryWidth, setSecondaryWidth] = useState(340);
  const [splitWidth, setSplitWidth] = useState<number | null>(null);
  const secondaryOnLeft = sidebarPosition === "right";

  const handleSecondaryResize = useCallback(
    (delta: number) => {
      const adjusted = secondaryOnLeft ? delta : -delta;
      setSecondaryWidth((w) => Math.min(600, Math.max(260, w + adjusted)));
    },
    [secondaryOnLeft],
  );

  const handleSplitResize = useCallback(
    (delta: number) => {
      setSplitWidth((w) => Math.max(200, (w ?? 400) - delta));
    },
    [],
  );

  const secondaryPanel = showVersionHistory ? (
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
        {/* Tab bar */}
        <TabBar />

        {/* Content — primary + optional split */}
        <div className="flex-1 flex min-h-0">
          {/* Primary pane */}
          <div className="flex-1 flex flex-col min-w-0">
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
              <div className="shrink-0 h-full border-l border-[rgb(var(--color-border))]" style={{ width: splitWidth ?? "40%" }}>
                <SplitPreviewPane />
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
