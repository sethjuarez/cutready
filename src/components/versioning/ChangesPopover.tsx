import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { isSaveBlocked, runVersionOperation } from "../../services/versionOperation";
import { useChangeSummaryStore } from "../../stores/changeSummaryStore";
import { useVersioningStore } from "../../stores/versioningStore";
import { ChangeList } from "./ChangeList";
import { PowerMenu } from "./PowerMenu";
import { RecentVersions } from "./RecentVersions";
import { RemoteStatus } from "./RemoteStatus";
import { SendSection } from "./SendSection";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { VersionForm } from "./VersionForm";

const POPOVER_WIDTH = 360;

/** Saving and sending, anchored under the status chip. Never a side panel. */
export function ChangesPopover({ anchorRef }: { anchorRef: RefObject<HTMLElement | null> }) {
  const open = useChangeSummaryStore((s) => s.popoverOpen);
  const setOpen = useChangeSummaryStore((s) => s.setPopoverOpen);
  const nameFocusRequest = useChangeSummaryStore((s) => s.nameFocusRequest);
  const changedFiles = useVersioningStore((s) => s.changedFiles);
  const hasChanges = useChangeSummaryStore((s) => (s.summary?.documents.length ?? 0) > 0);
  const style = useAnchoredPopover(open, anchorRef, POPOVER_WIDTH, "right");
  const panelRef = useRef<HTMLDivElement>(null);

  // Opening saves open edits first, so the summary is what a version would hold.
  // One load path: the boundary publishes only its newest summary.
  useEffect(() => {
    if (!open) return;
    void runVersionOperation("Review changes", async (summary) => summary, { quiet: true }).catch((err) => {
      if (!isSaveBlocked(err)) console.error("Couldn't load changes:", err);
    });
  }, [open, changedFiles]);

  // Put focus inside the portaled dialog unless the Version form already took it.
  const positioned = !!style;
  useEffect(() => {
    if (!open || !positioned) return;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
  }, [open, positioned]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      // Leave menus and dialogs portaled elsewhere alone.
      if (target instanceof Element && target.closest("[role=dialog],[role=alertdialog]")) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setOpen(false);
      anchorRef.current?.focus();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, open, setOpen]);

  if (!open || !style) return null;
  const close = () => setOpen(false);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      aria-label="Changes and versions"
      style={style}
      className="z-50 overflow-hidden rounded-panel border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] shadow-lg outline-none"
      data-testid="changes-popover"
    >
      <div className="flex items-center justify-between px-3 pt-2">
        <h2 className="text-xs font-semibold">Changes</h2>
        <PowerMenu />
      </div>
      <ChangeList />
      {hasChanges && (
        <div className="border-t border-[rgb(var(--color-border-subtle))]">
          <VersionForm focusRequest={nameFocusRequest} />
        </div>
      )}
      <SendSection />
      <RemoteStatus />
      <RecentVersions onNavigate={close} />
    </div>,
    document.body,
  );
}
