import { useCallback } from "react";
import { useAppStore } from "../stores/appStore";
import { ChatPanel } from "./ChatPanel";
import { ResizeHandle } from "./ResizeHandle";

/** Direction C companion: the docked chat pane, layered beside the editor. */
export function CompanionPane() {
  const secondaryWidth = useAppStore((s) => s.secondaryWidth);
  const setSecondaryWidth = useAppStore((s) => s.setSecondaryWidth);

  const handleResize = useCallback(
    (delta: number) => setSecondaryWidth((width) => width - delta),
    [setSecondaryWidth],
  );

  return (
    <>
      <ResizeHandle direction="horizontal" subtle onResize={handleResize} />
      <aside
        aria-label="Companion"
        data-testid="secondary-chat-panel"
        className="mb-[var(--card-gap)] ml-[var(--card-gap)] mr-[var(--card-gap)] shrink-0 overflow-hidden rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface-inset))] shadow-layer"
        style={{ width: secondaryWidth }}
      >
        <ChatPanel />
      </aside>
    </>
  );
}
