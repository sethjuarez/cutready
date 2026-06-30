import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockUnlisten = vi.hoisted(() => vi.fn());

vi.mock("../services/tauri", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  listen: () => Promise.resolve(mockUnlisten),
}));

import {
  adoptDraftlineRemoteBranch,
  createDraftlineVariation,
  diffDraftlineVersions,
  hasDraftlineChanges,
  deleteDraftlineVariation,
  isDraftlineVariationCreateConflictError,
  listDraftlineChangedFiles,
  listDraftlineGraphNodes,
  listDraftlineLargeChangedFiles,
  listDraftlineRemoteBranches,
  listDraftlineSnapshotCleanupCandidates,
  listDraftlineTimelines,
  listDraftlineVersions,
  hasDraftlineShelf,
  popDraftlineShelf,
  preflightDraftlineUndoSnapshotCleanup,
  preflightDraftlineRenameVariation,
  applyDraftlineSnapshotCleanup,
  previewDraftlineSnapshotCleanup,
  preflightDraftlineSwitchVariation,
  previewDraftlineVersion,
  renameDraftlineVariation,
  resolveDraftlineRewrittenVersion,
  saveDraftlineVersion,
  setDraftlineWorkspacePath,
  shelveDraftlineChanges,
  switchDraftlineVariation,
  undoDraftlineSnapshotCleanup,
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

  it("creates a Draftline variation through remote-aware preflight and guarded create", async () => {
    const token = {
      operation_id: "create-feature",
      from_version: "1111111111111111111111111111111111111111",
      variation: "feature",
      remote: "origin",
      expected_source_oid: "abc123",
      expected_remote_oid: null,
    };
    const preflight = {
      from_version: token.from_version,
      variation: "feature",
      remote: "origin",
      can_create: true,
      local_collision: false,
      remote_collision: false,
      remote_only_collision: false,
      existing_remote_head: null,
      suggested_alternative: null,
      token,
    };

    mockInvoke
      .mockResolvedValueOnce(preflight)
      .mockResolvedValueOnce({
        preflight,
        variation: variation("feature", "Feature", false),
        postconditions: { workspace_changed: true, active_variation: "main", dirty_files: [] },
      });

    await expect(createDraftlineVariation(token.from_version, "feature", "origin")).resolves.toBeUndefined();
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "preflight_create_variation_from_version", {
      request: {
        workspace_path: WORKSPACE,
        version_id: token.from_version,
        name: "feature",
        remote: "origin",
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "create_variation_from_version_guarded", {
      request: {
        workspace_path: WORKSPACE,
        token,
        metadata: { label: "feature", slug: "feature" },
      },
    });
  });

  it("surfaces remote variation collisions without creating a local branch", async () => {
    const preflight = {
      from_version: "1111111111111111111111111111111111111111",
      variation: "feature",
      remote: "origin",
      can_create: false,
      local_collision: false,
      remote_collision: true,
      remote_only_collision: true,
      existing_remote_head: version("3333333333333333333333333333333333333333", "Remote feature", 1_700_000_200),
      suggested_alternative: "feature-2",
      token: null,
    };
    mockInvoke.mockResolvedValueOnce(preflight);

    try {
      await createDraftlineVariation(preflight.from_version, "feature", "origin");
      throw new Error("expected createDraftlineVariation to reject");
    } catch (error) {
      expect(isDraftlineVariationCreateConflictError(error)).toBe(true);
      if (isDraftlineVariationCreateConflictError(error)) {
        expect(error.preflight.remote_only_collision).toBe(true);
        expect(error.preflight.suggested_alternative).toBe("feature-2");
      }
    }
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("preflight_create_variation_from_version", {
      request: {
        workspace_path: WORKSPACE,
        version_id: preflight.from_version,
        name: "feature",
        remote: "origin",
      },
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

  it("previews and applies Draftline history cleanup for a selected snapshot range", async () => {
    const preview = {
      plan_id: "cleanup-plan-1",
      target_variation: "main",
      old_head: "2222222222222222222222222222222222222222",
      new_head: "3333333333333333333333333333333333333333",
      preview_ref: "refs/draftline/previews/history-cleanup/main/cleanup-plan-1",
      planned_backup_ref: "refs/draftline/backups/history-cleanup/main/cleanup-plan-1",
      operations: [],
      graph_diff: {
        old_head: "2222222222222222222222222222222222222222",
        new_head: "3333333333333333333333333333333333333333",
        old_commit_count: 2,
        new_commit_count: 1,
        squashed_commit_count: 2,
      },
      commit_map: [],
      snapshot_map: [],
      warnings: [],
    };
    const result = {
      plan_id: preview.plan_id,
      old_head: preview.old_head,
      new_head: preview.new_head,
      backup_refs: ["refs/draftline/backups/history-cleanup/main/cleanup-plan-1"],
      ref_updates: [],
      commit_map: [],
      snapshot_map: [],
      warnings: [],
    };
    mockInvoke
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(result);

    await expect(previewDraftlineSnapshotCleanup(
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
      "Demo milestone",
      "main",
    )).resolves.toEqual(preview);
    await expect(applyDraftlineSnapshotCleanup("cleanup-plan-1")).resolves.toEqual(result);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "preview_history_cleanup", {
      request: {
        workspace_path: WORKSPACE,
        cleanup: {
          target_variation: "main",
          base: { kind: "auto" },
          mode: {
            kind: "compact_milestones",
            milestones: [{
              title: "Demo milestone",
              description: null,
              include_range: {
                start: "1111111111111111111111111111111111111111",
                end: "2222222222222222222222222222222222222222",
              },
            }],
            preserve_named_branches: true,
            preserve_merge_boundaries: true,
          },
          safety: {
            create_backup_ref: true,
            backup_ref_name: null,
            require_clean_worktree: true,
          },
          remote_policy: { kind: "local_only" },
        },
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "apply_history_cleanup", {
      request: {
        workspace_path: WORKSPACE,
        plan_id: "cleanup-plan-1",
        confirmation: "user_confirmed",
      },
    });
  });

  it("loads Draftline history cleanup candidates for a selected snapshot", async () => {
    const candidates = {
      target_variation: "main",
      selected_version: "1111111111111111111111111111111111111111",
      target_head: "3333333333333333333333333333333333333333",
      candidates: [{
        version: version("2222222222222222222222222222222222222222", "Range end", 2),
        include_range: {
          start: "1111111111111111111111111111111111111111",
          end: "2222222222222222222222222222222222222222",
        },
        selected_role: "range_start",
        can_compact: true,
        requires_descendant_replay: true,
        selected_commit_count: 2,
        descendant_rewrite_count: 1,
        blockers: [],
        warnings: [],
      }],
    };
    mockInvoke.mockResolvedValueOnce(candidates);

    await expect(listDraftlineSnapshotCleanupCandidates(
      "1111111111111111111111111111111111111111",
      "main",
      "origin",
    )).resolves.toEqual(candidates);

    expect(mockInvoke).toHaveBeenCalledWith("get_history_compaction_candidates", {
      request: {
        workspace_path: WORKSPACE,
        request: {
          target_variation: "main",
          selected_version: "1111111111111111111111111111111111111111",
          remote: "origin",
          preserve_named_branches: true,
          preserve_merge_boundaries: true,
        },
      },
    });
  });

  it("resolves stale versions and undoes Draftline history cleanup through guarded tokens", async () => {
    const resolution = {
      requested: "1111111111111111111111111111111111111111",
      disposition: {
        kind: "squashed_into",
        version: "3333333333333333333333333333333333333333",
      },
    };
    const preflight = {
      plan_id: "cleanup-plan-1",
      target_variation: "main",
      backup_ref: "refs/draftline/backups/history-cleanup/main/cleanup-plan-1",
      expected_current_head: "3333333333333333333333333333333333333333",
      restore_head: "2222222222222222222222222222222222222222",
      token: {
        plan_id: "cleanup-plan-1",
        target_variation: "main",
        backup_ref: "refs/draftline/backups/history-cleanup/main/cleanup-plan-1",
        expected_current_head: "3333333333333333333333333333333333333333",
        restore_head: "2222222222222222222222222222222222222222",
      },
      can_undo: true,
    };
    const undoResult = {
      plan_id: "cleanup-plan-1",
      old_head: "3333333333333333333333333333333333333333",
      new_head: "2222222222222222222222222222222222222222",
      backup_refs: [],
      ref_updates: [],
      commit_map: [],
      snapshot_map: [],
      warnings: [],
    };
    mockInvoke
      .mockResolvedValueOnce(resolution)
      .mockResolvedValueOnce(preflight)
      .mockResolvedValueOnce(undoResult);

    await expect(resolveDraftlineRewrittenVersion(resolution.requested)).resolves.toEqual(resolution);
    await expect(preflightDraftlineUndoSnapshotCleanup("cleanup-plan-1")).resolves.toEqual(preflight);
    await expect(undoDraftlineSnapshotCleanup(preflight.token)).resolves.toEqual(undoResult);

    expect(mockInvoke).toHaveBeenNthCalledWith(1, "resolve_rewritten_version", {
      request: {
        workspace_path: WORKSPACE,
        version_id: resolution.requested,
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "preflight_undo_history_cleanup", {
      request: {
        workspace_path: WORKSPACE,
        plan_id: "cleanup-plan-1",
      },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "undo_history_cleanup", {
      request: {
        workspace_path: WORKSPACE,
        token: preflight.token,
      },
    });
  });

  it("switches Draftline variations through the no-save guarded API", async () => {
    const preflight = {
      operation: "switch_variation",
      will_write_files: true,
      dirty_files: [],
      file_hazards: [],
      untracked_assets: [],
      unresolved_conflicts: [],
      large_files: [],
      binary_files: [],
      variation_divergence: null,
      can_proceed: true,
    };

    mockInvoke
      .mockResolvedValueOnce(preflight)
      .mockResolvedValueOnce({
        variation: variation("feature", "Feature"),
        postconditions: { workspace_changed: true, active_variation: "feature", dirty_files: [] },
      });

    await expect(preflightDraftlineSwitchVariation("feature")).resolves.toEqual(preflight);
    await expect(switchDraftlineVariation("feature")).resolves.toMatchObject({
      variation: { id: "feature" },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "preflight_switch_variation", {
      request: { workspace_path: WORKSPACE, variation_id: "feature" },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "switch_variation", {
      request: { workspace_path: WORKSPACE, variation_id: "feature" },
    });
  });

  it("lists and adopts remote Draftline branches", async () => {
    mockInvoke
      .mockResolvedValueOnce([
        {
          id: "teammate-option",
          name: "teammate-option",
          remote: "origin",
          head_version: version("3333333333333333333333333333333333333333", "Remote idea", 1_700_000_200, "Maria"),
        },
      ])
      .mockResolvedValueOnce({
        variation: variation("teammate-option", "teammate-option", false),
        postconditions: { workspace_changed: true, active_variation: "main", dirty_files: [] },
      });

    await expect(listDraftlineRemoteBranches("origin")).resolves.toEqual([
      {
        id: "teammate-option",
        name: "teammate-option",
        remote: "origin",
        head_message: "Remote idea",
        head_author: "Maria",
        head_timestamp: "2023-11-14T22:16:40.000Z",
      },
    ]);
    await expect(adoptDraftlineRemoteBranch("origin", "teammate-option")).resolves.toBeUndefined();
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "list_remote_variations", {
      request: { workspace_path: WORKSPACE, remote: "origin" },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "adopt_remote_variation", {
      request: { workspace_path: WORKSPACE, remote: "origin", variation_id: "teammate-option" },
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
