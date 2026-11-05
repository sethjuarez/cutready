import { useEffect } from "react";
import { pruneDiscardShelves } from "../services/discardShelves";
import { useAppStore } from "../stores/appStore";
import { useChangeSummaryStore } from "../stores/changeSummaryStore";
import { useHistoryFilterStore } from "../stores/historyFilterStore";
import { projectToDraftlinePath } from "../utils/draftlinePaths";
import { useRemoteSync } from "./useRemoteSync";

/** Opens the History document tab, showing the whole project. */
export function openHistoryTab() {
  useHistoryFilterStore.getState().setDocument(null);
  showHistoryTab();
}

/** Opens the History tab filtered to one document, given its active-project path. */
export function openDocumentHistory(projectPath: string, title: string) {
  const path = projectToDraftlinePath(projectPath, useAppStore.getState().currentProject);
  useHistoryFilterStore.getState().setDocument({ path, title });
  showHistoryTab();
}

function showHistoryTab() {
  useChangeSummaryStore.getState().setPopoverOpen(false);
  useAppStore.getState().openTab({ type: "history", path: "__history__", title: "History" });
}

/** Per-project versioning upkeep: remote checks, stale discard shelves, and a fresh chip on switch. */
export function useVersioningLifecycle() {
  // `root`, not `repo_root`: projects in one multi-project repository share a repo_root.
  const projectRoot = useAppStore((s) => s.currentProject?.root ?? null);
  useRemoteSync();

  useEffect(() => {
    useChangeSummaryStore.getState().reset();
    useHistoryFilterStore.getState().setDocument(null);
    if (!projectRoot) return;
    void pruneDiscardShelves().catch((err) => console.warn("Couldn't prune old discards:", err));
  }, [projectRoot]);
}
