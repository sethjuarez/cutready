import { describe, expect, it, vi } from "vitest";
import { createCoalescedRefresh } from "../services/coalescedRefresh";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createCoalescedRefresh", () => {
  it("runs one pass plus one trailing pass for a burst of events", async () => {
    const firstPass = deferred();
    const refresh = vi.fn().mockReturnValueOnce(firstPass.promise).mockResolvedValue(undefined);
    const refresher = createCoalescedRefresh(refresh);

    const done = refresher.request();
    void refresher.request();
    void refresher.request();
    expect(refresh).toHaveBeenCalledTimes(1);
    firstPass.resolve();
    await done;
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops refreshing once disposed", async () => {
    const firstPass = deferred();
    const refresh = vi.fn().mockReturnValueOnce(firstPass.promise).mockResolvedValue(undefined);
    const refresher = createCoalescedRefresh(refresh);
    const done = refresher.request();
    void refresher.request();
    refresher.dispose();
    firstPass.resolve();
    await done;
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
