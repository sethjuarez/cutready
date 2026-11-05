/**
 * Coalesces bursts of workspace events into one refresh pass plus at most one
 * trailing pass.
 */
export function createCoalescedRefresh(refresh: () => Promise<void>) {
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
