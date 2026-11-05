import { useEffect } from "react";
import { pruneDiscardShelves } from "../services/discardShelves";
import { useAppStore } from "../stores/appStore";
import { useChangeSummaryStore } from "../stores/changeSummaryStore";
import { useRemoteSync } from "./useRemoteSync";

/** Opens the History document tab. */
export function openHistoryTab() {
  useChangeSummaryStore.getState().setPopoverOpen(false);
  useAppStore.getState().openTab({ type: "history", path: "__history__", title: "History" });
}

/** Per-project versioning upkeep: remote checks, stale discard shelves, and a fresh chip on switch. */
export function useVersioningLifecycle() {
  const projectRoot = useAppStore((s) => s.currentProject?.repo_root ?? null);
  useRemoteSync();

  useEffect(() => {
    useChangeSummaryStore.getState().reset();
    if (!projectRoot) return;
    void pruneDiscardShelves().catch((err) => console.warn("Couldn't prune old discards:", err));
  }, [projectRoot]);
}
