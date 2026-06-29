import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockUnlisten = vi.hoisted(() => vi.fn());

vi.mock("../services/tauri", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  listen: () => Promise.resolve(mockUnlisten),
}));

import {
  diffDraftlineVersions,
  hasDraftlineChanges,
  deleteDraftlineVariation,
  listDraftlineChangedFiles,
  listDraftlineGraphNodes,
  listDraftlineLargeChangedFiles,
  listDraftlineTimelines,
  listDraftlineVersions,
  hasDraftlineShelf,
  popDraftlineShelf,
  preflightDraftlineRenameVariation,
  previewDraftlineVersion,
  renameDraftlineVariation,
  saveDraftlineVersion,
  setDraftlineWorkspacePath,
  shelveDraftlineChanges,
} from "../services/draftlineVersioning";

const WORKSPACE = "D:\\project";

function variation(id: string, label = id, isCurrent = true) {
  return {
    id,
    name: id,
    metadata: { label, slug: id },
    is_current: isCurrent,
  };
}

function version(id: string, label: string, timeSeconds: number, name = "Seth") {
  return {
    id,
    label,
    author: { name, email: null },
    saved_by: { name, email: null },
    time_seconds: timeSeconds,
  };
}

function diagnostics({
  versions = [],
  dirtyFiles = [],
}: {
  versions?: ReturnType<typeof version>[];
  dirtyFiles?: Array<{ path: string; kind: string; is_binary?: boolean; is_large?: boolean }>;
} = {}) {
  const main = variation("main", "main");
  return {
    summary: {
      active_variation: main,
      variations: [main],
      versions,
      dirty_files: dirtyFiles,
      is_dirty: dirtyFiles.length > 0,
      recovery: null,
      state_may_be_inconsistent: false,
    },
  };
}

describe("draftlineVersioning", () => {
  beforeEach(() => {
    setDraftlineWorkspacePath(WORKSPACE);
  });

  afterEach(() => {
    setDraftlineWorkspacePath(null);
    mockInvoke.mockReset();
    mockUnlisten.mockReset();
    localStorage.clear();
  });

  it("maps Draftline versions onto existing version entries", async () => {
    mockInvoke.mockResolvedValueOnce(diagnostics({
      versions: [version("0123456789012345678901234567890123456789", "Initial storyboard", 1_700_000_000)],
    }));

    await expect(listDraftlineVersions()).resolves.toEqual([
      {
        id: "0123456789012345678901234567890123456789",
        message: "Initial storyboard",
        timestamp: "2023-11-14T22:13:20.000Z",
        summary: "Initial storyboard",
      },
    ]);
    expect(mockInvoke).toHaveBeenCalledWith("inspect_workspace", {
      request: { workspace_path: WORKSPACE },
    });
  });

  it("maps Draftline change kinds onto existing diff entries", async () => {
    mockInvoke
      .mockResolvedValueOnce(diagnostics({
        versions: [version("2222222222222222222222222222222222222222", "Head", 1_700_000_100)],
      }))
      .mockResolvedValueOnce({
        from_version: "2222222222222222222222222222222222222222",
        to_version: null,
        files: [
          { path: "intro.sk", kind: "Added", is_binary: false, is_large: false },
          { path: "demo.sb", kind: "TypeChanged", is_binary: false, is_large: false },
          { path: "notes.md", kind: "Deleted", is_binary: false, is_large: false },
        ],
        patch: null,
      });

    await expect(listDraftlineChangedFiles()).resolves.toEqual([
      { path: "intro.sk", status: "added", additions: 0, deletions: 0 },
      { path: "demo.sb", status: "modified", additions: 0, deletions: 0 },
      { path: "notes.md", status: "deleted", additions: 0, deletions: 0 },
    ]);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "inspect_workspace", {
      request: { workspace_path: WORKSPACE },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "diff_version_to_workspace", {
      request: { workspace_path: WORKSPACE, version_id: "2222222222222222222222222222222222222222" },
    });
  });

  it("falls back to summary dirty files in an empty workspace", async () => {
    mockInvoke.mockResolvedValueOnce(diagnostics({
      dirtyFiles: [{ path: "intro.sk", kind: "Added", is_binary: false, is_large: false }],
    }));

    await expect(listDraftlineChangedFiles()).resolves.toEqual([
      { path: "intro.sk", status: "added", additions: 0, deletions: 0 },
    ]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("maps Draftline workspace graph overview onto graph nodes", async () => {
    mockInvoke
      .mockResolvedValueOnce({
        workspace_id: { root: WORKSPACE },
        current_variation: "main",
        current_version: "2222222222222222222222222222222222222222",
        dirty: { is_dirty: false, files: [] },
        recovery: null,
        state_may_be_inconsistent: false,
        snapshot_id: "snapshot-1",
        was_pruned: false,
        has_more: false,
        nodes: [
          {
            id: "node-2222222222222222222222222222222222222222",
            version: version("2222222222222222222222222222222222222222", "Second", 1_700_000_100, "Seth"),
            parent_ids: ["node-1111111111111111111111111111111111111111"],
            parent_version_ids: ["1111111111111111111111111111111111111111"],
            variation_tips: ["main"],
            is_head: true,
            is_current: true,
            is_tip: true,
            layout: { lane: 0, row: 0, display_label: "main" },
          },
          {
            id: "node-1111111111111111111111111111111111111111",
            version: version("1111111111111111111111111111111111111111", "First", 1_700_000_000, "Maria"),
            parent_ids: [],
            parent_version_ids: [],
            variation_tips: [],
            is_head: false,
            is_current: false,
            is_tip: false,
            layout: { lane: 0, row: 1, display_label: "main" },
          },
        ],
        refs: [
          {
            id: "refs/heads/main",
            name: "main",
            display_label: "Main",
            kind: "local_variation",
            scope: "local",
            target: "main",
            target_version: "2222222222222222222222222222222222222222",
            variation: "main",
            is_current: true,
            is_user_facing: true,
          },
        ],
      })
      .mockResolvedValueOnce([
        {
          variation: variation("main", "Main"),
          head_version: version("2222222222222222222222222222222222222222", "Second", 1_700_000_100),
          reachable_version_count: 2,
        },
      ]);

    await expect(listDraftlineGraphNodes()).resolves.toEqual([
      {
        id: "2222222222222222222222222222222222222222",
        message: "Second",
        timestamp: "2023-11-14T22:15:00.000Z",
        timeline: "main",
        parents: ["1111111111111111111111111111111111111111"],
        lane: 0,
        is_head: true,
        is_branch_tip: true,
        is_remote_tip: false,
        author: "Seth",
      },
      {
        id: "1111111111111111111111111111111111111111",
        message: "First",
        timestamp: "2023-11-14T22:13:20.000Z",
        timeline: "main",
        parents: [],
        lane: 0,
        is_head: false,
        is_branch_tip: false,
        is_remote_tip: false,
        author: "Maria",
      },
    ]);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "get_workspace_graph_overview", {
      request: {
        workspace_path: WORKSPACE,
        options: {
          include_remotes: true,
          include_support_refs: true,
          max_nodes: 250,
          recent_nodes: 80,
        },
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "list_variations", {
      request: { workspace_path: WORKSPACE },
    });
  });

  it("maps Draftline variations onto timeline entries", async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        variation: variation("main", "Main"),
        head_version: version("1111111111111111111111111111111111111111", "First", 1_700_000_000),
        reachable_version_count: 1,
      },
      {
        variation: variation("alt", "Alternative", false),
        head_version: null,
        reachable_version_count: 3,
      },
    ]);

    await expect(listDraftlineTimelines()).resolves.toEqual([
      { name: "main", label: "Main", is_active: true, snapshot_count: 1, color_index: 0 },
      { name: "alt", label: "Alternative", is_active: false, snapshot_count: 3, color_index: 1 },
    ]);
  });

  it("deletes a Draftline variation by typed id string", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);

    await expect(deleteDraftlineVariation("alt")).resolves.toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith("delete_variation", {
      request: { workspace_path: WORKSPACE, variation: "alt" },
    });
  });

  it("preflights and renames a Draftline variation through the guarded API", async () => {
    const token = {
      operation_id: "rename-master-main",
      source_variation: "master",
      target_variation: "main",
      expected_oid: "abc123",
      support_ref: "refs/draftline/variations/master",
    };
    const preflight = {
      source_variation: "master",
      target_variation: "main",
      expected_oid: "abc123",
      support_ref: "refs/draftline/variations/master",
      token,
      can_rename: true,
    };

    mockInvoke
      .mockResolvedValueOnce(preflight)
      .mockResolvedValueOnce({
        preflight,
        variation: variation("main", "main"),
        postconditions: { workspace_changed: true, active_variation: "main", dirty_files: [] },
      });

    await expect(preflightDraftlineRenameVariation("master", "main")).resolves.toEqual(preflight);
    await expect(renameDraftlineVariation("master", "main", token)).resolves.toMatchObject({
      preflight,
      variation: { id: "main" },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "preflight_rename_variation", {
      request: {
        workspace_path: WORKSPACE,
        source_variation_id: "master",
        target_variation_id: "main",
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "rename_variation", {
      request: {
        workspace_path: WORKSPACE,
        source_variation_id: "master",
        target_variation_id: "main",
        token,
      },
    });
  });

  it("reports large changed files from the Draftline content policy", async () => {
    mockInvoke.mockResolvedValueOnce({
      files: [
        { path: "intro.sk", kind: "Modified", is_binary: false, is_large: false },
        { path: "screenshots/demo.png", kind: "Added", is_binary: true, is_large: true },
      ],
      diff: null,
    });

    await expect(listDraftlineLargeChangedFiles()).resolves.toEqual(["screenshots/demo.png"]);
    expect(mockInvoke).toHaveBeenCalledWith("get_changes", {
      request: { workspace_path: WORKSPACE },
    });
  });

  it("maps Draftline version diffs to diff entries", async () => {
    mockInvoke.mockResolvedValueOnce({
      from_version: "1111111111111111111111111111111111111111",
      to_version: "2222222222222222222222222222222222222222",
      files: [{ path: "intro.sk", kind: "Modified", is_binary: false, is_large: false }],
      patch: "@@",
    });

    await expect(diffDraftlineVersions(
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
    )).resolves.toEqual([
      { path: "intro.sk", status: "modified", additions: 0, deletions: 0 },
    ]);
    expect(mockInvoke).toHaveBeenCalledWith("diff_versions", {
      request: {
        workspace_path: WORKSPACE,
        from_version_id: "1111111111111111111111111111111111111111",
        to_version_id: "2222222222222222222222222222222222222222",
      },
    });
  });

  it("maps Draftline version-to-workspace diffs for previews", async () => {
    mockInvoke.mockResolvedValueOnce({
      from_version: "1111111111111111111111111111111111111111",
      to_version: null,
      files: [
        { path: "intro.sk", kind: "Modified", is_binary: false, is_large: false },
        { path: "screenshots/a.png", kind: "Added", is_binary: true, is_large: false },
      ],
      patch: null,
    });

    await expect(previewDraftlineVersion("1111111111111111111111111111111111111111")).resolves.toEqual([
      { path: "intro.sk", status: "modified", additions: 0, deletions: 0 },
      { path: "screenshots/a.png", status: "added", additions: 0, deletions: 0 },
    ]);
    expect(mockInvoke).toHaveBeenCalledWith("diff_version_to_workspace", {
      request: { workspace_path: WORKSPACE, version_id: "1111111111111111111111111111111111111111" },
    });
  });

  it("uses Draftline summary and save commands for the adapter lane", async () => {
    mockInvoke
      .mockResolvedValueOnce({
        files: [{ path: "intro.sk", kind: "Modified", is_binary: false, is_large: false }],
        diff: null,
      })
      .mockResolvedValueOnce({
        version: version("fedcba98765432100123456789abcdef01234567", "Save", 1_700_000_300),
        postconditions: { errors: [] },
      });

    await expect(hasDraftlineChanges()).resolves.toBe(true);
    await expect(saveDraftlineVersion("Save")).resolves.toBe("fedcba98765432100123456789abcdef01234567");
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "get_changes", {
      request: { workspace_path: WORKSPACE },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "save", {
      request: { workspace_path: WORKSPACE, label: "Save" },
    });
  });

  it("uses Draftline shelves for stash-compatible operations", async () => {
    mockInvoke
      .mockResolvedValueOnce({
        files: [{ path: "intro.sk", kind: "Modified", is_binary: false, is_large: false }],
        diff: null,
      })
      .mockResolvedValueOnce({
        shelf: {
          id: "cutready-stash",
          version: version("3333333333333333333333333333333333333333", "Shelved changes", 1_700_000_200),
        },
        postconditions: { errors: [] },
      })
      .mockResolvedValueOnce([
        {
          id: "cutready-stash",
          version: version("3333333333333333333333333333333333333333", "Shelved changes", 1_700_000_200),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "cutready-stash",
          version: version("3333333333333333333333333333333333333333", "Shelved changes", 1_700_000_200),
        },
      ])
      .mockResolvedValueOnce({
        shelf: {
          id: "cutready-stash",
          version: version("3333333333333333333333333333333333333333", "Shelved changes", 1_700_000_200),
        },
        postconditions: { errors: [] },
      })
      .mockResolvedValueOnce(undefined);

    await expect(shelveDraftlineChanges()).resolves.toBeUndefined();
    await expect(hasDraftlineShelf()).resolves.toBe(true);
    await expect(popDraftlineShelf()).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "get_changes", {
      request: { workspace_path: WORKSPACE },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "selected_shelve", {
      request: { workspace_path: WORKSPACE, paths: ["intro.sk"], name: "cutready-stash" },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "list_shelves", {
      request: { workspace_path: WORKSPACE },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "list_shelves", {
      request: { workspace_path: WORKSPACE },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(5, "apply_shelf", {
      request: { workspace_path: WORKSPACE, shelf_id: "cutready-stash" },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(6, "delete_shelf", {
      request: { workspace_path: WORKSPACE, shelf_id: "cutready-stash" },
    });
  });
});
