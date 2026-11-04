import { describe, expect, it, vi } from "vitest";
import type { ChangeSummary } from "../domain/changes";
import { createVersionOperation, isSaveBlocked, type VersionOperationDeps } from "../services/versionOperation";
import { diffEntryToInput } from "../services/workspaceChangeSummary";
import type { SaveFailure } from "../stores/changeSummaryStore";

const summary = { documents: [], totals: {} } as unknown as ChangeSummary;

function harness(overrides: Partial<VersionOperationDeps> = {}) {
  const calls: string[] = [];
  let failure: SaveFailure | null = null;
  const deps: VersionOperationDeps = {
    settle: vi.fn(async () => { calls.push("settle"); }),
    loadSummary: vi.fn(async () => { calls.push("summary"); return summary; }),
    onSummary: vi.fn(),
    onSaveFailure: vi.fn((next) => { failure = next; }),
    ...overrides,
  };
  return { deps, calls, run: createVersionOperation(deps), failure: () => failure };
}

describe("runVersionOperation boundary", () => {
  it("saves, recomputes the summary, then runs the action with it", async () => {
    const h = harness();
    const result = await h.run("Save version", async (s) => {
      h.calls.push("action");
      expect(s).toBe(summary);
      return 42;
    });
    expect(result).toBe(42);
    expect(h.calls).toEqual(["settle", "summary", "action"]);
    expect(h.deps.onSummary).toHaveBeenCalledWith(summary);
    expect(h.failure()).toBeNull();
  });

  it("stops before the action when the save fails and publishes a retry", async () => {
    let attempts = 0;
    const h = harness({
      settle: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk full");
      }),
    });
    const action = vi.fn(async () => "sent");
    const error = await h.run("Send", action).catch((e) => e);
    expect(isSaveBlocked(error)).toBe(true);
    expect(error.operation).toBe("Send");
    expect(action).not.toHaveBeenCalled();
    expect(h.deps.loadSummary).not.toHaveBeenCalled();
    expect(h.failure()?.operation).toBe("Send");

    await h.failure()!.retry();
    expect(action).toHaveBeenCalledTimes(1);
    expect(h.failure()).toBeNull();
  });

  it("does not report summary or action errors as save failures", async () => {
    const h = harness({ loadSummary: vi.fn(async () => { throw new Error("offline"); }) });
    const error = await h.run("Switch", async () => 1).catch((e) => e);
    expect(isSaveBlocked(error)).toBe(false);
    expect(error.message).toBe("offline");
    expect(h.failure()).toBeNull();

    const h2 = harness();
    const actionError = await h2.run("Restore", async () => { throw new Error("conflict"); }).catch((e) => e);
    expect(isSaveBlocked(actionError)).toBe(false);
    expect(h2.failure()).toBeNull();
  });
  it("makes retry single-flight and never clears a newer operation's failure", async () => {
    let failSettle = true;
    let releaseSettle: (() => void) | null = null;
    const h = harness({
      settle: vi.fn(async () => {
        if (failSettle) throw new Error("disk full");
        await new Promise<void>((resolve) => { releaseSettle = resolve; });
      }),
    });
    const action = vi.fn(async () => "sent");
    await h.run("Send", action).catch(() => undefined);
    const firstFailure = h.failure()!;

    failSettle = false;
    const a = firstFailure.retry();
    const b = firstFailure.retry();
    expect(a).toBe(b);
    await Promise.resolve();
    releaseSettle!();
    await a;
    expect(action).toHaveBeenCalledTimes(1);

    // A slow older run finishing after a newer failure leaves the newer failure shown.
    const slow = h.run("Save version", async () => 1);
    await Promise.resolve();
    failSettle = true;
    await h.run("Switch", async () => 2).catch(() => undefined);
    expect(h.failure()?.operation).toBe("Switch");
    releaseSettle!();
    await slow;
    expect(h.failure()?.operation).toBe("Switch");
  });
});

describe("diffEntryToInput", () => {
  it("keeps known statuses and maps unknown ones to modified", () => {
    expect(diffEntryToInput({ path: "a.sk", status: "added", additions: 0, deletions: 0 }).status).toBe("added");
    expect(diffEntryToInput({ path: "a.sk", status: "conflicted", additions: 0, deletions: 0 }).status).toBe("conflicted");
    expect(diffEntryToInput({ path: "a.sk", status: "typechange", additions: 0, deletions: 0 }).status).toBe("modified");
  });
});
