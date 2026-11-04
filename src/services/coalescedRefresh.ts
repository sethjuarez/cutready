import { workspaceWritesIdle } from "./workspaceWriteGate";

/**
 * Coalesces bursts of workspace events into one refresh pass plus at most one
 * trailing pass, and holds each pass until no workspace write is in flight.
 */
export function createCoalescedRefresh(refresh: () => Promise<void>, waitForWrites = workspaceWritesIdle) {
  let disposed = false;
  let refreshing = false;
  let rerun = false;

  const request = async () => {
    if (refreshing) {
      rerun = true;
      return;
    }
    refreshing = true;
    try {
      do {
        rerun = false;
        await waitForWrites();
        if (!disposed) await refresh();
      } while (rerun && !disposed);
    } finally {
      refreshing = false;
    }
  };

  return {
    request,
    dispose: () => {
      disposed = true;
    },
  };
}
