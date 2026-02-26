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
