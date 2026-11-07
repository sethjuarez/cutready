import { afterEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  preflightMergeVariation: vi.fn(),
  mergeVariationWithResolutions: vi.fn(async (..._args: unknown[]) => ({ merge: { version: { id: "merge456" } } })),
}));
vi.mock("../services/draftlineVersioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/draftlineVersioning")>()),
  facade: () => f,
}));

import { useAppStore } from "../stores/appStore";
import { useMergeNameStore } from "../stores/mergeNameStore";
import { useSyncStore } from "../stores/syncStore";
import { useToastStore } from "../stores/toastStore";
import { useVersioningStore } from "../stores/versioningStore";
import { variationMergeErrorMessage } from "../services/variationMerge";

const originalVersioning = useVersioningStore.getState();
const originalSync = useSyncStore.getState();
const originalApp = useAppStore.getState();
const token = { remote: "", variation: "main", local_oid: "a", remote_oid: "b", merge_base_oid: "c", source: "draft", local: true };
const draft = { name: "draft", label: "Draft", is_active: false, snapshot_count: 3, color_index: 1 };

function report(overrides: Record<string, unknown> = {}) {
  return {
    sync_status: { remote: "", variation: "main", ahead: 0, behind: 1, state: "RemoteAhead", local_oid: "a", remote_oid: "b",
      incoming: [{ id: "v1", label: "Tighten intro", comment: "Cut the long opener" }] },
    dirty_files: [],
    file_hazards: [],
    conflicts: [],
    token,
    can_merge_cleanly: true,
    ...overrides,
  };
}

function setUp() {
  const noop = vi.fn(async () => undefined);
  useAppStore.setState({ loadSketches: noop, loadStoryboards: noop, loadNotes: noop });
  useSyncStore.setState({ refreshSyncStatus: noop, refreshIncomingCommits: noop });
  useVersioningStore.setState({
    loadVersions: noop,
    loadGraphData: noop,
    loadTimelines: noop,
    checkDirty: noop,
    timelines: [{ name: "main", label: "main", is_active: true, snapshot_count: 2, color_index: 0 }, draft],
  });
}

afterEach(() => {
  f.preflightMergeVariation.mockReset();
  f.mergeVariationWithResolutions.mockClear();
  useMergeNameStore.setState({ pending: null });
  useVersioningStore.setState(originalVersioning, true);
  useSyncStore.setState(originalSync, true);
  useAppStore.setState(originalApp, true);
});

describe("mergeTimelines", () => {
  it("merges cleanly, pinned to the preview's token, after the name is approved", async () => {
    setUp();
    f.preflightMergeVariation.mockResolvedValue(report());
    const merged = useVersioningStore.getState().mergeTimelines(draft);
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending?.defaultName).toBe("Merge updates from Draft"));
    expect(f.preflightMergeVariation).toHaveBeenCalledWith("draft");
    expect(useMergeNameStore.getState().pending?.incoming).toEqual([{ name: "Tighten intro", comment: "Cut the long opener" }]);
    useMergeNameStore.getState().answer("Bring in the tighter intro");
    await merged;
    expect(f.mergeVariationWithResolutions).toHaveBeenCalledWith("Bring in the tighter intro", token, []);
  });

  it("merges nothing when the name prompt is cancelled", async () => {
    setUp();
    f.preflightMergeVariation.mockResolvedValue(report());
    const merged = useVersioningStore.getState().mergeTimelines(draft);
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending).not.toBeNull());
    useMergeNameStore.getState().answer(null);
    await merged;
    expect(f.mergeVariationWithResolutions).not.toHaveBeenCalled();
  });

  it("opens the conflict panel, then merges the resolutions as a local merge", async () => {
    setUp();
    const conflict = { path: "intro.sk", kind: "both_modified", base: "{}", ours: "{}", theirs: "{}" };
    f.preflightMergeVariation.mockResolvedValue(report({ can_merge_cleanly: false, conflicts: [conflict] }));
    await useVersioningStore.getState().mergeTimelines(draft);
    const state = useVersioningStore.getState();
    expect(state.isMerging).toBe(true);
    expect(state.mergeSource).toBe("Draft");
    expect(state.draftlineMergeRemote).toBeNull();
    expect(f.mergeVariationWithResolutions).not.toHaveBeenCalled();

    const applied = state.applyMergeResolution([{ path: "intro.sk", content: "{\"x\":1}" }]);
    await vi.waitFor(() => expect(useMergeNameStore.getState().pending?.defaultName).toBe("Merge updates from Draft"));
    useMergeNameStore.getState().answer("Merge Draft");
    await expect(applied).resolves.toBe("merge456");
    const [label, usedToken, resolutions] = f.mergeVariationWithResolutions.mock.calls[0];
    expect(label).toBe("Merge Draft");
    expect(usedToken).toEqual(token);
    expect(resolutions).toEqual([{ path: "intro.sk", field_path: null, choice: { kind: "use_content", content: "{\"x\":1}" } }]);
    expect(useVersioningStore.getState().isMerging).toBe(false);
  });

  it("explains a refused merge and merges nothing", async () => {
    setUp();
    const show = vi.spyOn(useToastStore.getState(), "show");
    f.preflightMergeVariation.mockRejectedValue({ code: "nothing_to_merge", message: "nothing", details: { branch: "draft" } });
    await useVersioningStore.getState().mergeTimelines(draft);
    expect(show).toHaveBeenCalledWith("main already has everything from Draft.", 6000, "error");
    expect(useVersioningStore.getState().loadTimelines).toHaveBeenCalled();
    expect(f.mergeVariationWithResolutions).not.toHaveBeenCalled();
    show.mockRestore();
  });
});

describe("variationMergeErrorMessage", () => {
  it.each([
    ["invalid_merge_token", "That merge preview can't be used anymore. Nothing was merged — try again."],
    ["remote_race", "Draft or main changed while you were naming the merge. Nothing was merged — try again."],
    ["local_state_changed", "Draft or main changed while you were naming the merge. Nothing was merged — try again."],
  ])("maps %s", (code, message) => {
    expect(variationMergeErrorMessage({ code, message: "x" }, "Draft", "main")).toBe(message);
  });

  it("explains branches outside CutReady's namespace", () => {
    expect(variationMergeErrorMessage({ code: "variation_outside_namespace", message: "x" }, "feature", "main")).toMatch(/belongs to the code repository/);
  });
});
