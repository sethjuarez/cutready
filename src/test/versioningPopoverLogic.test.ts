import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useVersionSuggest, type SuggestFields, type VersionSuggestDeps } from "../components/versioning/useVersionSuggest";
import type { ChangeSummary } from "../domain/changes";
import { classifySyncError, fileBelongsToProject, pullRequestUrl } from "../domain/versioning";
import { discardWithUndo, undoMessage, type DiscardDeps } from "../services/discardWithUndo";
import { useChangeSummaryStore } from "../stores/changeSummaryStore";

const summary = { documents: [{ path: "a.sk" }], totals: {} } as unknown as ChangeSummary;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function suggestHarness(initial: SuggestFields, deps: Partial<VersionSuggestDeps>) {
  let fields = initial;
  const setFields = vi.fn((next: SuggestFields) => { fields = next; });
  const full: VersionSuggestDeps = {
    isConfigured: () => Promise.resolve(true),
    suggest: () => Promise.resolve({ name: "Suggested", comment: "" }),
    getSummary: () => summary,
    isOnline: () => true,
    ...deps,
  };
  const hook = renderHook(() => useVersionSuggest(fields, setFields, full));
  return { hook, setFields, fields: () => fields };
}

describe("useVersionSuggest", () => {
  it("fills empty fields with the suggestion", async () => {
    const { hook, setFields } = suggestHarness({ name: "", comment: "" }, {});
    await act(() => hook.result.current.run());
    expect(setFields).toHaveBeenCalledWith({ name: "Suggested", comment: "" });
  });

  it("asks before replacing what the user typed", async () => {
    const { hook, setFields } = suggestHarness({ name: "Mine", comment: "" }, {});
    await act(() => hook.result.current.run());
    expect(setFields).not.toHaveBeenCalled();
    expect(hook.result.current.pending).toEqual({ name: "Suggested", comment: "" });
    act(() => hook.result.current.confirmReplace());
    expect(setFields).toHaveBeenCalledWith({ name: "Suggested", comment: "" });
  });

  it("ignores a reply that arrives after Esc", async () => {
    const reply = deferred<{ name: string; comment: string }>();
    const { hook, setFields } = suggestHarness({ name: "", comment: "" }, { suggest: () => reply.promise });
    let running!: Promise<void>;
    act(() => { running = hook.result.current.run(); });
    expect(hook.result.current.status).toBe("running");
    act(() => { expect(hook.result.current.cancel()).toBe(true); });
    await act(async () => { reply.resolve({ name: "Late", comment: "" }); await running; });
    expect(setFields).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
  });

  it("drops a reply when the changes moved on mid-request", async () => {
    const reply = deferred<{ name: string; comment: string }>();
    let current: ChangeSummary = summary;
    const { hook, setFields } = suggestHarness({ name: "", comment: "" }, {
      suggest: () => reply.promise,
      getSummary: () => current,
    });
    let running!: Promise<void>;
    act(() => { running = hook.result.current.run(); });
    current = { documents: [{ path: "b.sk" }], totals: {} } as unknown as ChangeSummary;
    await act(async () => { reply.resolve({ name: "Stale", comment: "" }); await running; });
    expect(setFields).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBe("idle");
  });

  it("is disabled offline and without a model", async () => {
    const offline = suggestHarness({ name: "", comment: "" }, { isOnline: () => false });
    await act(async () => undefined);
    expect(offline.hook.result.current.disabledReason).toBe("Suggestions need a connection");
    const noModel = suggestHarness({ name: "", comment: "" }, { isConfigured: () => Promise.resolve(false) });
    await act(async () => undefined);
    expect(noModel.hook.result.current.disabledReason).toMatch(/Connect a model/);
  });
});

describe("discardWithUndo", () => {
  function fakeDeps(overrides: Partial<DiscardDeps> = {}) {
    const notes: { message: string; type: string; undo?: () => void }[] = [];
    const deps: DiscardDeps = {
      shelve: vi.fn(() => Promise.resolve("shelf-1")),
      undo: vi.fn(() => Promise.resolve("restored" as const)),
      rewriteAll: vi.fn(async (op) => { await op(); return true; }),
      rewriteFile: vi.fn(async (path, op) => op(`repo/${path}`)),
      notify: (message, type, undo) => { notes.push({ message, type, undo }); },
      guard: vi.fn((_operation, action) => action()),
      ...overrides,
    };
    return { deps, notes };
  }

  it("shelves everything and offers Undo that restores it", async () => {
    const { deps, notes } = fakeDeps();
    await expect(discardWithUndo(deps, 3)).resolves.toBe("shelf-1");
    expect(deps.shelve).toHaveBeenCalledWith();
    expect(notes[0]).toMatchObject({ message: "Discarded 3 changes", type: "info" });
    notes[0].undo?.();
    await vi.waitFor(() => expect(notes[1]).toMatchObject({ message: "Discarded changes restored.", type: "success" }));
    expect(deps.undo).toHaveBeenCalledWith("shelf-1");
    expect(deps.guard).toHaveBeenCalledWith("Undo discard", expect.any(Function));
  });

  it("doesn't undo when open edits can't be saved first", async () => {
    const { deps, notes } = fakeDeps({ guard: vi.fn(() => Promise.reject(new Error("blocked"))) });
    await discardWithUndo(deps, 2);
    notes[0].undo?.();
    await vi.waitFor(() => expect(deps.guard).toHaveBeenCalled());
    await Promise.resolve();
    expect(deps.undo).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
  });

  it("shelves only the one file by its repository path", async () => {
    const { deps, notes } = fakeDeps();
    await discardWithUndo(deps, 1, "plan.md");
    expect(deps.shelve).toHaveBeenCalledWith(["repo/plan.md"]);
    expect(notes[0].message).toBe("Discarded 1 change");
  });

  it("reports a failed single-file discard without an Undo", async () => {
    const { deps, notes } = fakeDeps({ rewriteFile: () => Promise.reject(new Error("locked")) });
    await expect(discardWithUndo(deps, 1, "plan.md")).resolves.toBeNull();
    expect(notes).toEqual([{ message: "Discard failed: locked", type: "error", undo: undefined }]);
  });

  it("offers nothing when there was nothing to shelve", async () => {
    const { deps, notes } = fakeDeps({ shelve: () => Promise.resolve(null) });
    await expect(discardWithUndo(deps, 0)).resolves.toBeNull();
    expect(notes).toEqual([]);
  });

  it("keeps the shelf when Undo would overwrite newer edits", () => {
    expect(undoMessage("conflict")).toEqual({
      text: "Couldn't undo: you've edited since. The discarded changes are kept for 7 days.",
      type: "warning",
    });
  });
});

describe("classifySyncError", () => {
  const is = { isIdentityRequired: (m: string) => m.includes("identity"), isGuidance: (m: string) => m.startsWith("Tip:") };

  it.each([
    ["Changes can't be merged automatically", "conflict"],
    ["identity required", "identity"],
    ["Tip: get updates first", "guidance"],
    ["Could not resolve host github.com", "offline"],
    ["Push rejected: non-fast-forward", "rejected"],
    ["401 Unauthorized", "auth"],
    ["Repository returned 404", "not-found"],
    ["Something else", "other"],
  ])("classifies %s as %s", (message, kind) => {
    expect(classifySyncError(message, is).kind).toBe(kind);
  });

  it("keeps unknown errors visible as-is", () => {
    expect(classifySyncError("Disk full", is).text).toBe("Disk full");
  });
});

describe("pullRequestUrl", () => {
  it("links review branches on GitHub remotes", () => {
    expect(pullRequestUrl("git@github.com:acme/talk.git", "cutready/intro")).toBe(
      "https://github.com/acme/talk/compare/cutready/intro?expand=1",
    );
  });

  it.each([
    ["https://github.com/acme/talk.git", "main"],
    ["https://gitlab.com/acme/talk.git", "feature"],
    [null, "feature"],
  ])("returns null for %s on %s", (remote, branch) => {
    expect(pullRequestUrl(remote, branch)).toBeNull();
  });
});

describe("fileBelongsToProject", () => {
  it("matches files inside the project folder only", () => {
    expect(fileBelongsToProject("talks\\intro.sk", "talks/")).toBe(true);
    expect(fileBelongsToProject("talks-old/intro.sk", "talks")).toBe(false);
    expect(fileBelongsToProject("anything.md", ".")).toBe(true);
  });
});

describe("changeSummaryStore.openForSave", () => {
  it("opens the popover and asks the name field for focus", () => {
    useChangeSummaryStore.setState({ popoverOpen: false, nameFocusRequest: 4 });
    useChangeSummaryStore.getState().openForSave();
    expect(useChangeSummaryStore.getState()).toMatchObject({ popoverOpen: true, nameFocusRequest: 5 });
    useChangeSummaryStore.getState().reset();
    expect(useChangeSummaryStore.getState().popoverOpen).toBe(false);
  });
});
