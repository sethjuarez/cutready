import { useEffect, useCallback, useState } from "react";
import { useTheme } from "./hooks/useTheme";
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys";
import { useDiagnostics } from "./hooks/useDiagnostics";
import { getCurrentDeepLinkUrl, useDeepLink } from "./hooks/useDeepLink";
import { warmFfmpegStatus } from "./hooks/useFfmpegStatus";
import { StatusBar } from "./components/StatusBar";
import { AppLayout } from "./components/AppLayout";
import { ToastContainer } from "./components/ToastContainer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppCloseGuard } from "./components/AppCloseGuard";
import { invoke, listen } from "./services/tauri";
import { isMac } from "./utils/platform";

import { useAppStore } from "./stores/appStore";
import { useUpdateStore } from "./stores/updateStore";

function App() {
  useTheme();
  useGlobalHotkeys();
  useDiagnostics();
  useDeepLink();

  const [resetKey, setResetKey] = useState(0);
  const handleReset = useCallback(() => setResetKey((k) => k + 1), []);
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? "none");
  const projectSwitching = useAppStore((s) => s.projectSwitching);
  const errorBoundaryResetKey = `${resetKey}:${projectRoot}:${projectSwitching ? "switching" : "ready"}`;

  // Auto-open last project on startup
  useEffect(() => {
    let cancelled = false;
    async function openStartupProject() {
      const deepLinkUrl = await getCurrentDeepLinkUrl();
      if (cancelled) return;
      if (deepLinkUrl) return;

      const startupProject = await invoke<string | null>("get_startup_project_path").catch(() => null);
      if (cancelled) return;

      const projectToOpen = startupProject || localStorage.getItem("cutready:lastProject");
      if (projectToOpen) {
        await useAppStore.getState().openProject(projectToOpen);
      } else {
        useAppStore.getState().loadRecentProjects();
      }
      if (import.meta.env.DEV && import.meta.env.VITE_CUTREADY_STARTUP_VIEW === "settings") {
        useAppStore.getState().setView("settings");
      }
    }
    openStartupProject();
    warmFfmpegStatus();
    // Silent update check on startup
    useUpdateStore.getState().checkForUpdate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    let rerun = false;

    const refreshFromDraftlineEvent = async () => {
      if (refreshing) {
        rerun = true;
        return;
      }
      refreshing = true;
      try {
        do {
          rerun = false;
          const store = useAppStore.getState();
          if (store.currentProject) {
            await Promise.all([
              store.checkDirty(),
              store.refreshChangedFiles(),
              store.loadVersions(),
              store.loadGraphData(),
              store.loadTimelines(),
              store.refreshSyncStatus(),
              store.refreshIncomingCommits(),
            ]);
          }
        } while (rerun && !disposed);
      } finally {
        refreshing = false;
      }
    };

    let unlisten: (() => void) | undefined;
    listen("draftline://workspace_event", () => {
      void refreshFromDraftlineEvent();
    }).then((off) => {
      if (disposed) {
        off();
      } else {
        unlisten = off;
      }
    }).catch(() => {
      // Explicit command refreshes remain authoritative if event subscription is unavailable.
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <ErrorBoundary
      resetKey={errorBoundaryResetKey}
      fallback={
        <div className="h-full bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] flex items-center justify-center">
          <div className="text-center space-y-4">
            <p className="text-lg font-medium text-[rgb(var(--color-text))]">Something went wrong</p>
            <p className="text-sm text-[rgb(var(--color-text-secondary))]">An unexpected error crashed the interface.</p>
            <button
              onClick={handleReset}
              className="px-4 py-2 rounded-lg bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] text-sm font-medium hover:bg-[rgb(var(--color-accent-hover))] transition-colors"
            >
              Reload interface
            </button>
          </div>
        </div>
      }
    >
      <div className={`h-full bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]${isMac ? " mac-window-shell" : ""}`}>
        <AppLayout />
        <AppCloseGuard />
        <StatusBar />
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
}

export default App;
