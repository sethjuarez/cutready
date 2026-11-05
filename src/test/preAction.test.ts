import { afterEach, describe, expect, it, vi } from "vitest";

let documents: unknown[] = [];
vi.mock("../services/versionOperation", () => ({
  isSaveBlocked: () => false,
  runVersionOperation: (_operation: string, action: (summary: unknown) => Promise<unknown>) =>
    action({ documents, totals: {} }),
}));

import { preActionDecision } from "../domain/versioning";
import { requestPreAction, setAsideFor } from "../services/preAction";
import { usePreActionStore } from "../stores/preActionStore";
import { useVersioningStore } from "../stores/versioningStore";

const original = useVersioningStore.getState();

afterEach(() => {
  documents = [];
  useVersioningStore.setState(original, true);
  usePreActionStore.setState({ pending: null });
});

describe("preActionDecision", () => {
  it("runs straight away when everything is saved", () => {
    expect(preActionDecision({ changedDocuments: 0, isDirty: false })).toEqual({ kind: "run" });
  });

  it("asks when documents changed, always offering set aside", () => {
    expect(preActionDecision({ changedDocuments: 3, isDirty: true }))
      .toEqual({ kind: "ask", changeCount: 3 });
  });

  it("still asks when Draftline is dirty but no document is classified", () => {
    expect(preActionDecision({ changedDocuments: 0, isDirty: true }))
      .toEqual({ kind: "ask", changeCount: 1 });
  });
});

describe("requestPreAction", () => {
  it("runs the action when the workspace is clean", async () => {
    const run = vi.fn(async () => undefined);
    await requestPreAction({ operation: "Restore", target: "restoring", run });
    expect(run).toHaveBeenCalledOnce();
    expect(usePreActionStore.getState().pending).toBeNull();
  });

  it("opens the dialog instead of running when work is unsaved", async () => {
    documents = [{ path: "intro.sk" }];
    const run = vi.fn(async () => undefined);
    await requestPreAction({ operation: "Restore", target: "restoring", run });
    expect(run).not.toHaveBeenCalled();
    expect(usePreActionStore.getState().pending).toMatchObject({ operation: "Restore", changeCount: 1 });
  });
});

describe("setAsideFor", () => {
  it("shelves the work and hands back the request's follow-up", async () => {
    const order: string[] = [];
    const followUp = vi.fn(async () => undefined);
    const stashChanges = vi.fn(async (_name?: string) => { order.push("stash"); return true; });
    useVersioningStore.setState({ stashChanges });
    const result = await setAsideFor({
      operation: "x",
      target: "switching to alt",
      run: vi.fn(),
      onSetAside: () => { order.push("prepare"); return followUp; },
    });
    expect(order).toEqual(["prepare", "stash"]);
    expect(stashChanges).toHaveBeenCalledWith("Before switching to alt");
    expect(result).toEqual({ shelved: true, followUp });
  });

  it("reports when nothing was shelved", async () => {
    useVersioningStore.setState({ stashChanges: vi.fn(async () => false) });
    await expect(setAsideFor({ operation: "x", target: "x", run: vi.fn() })).resolves.toEqual({ shelved: false });
  });
});

describe("preActionStore", () => {
  it("never replaces a waiting request", () => {
    const base = { operation: "x", target: "x", run: vi.fn(), changeCount: 1 };
    expect(usePreActionStore.getState().ask(base)).toBe(true);
    const first = usePreActionStore.getState().pending!.id;
    expect(usePreActionStore.getState().ask({ ...base, operation: "y" })).toBe(false);
    expect(usePreActionStore.getState().pending).toMatchObject({ id: first, operation: "x" });
  });
});
