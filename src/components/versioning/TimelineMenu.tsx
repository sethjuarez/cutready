import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ChevronDown, Cloud, GitBranch, GitMerge, History, RefreshCw } from "lucide-react";
import { filterRemoteTimelines, filterTimelines } from "../../domain/versioning";
import { openHistoryTab } from "../../hooks/useVersioningLifecycle";
import { isSaveBlocked, runVersionOperation } from "../../services/versionOperation";
import { useAppStore } from "../../stores/appStore";
import { useSyncStore } from "../../stores/syncStore";
import { useVersioningStore } from "../../stores/versioningStore";
import type { TimelineInfo } from "../../types/sketch";
import { useConfirmDialog } from "../ConfirmDialog";
import { NewTimelineForm } from "./NewTimelineForm";
import { TimelineRows, menuInputClass, menuRowClass } from "./TimelineRows";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { useTimelineSwitch } from "./useTimelineSwitch";

const chipClass =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-control px-2 text-xs text-[rgb(var(--color-text-secondary))] transition-colors duration-fast ease-fluent hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";
const sectionLabelClass = "flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]";

function guarded(operation: string, action: () => Promise<void>) {
  void runVersionOperation(operation, () => action()).catch((err) => {
    if (!isSaveBlocked(err)) console.error(`${operation} failed:`, err);
  });
}

/** The timeline chip and its dropdown: switch, create, adopt, rename, delete, updates, history. */
export function TimelineMenu() {
  const timelines = useVersioningStore((s) => s.timelines);
  const switchTimeline = useVersioningStore((s) => s.switchTimeline);
  const renameTimeline = useVersioningStore((s) => s.renameTimeline);
  const deleteTimeline = useVersioningStore((s) => s.deleteTimeline);
  const currentRemote = useSyncStore((s) => s.currentRemote);
  const remoteBranches = useSyncStore((s) => s.remoteBranches);
  const remoteLoading = useSyncStore((s) => s.remoteBranchesLoading);
  const loadRemoteBranches = useSyncStore((s) => s.loadRemoteBranches);
  const checkoutRemoteTimeline = useSyncStore((s) => s.checkoutRemoteTimeline);
  const isSyncing = useSyncStore((s) => s.isSyncing);
  const behind = useSyncStore((s) => s.syncStatus?.behind ?? 0);
  const baseStatus = useSyncStore((s) => s.baseStatus);
  const isHybrid = useAppStore((s) => s.currentProject?.hybrid === true);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredPopover(open, triggerRef, 280, "left");
  const { request, dialog } = useTimelineSwitch();
  const { confirm, confirmationDialog } = useConfirmDialog();

  const active = timelines.find((timeline) => timeline.is_active);
  const baseBehind = isHybrid && baseStatus ? baseStatus.behind : 0;

  const close = (refocus = true) => {
    setOpen(false);
    setFilter("");
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (open && currentRemote) void loadRemoteBranches();
  }, [currentRemote, loadRemoteBranches, open]);

  if (!active) return null;
  const name = active.label || active.name;

  const run = (action: () => Promise<void>) => void action().catch((err) => {
    if (!isSaveBlocked(err)) console.error("Timeline action failed:", err);
  });
  const switchTo = (timeline: TimelineInfo) => {
    close();
    if (timeline.is_active) return;
    run(() => request(timeline.label || timeline.name, () => switchTimeline(timeline.name)));
  };
  const adopt = (branch: string) => {
    close();
    run(() => request(`${currentRemote?.name ?? "origin"}/${branch}`, () => checkoutRemoteTimeline(branch)));
  };
  const confirmAdopt = async (branch: string) => {
    const ok = await confirm({
      title: "Adopt remote timeline?",
      message: `This creates a local timeline from ${currentRemote?.name ?? "origin"}/${branch} and switches to it. Your current timeline is left unchanged.`,
      confirmLabel: "Adopt and switch",
      cancelLabel: "Cancel",
      variant: "default",
    });
    if (ok) adopt(branch);
  };
  const remove = async (timeline: TimelineInfo) => {
    const label = timeline.label || timeline.name;
    const ok = await confirm({
      title: `Delete ${label}?`,
      message: `This removes the ${label} timeline. Versions only on it can't be reached afterwards.`,
      confirmLabel: "Delete timeline",
      cancelLabel: "Keep timeline",
      variant: "warning",
    });
    if (ok) await deleteTimeline(timeline.name);
  };

  const local = filterTimelines(timelines, filter);
  const remote = filterRemoteTimelines(remoteBranches, timelines, filter);

  const panel = open && style ? createPortal(
    <div
      ref={panelRef}
      style={style}
      role="dialog"
      aria-label="Timelines"
      className="z-dropdown overflow-hidden rounded-card border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
        if (event.key !== "Tab" || !panelRef.current) return;
        // Keep Tab inside the panel while it's open.
        const focusable = panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)");
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      data-testid="timeline-menu"
    >
      <div className="px-2 pt-2">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter timelines…"
          aria-label="Filter timelines"
          className={menuInputClass}
          autoFocus
        />
      </div>
      <div className="max-h-72 overflow-y-auto px-1">
        <TimelineRows timelines={local} all={timelines} onSwitch={switchTo} onRename={(t, to) => renameTimeline(t.name, to)} onDelete={(t) => run(() => remove(t))} />
        {local.length === 0 && <p className="px-2 py-1.5 text-2xs text-[rgb(var(--color-text-secondary))]">No timelines match "{filter}"</p>}
        {currentRemote && (
          <div className="border-t border-[rgb(var(--color-border-subtle))] pb-1">
            <div className={sectionLabelClass}>
              <Cloud className="h-3 w-3" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">On {currentRemote.name}</span>
              <button
                type="button"
                onClick={() => void loadRemoteBranches()}
                disabled={remoteLoading}
                className="grid h-5 w-5 place-items-center rounded normal-case hover:bg-fill-hover disabled:opacity-40"
                title="Refresh remote timelines"
                aria-label="Refresh remote timelines"
              >
                <RefreshCw className={`h-3 w-3 ${remoteLoading ? "motion-safe:animate-spin" : ""}`} aria-hidden="true" />
              </button>
            </div>
            {remoteLoading && remoteBranches.length === 0
              ? <p className="px-2 py-1 text-2xs text-[rgb(var(--color-text-secondary))]">Fetching remote timelines…</p>
              : remote.length === 0
                ? <p className="px-2 py-1 text-2xs text-[rgb(var(--color-text-secondary))]">{filter ? `No remote timelines match "${filter}"` : "No remote-only timelines"}</p>
                : remote.map((branch) => (
                  <button
                    key={`${branch.remote}/${branch.id}`}
                    type="button"
                    onClick={() => run(() => confirmAdopt(branch.id))}
                    className={`${menuRowClass} text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]`}
                    title={`Adopt ${branch.remote}/${branch.name}`}
                  >
                    <span aria-hidden="true" className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full border border-[rgb(var(--color-accent))]/60" />
                    <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                  </button>
                ))}
          </div>
        )}
      </div>
      <div className="border-t border-[rgb(var(--color-border-subtle))] p-1">
        <NewTimelineForm onCreated={() => close()} onAdopt={adopt} />
        {behind > 0 && (
          <button type="button" disabled={isSyncing} onClick={() => { close(); guarded("Get updates", useSyncStore.getState().pullFromRemote); }} className={`${menuRowClass} text-[rgb(var(--color-text))] disabled:opacity-50`}>
            <ArrowDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            Get updates ({behind})
          </button>
        )}
        {baseBehind > 0 && baseStatus && (
          <button type="button" disabled={isSyncing} onClick={() => { close(); guarded("Get updates", useSyncStore.getState().getUpdatesFromBase); }} className={`${menuRowClass} text-[rgb(var(--color-text))] disabled:opacity-50`}>
            <GitMerge className="h-3 w-3 shrink-0" aria-hidden="true" />
            Get updates from {baseStatus.base} ({baseBehind})
          </button>
        )}
        {currentRemote && (
          <button type="button" disabled={isSyncing} onClick={() => void useSyncStore.getState().fetchFromRemote({ notifyAuthRequired: true })} className={`${menuRowClass} text-[rgb(var(--color-text))] disabled:opacity-50`}>
            <RefreshCw className={`h-3 w-3 shrink-0 ${isSyncing ? "motion-safe:animate-spin" : ""}`} aria-hidden="true" />
            Check for updates
          </button>
        )}
        <button type="button" onClick={() => { close(false); openHistoryTab(); }} className={`${menuRowClass} text-[rgb(var(--color-text))]`}>
          <History className="h-3 w-3 shrink-0" aria-hidden="true" />
          Open history
        </button>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${chipClass} max-w-[180px]`}
        onClick={() => (open ? close() : setOpen(true))}
        title={`Timeline: ${name}`}
        aria-label={`Timeline ${name}. Switch or manage timelines`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="titlebar-variation"
      >
        <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate max-[1100px]:hidden">{name}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
      </button>
      {panel}
      {dialog}
      {confirmationDialog}
    </>
  );
}
