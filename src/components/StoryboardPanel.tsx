import { useCallback, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { StoryboardView } from "./StoryboardView";
import { SketchForm } from "./SketchForm";
import { VersionHistory } from "./VersionHistory";
import { ResizeHandle } from "./ResizeHandle";
import { TabBar } from "./TabBar";

/**
 * StoryboardPanel — center content area for sketch/storyboard workflow.
 *
 * TabBar + editor content + secondary panel (VersionHistory).
 * The primary sidebar (StoryboardList) is now managed by AppLayout.
 */
export function StoryboardPanel() {
  const activeStoryboard = useAppStore((s) => s.activeStoryboard);
  const activeSketch = useAppStore((s) => s.activeSketch);
  const showVersionHistory = useAppStore((s) => s.showVersionHistory);
  const toggleVersionHistory = useAppStore((s) => s.toggleVersionHistory);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);

  const [secondaryWidth, setSecondaryWidth] = useState(280);
  const secondaryOnLeft = sidebarPosition === "right";

  const handleSecondaryResize = useCallback(
    (delta: number) => {
      const adjusted = secondaryOnLeft ? delta : -delta;
      setSecondaryWidth((w) => Math.min(500, Math.max(180, w + adjusted)));
    },
    [secondaryOnLeft],
  );

  const secondaryPanel = showVersionHistory ? (
    <>
      {!secondaryOnLeft && <ResizeHandle direction="horizontal" onResize={handleSecondaryResize} />}
      <div className="shrink-0 h-full" style={{ width: secondaryWidth }}>
        <VersionHistory />
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

        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 text-sm font-medium truncate">
            {activeStoryboard ? (
              <>
                <span className="text-[var(--color-text-secondary)]">
                  {activeStoryboard.title}
                </span>
                {activeSketch && (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-text-secondary)]">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span>{activeSketch.title}</span>
                  </>
                )}
              </>
            ) : activeSketch ? (
              <span>{activeSketch.title}</span>
            ) : (
              <span className="text-[var(--color-text-secondary)]">
                Select a storyboard or sketch
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleVersionHistory}
              className={`p-1.5 rounded-md transition-colors ${
                showVersionHistory
                  ? "text-[var(--color-accent)] bg-[var(--color-accent)]/10"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface)]"
              }`}
              title="Toggle version history"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        {activeSketch ? (
          <SketchForm />
        ) : activeStoryboard ? (
          <StoryboardView />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-4">🎬</div>
              <p className="text-sm text-[var(--color-text-secondary)]">
                Create a sketch or storyboard to get started
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Secondary panel on right when sidebar is left */}
      {!secondaryOnLeft && secondaryPanel}
    </div>
  );
}
