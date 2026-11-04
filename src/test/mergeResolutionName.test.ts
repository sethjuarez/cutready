import { afterEach, describe, expect, it, vi } from "vitest";

const merge = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "merge123"));
vi.mock("../services/draftlineVersioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/draftlineVersioning")>()),
  mergeDraftlineIncomingWithResolutions: merge,
}));

import { useAppStore } from "../stores/appStore";
import { useMergeNameStore } from "../stores/mergeNameStore";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";

const originalVersioning = useVersioningStore.getState();
const originalSync = useSyncStore.getState();
const originalApp = useAppStore.getState();

function startConflictMerge(source: string | null) {
  const noop = vi.fn(async () => undefined);
  useAppStore.setState({ loadSketches: noop, loadStoryboards: noop, loadNotes: noop });
  useSyncStore.setState({ refreshSyncStatus: noop, refreshIncomingCommits: noop });
  useVersioningStore.setState({
    loadVersions: noop,
    loadGraphData: noop,
    loadTimelines: noop,
    checkDirty: noop,
    timelines: [{ name: "keynote", label: "Keynote", is_active: true, snapshot_count: 2, color_index: 0 }],
    isMerging: true,
    mergeSource: "origin",
    mergeTarget: "incoming",
    mergeConflicts: [],
    draftlineMergeToken: { source } as never,
    draftlineMergeRemote: "origin",
  });
}

afterEach(() => {
  merge.mockClear();
  useMergeNameStore.setState({ pending: null });
  useVersioningStore.setState(originalVersioning, true);
  useSyncStore.setState(originalSync, true);
  useAppStore.setState(originalApp, true);
});

describe("applyMergeResolution", () => {
  it("merges resolved incoming saves under the approved name", async () => {
    startConflictMerge(null);
    const applied = useVersioningStore.getState().applyMergeResolution([{ path: "intro.sk", content: "{}" }]);
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending?.defaultName).toBe("Merge updates from Keynote"));
    useMergeNameStore.getState().answer("Merge Ana's intro");
    await expect(applied).resolves.toBe("merge123");
    expect(merge.mock.calls[0][1]).toBe("Merge Ana's intro");
    expect(useVersioningStore.getState().isMerging).toBe(false);
  });

  it("prefills base merges with the base name", async () => {
    startConflictMerge("main");
    const applied = useVersioningStore.getState().applyMergeResolution([]);
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending?.defaultName).toBe("Merge updates from main"));
    useMergeNameStore.getState().answer("Merge updates from main");
    await applied;
  });

  it("keeps the merge open and writes nothing when naming is cancelled", async () => {
    startConflictMerge(null);
    const applied = useVersioningStore.getState().applyMergeResolution([]);
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending).not.toBeNull());
    useMergeNameStore.getState().answer(null);
    await expect(applied).resolves.toBeNull();
    expect(merge).not.toHaveBeenCalled();
    expect(useVersioningStore.getState().isMerging).toBe(true);
  });
});
