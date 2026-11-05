import { afterEach, describe, expect, it, vi } from "vitest";

const dl = vi.hoisted(() => ({
  preflightIncoming: vi.fn(),
  preflightMerge: vi.fn(),
  applyIncoming: vi.fn(async () => undefined),
  mergeIncoming: vi.fn(async (..._args: unknown[]) => "merge123"),
  publish: vi.fn(async () => undefined),
  auth: vi.fn(async () => ({ connected: true })),
}));
vi.mock("../services/draftlineVersioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/draftlineVersioning")>()),
  preflightDraftlineIncoming: dl.preflightIncoming,
  preflightDraftlineMergeIncoming: dl.preflightMerge,
  applyDraftlineIncoming: dl.applyIncoming,
  mergeDraftlineIncomingWithToken: dl.mergeIncoming,
  publishDraftlineChanges: dl.publish,
}));
vi.mock("../services/githubSetup", () => ({ getGitHubAuthStatus: dl.auth }));

import { MERGE_UPDATES_CHANGED_MESSAGE } from "../services/draftlineErrors";
import { SAVE_BEFORE_UPDATES_MESSAGE, TEAM_UPDATES_SOURCE } from "../services/teamUpdates";
import { useAppStore } from "../stores/appStore";
import { useMergeNameStore } from "../stores/mergeNameStore";
import { useSyncStore } from "../stores/syncStore";
import { useToastStore } from "../stores/toastStore";
import { useVersioningStore } from "../stores/versioningStore";
import { beginWorkspaceGeneration } from "../stores/workspaceHelpers";

const originals = [useAppStore.getState(), useSyncStore.getState(), useVersioningStore.getState()] as const;
const TOKEN = { remote: "origin", variation: "main", local_oid: "a1", remote_oid: "b2", merge_base_oid: "c3" };
const INCOMING = [{ name: "#24 lead queue with wing-light hero", comment: "", author: "Dana" }];

function connect(status = { state: "needsMerge", ahead: 1, behind: 1 }) {
  const noop = vi.fn(async () => undefined);
  useAppStore.setState({ loadSketches: noop, loadStoryboards: noop, loadNotes: noop, loadChatArtifacts: noop });
  useSyncStore.setState({
    currentRemote: { name: "origin", url: "https://github.com/contoso/talk.git" },
    refreshSyncStatus: noop,
    refreshIncomingCommits: noop,
    syncStatus: { ahead: status.ahead, behind: status.behind },
  });
  useVersioningStore.setState({ loadVersions: noop, loadGraphData: noop, loadTimelines: noop, checkDirty: noop });
  dl.preflightIncoming.mockResolvedValue({ canProceed: false, dirtyFiles: [], syncStatus: status });
  dl.preflightMerge.mockResolvedValue({ canMergeCleanly: true, token: TOKEN, conflicts: [], incoming: INCOMING, dirtyFiles: [], syncStatus: status });
}

afterEach(() => {
  vi.clearAllMocks();
  useMergeNameStore.setState({ pending: null });
  useAppStore.setState(originals[0], true);
  useSyncStore.setState(originals[1], true);
  useVersioningStore.setState(originals[2], true);
});

describe("getting team updates", () => {
  it("brings in diverged updates without asking for a name", async () => {
    connect();
    const outcome = await useSyncStore.getState().pullFromRemote();
    expect(outcome).toEqual({ kind: "brought-in", count: 1 });
    expect(useMergeNameStore.getState().pending).toBeNull();
    expect(dl.mergeIncoming).toHaveBeenCalledWith(TOKEN, "Brought in team updates\n\n- #24 lead queue with wing-light hero (Dana)", "origin");
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });

  it("fast-forwards when only the team moved", async () => {
    connect({ state: "behind", ahead: 0, behind: 2 });
    dl.preflightIncoming.mockResolvedValue({ canProceed: true, dirtyFiles: [], syncStatus: { state: "behind", ahead: 0, behind: 2 } });
    expect(await useSyncStore.getState().pullFromRemote()).toEqual({ kind: "brought-in", count: 2 });
    expect(dl.applyIncoming).toHaveBeenCalledWith("origin");
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
  });

  it("asks for a save first when there's unsaved work", async () => {
    connect();
    dl.preflightIncoming.mockResolvedValue({ canProceed: false, dirtyFiles: ["intro.sk"], syncStatus: { state: "needsMerge", ahead: 1, behind: 1 } });
    expect((await useSyncStore.getState().pullFromRemote())?.kind).toBe("blocked");
    expect(useSyncStore.getState().syncError).toBe(SAVE_BEFORE_UPDATES_MESSAGE);
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
  });

  it("opens the conflict panel only on a real conflict", async () => {
    connect();
    dl.preflightMerge.mockResolvedValue({
      canMergeCleanly: false, token: TOKEN, incoming: INCOMING, dirtyFiles: [],
      conflicts: [{ path: "compass.sk" }], syncStatus: { ahead: 1, behind: 1 },
    });
    expect((await useSyncStore.getState().pullFromRemote())?.kind).toBe("conflict");
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
    expect(useVersioningStore.getState()).toMatchObject({ isMerging: true, mergeSource: TEAM_UPDATES_SOURCE, draftlineMergeRemote: "origin" });
  });

  it.each(["remote_race", "local_state_changed"])("explains a %s refusal and merges nothing", async (code) => {
    connect();
    dl.mergeIncoming.mockRejectedValueOnce({ code, message: "moved" });
    expect(await useSyncStore.getState().pullFromRemote()).toBeNull();
    expect(useSyncStore.getState().syncError).toBe(MERGE_UPDATES_CHANGED_MESSAGE);
    expect(useSyncStore.getState().isSyncing).toBe(false);
  });
});

describe("send with team updates waiting", () => {
  function sendSetup(hybrid: boolean) {
    connect();
    const pushToRemote = vi.fn(async () => {
      useSyncStore.setState({ syncStatus: { ahead: 0, behind: 0 } });
      return true;
    });
    const sendForReview = vi.fn(async () => true);
    // After the update, the merge itself is one more save to send.
    const refreshSyncStatus = vi.fn(async () => {
      if (dl.mergeIncoming.mock.calls.length > 0) useSyncStore.setState({ syncStatus: { ahead: 2, behind: 0 } });
    });
    useSyncStore.setState({ fetchFromRemote: vi.fn(async () => undefined), pushToRemote, sendForReview, refreshSyncStatus });
    useAppStore.setState({ currentProject: { name: "talk", root: "C:/talk", hybrid } as never });
    return { pushToRemote, sendForReview };
  }

  it("brings updates in, then actually sends", async () => {
    const { pushToRemote } = sendSetup(false);
    const show = vi.spyOn(useToastStore.getState(), "showUpdate");
    await useSyncStore.getState().syncWithRemote();
    expect(dl.mergeIncoming).toHaveBeenCalledOnce();
    expect(pushToRemote).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith("Sent ✓ (also picked up 1 team update)", "success");
    expect(useMergeNameStore.getState().pending).toBeNull();
  });

  it("sends a hybrid project for review under the user's own save name", async () => {
    const { sendForReview } = sendSetup(true);
    await useSyncStore.getState().syncWithRemote({ name: "initial outline", comment: "first pass" });
    expect(sendForReview).toHaveBeenCalledWith("initial outline", "first pass", 1);
  });

  it("stops the send on a conflict", async () => {
    const { pushToRemote, sendForReview } = sendSetup(false);
    dl.preflightMerge.mockResolvedValue({
      canMergeCleanly: false, token: TOKEN, incoming: INCOMING, dirtyFiles: [],
      conflicts: [{ path: "compass.sk" }], syncStatus: { ahead: 1, behind: 1 },
    });
    await useSyncStore.getState().syncWithRemote();
    expect(pushToRemote).not.toHaveBeenCalled();
    expect(sendForReview).not.toHaveBeenCalled();
    expect(useVersioningStore.getState().isMerging).toBe(true);
  });

  it("never says Sent when the push didn't happen", async () => {
    const { pushToRemote } = sendSetup(false);
    pushToRemote.mockResolvedValueOnce(false);
    const show = vi.spyOn(useToastStore.getState(), "showUpdate");
    await useSyncStore.getState().syncWithRemote();
    expect(pushToRemote).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalledWith(expect.stringContaining("Sent"), "success");
  });

  it("still sends when a document reload fails after the update", async () => {
    const { pushToRemote } = sendSetup(false);
    useAppStore.setState({ loadNotes: vi.fn(async () => { throw new Error("disk"); }) });
    await useSyncStore.getState().syncWithRemote();
    expect(pushToRemote).toHaveBeenCalledOnce();
  });

  it("reports a failed send when the status can't be read after the update", async () => {
    const { pushToRemote } = sendSetup(false);
    useSyncStore.setState({ refreshSyncStatus: vi.fn(async () => { useSyncStore.setState({ syncStatus: null }); }) });
    await useSyncStore.getState().syncWithRemote();
    expect(pushToRemote).not.toHaveBeenCalled();
    expect(useSyncStore.getState().syncError).toMatch(/Nothing was sent/);
  });
});

describe("switching projects mid-update", () => {
  function switchDuring(mock: typeof dl.preflightIncoming, value: unknown) {
    mock.mockImplementationOnce(async () => {
      beginWorkspaceGeneration("C:/other");
      return value;
    });
  }

  it("doesn't fast-forward the newly opened project", async () => {
    connect({ state: "behind", ahead: 0, behind: 2 });
    switchDuring(dl.preflightIncoming, { canProceed: true, dirtyFiles: [], syncStatus: { state: "behind", ahead: 0, behind: 2 } });
    expect(await useSyncStore.getState().pullFromRemote()).toEqual({ kind: "cancelled" });
    expect(dl.applyIncoming).not.toHaveBeenCalled();
  });

  it("doesn't merge or open a conflict in the newly opened project", async () => {
    connect();
    switchDuring(dl.preflightMerge, {
      canMergeCleanly: false, token: TOKEN, incoming: INCOMING, dirtyFiles: [],
      conflicts: [{ path: "compass.sk" }], syncStatus: { ahead: 1, behind: 1 },
    });
    expect(await useSyncStore.getState().pullFromRemote()).toEqual({ kind: "cancelled" });
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
    expect(useVersioningStore.getState().isMerging).toBe(false);
  });

  it("doesn't send the newly opened project when the switch happens during the credential check", async () => {
    connect({ state: "ahead", ahead: 1, behind: 0 });
    useVersioningStore.setState({
      timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 1, color_index: 0 }],
      checkLargeFiles: vi.fn(async () => []),
      refreshChangedFiles: vi.fn(async () => undefined),
    });
    useAppStore.setState({ currentProject: { name: "talk", root: "C:/talk" } as never });
    dl.auth.mockImplementationOnce(async () => {
      beginWorkspaceGeneration("C:/other");
      return { connected: true };
    });
    expect(await useSyncStore.getState().pushToRemote()).toBe(false);
    expect(dl.publish).not.toHaveBeenCalled();
    // Control: without a switch, the same setup really pushes.
    expect(await useSyncStore.getState().pushToRemote()).toBe(true);
    expect(dl.publish).toHaveBeenCalledOnce();
  });
});
