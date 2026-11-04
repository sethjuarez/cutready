import { useState } from "react";
import { useAppStore } from "../stores/appStore";
import { useVersioningStore } from "../stores/versioningStore";
import { useSyncStore } from "../stores/syncStore";
import { useSettings } from "../hooks/useSettings";
import { Check, ArrowUp, ArrowDown, AlertTriangle, GitMerge, Globe, RefreshCw, UserRound } from "lucide-react";
import { isContributorIdentityRequired } from "../services/identity";
import { isDraftlineGuidanceMessage } from "../services/draftlineErrors";
import { IncomingPreview } from "./versioning/IncomingPreview";

export { IncomingPreview };

/**
 * SyncBar — shown at the top of the Snapshots panel when a remote is configured.
 * Displays remote URL, ahead/behind counts, and Fetch/Sync/Push buttons.
 * Progressive disclosure: invisible to solo users.
 */
export function SyncBar({ variant = "full" }: { variant?: "full" | "compact" }) {
  const currentRemote = useSyncStore((s) => s.currentRemote);
  const syncStatus = useSyncStore((s) => s.syncStatus);
  const incomingCommits = useSyncStore((s) => s.incomingCommits);
  const isSyncing = useSyncStore((s) => s.isSyncing);
  const syncError = useSyncStore((s) => s.syncError);
  const fetchFromRemote = useSyncStore((s) => s.fetchFromRemote);
  const pushToRemote = useSyncStore((s) => s.pushToRemote);
  const pullFromRemote = useSyncStore((s) => s.pullFromRemote);
  const syncWithRemote = useSyncStore((s) => s.syncWithRemote);
  const isHybrid = useAppStore((s) => s.currentProject?.hybrid === true);
  const baseStatus = useSyncStore((s) => s.baseStatus);
  const getUpdatesFromBase = useSyncStore((s) => s.getUpdatesFromBase);
  const { settings } = useSettings();
  const [showIncoming, setShowIncoming] = useState(false);
  const timelines = useVersioningStore((s) => s.timelines);
  const activeTimeline = timelines.find((t) => t.is_active);

  // Remote detection and the periodic check live in useRemoteSync (AppLayout).

  // Hidden for solo users
  if (!currentRemote && !settings.repoRemoteUrl) return null;

  // Extract short display name from URL
  const displayUrl = currentRemote?.url
    ? currentRemote.url
        .replace(/^https?:\/\/(www\.)?github\.com\//, "")
        .replace(/\.git$/, "")
    : settings.repoRemoteUrl || "Not connected";

  const ahead = syncStatus?.ahead ?? 0;
  const behind = syncStatus?.behind ?? 0;
  const isUpToDate = ahead === 0 && behind === 0 && syncStatus !== null;
  const showPrimaryAction = !isUpToDate && syncStatus !== null;

  // Determine primary action label
  let actionLabel = "Sync";
  let compactActionLabel = "Sync";
  let compactButtonLabel = "Sync";
  let actionFn = syncWithRemote;
  if (ahead > 0 && behind === 0) {
    actionLabel = "Push";
    // Hybrid projects never push directly: this opens the Send for review prompt.
    compactActionLabel = isHybrid ? "Send for review" : "Share changes";
    compactButtonLabel = "Send";
    actionFn = pushToRemote;
  } else if (behind > 0 && ahead === 0) {
    actionLabel = "Pull";
    compactActionLabel = "Get updates";
    compactButtonLabel = "Get";
    actionFn = pullFromRemote;
  }
  const ActionIcon = isSyncing
    ? RefreshCw
    : actionLabel === "Push"
      ? ArrowUp
      : actionLabel === "Pull"
        ? ArrowDown
        : RefreshCw;
  const actionTitle = isSyncing
    ? "Syncing with collaborators"
    : isHybrid && actionFn === pushToRemote
      ? "Send for review"
      : `${compactActionLabel} with collaborators`;

  // Hybrid projects on a review branch: offer the base's new commits (e.g. from developers on main).
  const baseBehind = isHybrid && baseStatus ? baseStatus.behind : 0;
  const baseUpdateTitle = baseStatus
    ? `Get updates from ${baseStatus.base} (${baseBehind} new change${baseBehind === 1 ? "" : "s"})`
    : "";

  // Compute PR URL — only for non-main branches with a GitHub remote
  const prUrl = (() => {
    if (!currentRemote?.url || !activeTimeline) return null;
    if (activeTimeline.name === "main" || activeTimeline.name === "master") return null;
    const match = currentRemote.url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (!match) return null;
    return `https://github.com/${match[1]}/compare/${activeTimeline.name}?expand=1`;
  })();

  if (variant === "compact") {
    return (
      <div className="relative flex min-w-0 shrink-0 items-center gap-1.5">
        {showPrimaryAction && (
          <button
            onClick={() => actionFn()}
            disabled={isSyncing}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/8 px-1.5 text-2xs font-semibold text-[rgb(var(--color-accent))] transition-colors hover:bg-[rgb(var(--color-accent))]/14 disabled:opacity-50"
            title={actionTitle}
            aria-label={actionTitle}
          >
            <ActionIcon className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`} />
            <span className="hidden min-[260px]:inline">{isSyncing ? "Syncing" : compactButtonLabel}</span>
          </button>
        )}
        {baseBehind > 0 && baseStatus && (
          <button
            onClick={() => getUpdatesFromBase()}
            disabled={isSyncing}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-[rgb(var(--color-accent))]/20 bg-[rgb(var(--color-accent))]/8 px-1.5 text-2xs font-semibold text-[rgb(var(--color-accent))] transition-colors hover:bg-[rgb(var(--color-accent))]/14 disabled:opacity-50"
            title={baseUpdateTitle}
            aria-label={baseUpdateTitle}
          >
            <GitMerge className="h-3 w-3" />
            <span className="hidden min-[260px]:inline">Get {baseStatus.base}</span>
          </button>
        )}
        <button
          onClick={() => fetchFromRemote()}
          disabled={isSyncing}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs font-medium text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:opacity-40"
          title="Check for updates without changing your files"
          aria-label="Check for updates without changing your files"
        >
          <RefreshCw className="h-3 w-3" />
          <span className="hidden min-[260px]:inline">Refresh</span>
        </button>
        {currentRemote?.url && prUrl && (
          <button
            onClick={() => window.open(prUrl, "_blank")}
            className="grid h-5 w-5 place-items-center rounded-md text-[8px] font-semibold text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-accent))]/5 hover:text-[rgb(var(--color-accent))]"
            title="Open Pull Request on GitHub"
            aria-label="Open Pull Request on GitHub"
          >
            PR
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/50">
      {/* Remote URL line */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          aria-hidden="true"
          data-status={isSyncing ? "busy" : currentRemote ? "ok" : "off"}
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isSyncing
              ? "bg-warning text-warning animate-pulse"
              : currentRemote
                ? "bg-success"
                : "bg-[rgb(var(--color-text-secondary))]"
          }`}
        />
        <span className="text-2xs text-[rgb(var(--color-text-secondary))] truncate flex-1">
          {displayUrl}
        </span>
      </div>

      {/* Status + actions */}
      <div className="flex items-center gap-2">
        {/* Ahead/behind badges */}
        {syncStatus && (
          <div className="flex items-center gap-1.5 text-2xs">
            {isUpToDate ? (
              <span className="text-success flex items-center gap-1">
                <Check className="w-2.5 h-2.5" />
                Up to date
              </span>
            ) : (
              <>
                {ahead > 0 && (
                  <span className="text-[rgb(var(--color-accent))] flex items-center gap-0.5" title={`${ahead} snapshot${ahead !== 1 ? "s" : ""} ready to share`}>
                    <ArrowUp className="w-2.5 h-2.5" />
                    {ahead}
                  </span>
                )}
                {behind > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowIncoming((value) => !value)}
                    className="text-warning flex items-center gap-0.5 rounded px-1 hover:bg-warning/10"
                    title={`${behind} incoming collaborator snapshot${behind !== 1 ? "s" : ""}`}
                  >
                    <ArrowDown className="w-2.5 h-2.5" />
                    {behind}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Fetch button */}
        <button
          onClick={() => fetchFromRemote()}
          disabled={isSyncing}
          className="px-2 py-0.5 rounded text-2xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-border))]/50 transition-colors disabled:opacity-40"
          title="Check for updates without changing your files"
        >
          Check updates
        </button>

        {/* Primary action: Sync / Push / Pull */}
        {showPrimaryAction && (
          <button
            onClick={() => actionFn()}
            disabled={isSyncing}
            className="flex items-center gap-1 px-2.5 py-0.5 rounded text-2xs font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:opacity-90 transition-opacity disabled:opacity-60"
            title={actionTitle}
          >
            <ActionIcon className={`w-2.5 h-2.5 ${isSyncing ? "animate-spin" : ""}`} />
            {!isSyncing && compactActionLabel}
          </button>
        )}

        {/* Get updates from base — hybrid projects behind their base branch */}
        {baseBehind > 0 && baseStatus && (
          <button
            onClick={() => getUpdatesFromBase()}
            disabled={isSyncing}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-2xs font-medium text-[rgb(var(--color-accent))] border border-[rgb(var(--color-accent))]/30 hover:bg-[rgb(var(--color-accent))]/10 transition-colors disabled:opacity-60"
            title={baseUpdateTitle}
            aria-label={baseUpdateTitle}
          >
            <GitMerge className="w-2.5 h-2.5" />
            Get updates from {baseStatus.base}
          </button>
        )}

        {/* Open PR button — shown for non-main branches */}
        {currentRemote?.url && prUrl && (
          <button
            onClick={() => window.open(prUrl, "_blank")}
            className="px-2 py-0.5 rounded text-2xs text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors"
            title="Open Pull Request on GitHub"
          >
            PR
          </button>
        )}
      </div>

      {showIncoming && behind > 0 && (
        <div className="mt-1.5">
          <IncomingPreview commits={incomingCommits} inline />
        </div>
      )}

      {/* Conflict / diverge banner */}
      {syncError && syncError.includes("can't be merged") && (
        <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1.5 rounded bg-warning/10 border border-warning/20">
          <AlertTriangle className="text-warning shrink-0 w-3 h-3" />
          <span className="text-2xs text-warning flex-1">
            Changes conflict with remote. Take a snapshot, then try pulling again.
          </span>
        </div>
      )}

      {/* General error message (non-diverge) */}
      {syncError && !syncError.includes("can't be merged") && (
        <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-error" title={syncError}>
          {isContributorIdentityRequired(syncError) ? (
            <>
              <UserRound className="shrink-0 w-2.5 h-2.5" />
              <span className="truncate">Add your name and email in Settings › Profile</span>
            </>
          ) : isDraftlineGuidanceMessage(syncError) ? (
            <>
              <AlertTriangle className="shrink-0 w-2.5 h-2.5" />
              <span className="truncate">{syncError}</span>
            </>
          ) : (syncError.includes("network") || syncError.includes("resolve host") || syncError.includes("Could not resolve") || syncError.includes("timed out")) ? (
            <>
              <Globe className="shrink-0 w-2.5 h-2.5" />
              <span className="truncate">Offline — changes saved locally</span>
            </>
          ) : syncError.includes("Push rejected") ? (
            <>
              <AlertTriangle className="shrink-0 w-2.5 h-2.5" />
              <span className="truncate">Remote is ahead — pull first, then push</span>
            </>
          ) : /github|sign-in|auth|unauthorized|401/i.test(syncError) ? (
            <>
              <AlertTriangle className="shrink-0 w-2.5 h-2.5" />
              <span className="truncate">GitHub sign-in required — reconnect in Settings</span>
            </>
          ) : syncError && syncError.includes("404") ? (
            <>
              <AlertTriangle className="shrink-0 w-2.5 h-2.5" />
              <span className="truncate">Remote not found — check remote URL in settings</span>
            </>
          ) : (
            <span className="truncate">{syncError}</span>
          )}
          <button
            onClick={() => useSyncStore.setState({ syncError: null })}
            className="ml-auto shrink-0 opacity-60 hover:opacity-100"
          >✕</button>
        </div>
      )}
    </div>
  );
}
