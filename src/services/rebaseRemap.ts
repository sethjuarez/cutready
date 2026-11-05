// Points everything the app holds by version id at the replayed saves' new ids.
import { hasRebasedIds, remapId, remapTabGroup, type RebasedIds } from "../domain/versioning/rebaseRemap";
import { makeMainTabId, makeSplitTabId, useAppStore } from "../stores/appStore";
import { useVersioningStore } from "../stores/versioningStore";

export function applyRebasedIds(ids: RebasedIds): void {
  if (!hasRebasedIds(ids)) return;
  const app = useAppStore.getState();
  const main = remapTabGroup(app.openTabs, app.activeTabId, ids, makeMainTabId);
  const split = remapTabGroup(app.splitTabs, app.splitActiveTabId, ids, makeSplitTabId);
  useAppStore.setState({
    openTabs: main.tabs,
    activeTabId: main.activeTabId,
    splitTabs: split.tabs,
    splitActiveTabId: split.activeTabId,
  });
  for (const id of main.gone) useAppStore.getState().closeTab(id);
  for (const id of split.gone) useAppStore.getState().closeTabInSplit(id);
  useAppStore.getState()._persistTabs();

  useVersioningStore.setState((state) => {
    const started = state.startedBranchFromSnapshot;
    const snapshotId = started ? remapId(started.snapshotId, ids) : null;
    const selection = state.diffSelection;
    const from = selection ? remapId(selection.from, ids) : null;
    const to = selection ? remapId(selection.to, ids) : null;
    return {
      startedBranchFromSnapshot: started && snapshotId ? { ...started, snapshotId } : null,
      ...(selection && (from === null || to === null)
        ? { diffSelection: null, diffResult: null }
        : selection
          ? { diffSelection: { from: from!, to: to! } }
          : {}),
    };
  });
}
