// Native file drops. Tauri intercepts OS file drags before the DOM sees them, so the
// webview's drag-drop event is the only way to learn which files were dropped and where.

/** A file drag over the window, in CSS pixels relative to the viewport. */
export type FileDropEvent =
  | { type: "over"; x: number; y: number }
  | { type: "drop"; x: number; y: number; paths: string[] }
  | { type: "leave" };

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Subscribes to file drags over the window; resolves to an unsubscribe. A no-op outside Tauri. */
export async function onFileDrop(handler: (event: FileDropEvent) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "leave") {
      handler({ type: "leave" });
      return;
    }
    const { x, y } = payload.position.toLogical(window.devicePixelRatio || 1);
    if (payload.type === "drop") handler({ type: "drop", x, y, paths: payload.paths });
    else handler({ type: "over", x, y });
  });
}
