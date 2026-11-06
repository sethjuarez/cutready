import { afterEach, describe, expect, it, vi } from "vitest";

const dl = vi.hoisted(() => ({
  preflightIncoming: vi.fn(),
  preflightMerge: vi.fn(),
  applyIncoming: vi.fn(async () => undefined),
  mergeIncoming: vi.fn(async (..._args: unknown[]) => "merge123"),
  publish: vi.fn(async () => undefined),
  auth: vi.fn(async () => ({ connected: true })),
  preflightRebase: vi.fn(),
  rebase: vi.fn(),
  sendReview: vi.fn(async (..._args: unknown[]) => ({ pull_request: { url: "https://github.com/contoso/talk/pull/31" } })),
}));
vi.mock("../services/draftlineVersioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/draftlineVersioning")>()),
  preflightDraftlineIncoming: dl.preflightIncoming,
  preflightDraftlineMergeIncoming: dl.preflightMerge,
  applyDraftlineIncoming: dl.applyIncoming,
  mergeDraftlineIncomingWithToken: dl.mergeIncoming,
  publishDraftlineChanges: dl.publish,
  preflightDraftlineRebaseIncoming: dl.preflightRebase,
  rebaseDraftlineIncoming: dl.rebase,
  sendForReview: dl.sendReview,
}));
vi.mock("../services/githubSetup", () => ({ getGitHubAuthStatus: dl.auth }));

import { MERGE_UPDATES_CHANGED_MESSAGE } from "../services/draftlineErrors";
import { SAVE_BEFORE_UPDATES_MESSAGE, TEAM_UPDATES_SOURCE } from "../services/teamUpdates";
import { compareTabPath, parseCompareTabPath } from "../domain/compare/compareTarget";
import { snapshotDiffTabPath } from "../domain/versioning/snapshotDiffTab";
import { makeMainTabId, makeSplitTabId, useAppStore } from "../stores/appStore";
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
  // By default the replay can't run, so the work is combined (the fallback).
  dl.preflightRebase.mockResolvedValue({ can_rebase: false, local_versions: [], conflicts: [], unsupported: "merge history" });
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
    expect(dl.mergeIncoming).toHaveBeenCalledWith(TOKEN, "Bring in team updates\n\n- #24 lead queue with wing-light hero (Dana)", "origin");
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

describe("replaying unsent saves on the team's", () => {
  const OLD = "a".repeat(40);
  const NEW = "b".repeat(40);
  const GONE = "c".repeat(40);
  const BASE = "d".repeat(40);

  function replayable() {
    connect();
    dl.preflightRebase.mockResolvedValue({ can_rebase: true, local_versions: [{ id: OLD }, { id: GONE }], conflicts: [], unsupported: null });
    dl.rebase.mockResolvedValue({ rewritten: [{ from: OLD, to: NEW }], dropped: [GONE], incoming: INCOMING });
  }

  function tab(type: "snapshot-preview" | "compare" | "diff" | "note", path: string, split = false) {
    return { id: (split ? makeSplitTabId : makeMainTabId)(type, path), type, path, title: path };
  }

  it("brings the team's work in with no new version and no name", async () => {
    replayable();
    expect(await useSyncStore.getState().pullFromRemote()).toEqual({ kind: "brought-in", count: 1 });
    expect(dl.rebase).toHaveBeenCalledWith("origin");
    expect(dl.preflightMerge).not.toHaveBeenCalled();
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
    expect(useMergeNameStore.getState().pending).toBeNull();
  });

  it("keeps History previews and Compare tabs on the replayed saves", async () => {
    replayable();
    const compare = compareTabPath({ from: BASE, to: OLD, fromLabel: "outline", toLabel: OLD.slice(0, 7), path: null, documentTitle: null });
    const gone = compareTabPath({ from: GONE, to: "workspace", fromLabel: "x", toLabel: "Now", path: null, documentTitle: null });
    const note = tab("note", "intro.md");
    const preview = tab("snapshot-preview", `snapshot:${OLD}`);
    useAppStore.setState({
      openTabs: [note, preview, tab("compare", compare), tab("compare", gone), tab("diff", snapshotDiffTabPath(OLD, "intro.sk")), tab("diff", snapshotDiffTabPath(GONE, "a.md"))],
      activeTabId: preview.id,
      splitTabs: [tab("snapshot-preview", `snapshot:${GONE}`, true), tab("compare", compare, true)],
      splitActiveTabId: makeSplitTabId("snapshot-preview", `snapshot:${GONE}`),
      _persistTabs: vi.fn(),
    });
    useVersioningStore.setState({
      startedBranchFromSnapshot: { branchName: "alt", snapshotId: OLD },
      diffSelection: { from: OLD, to: "working" },
    });

    await useSyncStore.getState().pullFromRemote();

    const { openTabs, activeTabId, splitTabs, splitActiveTabId } = useAppStore.getState();
    expect(openTabs.map((t) => t.path)).toEqual(["intro.md", `snapshot:${NEW}`, expect.stringContaining("compare"), snapshotDiffTabPath(NEW, "intro.sk")]);
    expect(openTabs[3].id).toBe(makeMainTabId("diff", snapshotDiffTabPath(NEW, "intro.sk")));
    expect(activeTabId).toBe(makeMainTabId("snapshot-preview", `snapshot:${NEW}`));
    const target = parseCompareTabPath(openTabs[2].path)!;
    expect(target).toMatchObject({ from: BASE, to: NEW, fromLabel: "outline", toLabel: NEW.slice(0, 7) });
    expect(openTabs[2].id).toBe(makeMainTabId("compare", openTabs[2].path));
    expect(splitTabs).toHaveLength(1);
    expect(splitTabs[0].id).toBe(makeSplitTabId("compare", splitTabs[0].path));
    expect(splitActiveTabId).toBe(splitTabs[0].id);
    expect(useVersioningStore.getState().startedBranchFromSnapshot).toEqual({ branchName: "alt", snapshotId: NEW });
    expect(useVersioningStore.getState().diffSelection).toEqual({ from: NEW, to: "working" });
  });

  it("combines the work instead when another timeline holds an unsent save", async () => {
    replayable();
    dl.rebase.mockRejectedValueOnce({ code: "versions_on_other_timelines", message: "no", details: { timelines: ["alt"] } });
    expect(await useSyncStore.getState().pullFromRemote()).toEqual({ kind: "brought-in", count: 1 });
    expect(dl.mergeIncoming).toHaveBeenCalledOnce();
  });

  it.each(["versions_already_shared", "rebase_unsupported", "preflight_failed"])(
    "combines the work instead when the replay refuses with %s",
    async (code) => {
      replayable();
      dl.rebase.mockRejectedValueOnce({ code, message: "no" });
      expect(await useSyncStore.getState().pullFromRemote()).toEqual({ kind: "brought-in", count: 1 });
      expect(dl.mergeIncoming).toHaveBeenCalledOnce();
    },
  );

  it("frames a real conflict around files", async () => {
    replayable();
    dl.rebase.mockRejectedValueOnce({ code: "incoming_conflicts", message: "no", details: { paths: ["compass.sk"] } });
    dl.preflightMerge.mockResolvedValue({
      canMergeCleanly: false, token: TOKEN, incoming: INCOMING, dirtyFiles: [],
      conflicts: [{ path: "compass.sk" }], syncStatus: { ahead: 1, behind: 1 },
    });
    expect((await useSyncStore.getState().pullFromRemote())?.kind).toBe("conflict");
    expect(useVersioningStore.getState()).toMatchObject({ isMerging: true, mergeSource: TEAM_UPDATES_SOURCE });
  });

  it("leaves another project's tabs alone when it was opened during the replay", async () => {
    replayable();
    const preview = tab("snapshot-preview", `snapshot:${OLD}`);
    useAppStore.setState({ openTabs: [preview], activeTabId: preview.id, _persistTabs: vi.fn() });
    dl.rebase.mockImplementationOnce(async () => {
      beginWorkspaceGeneration('C:/other');
      return { rewritten: [{ from: OLD, to: NEW }], dropped: [], incoming: INCOMING };
    });
    expect(await useSyncStore.getState().pullFromRemote()).toEqual({ kind: "cancelled" });
    expect(useAppStore.getState().openTabs).toEqual([preview]);
  });

  it("stops on a locked project without combining anything", async () => {
    replayable();
    dl.rebase.mockRejectedValueOnce({ code: "workspace_locked", message: "locked" });
    expect(await useSyncStore.getState().pullFromRemote()).toBeNull();
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
    expect(useSyncStore.getState().syncError).toBeTruthy();
  });

  it("names the combined version the conventional way when the repository does", async () => {
    connect();
    useVersioningStore.setState({
      graphNodes: ["feat: intro", "fix(ui): spacing", "docs: notes"].map((message, i) => ({ id: String(i), message }) as never),
    });
    await useSyncStore.getState().pullFromRemote();
    expect(dl.mergeIncoming).toHaveBeenCalledWith(TOKEN, expect.stringMatching(/^chore\(sync\): bring in team updates \(#24\)\n/), "origin");
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
      if (dl.rebase.mock.calls.length > 0) useSyncStore.setState({ syncStatus: { ahead: 1, behind: 0 } });
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

  it("replays the unsent saves, then actually sends", async () => {
    const { pushToRemote } = sendSetup(false);
    dl.preflightRebase.mockResolvedValue({ can_rebase: true, local_versions: [{ id: "a" }], conflicts: [], unsupported: null });
    dl.rebase.mockResolvedValue({ rewritten: [], dropped: [], incoming: INCOMING });
    const show = vi.spyOn(useToastStore.getState(), "showUpdate");
    await useSyncStore.getState().syncWithRemote();
    expect(dl.mergeIncoming).not.toHaveBeenCalled();
    expect(pushToRemote).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith("Sent ✓ (also picked up 1 team update)", "success");
  });

  it("sends a hybrid project for review under the user's own save name", async () => {
    const { sendForReview } = sendSetup(true);
    await useSyncStore.getState().syncWithRemote({ name: "initial outline", comment: "first pass" });
    expect(sendForReview).toHaveBeenCalledWith("initial outline", "first pass", 1);
  });

  it("names the review after the user's save, not the team updates Send brought in", async () => {
    // Seth's sequence: an older team-update version blocks the replay, so Send
    // combines the new team saves, then opens the review from the result.
    connect({ state: "needsMerge", ahead: 2, behind: 3 });
    const incoming = ["feat: #30 hero copy", "fix: #29 pricing", "feat: #28 lead queue"].map((name) => ({ name, comment: "", author: "Dana" }));
    dl.preflightMerge.mockResolvedValue({ canMergeCleanly: true, token: TOKEN, conflicts: [], incoming, dirtyFiles: [], syncStatus: { ahead: 2, behind: 3 } });
    const shared = { reachable_from_remote_variation: true };
    const graph = (head: { message: string; comment: string } | null) => [
      ...(head ? [{ id: "m2", message: head.message, comment: head.comment, parents: ["s", "t30"], is_head: true }] : []),
      { id: "t30", message: "feat: #30 hero copy", parents: ["t28"], ...shared },
      { id: "t28", message: "fix: #28 lead queue", parents: ["t25"], ...shared },
      { id: "s", message: "initial outline", comment: "first pass", parents: ["m1"], is_head: !head },
      { id: "m1", message: "chore(sync): bring in team updates (#25)", comment: "- #25 nav (Lee)", parents: ["base", "t25"] },
      { id: "t25", message: "docs: #25 nav", parents: ["base"], ...shared },
      { id: "base", message: "feat: setup", parents: [], ...shared },
    ] as never;
    useVersioningStore.setState({ graphNodes: graph(null), checkLargeFiles: vi.fn(async () => []) as never, refreshChangedFiles: vi.fn(async () => undefined) });
    dl.mergeIncoming.mockImplementationOnce(async (_token, label) => {
      const [message, , ...lines] = String(label).split("\n");
      useVersioningStore.setState({ graphNodes: graph({ message, comment: lines.join("\n") }) });
      return "m2";
    });
    useSyncStore.setState({
      fetchFromRemote: vi.fn(async () => undefined),
      refreshSyncStatus: vi.fn(async () => {
        if (dl.mergeIncoming.mock.calls.length > 0) useSyncStore.setState({ syncStatus: { ahead: 3, behind: 0 } });
      }),
    });
    useAppStore.setState({ currentProject: { name: "talk", root: "C:/talk", hybrid: true } as never });

    await useSyncStore.getState().syncWithRemote();

    expect(dl.mergeIncoming.mock.calls[0][1]).toMatch(/^chore\(sync\): bring in team updates \(#30, #29, #28/);
    expect(dl.sendReview).toHaveBeenCalledWith({
      remote: "origin",
      title: "initial outline",
      body: "first pass\n\nAlso includes 4 team updates that are already shared; they aren't part of this review.",
    });
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
