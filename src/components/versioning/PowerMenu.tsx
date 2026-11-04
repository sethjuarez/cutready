import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, GitBranch, MoreHorizontal } from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { pullRequestUrl } from "../../domain/versioning";
import { useAppStore } from "../../stores/appStore";
import { useSyncStore } from "../../stores/syncStore";
import { useToastStore } from "../../stores/toastStore";
import { useVersioningStore } from "../../stores/versioningStore";
import { firstParentTimelineNodes } from "../../utils/timelineNodes";

const itemClass =
  "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-[rgb(var(--color-text))] hover:bg-fill-hover focus-visible:bg-fill-hover focus-visible:outline-none";

/** The ⋯ menu: Open PR, branch rename, raw version ID. */
export function PowerMenu() {
  const [open, setOpen] = useState(false);
  const [confirmRename, setConfirmRename] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentRemote = useSyncStore((s) => s.currentRemote);
  const baseRename = useSyncStore((s) => s.baseRename);
  const timelines = useVersioningStore((s) => s.timelines);
  const graphNodes = useVersioningStore((s) => s.graphNodes);
  const renameLegacyMasterTimeline = useVersioningStore((s) => s.renameLegacyMasterTimeline);
  const isHybrid = useAppStore((s) => s.currentProject?.hybrid === true);

  const activeTimeline = timelines.find((timeline) => timeline.is_active);
  const prUrl = pullRequestUrl(currentRemote?.url, activeTimeline?.name);
  const hasLegacyMaster = !isHybrid
    && timelines.some((timeline) => timeline.name === "master")
    && !timelines.some((timeline) => timeline.name === "main");
  const rename = baseRename ?? (hasLegacyMaster ? { from: "master", to: "main" } : null);
  const headId = firstParentTimelineNodes(graphNodes)[0]?.id ?? null;

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) setConfirmRename(false);
  }, [open]);

  if (!prUrl && !rename && !headId) return null;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More version actions"
        title="More"
        className="relative inline-flex h-6 w-6 items-center justify-center rounded-control text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        {rename && <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-warning" />}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More version actions"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-7 z-10 w-60 rounded-panel border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-1 shadow-lg"
        >
          {prUrl && (
            <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); void shellOpen(prUrl); }}>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Open pull request
            </button>
          )}
          {rename && (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              title={`The real branch is ${rename.from}. Rename it to ${rename.to} at the source instead of hiding it.`}
              onClick={async () => {
                if (!confirmRename) {
                  setConfirmRename(true);
                  return;
                }
                close();
                await renameLegacyMasterTimeline();
              }}
            >
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
              {confirmRename ? `Confirm: rename ${rename.from} to ${rename.to}` : `Rename ${rename.from} to ${rename.to}`}
            </button>
          )}
          {headId && (
            <button
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => {
                close();
                void navigator.clipboard.writeText(headId).then(
                  () => useToastStore.getState().show("Copied version ID", 2500, "success"),
                  () => useToastStore.getState().show("Couldn't copy the version ID", 4000, "error"),
                );
              }}
            >
              <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">Copy version ID</span>
              <code className="text-2xs text-[rgb(var(--color-text-secondary))]">{headId.slice(0, 7)}</code>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
