import { useEffect, useState } from "react";
import type { PathHistory } from "@draftline/client";
import { loadPathHistory } from "../../services/versionHistory";
import { useVersioningStore } from "../../stores/versioningStore";

export interface PathHistoryState {
  history: PathHistory | null;
  loading: boolean;
  error: string | null;
}

/** Loads per-document history for `path` (a Draftline path), reloading when the versioning store refreshes. */
export function usePathHistory(path: string | null): PathHistoryState {
  const refreshKey = useVersioningStore((s) => s.graphNodes);
  const [state, setState] = useState<PathHistoryState>({ history: null, loading: false, error: null });

  useEffect(() => {
    if (!path) {
      setState({ history: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ history: null, loading: true, error: null });
    loadPathHistory(path).then(
      (history) => { if (!cancelled) setState({ history, loading: false, error: null }); },
      (err) => { if (!cancelled) setState({ history: null, loading: false, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { cancelled = true; };
  }, [path, refreshKey]);

  return state;
}
