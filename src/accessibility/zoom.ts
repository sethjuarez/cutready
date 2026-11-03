// Native webview zoom. Calls are serialized: while one setZoom is in flight,
// later requests collapse into the most recent one, so a burst of Ctrl+= ends
// at the last level instead of racing.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { trafficLightSpace } from "./settings";

export type ZoomSetter = (factor: number) => Promise<void>;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

const nativeSetter: ZoomSetter = async (factor) => {
  if (!isTauriRuntime()) return;
  await getCurrentWebview().setZoom(factor);
};

/** `onApplied` runs only after the setter succeeds, with the level in percent. */
export function createZoomQueue(setter: ZoomSetter, onApplied: (percent: number) => void = () => {}) {
  let pending: number | null = null;
  let applied: number | null = null;
  let running: Promise<void> | null = null;

  async function drain() {
    while (pending !== null) {
      const next = pending;
      pending = null;
      if (next === applied) continue;
      try {
        await setter(next / 100);
        applied = next;
        onApplied(next);
      } catch (error) {
        console.warn("[a11y] Failed to set zoom:", error);
      }
    }
    running = null;
  }

  return {
    /** Requests a zoom level in percent; resolves once the queue is idle. */
    request(percent: number): Promise<void> {
      pending = percent;
      running ??= drain();
      return running;
    },
  };
}

let compensationRoot: HTMLElement | null = null;

function compensate(percent: number) {
  const root = compensationRoot ?? document.documentElement;
  root.style.setProperty("--app-zoom", String(percent / 100));
  root.style.setProperty("--macos-traffic-light-space", `${trafficLightSpace(percent)}px`);
}

const queue = createZoomQueue(nativeSetter, compensate);

/**
 * Applies zoom natively and keeps native chrome the same physical size: the
 * macOS traffic-light gap and the Windows caption buttons are sized in CSS px,
 * which the webview zoom would otherwise scale. Compensation follows the zoom
 * that actually took effect, so a failed call (or the browser dev shim, which
 * has no native zoom) leaves the chrome alone.
 */
export function applyZoom(percent: number, root: HTMLElement = document.documentElement): Promise<void> {
  compensationRoot = root;
  if (!isTauriRuntime()) return Promise.resolve();
  return queue.request(percent);
}
