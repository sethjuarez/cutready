import { ChevronDown, CloudUpload, GitBranch } from "lucide-react";
import { useAppStore } from "../stores/appStore";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";

const chipClass =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-control px-2 text-xs text-[rgb(var(--color-text-secondary))] transition-colors duration-fast ease-fluent hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

export function unsavedChangesLabel(count: number): string {
  if (count <= 0) return "All changes saved";
  return `${count} unsaved change${count === 1 ? "" : "s"}`;
}

type SendAction = { kind: "push" | "sync" | "disabled"; title: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Decides what Send does. Diverged branches sync first, since a plain push would be rejected. */
export function sendAction(
  status: { ahead: number; behind: number } | null,
  isSyncing: boolean,
  sendLabel: string,
): SendAction {
  if (isSyncing) return { kind: "disabled", title: "Syncing with collaborators" };
  if (!status) return { kind: "disabled", title: "Checking sync status" };
  const { ahead, behind } = status;
  if (ahead > 0 && behind > 0) {
    return { kind: "sync", title: `Sync: get ${plural(behind, "update")}, then share ${plural(ahead, "saved change")}` };
  }
  if (ahead > 0) return { kind: "push", title: `${sendLabel}: share ${plural(ahead, "saved change")}` };
  if (behind > 0) return { kind: "disabled", title: `Get ${plural(behind, "update")} in Changes before sending` };
  return { kind: "disabled", title: "Nothing saved to send yet" };
}

/** Active variation chip shown next to the project name. Opens the Changes view. */
export function TitleBarVariationChip() {
  const activeTimeline = useVersioningStore((s) => s.timelines.find((t) => t.is_active));
  const setView = useAppStore((s) => s.setView);
  if (!activeTimeline) return null;
  const name = activeTimeline.label || activeTimeline.name;
  return (
    <button
      type="button"
      className={`${chipClass} max-w-[180px] max-[1100px]:hidden`}
      onClick={() => setView("changes")}
      title={`Variation: ${name}`}
      aria-label={`Variation ${name}. Open changes`}
      data-testid="titlebar-variation"
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{name}</span>
      <ChevronDown className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
    </button>
  );
}

/** Save state + Send. Send pushes saved work; hybrid projects open Send for review instead. */
export function TitleBarSyncStatus() {
  const changedCount = useVersioningStore((s) => s.changedFiles.length);
  const setView = useAppStore((s) => s.setView);
  const inChanges = useAppStore((s) => s.view === "changes");
  const isHybrid = useAppStore((s) => s.currentProject?.hybrid === true);
  const currentRemote = useSyncStore((s) => s.currentRemote);
  const syncStatus = useSyncStore((s) => s.syncStatus);
  const isSyncing = useSyncStore((s) => s.isSyncing);
  const pushToRemote = useSyncStore((s) => s.pushToRemote);
  const syncWithRemote = useSyncStore((s) => s.syncWithRemote);

  const label = unsavedChangesLabel(changedCount);
  const dirty = changedCount > 0;
  const sendLabel = isHybrid ? "Send for review" : "Send";
  const send = sendAction(syncStatus, isSyncing, sendLabel);

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        className={chipClass}
        onClick={() => setView("changes")}
        title={`${label}. Open changes`}
        aria-label={`${label}. Open changes`}
        aria-current={inChanges ? "page" : undefined}
        data-testid="titlebar-sync-status"
      >
        <span
          aria-hidden="true"
          data-status={dirty ? "warn" : "ok"}
          className={`h-2 w-2 shrink-0 rounded-full ${
            dirty
              ? "bg-warning shadow-[0_0_0_3px_rgb(var(--color-warning)/0.2)]"
              : "bg-success"
          }`}
        />
        <span className="truncate max-[900px]:sr-only">{label}</span>
      </button>
      {currentRemote && (
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-control bg-accent px-3 text-xs font-medium text-accent-fg transition-colors duration-fast ease-fluent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(var(--color-surface))] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void (send.kind === "sync" ? syncWithRemote() : pushToRemote())}
          disabled={send.kind === "disabled"}
          title={send.title}
          aria-label={send.title}
          data-testid="titlebar-send"
        >
          <CloudUpload className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="max-[900px]:sr-only">{sendLabel}</span>
        </button>
      )}
    </div>
  );
}
