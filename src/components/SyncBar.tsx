import { useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";
import { Check, ArrowUp, ArrowDown, AlertTriangle, Globe, RefreshCw } from "lucide-react";

/**
 * SyncBar — shown at the top of the Snapshots panel when a remote is configured.
 * Displays remote URL, ahead/behind counts, and Fetch/Sync/Push buttons.
 * Progressive disclosure: invisible to solo users.
 */
export function SyncBar({ variant = "full" }: { variant?: "full" | "compact" }) {
  const currentRemote = useAppStore((s) => s.currentRemote);
  const syncStatus = useAppStore((s) => s.syncStatus);
  const incomingCommits = useAppStore((s) => s.incomingCommits);
  const isSyncing = useAppStore((s) => s.isSyncing);
  const syncError = useAppStore((s) => s.syncError);
  const detectRemote = useAppStore((s) => s.detectRemote);
  const fetchFromRemote = useAppStore((s) => s.fetchFromRemote);
  const pushToRemote = useAppStore((s) => s.pushToRemote);
  const pullFromRemote = useAppStore((s) => s.pullFromRemote);
  const syncWithRemote = useAppStore((s) => s.syncWithRemote);
  const { settings } = useSettings();
  const [showIncoming, setShowIncoming] = useState(false);
  const timelines = useAppStore((s) => s.timelines);
  const activeTimeline = timelines.find((t) => t.is_active);

  // Detect remote on mount (if the user configured one in settings or one exists in git)
  useEffect(() => {
    detectRemote();
  }, [detectRemote]);

  // Periodic fetch every 5 minutes when remote is configured — pauses when app is hidden
  useEffect(() => {
    if (!currentRemote) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (!intervalId) {
        intervalId = setInterval(() => { fetchFromRemote(); }, 5 * 60 * 1000);
      }
    };
    const stop = () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        fetchFromRemote(); // catch up immediately on return
        start();
      }
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [currentRemote, fetchFromRemote]);

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

  // Determine primary action label
  let actionLabel = "Sync";
  let actionFn = syncWithRemote;
  if (ahead > 0 && behind === 0) {
    actionLabel = "Push";
    actionFn = pushToRemote;
  } else if (behind > 0 && ahead === 0) {
    actionLabel = "Pull";
    actionFn = pullFromRemote;
  }
  const ActionIcon = isSyncing
    ? RefreshCw
    : actionLabel === "Push"
      ? ArrowUp
      : actionLabel === "Pull"
        ? ArrowDown
        : RefreshCw;
  const actionTitle = isSyncing ? "Sharing workspace changes" : `${actionLabel} workspace changes`;

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
      <div className="relative flex min-w-0 items-center gap-1.5">
        {syncStatus && (
          <div className="flex items-center gap-1 text-[10px]">
            {isUpToDate ? (
              <span className="flex items-center gap-0.5 text-success" title="Remote is up to date">
                <Check className="h-2.5 w-2.5" />
              </span>
            ) : (
              <>
                {ahead > 0 && (
                  <span className="flex items-center gap-0.5 text-[rgb(var(--color-accent))]" title={`${ahead} snapshot${ahead !== 1 ? "s" : ""} ready to share`}>
                    <ArrowUp className="h-2.5 w-2.5" />
                    {ahead}
                  </span>
                )}
                {behind > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowIncoming((value) => !value)}
                    className="flex items-center gap-0.5 rounded text-warning hover:bg-warning/10"
                    title={`${behind} incoming collaborator snapshot${behind !== 1 ? "s" : ""}`}
                  >
                    <ArrowDown className="h-2.5 w-2.5" />
                    {behind}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <button
          onClick={() => fetchFromRemote()}
          disabled={isSyncing}
          className="grid h-5 w-5 place-items-center rounded-md text-[rgb(var(--color-text-secondary))] transition-colors hover:bg-[rgb(var(--color-surface-alt))] hover:text-[rgb(var(--color-text))] disabled:opacity-40"
          title="Check for collaborator updates"
          aria-label="Check for collaborator updates"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        {!isUpToDate && syncStatus && (
          <button
            onClick={() => actionFn()}
            disabled={isSyncing}
            className="grid h-5 w-5 place-items-center rounded-md text-[rgb(var(--color-accent))] transition-colors hover:bg-[rgb(var(--color-accent))]/10 disabled:opacity-50"
            title={actionTitle}
            aria-label={actionTitle}
          >
            <ActionIcon className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`} />
          </button>
        )}
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
        {showIncoming && behind > 0 && (
          <IncomingPreview commits={incomingCommits} />
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]/50">
      {/* Remote URL line */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isSyncing
              ? "bg-warning animate-pulse"
              : currentRemote
                ? "bg-success"
                : "bg-zinc-400"
          }`}
        />
        <span className="text-[10px] text-[rgb(var(--color-text-secondary))] truncate flex-1">
          {displayUrl}
        </span>
      </div>

      {/* Status + actions */}
      <div className="flex items-center gap-2">
        {/* Ahead/behind badges */}
        {syncStatus && (
          <div className="flex items-center gap-1.5 text-[10px]">
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
          className="px-2 py-0.5 rounded text-[10px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-border))]/50 transition-colors disabled:opacity-40"
          title="Check for collaborator updates"
        >
          Fetch
        </button>

        {/* Primary action: Sync / Push / Pull */}
        {!isUpToDate && syncStatus && (
          <button
            onClick={() => actionFn()}
            disabled={isSyncing}
            className="flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:opacity-90 transition-opacity disabled:opacity-60"
            title={actionTitle}
          >
            <ActionIcon className={`w-2.5 h-2.5 ${isSyncing ? "animate-spin" : ""}`} />
            {!isSyncing && actionLabel}
          </button>
        )}

        {/* Open PR button — shown for non-main branches */}
        {currentRemote?.url && prUrl && (
          <button
            onClick={() => window.open(prUrl, "_blank")}
            className="px-2 py-0.5 rounded text-[10px] text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-accent))]/5 transition-colors"
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
          <span className="text-[10px] text-warning flex-1">
            Changes conflict with remote. Take a snapshot, then try pulling again.
          </span>
        </div>
      )}

      {/* General error message (non-diverge) */}
      {syncError && !syncError.includes("can't be merged") && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-error" title={syncError}>
          {(syncError.includes("network") || syncError.includes("resolve host") || syncError.includes("Could not resolve") || syncError.includes("timed out")) ? (
            <>
              <Globe className="shrink-0 w-2.5 h-2.5" />
              <span className="truncate">Offline — changes saved locally</span>
            </>
          ) : syncError.includes("Push rejected") ? (
            <>
              <AlertTriangle className="shrink-0 w-2.5 h-2.5" />
              <span className="truncate">Remote is ahead — pull first, then push</span>
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
            onClick={() => useAppStore.setState({ syncError: null })}
            className="ml-auto shrink-0 opacity-60 hover:opacity-100"
          >✕</button>
        </div>
      )}
    </div>
  );
}

function IncomingPreview({
  commits,
  inline = false,
}: {
  commits: Array<{
    id: string;
    message: string;
    author: string;
    timestamp: string;
    changed_files: Array<{ path: string }>;
    projects: string[];
  }>;
  inline?: boolean;
}) {
  const body = (
    <div className="max-h-64 overflow-y-auto py-1">
      <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
        Incoming work
      </div>
      {commits.length === 0 ? (
        <div className="px-2 py-1 text-[10px] text-[rgb(var(--color-text-secondary))]">
          Fetch latest to preview what collaborators changed.
        </div>
      ) : (
        commits.map((commit) => (
          <div key={commit.id} className="border-t border-[rgb(var(--color-border))]/60 px-2 py-1.5 first:border-t-0">
            <div className="truncate text-[11px] font-medium text-[rgb(var(--color-text))]">{commit.message}</div>
            <div className="mt-0.5 flex items-center gap-1 text-[9px] text-[rgb(var(--color-text-secondary))]">
              <span className="truncate">{commit.author}</span>
              <span>•</span>
              <span>{commit.changed_files.length} file{commit.changed_files.length === 1 ? "" : "s"}</span>
              {commit.projects.length > 0 && (
                <>
                  <span>•</span>
                  <span className="truncate">{commit.projects.slice(0, 2).join(", ")}</span>
                </>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );

  if (inline) {
    return (
      <div className="rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]">
        {body}
      </div>
    );
  }

  return (
    <div className="absolute right-0 top-full z-dropdown mt-1 w-64 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg">
      {body}
    </div>
  );
}
