import { afterEach, describe, expect, it, vi } from "vitest";

const mockListen = vi.hoisted(() => vi.fn());

vi.mock("../services/tauri", () => ({
  invoke: vi.fn(),
  listen: (...args: unknown[]) => mockListen(...args),
}));

import {
  WORKSPACE_SNAPSHOT_DEFERRED_EVENT,
  onWorkspaceSnapshotDeferred,
} from "../services/identity";

type Handler = (event: { payload: unknown }) => void;

function subscribe() {
  const off = vi.fn();
  mockListen.mockResolvedValue(off);
  const handler = vi.fn();
  const subscription = onWorkspaceSnapshotDeferred(handler);
  const [event, listener] = mockListen.mock.calls[0] as [string, Handler];
  return { handler, listener, event, subscription, off };
}

describe("onWorkspaceSnapshotDeferred", () => {
  afterEach(() => {
    mockListen.mockReset();
  });

  it("subscribes to the backend event and returns its unlisten", async () => {
    const { event, subscription, off } = subscribe();
    expect(event).toBe(WORKSPACE_SNAPSHOT_DEFERRED_EVENT);
    expect(event).toBe("workspace-snapshot-deferred");
    await expect(subscription).resolves.toBe(off);
  });

  it("passes the backend message through", () => {
    const { handler, listener } = subscribe();
    const message =
      "\"Add Demo to workspace\" is in your pending changes. Add your name and email in Settings › Profile to save it as a version.";
    listener({ payload: { message, reason: "identity" } });
    expect(handler).toHaveBeenCalledWith(message, "identity");
  });

  it("passes the unsaved-edits reason and defaults others to identity", () => {
    const { handler, listener } = subscribe();
    listener({ payload: { message: "a", reason: "unsaved_edits" } });
    listener({ payload: { message: "b" } });
    listener({ payload: { message: "c", reason: "bogus" } });
    expect(handler.mock.calls).toEqual([
      ["a", "unsaved_edits"],
      ["b", "identity"],
      ["c", "identity"],
    ]);
  });

  it("ignores malformed payloads", () => {
    const { handler, listener } = subscribe();
    listener({ payload: null });
    listener({ payload: { message: "   " } });
    listener({ payload: { message: 42 } });
    expect(handler).not.toHaveBeenCalled();
  });
});
