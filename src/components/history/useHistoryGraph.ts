import { useEffect, useState } from "react";
import type { WorkspaceGraph } from "@draftline/client";
import { loadHistoryGraph } from "../../services/versionHistory";
import { useVersioningStore } from "../../stores/versioningStore";

export interface HistoryGraphState {
  graph: WorkspaceGraph | null;
  loading: boolean;
  error: string | null;
}

/** Loads the current timeline's graph, reloading whenever the versioning store refreshes its own. */
export function useHistoryGraph(): HistoryGraphState {
  const refreshKey = useVersioningStore((s) => s.graphNodes);
  const [state, setState] = useState<HistoryGraphState>({ graph: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    loadHistoryGraph().then(
      (graph) => { if (!cancelled) setState({ graph, loading: false, error: null }); },
      (err) => { if (!cancelled) setState({ graph: null, loading: false, error: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { cancelled = true; };
  }, [refreshKey]);

  return state;
}
