import { useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { useSettings } from "../hooks/useSettings";

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

  // Periodic fetch every 5 minutes when remote is configured
  useEffect(() => {
    if (!currentRemote) return;
    const interval = setInterval(() => {
      fetchFromRemote();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
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
    <div className="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]/50">
      {/* Remote URL line */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isSyncing
              ? "bg-amber-400 animate-pulse"
              : currentRemote
                ? "bg-emerald-400"
                : "bg-zinc-400"
          }`}
        />
        <span className="text-[10px] text-[var(--color-text-secondary)] truncate flex-1">
          {displayUrl}
        </span>
      </div>

      {/* Status + actions */}
      <div className="flex items-center gap-2">
        {/* Ahead/behind badges */}
        {syncStatus && (
          <div className="flex items-center gap-1.5 text-[10px]">
            {isUpToDate ? (
              <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Up to date
              </span>
            ) : (
              <>
                {ahead > 0 && (
                  <span className="text-[var(--color-accent)] flex items-center gap-0.5" title={`${ahead} unpublished snapshot${ahead !== 1 ? "s" : ""}`}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                    {ahead}
                  </span>
                )}
                {behind > 0 && (
                  <span className="text-amber-600 dark:text-amber-400 flex items-center gap-0.5" title={`${behind} incoming snapshot${behind !== 1 ? "s" : ""}`}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <polyline points="19 12 12 19 5 12" />
                    </svg>
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
          className="px-2 py-0.5 rounded text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)]/50 transition-colors disabled:opacity-40"
          title="Fetch latest from remote"
        >
          Fetch
        </button>

        {/* Primary action: Sync / Push / Pull */}
        {!isUpToDate && syncStatus && (
          <button
            onClick={() => actionFn()}
            disabled={isSyncing}
            className="px-2.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {isSyncing ? "Syncing\u2026" : actionLabel}
          </button>
        )}

        {/* Open PR button — shown for non-main branches */}
        {currentRemote?.url && prUrl && (
          <button
            onClick={() => window.open(prUrl, "_blank")}
            className="px-2 py-0.5 rounded text-[10px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent)]/5 transition-colors"
            title="Open Pull Request on GitHub"
          >
            PR
          </button>
        )}
      </div>

      {/* Conflict / diverge banner */}
      {syncError && syncError.includes("diverged") && (
        <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/20">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-[10px] text-amber-600 dark:text-amber-400 flex-1">
            Timelines have diverged. Manual merge may be required.
          </span>
        </div>
      )}

      {/* General error message (non-diverge) */}
      {syncError && !syncError.includes("diverged") && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-red-500 dark:text-red-400" title={syncError}>
          {(syncError.includes("network") || syncError.includes("resolve host") || syncError.includes("Could not resolve") || syncError.includes("timed out")) ? (
            <>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <line x1="1" y1="1" x2="23" y2="23" /><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" /><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" /><path d="M10.71 5.05A16 16 0 0 1 22.56 9" /><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><line x1="12" y1="20" x2="12.01" y2="20" />
              </svg>
              <span className="truncate">Offline — changes saved locally</span>
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
