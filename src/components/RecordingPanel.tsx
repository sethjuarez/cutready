import { useRef, useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { ActionCard } from "./ActionCard";

export function RecordingPanel() {
  const currentProject = useAppStore((s) => s.currentProject);
  const isBrowserReady = useAppStore((s) => s.isBrowserReady);
  const browserChannel = useAppStore((s) => s.browserChannel);
  const isRecording = useAppStore((s) => s.isRecording);
  const capturedActions = useAppStore((s) => s.capturedActions);
  const lastSession = useAppStore((s) => s.lastSession);
  const loading = useAppStore((s) => s.loading);

  const profiles = useAppStore((s) => s.profiles);
  const selectedProfile = useAppStore((s) => s.selectedProfile);
  const browserRunning = useAppStore((s) => s.browserRunning);

  const prepareBrowser = useAppStore((s) => s.prepareBrowser);
  const disconnectBrowser = useAppStore((s) => s.disconnectBrowser);
  const startRecording = useAppStore((s) => s.startRecording);
  const stopRecording = useAppStore((s) => s.stopRecording);
  const detectProfiles = useAppStore((s) => s.detectProfiles);
  const checkBrowsersRunning = useAppStore((s) => s.checkBrowsersRunning);
  const setSelectedProfile = useAppStore((s) => s.setSelectedProfile);
  const error = useAppStore((s) => s.error);
  const clearError = useAppStore((s) => s.clearError);

  const listRef = useRef<HTMLDivElement>(null);

  // Load profiles when entering Phase 1 (no browser connected)
  useEffect(() => {
    if (!isBrowserReady && currentProject) {
      detectProfiles();
      checkBrowsersRunning();
    }
  }, [isBrowserReady, currentProject, detectProfiles, checkBrowsersRunning]);

  // Refresh browser running status periodically while in Phase 1
  useEffect(() => {
    if (isBrowserReady || !currentProject || !selectedProfile) return;
    const timer = setInterval(checkBrowsersRunning, 3000);
    return () => clearInterval(timer);
  }, [isBrowserReady, currentProject, selectedProfile, checkBrowsersRunning]);

  // Auto-scroll to the bottom as new actions come in
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [capturedActions.length]);

  // Helper: is the selected profile's browser currently running?
  const isSelectedBrowserRunning =
    selectedProfile &&
    browserRunning &&
    ((selectedProfile.browser === "msedge" && browserRunning.msedge) ||
      (selectedProfile.browser === "chrome" && browserRunning.chrome));

  // Helper: unique key for a profile
  const profileKey = (p: { browser: string; profile_directory: string }) =>
    `${p.browser}::${p.profile_directory}`;

  // ── No project open ───────────────────────────────────────

  if (!currentProject) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center">
          <h2 className="text-lg font-semibold text-[var(--color-text)]">
            No Project Open
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Open or create a project to start recording.
          </p>
        </div>
      </div>
    );
  }

  // ── Friendly browser channel name ─────────────────────────

  const channelLabel =
    browserChannel === "chrome"
      ? "Chrome"
      : browserChannel === "msedge"
        ? "Edge"
        : browserChannel === "chromium"
          ? "Chromium"
          : "Browser";

  // ── Phase 1: No browser connected — Profile picker ───────

  if (!isBrowserReady) {
    return (
      <div className="flex h-full flex-col p-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">
            Record Demo
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Choose a browser profile to record with your extensions and
            bookmarks, or use a fresh browser.
          </p>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center">
          <div className="w-full max-w-sm">
            {/* Profile selector */}
            <label className="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
              Browser Profile
            </label>
            <select
              value={
                selectedProfile ? profileKey(selectedProfile) : "__fresh__"
              }
              onChange={(e) => {
                if (e.target.value === "__fresh__") {
                  setSelectedProfile(null);
                } else {
                  const match = profiles.find(
                    (p) => profileKey(p) === e.target.value,
                  );
                  setSelectedProfile(match ?? null);
                }
              }}
              className="mb-4 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-accent)]"
            >
              {profiles.map((p) => (
                <option key={profileKey(p)} value={profileKey(p)}>
                  {p.display_name} ({p.browser_name})
                </option>
              ))}
              <option value="__fresh__">Fresh browser (no extensions)</option>
            </select>

            {/* Browser running warning */}
            {isSelectedBrowserRunning && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-0.5 shrink-0 text-amber-500"
                >
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div>
                  <p className="text-xs font-medium text-amber-500">
                    Close{" "}
                    {selectedProfile?.browser === "msedge" ? "Edge" : "Chrome"}{" "}
                    first
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                    The browser must be closed to use your profile with
                    extensions.
                  </p>
                </div>
              </div>
            )}

            {/* Error display */}
            {error && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
                <div className="flex-1">
                  <p className="text-xs font-medium text-red-400">
                    Failed to open browser
                  </p>
                  <p className="mt-0.5 break-all text-xs text-[var(--color-text-secondary)]">
                    {error}
                  </p>
                </div>
                <button
                  onClick={clearError}
                  className="shrink-0 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}

            {/* Open Browser button */}
            <button
              onClick={prepareBrowser}
              disabled={loading || !!isSelectedBrowserRunning}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            >
              {loading ? (
                <svg
                  className="animate-spin"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="14" rx="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              )}
              Open Browser
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Phase 2: Browser ready, not recording ────────────────

  if (!isRecording && !lastSession) {
    return (
      <div className="flex h-full flex-col p-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">
            Record Demo
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Navigate to your demo starting point, then click &ldquo;Ready to
            Record&rdquo; when you&rsquo;re set.
          </p>
        </div>

        {/* Browser status */}
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-[var(--color-accent)]/10 px-3 py-2">
          <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" />
          <span className="text-sm font-medium text-[var(--color-accent)]">
            {channelLabel} connected
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
              Set up your demo in the browser, then start recording.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={startRecording}
                disabled={loading}
                className="flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <circle cx="12" cy="12" r="10" />
                </svg>
                Ready to Record
              </button>
              <span className="text-xs text-[var(--color-text-secondary)]">
                or press{" "}
                <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] px-1.5 py-0.5 font-mono text-[10px]">
                  Ctrl+Shift+R
                </kbd>
              </span>
            </div>
            <button
              onClick={disconnectBrowser}
              disabled={loading}
              className="mt-6 text-xs text-[var(--color-text-secondary)] underline decoration-[var(--color-border)] underline-offset-2 transition-colors hover:text-[var(--color-text)]"
            >
              Close Browser
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Phase 3: Recording active ────────────────────────────

  if (isRecording) {
    return (
      <div className="flex h-full flex-col p-6">
        <div className="mb-4">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">
            Record Demo
          </h1>
        </div>

        {/* Recording status */}
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
          <span className="text-sm font-medium text-red-400">
            Recording in progress
          </span>
          <span className="text-sm text-[var(--color-text-secondary)]">
            — {capturedActions.length} action
            {capturedActions.length !== 1 ? "s" : ""} captured
          </span>
        </div>

        {/* Stop button */}
        <div className="mb-4 flex items-center gap-3">
          <button
            onClick={stopRecording}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            Stop Recording
          </button>
          <span className="text-xs text-[var(--color-text-secondary)]">
            or press{" "}
            <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] px-1.5 py-0.5 font-mono text-[10px]">
              Ctrl+Shift+R
            </kbd>
          </span>
        </div>

        {/* Action list */}
        <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto">
          {capturedActions.length === 0 && (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
              Interact with the browser — actions will appear here in real time.
            </div>
          )}
          {capturedActions.map((action, i) => (
            <ActionCard key={i} action={action} index={i} />
          ))}
        </div>
      </div>
    );
  }

  // ── Phase 4: Recording complete, browser still connected ─

  return (
    <div className="flex h-full flex-col p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-[var(--color-text)]">
          Record Demo
        </h1>
      </div>

      {/* Browser status */}
      <div className="mb-4 flex items-center gap-2 rounded-lg bg-[var(--color-accent)]/10 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" />
        <span className="text-sm font-medium text-[var(--color-accent)]">
          {channelLabel} connected
        </span>
      </div>

      {/* Summary */}
      <div className="mb-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-alt)] p-4">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">
          Recording Complete
        </h3>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Captured {capturedActions.length} action
          {capturedActions.length !== 1 ? "s" : ""}. Continue to the Script
          Editor to refine your demo script, or record another take.
        </p>
      </div>

      {/* Action list */}
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto">
        {capturedActions.map((action, i) => (
          <ActionCard key={i} action={action} index={i} />
        ))}
      </div>

      {/* Bottom actions */}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={startRecording}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10" />
          </svg>
          Record Again
        </button>
        <button
          onClick={disconnectBrowser}
          disabled={loading}
          className="text-xs text-[var(--color-text-secondary)] underline decoration-[var(--color-border)] underline-offset-2 transition-colors hover:text-[var(--color-text)]"
        >
          Close Browser
        </button>
      </div>
    </div>
  );
}

