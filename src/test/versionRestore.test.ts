import { afterEach, describe, expect, it, vi } from "vitest";

let documents: unknown[] = [];
vi.mock("../services/versionOperation", () => ({
  isSaveBlocked: () => false,
  runVersionOperation: (_operation: string, action: (summary: unknown) => Promise<unknown>) =>
    action({ documents, totals: {} }),
}));

const client = vi.hoisted(() => ({
  restoreVersionAsNewSave: vi.fn(async (_request: unknown) => ({})),
  restoreVersionPathsAsNewSave: vi.fn(async (_request: unknown) => ({})),
}));
vi.mock("../services/draftlineVersioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/draftlineVersioning")>()),
  draftlineClient: client,
  requireWorkspacePath: () => "C:/demo",
}));

vi.mock("../stores/workspaceHelpers", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  rewriteWorkspaceFiles: async (operation: () => Promise<void>, _label: string, options: { rethrow?: boolean } = {}) => {
    try {
      await operation();
      return true;
    } catch (err) {
      if (options.rethrow) throw err;
      return false;
    }
  },
}));

import { MAX_VERSION_NAME } from "../domain/versioning";
import {
  defaultRestoreComment,
  defaultRestoreName,
  restoreErrorMessage,
  restoreVersion,
  startRestore,
} from "../services/versionRestore";
import { usePreActionStore } from "../stores/preActionStore";
import { useSyncStore } from "../stores/syncStore";
import { useToastStore } from "../stores/toastStore";
import { useVersioningStore } from "../stores/versioningStore";

const originalVersioning = useVersioningStore.getState();
const originalSync = useSyncStore.getState();

function stubRefresh() {
  const noop = vi.fn(async () => undefined);
  useVersioningStore.setState({ loadVersions: noop, loadTimelines: noop, loadGraphData: noop, checkDirty: noop, checkRewound: noop });
  useSyncStore.setState({ refreshSyncStatus: noop });
  return noop;
}

afterEach(() => {
  documents = [];
  client.restoreVersionAsNewSave.mockReset().mockResolvedValue({});
  client.restoreVersionPathsAsNewSave.mockReset().mockResolvedValue({});
  useVersioningStore.setState(originalVersioning, true);
  useSyncStore.setState(originalSync, true);
  usePreActionStore.setState({ pending: null });
  vi.restoreAllMocks();
});

describe("restore defaults", () => {
  it("names the new version after the source version's name line", () => {
    expect(defaultRestoreName("Intro rewrite\n\nLonger comment")).toBe("Restore Intro rewrite");
    expect(defaultRestoreName("  ")).toBe("Restore version");
  });

  it("keeps a long default name within the limit", () => {
    const name = defaultRestoreName("x".repeat(100));
    expect([...name].length).toBeLessThanOrEqual(MAX_VERSION_NAME);
    expect(name.endsWith("…")).toBe(true);
  });

  it("links the comment back to the source version", () => {
    expect(defaultRestoreComment("Intro rewrite", "abcdef1234")).toBe("Restored from “Intro rewrite” (abcdef1)");
    expect(defaultRestoreComment("", "abcdef1234")).toBe("Restored from abcdef1");
  });
});

describe("restoreErrorMessage", () => {
  it.each([
    ["no_paths_selected", "Pick at least one document to restore."],
    ["nothing_to_restore", "Nothing to restore. These documents already match that version."],
    ["path_kind_changed", "A file became a folder (or the other way round) since that version, so it can't be restored here."],
    ["preflight_failed", "Save or set aside your changes, then restore again."],
  ])("maps %s to friendly copy", (code, message) => {
    expect(restoreErrorMessage({ code, message: "raw" })).toBe(message);
  });

  it("falls back to the error's own message", () => {
    expect(restoreErrorMessage(new Error("disk full"))).toBe("disk full");
  });
});

describe("restoreVersion", () => {
  it("restores the project with the name and comment as one message", async () => {
    const refresh = stubRefresh();
    await restoreVersion({ versionId: "v1", versionName: "Old", scope: { kind: "project" }, name: " Restore Old ", comment: "Why" });
    expect(client.restoreVersionAsNewSave).toHaveBeenCalledWith({ workspace_path: "C:/demo", version_id: "v1", label: "Restore Old\n\nWhy" });
    expect(refresh).toHaveBeenCalled();
  });

  it("confirms success with the new version's name", async () => {
    stubRefresh();
    const show = vi.spyOn(useToastStore.getState(), "show").mockClear();
    await restoreVersion({ versionId: "v1", versionName: "Old", scope: { kind: "project" }, name: "Restore Old" });
    expect(show).toHaveBeenCalledWith("Restored as “Restore Old”.", 4000, "success");
  });

  it("restores only the chosen documents", async () => {
    stubRefresh();
    await restoreVersion({ versionId: "v1", versionName: "Old", scope: { kind: "documents", paths: ["intro.sk"] }, name: "Restore Old" });
    expect(client.restoreVersionPathsAsNewSave).toHaveBeenCalledWith({
      workspace_path: "C:/demo",
      version_id: "v1",
      label: "Restore Old",
      paths: ["intro.sk"],
    });
    expect(client.restoreVersionAsNewSave).not.toHaveBeenCalled();
  });

  it("throws the friendly message when Draftline refuses", async () => {
    stubRefresh();
    client.restoreVersionPathsAsNewSave.mockRejectedValue({ code: "nothing_to_restore", message: "raw" });
    await expect(restoreVersion({ versionId: "v1", versionName: "Old", scope: { kind: "documents", paths: ["a.md"] }, name: "Restore Old" }))
      .rejects.toThrow("Nothing to restore. These documents already match that version.");
  });
});

describe("startRestore", () => {
  it("asks first when work is unsaved and restores only once the dialog continues", async () => {
    stubRefresh();
    documents = [{ path: "intro.sk" }];
    startRestore({ versionId: "v1", versionName: "Old take", scope: { kind: "project" }, name: "Restore Old take" });
    await vi.waitFor(() => expect(usePreActionStore.getState().pending).not.toBeNull());
    const pending = usePreActionStore.getState().pending!;
    expect(pending).toMatchObject({ operation: "Restore", target: "restoring “Old take”" });
    expect(client.restoreVersionAsNewSave).not.toHaveBeenCalled();
    await pending.run();
    expect(client.restoreVersionAsNewSave).toHaveBeenCalledOnce();
  });

  it("restores straight away with no unsaved work and reports a failure once", async () => {
    stubRefresh();
    const show = vi.spyOn(useToastStore.getState(), "show").mockClear();
    client.restoreVersionAsNewSave.mockRejectedValue({ code: "nothing_to_restore", message: "raw" });
    startRestore({ versionId: "v1", versionName: "Old", scope: { kind: "project" }, name: "Restore Old" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    expect(show).toHaveBeenCalledWith("Couldn't restore: Nothing to restore. These documents already match that version.", 5000, "error");
    expect(usePreActionStore.getState().pending).toBeNull();
  });
});
