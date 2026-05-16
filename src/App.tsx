import { useEffect, useCallback, useState } from "react";
import { useTheme } from "./hooks/useTheme";
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys";
import { useDebugLog } from "./hooks/useDebugLog";
import { useDiagnostics } from "./hooks/useDiagnostics";
import { getCurrentDeepLinkUrl, useDeepLink } from "./hooks/useDeepLink";
import { StatusBar } from "./components/StatusBar";
import { AppLayout } from "./components/AppLayout";
import { ToastContainer } from "./components/ToastContainer";
import { ErrorBoundary } from "./components/ErrorBoundary";

import { useAppStore } from "./stores/appStore";
import { useUpdateStore } from "./stores/updateStore";

function App() {
  useTheme();
  useGlobalHotkeys();
  useDebugLog();
  useDiagnostics();
  useDeepLink();

  const [resetKey, setResetKey] = useState(0);
  const handleReset = useCallback(() => setResetKey((k) => k + 1), []);

  // Auto-open last project on startup
  useEffect(() => {
    let cancelled = false;
    async function openStartupProject() {
      const deepLinkUrl = await getCurrentDeepLinkUrl();
      if (cancelled) return;
      if (deepLinkUrl) return;

      const lastProject = localStorage.getItem("cutready:lastProject");
      if (lastProject) {
        useAppStore.getState().openProject(lastProject);
      } else {
        useAppStore.getState().loadRecentProjects();
      }
    }
    openStartupProject();
    // Silent update check on startup
    useUpdateStore.getState().checkForUpdate();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ErrorBoundary
      resetKey={resetKey}
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
      <div className="h-full bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))]">
        <AppLayout />
        <StatusBar />
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
}

export default App;

