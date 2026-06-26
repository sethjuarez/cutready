import { afterEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("../services/tauri", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
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
  previewDraftlineVersion,
  saveDraftlineVersion,
  shelveDraftlineChanges,
} from "../services/draftlineVersioning";

function version(id: string, label: string, timeSeconds: number, name = "Seth") {
  return {
    id,
    label,
    timeSeconds,
    author: { name, email: null },
    savedBy: { name, email: null },
  };
}

describe("draftlineVersioning", () => {
  afterEach(() => {
    mockInvoke.mockReset();
    localStorage.clear();
  });

  it("maps Draftline versions onto existing version entries", async () => {
    mockInvoke.mockResolvedValueOnce({
      activeVariation: { id: "main", name: "main", displayLabel: "main", isCurrent: true },
      variations: [{ id: "main", name: "main", displayLabel: "main", isCurrent: true }],
      versions: [
        version("0123456789012345678901234567890123456789", "Initial storyboard", 1_700_000_000),
      ],
      dirtyFiles: [],
      isDirty: false,
      stateMayBeInconsistent: false,
    });

    await expect(listDraftlineVersions()).resolves.toEqual([
      {
        id: "0123456789012345678901234567890123456789",
        message: "Initial storyboard",
        timestamp: "2023-11-14T22:13:20.000Z",
        summary: "Initial storyboard",
      },
    ]);
    expect(mockInvoke).toHaveBeenCalledWith("draftline_workspace_summary");
  });

  it("maps Draftline change kinds onto existing diff entries", async () => {
    mockInvoke
      .mockResolvedValueOnce({
        activeVariation: { id: "main", name: "main", displayLabel: "main", isCurrent: true },
        variations: [{ id: "main", name: "main", displayLabel: "main", isCurrent: true }],
        versions: [version("2222222222222222222222222222222222222222", "Head", 1_700_000_100)],
        dirtyFiles: [],
        isDirty: false,
        stateMayBeInconsistent: false,
      })
      .mockResolvedValueOnce({
        fromVersion: "2222222222222222222222222222222222222222",
        toVersion: null,
        files: [
          { path: "intro.sk", kind: "added" },
          { path: "demo.sb", kind: "typeChanged" },
          { path: "notes.md", kind: "deleted" },
        ],
        patch: null,
      });

    await expect(listDraftlineChangedFiles()).resolves.toEqual([
      { path: "intro.sk", status: "added", additions: 0, deletions: 0 },
      { path: "demo.sb", status: "modified", additions: 0, deletions: 0 },
      { path: "notes.md", status: "deleted", additions: 0, deletions: 0 },
    ]);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "draftline_workspace_summary");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "draftline_diff_version_to_workspace", {
      version: "2222222222222222222222222222222222222222",
    });
  });

  it("falls back to summary dirty files in an empty workspace", async () => {
    mockInvoke.mockResolvedValueOnce({
      activeVariation: { id: "main", name: "main", displayLabel: "main", isCurrent: true },
      variations: [{ id: "main", name: "main", displayLabel: "main", isCurrent: true }],
      versions: [],
      dirtyFiles: [
        { path: "intro.sk", kind: "added" },
      ],
      isDirty: true,
      stateMayBeInconsistent: false,
    });

    await expect(listDraftlineChangedFiles()).resolves.toEqual([
      { path: "intro.sk", status: "added", additions: 0, deletions: 0 },
    ]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it("maps Draftline full history onto graph nodes", async () => {
    mockInvoke
      .mockResolvedValueOnce({
        activeVariation: { id: "main", name: "main", displayLabel: "main", isCurrent: true },
        variations: [{ id: "main", name: "main", displayLabel: "main", isCurrent: true }],
        versions: [],
        dirtyFiles: [],
        isDirty: false,
        stateMayBeInconsistent: false,
      })
      .mockResolvedValueOnce([
        {
          version: version("2222222222222222222222222222222222222222", "Second", 1_700_000_100, "Seth"),
          variationTips: ["main"],
          isHead: true,
          parentIds: ["1111111111111111111111111111111111111111"],
        },
        {
          version: version("1111111111111111111111111111111111111111", "First", 1_700_000_000, "Maria"),
          variationTips: [],
          isHead: false,
          parentIds: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          variation: { id: "main", name: "main", displayLabel: "Main", isCurrent: true },
          headVersion: version("2222222222222222222222222222222222222222", "Second", 1_700_000_100),
          reachableVersionCount: 2,
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
        author: "Maria",
      },
    ]);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "draftline_workspace_summary");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "draftline_full_history");
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "draftline_variation_summaries");
  });

  it("maps Draftline variations onto timeline entries", async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        variation: { id: "main", name: "main", displayLabel: "Main", isCurrent: true },
        headVersion: version("1111111111111111111111111111111111111111", "First", 1_700_000_000),
        reachableVersionCount: 1,
      },
      {
        variation: { id: "alt", name: "alt", displayLabel: "Alternative", isCurrent: false },
        headVersion: null,
        reachableVersionCount: 3,
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
    expect(mockInvoke).toHaveBeenCalledWith("draftline_delete_variation", { variation: "alt" });
  });

  it("reports large changed files from the Draftline content policy", async () => {
    mockInvoke.mockResolvedValueOnce({
      activeVariation: { id: "main", name: "main", displayLabel: "main", isCurrent: true },
      variations: [{ id: "main", name: "main", displayLabel: "main", isCurrent: true }],
      versions: [],
      dirtyFiles: [
        { path: "intro.sk", kind: "modified", isBinary: false, isLarge: false },
        { path: "screenshots/demo.png", kind: "added", isBinary: true, isLarge: true },
      ],
      isDirty: true,
      stateMayBeInconsistent: false,
    });

    await expect(listDraftlineLargeChangedFiles()).resolves.toEqual(["screenshots/demo.png"]);
    expect(mockInvoke).toHaveBeenCalledWith("draftline_workspace_summary");
  });

  it("maps Draftline version diffs to diff entries", async () => {
    mockInvoke.mockResolvedValueOnce({
      fromVersion: "1111111111111111111111111111111111111111",
      toVersion: "2222222222222222222222222222222222222222",
      files: [
        {
          path: "intro.sk",
          kind: "modified",
        },
      ],
      patch: "@@",
    });

    await expect(diffDraftlineVersions(
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
    )).resolves.toEqual([
      { path: "intro.sk", status: "modified", additions: 0, deletions: 0 },
    ]);
    expect(mockInvoke).toHaveBeenCalledWith("draftline_diff_versions", {
      from: "1111111111111111111111111111111111111111",
      to: "2222222222222222222222222222222222222222",
    });
  });

  it("maps Draftline version-to-workspace diffs for previews", async () => {
    mockInvoke.mockResolvedValueOnce({
      fromVersion: "1111111111111111111111111111111111111111",
      toVersion: null,
      files: [
        { path: "intro.sk", kind: "modified", isBinary: false },
        { path: "screenshots/a.png", kind: "added", isBinary: true },
      ],
      patch: null,
    });

    await expect(previewDraftlineVersion("1111111111111111111111111111111111111111")).resolves.toEqual([
      { path: "intro.sk", status: "modified", additions: 0, deletions: 0 },
      { path: "screenshots/a.png", status: "added", additions: 0, deletions: 0 },
    ]);
    expect(mockInvoke).toHaveBeenCalledWith("draftline_diff_version_to_workspace", {
      version: "1111111111111111111111111111111111111111",
    });
  });

  it("uses Draftline summary and save commands for the adapter lane", async () => {
    mockInvoke
      .mockResolvedValueOnce({
        activeVariation: { id: "main", name: "main", displayLabel: "main", isCurrent: true },
        variations: [{ id: "main", name: "main", displayLabel: "main", isCurrent: true }],
        versions: [],
        dirtyFiles: [{ path: "intro.sk", kind: "modified" }],
        isDirty: true,
        stateMayBeInconsistent: false,
      })
      .mockResolvedValueOnce({ id: "fedcba98765432100123456789abcdef01234567", label: "Save" });

    await expect(hasDraftlineChanges()).resolves.toBe(true);
    await expect(saveDraftlineVersion("Save")).resolves.toBe("fedcba98765432100123456789abcdef01234567");
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "draftline_workspace_summary");
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "draftline_save_version", { label: "Save" });
  });

  it("uses Draftline shelves for stash-compatible operations", async () => {
    mockInvoke
      .mockResolvedValueOnce({
        id: "cutready-stash",
        version: version("3333333333333333333333333333333333333333", "Shelved changes", 1_700_000_200),
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
        id: "cutready-stash",
        version: version("3333333333333333333333333333333333333333", "Shelved changes", 1_700_000_200),
      })
      .mockResolvedValueOnce(undefined);

    await expect(shelveDraftlineChanges()).resolves.toBeUndefined();
    await expect(hasDraftlineShelf()).resolves.toBe(true);
    await expect(popDraftlineShelf()).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, "draftline_shelve_changes", { name: "cutready-stash" });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, "draftline_list_shelves");
    expect(mockInvoke).toHaveBeenNthCalledWith(3, "draftline_list_shelves");
    expect(mockInvoke).toHaveBeenNthCalledWith(4, "draftline_apply_shelf", { id: "cutready-stash" });
    expect(mockInvoke).toHaveBeenNthCalledWith(5, "draftline_delete_shelf", { id: "cutready-stash" });
  });
});
