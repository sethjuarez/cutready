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
import { useToastStore } from "../stores/toastStore";
import { MERGE_UPDATES_CHANGED_MESSAGE } from "../services/draftlineErrors";

const originalVersioning = useVersioningStore.getState();
const originalSync = useSyncStore.getState();
const originalApp = useAppStore.getState();

function startConflictMerge(source: string | null) {
  const noop = vi.fn(async () => undefined);
  useAppStore.setState({ loadSketches: noop, loadStoryboards: noop, loadNotes: noop, loadChatArtifacts: noop });
  useSyncStore.setState({ refreshSyncStatus: noop, refreshIncomingCommits: noop });
  useVersioningStore.setState({
    loadVersions: noop,
    loadGraphData: noop,
    loadTimelines: noop,
    checkDirty: noop,
    timelines: [{ name: "keynote", label: "Keynote", is_active: true, snapshot_count: 2, color_index: 0 }],
    isMerging: true,
    mergeSource: "team updates",
    mergeTarget: "incoming",
    mergeConflicts: [],
    draftlineMergeToken: { source } as never,
    draftlineMergeRemote: "origin",
    draftlineMergeIncoming: [{ name: "#24 lead queue", comment: "", author: "Dana" }],
  });
}

afterEach(() => {
  merge.mockClear();
  useMergeNameStore.setState({ pending: null });
  useVersioningStore.setState(originalVersioning, true);
  useSyncStore.setState(originalSync, true);
  useAppStore.setState(originalApp, true);
});

describe("applyMergeResolution for team updates", () => {
  it.each([null, "main"])("saves the resolved updates under the generated name without asking (source %s)", async (source) => {
    startConflictMerge(source);
    await expect(useVersioningStore.getState().applyMergeResolution([{ path: "intro.sk", content: "{}" }])).resolves.toBe("merge123");
    expect(useMergeNameStore.getState().pending).toBeNull();
    expect(merge.mock.calls[0][1]).toBe("Bring in team updates\n\n- #24 lead queue (Dana)");
    expect(useVersioningStore.getState().isMerging).toBe(false);
    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain("Got 1 team update.");
  });

  it.each(["local_state_changed", "remote_race"])(
    "tells the user the updates changed and brings in nothing when Draftline rejects a stale token (%s)",
    async (code) => {
      startConflictMerge(null);
      const loadVersions = vi.fn(async () => undefined);
      useVersioningStore.setState({ loadVersions });
      // A successful refresh clears syncError, as the real one does.
      useSyncStore.setState({ refreshSyncStatus: vi.fn(async () => useSyncStore.setState({ syncError: null })) });
      merge.mockRejectedValueOnce({ code, message: "token is stale" });
      await expect(useVersioningStore.getState().applyMergeResolution([{ path: "intro.sk", content: "{}" }])).resolves.toBeNull();

      expect(useSyncStore.getState().syncError).toBe(MERGE_UPDATES_CHANGED_MESSAGE);
      expect(useToastStore.getState().toasts.map((toast) => toast.message)).toContain(MERGE_UPDATES_CHANGED_MESSAGE);
      const state = useVersioningStore.getState();
      expect(state.isMerging).toBe(false);
      expect(state.draftlineMergeToken).toBeNull();
      expect(loadVersions).not.toHaveBeenCalled();
    },
  );

  it("passes other failures to the caller", async () => {
    startConflictMerge(null);
    merge.mockRejectedValueOnce({ code: "invalid_merge_resolution", message: "bad" });
    await expect(useVersioningStore.getState().applyMergeResolution([])).rejects.toMatchObject({ code: "invalid_merge_resolution" });
    expect(useVersioningStore.getState().isMerging).toBe(true);
  });
});
