import { useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";
import { Check, ArrowUp, ArrowDown, AlertTriangle, Globe } from "lucide-react";

/**
 * SyncBar — shown at the top of the Snapshots panel when a remote is configured.
 * Displays remote URL, ahead/behind counts, and Fetch/Sync/Push buttons.
 * Progressive disclosure: invisible to solo users.
 */
export function SyncBar() {
  const currentRemote = useAppStore((s) => s.currentRemote);
  const syncStatus = useAppStore((s) => s.syncStatus);
  const isSyncing = useAppStore((s) => s.isSyncing);
  const syncError = useAppStore((s) => s.syncError);
  const detectRemote = useAppStore((s) => s.detectRemote);
  const fetchFromRemote = useAppStore((s) => s.fetchFromRemote);
  const pushToRemote = useAppStore((s) => s.pushToRemote);
  const pullFromRemote = useAppStore((s) => s.pullFromRemote);
  const syncWithRemote = useAppStore((s) => s.syncWithRemote);
  const { settings } = useSettings();
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

  // Compute PR URL — only for non-main branches with a GitHub remote
  const prUrl = (() => {
    if (!currentRemote?.url || !activeTimeline) return null;
    if (activeTimeline.name === "main" || activeTimeline.name === "master") return null;
    const match = currentRemote.url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (!match) return null;
    return `https://github.com/${match[1]}/compare/${activeTimeline.name}?expand=1`;
  })();

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
                  <span className="text-[rgb(var(--color-accent))] flex items-center gap-0.5" title={`${ahead} unpublished snapshot${ahead !== 1 ? "s" : ""}`}>
                    <ArrowUp className="w-2.5 h-2.5" />
                    {ahead}
                  </span>
                )}
                {behind > 0 && (
                  <span className="text-warning flex items-center gap-0.5" title={`${behind} incoming snapshot${behind !== 1 ? "s" : ""}`}>
                    <ArrowDown className="w-2.5 h-2.5" />
                    {behind}
                  </span>
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
          title="Fetch latest from remote"
        >
          Fetch
        </button>

        {/* Primary action: Sync / Push / Pull */}
        {!isUpToDate && syncStatus && (
          <button
            onClick={() => actionFn()}
            disabled={isSyncing}
            className="px-2.5 py-0.5 rounded text-[10px] font-medium bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {isSyncing ? "Syncing\u2026" : actionLabel}
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

      {/* Conflict / diverge banner */}
      {syncError && syncError.includes("diverged") && (
        <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1.5 rounded bg-warning/10 border border-warning/20">
          <AlertTriangle className="text-warning shrink-0 w-3 h-3" />
          <span className="text-[10px] text-warning flex-1">
            Timelines have diverged. Manual merge may be required.
          </span>
        </div>
      )}

      {/* General error message (non-diverge) */}
      {syncError && !syncError.includes("diverged") && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-error" title={syncError}>
          {(syncError.includes("network") || syncError.includes("resolve host") || syncError.includes("Could not resolve") || syncError.includes("timed out")) ? (
            <>
              <Globe className="shrink-0 w-2.5 h-2.5" />
              <span className="truncate">Offline — changes saved locally</span>
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
