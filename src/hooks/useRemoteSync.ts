import { useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { useSyncStore } from "../stores/syncStore";

const FETCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Detects the project's remote and checks for incoming work every 5 minutes.
 * The timer pauses while the app is hidden and catches up when it returns.
 */
export function useRemoteSync() {
  const projectRoot = useAppStore((s) => s.currentProject?.repo_root ?? null);
  const currentRemote = useSyncStore((s) => s.currentRemote);
  const detectRemote = useSyncStore((s) => s.detectRemote);
  const fetchFromRemote = useSyncStore((s) => s.fetchFromRemote);

  useEffect(() => {
    if (projectRoot) void detectRemote();
  }, [projectRoot, detectRemote]);

  useEffect(() => {
    if (!currentRemote) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const check = () => void fetchFromRemote({ notifyAuthRequired: false });
    const start = () => {
      intervalId ??= setInterval(check, FETCH_INTERVAL_MS);
    };
    const stop = () => {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        check();
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
}
