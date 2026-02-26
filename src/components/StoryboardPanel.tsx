import { useCallback } from "react";
import { useAppStore } from "../stores/appStore";
import { StoryboardList } from "./StoryboardList";
import { StoryboardView } from "./StoryboardView";
import { SketchForm } from "./SketchForm";
import { VersionHistory } from "./VersionHistory";
import { ResizeHandle } from "./ResizeHandle";
import { TabBar } from "./TabBar";

/**
 * StoryboardPanel — main layout for the sketch/storyboard workflow.
 *
 * Sidebar:  StoryboardList (resizable, can be left or right)
 * Center:   TabBar + StoryboardView or SketchForm
 * Right:    VersionHistory (toggleable)
 */
export function StoryboardPanel() {
  const activeStoryboard = useAppStore((s) => s.activeStoryboard);
  const activeSketch = useAppStore((s) => s.activeSketch);
  const showVersionHistory = useAppStore((s) => s.showVersionHistory);
  const toggleVersionHistory = useAppStore((s) => s.toggleVersionHistory);
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const sidebarPosition = useAppStore((s) => s.sidebarPosition);

  const handleSidebarResize = useCallback(
    (delta: number) => {
      // When sidebar is on the right, dragging left (negative delta) should increase width
      const adjustedDelta = sidebarPosition === "right" ? -delta : delta;
      setSidebarWidth(sidebarWidth + adjustedDelta);
    },
    [sidebarWidth, setSidebarWidth, sidebarPosition],
  );

  const sidebar = sidebarVisible ? (
    <>
      {sidebarPosition === "right" && (
        <ResizeHandle direction="horizontal" onResize={handleSidebarResize} />
      )}
      <StoryboardList />
      {sidebarPosition === "left" && (
        <ResizeHandle direction="horizontal" onResize={handleSidebarResize} />
      )}
    </>
  ) : null;

  return (
    <div className="flex h-full">
      {/* Sidebar on left */}
      {sidebarPosition === "left" && sidebar}

      {/* Center: Content area */}
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

      {/* Sidebar on right */}
      {sidebarPosition === "right" && sidebar}

      {/* Version history */}
      {showVersionHistory && <VersionHistory />}
    </div>
  );
}
