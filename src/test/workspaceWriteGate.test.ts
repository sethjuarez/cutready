import { beforeEach, describe, expect, it, vi } from "vitest";

import { gateWorkspaceWrites, isWorkspaceWriteCommand, whileWritingWorkspace, workspaceWritesIdle } from "../services/workspaceWriteGate";
import { createCoalescedRefresh } from "../services/coalescedRefresh";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const mockInvoke = vi.fn();
const workspaceInvoke = gateWorkspaceWrites((command: string, args?: unknown) => mockInvoke(command, args) as Promise<unknown>);

beforeEach(() => mockInvoke.mockReset());

describe("workspaceWriteGate", () => {
  it("is idle when nothing is writing", async () => {
    await expect(workspaceWritesIdle()).resolves.toBeUndefined();
  });

  it("holds refreshes until every overlapping write finishes", async () => {
    const order: string[] = [];
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = whileWritingWorkspace(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const second = whileWritingWorkspace(() => new Promise<void>((resolve) => { finishSecond = resolve; }));
    const idle = workspaceWritesIdle().then(() => order.push("refresh"));

    finishFirst();
    await first;
    order.push("first done");
    finishSecond();
    await second;
    await idle;

    expect(order).toEqual(["first done", "refresh"]);
  });

  it("releases waiters when a write fails", async () => {
    const write = whileWritingWorkspace(() => Promise.reject(new Error("merge failed")));
    const idle = workspaceWritesIdle();
    await expect(write).rejects.toThrow("merge failed");
    await expect(idle).resolves.toBeUndefined();
  });
});

describe("gateWorkspaceWrites", () => {
  it("gates commands that rewrite workspace files and passes reads straight through", async () => {
    expect(isWorkspaceWriteCommand("merge_incoming_with_resolutions")).toBe(true);
    expect(isWorkspaceWriteCommand("restore_version_paths_as_new_save")).toBe(true);
    expect(isWorkspaceWriteCommand("diff_version_to_workspace")).toBe(false);

    const write = deferred();
    mockInvoke.mockImplementation((command: string) => (command === "selected_discard" ? write.promise : Promise.resolve("read")));
    const discard = workspaceInvoke("selected_discard", { request: {} });
    let idle = false;
    void workspaceWritesIdle().then(() => { idle = true; });
    await expect(workspaceInvoke("diff_version_to_workspace")).resolves.toBe("read");
    expect(idle).toBe(false);
    write.resolve();
    await discard;
    await Promise.resolve();
    expect(idle).toBe(true);
  });
});

describe("createCoalescedRefresh", () => {
  it("waits for writes, then runs one pass plus one trailing pass for a burst of events", async () => {
    const writes = deferred();
    const firstPass = deferred();
    const refresh = vi.fn().mockReturnValueOnce(firstPass.promise).mockResolvedValue(undefined);
    let waitCalls = 0;
    const refresher = createCoalescedRefresh(refresh, () => (waitCalls++ === 0 ? writes.promise : Promise.resolve()));

    const done = refresher.request();
    void refresher.request();
    void refresher.request();
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();

    writes.resolve();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    void refresher.request();
    void refresher.request();
    firstPass.resolve();
    await done;
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops refreshing once disposed", async () => {
    const writes = deferred();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const refresher = createCoalescedRefresh(refresh, () => writes.promise);
    const done = refresher.request();
    refresher.dispose();
    writes.resolve();
    await done;
    expect(refresh).not.toHaveBeenCalled();
  });
});
