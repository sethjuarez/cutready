import { afterEach, describe, expect, it, vi } from "vitest";

const dl = vi.hoisted(() => ({
  preflightIncoming: vi.fn(),
  preflightMerge: vi.fn(),
  mergeIncoming: vi.fn(async (..._args: unknown[]) => "merge123"),
}));
vi.mock("../services/draftlineVersioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/draftlineVersioning")>()),
  preflightDraftlineIncoming: dl.preflightIncoming,
  preflightDraftlineMergeIncoming: dl.preflightMerge,
  mergeDraftlineIncomingWithToken: dl.mergeIncoming,
}));
vi.mock("../services/githubSetup", () => ({ getGitHubAuthStatus: async () => ({ connected: true }) }));

import { MERGE_UPDATES_CHANGED_MESSAGE } from "../services/draftlineErrors";
import { useAppStore } from "../stores/appStore";
import { useMergeNameStore } from "../stores/mergeNameStore";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";
import { beginWorkspaceGeneration } from "../stores/workspaceHelpers";

const originals = [useAppStore.getState(), useSyncStore.getState(), useVersioningStore.getState()] as const;
const TOKEN = { remote: "origin", variation: "main", local_oid: "a1", remote_oid: "b2", merge_base_oid: "c3" };

function startCleanIncomingMerge() {
  const noop = vi.fn(async () => undefined);
  useAppStore.setState({ loadSketches: noop, loadStoryboards: noop, loadNotes: noop });
  useSyncStore.setState({
    currentRemote: { name: "origin", url: "https://github.com/contoso/talk.git" },
    refreshSyncStatus: noop,
    refreshIncomingCommits: noop,
  });
  useVersioningStore.setState({
    loadVersions: noop,
    loadGraphData: noop,
    loadTimelines: noop,
    checkDirty: noop,
    timelines: [{ name: "main", label: "Keynote", is_active: true, snapshot_count: 3, color_index: 0 }],
  });
  dl.preflightIncoming.mockResolvedValue({ canProceed: false, dirtyFiles: [], syncStatus: { state: "needsMerge", ahead: 1, behind: 1 } });
  dl.preflightMerge.mockResolvedValue({ canMergeCleanly: true, token: TOKEN, conflicts: [], syncStatus: { ahead: 1, behind: 1 } });
  return useSyncStore.getState().pullFromRemote();
}

afterEach(() => {
  dl.mergeIncoming.mockClear();
  useMergeNameStore.setState({ pending: null });
  useAppStore.setState(originals[0], true);
  useSyncStore.setState(originals[1], true);
  useVersioningStore.setState(originals[2], true);
});

describe("pullFromRemote merge naming", () => {
  it("merges incoming saves only under the approved name", async () => {
    const pull = startCleanIncomingMerge();
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending?.defaultName).toBe("Merge updates from Keynote"));
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
    useMergeNameStore.getState().answer("Merge Ana's edits");
    await pull;
    expect(dl.mergeIncoming).toHaveBeenCalledWith(TOKEN, "Merge Ana's edits", "origin");
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it("doesn't merge when naming is cancelled", async () => {
    const pull = startCleanIncomingMerge();
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending).not.toBeNull());
    useMergeNameStore.getState().answer(null);
    await pull;
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it("drops the merge when the project changes while it's being named", async () => {
    const pull = startCleanIncomingMerge();
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending).not.toBeNull());
    beginWorkspaceGeneration("C:/other-talk");
    expect(useMergeNameStore.getState().pending).toBeNull();
    await pull;
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
  });

  it.each(["remote_race", "local_state_changed"])("explains a %s refusal of the previewed merge", async (code) => {
    dl.mergeIncoming.mockRejectedValueOnce({ code, message: "moved" });
    const pull = startCleanIncomingMerge();
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending).not.toBeNull());
    useMergeNameStore.getState().answer("Merge Ana's edits");
    await pull;
    expect(useSyncStore.getState().syncError).toBe(MERGE_UPDATES_CHANGED_MESSAGE);
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });
});
