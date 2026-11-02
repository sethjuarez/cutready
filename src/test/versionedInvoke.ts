// Test double for the Tauri invoke used by app document reads and saves
// (ADR 0002 "App saves"). Versioned reads delegate to the plain read command
// and saves to the mock's own result, both wrapped as versioned documents, so
// existing mocks of get_sketch/update_sketch keep working.
const DOCUMENT_SAVES = /^(update_(sketch|sketch_title|storyboard|note)|set_(sketch|storyboard|planning_row|planning_cell)_lock|add_s\w+_to_storyboard|remove_sketch_from_storyboard|reorder_storyboard_items)$/;

export function versioned(document: unknown) {
  const content = typeof document === "string" ? document : JSON.stringify(document ?? null);
  return { document, content, version: `v:${content}`, merged: false };
}

export function versionedInvoke(mock: (...args: unknown[]) => unknown) {
  return (command: string, args?: Record<string, unknown>) => {
    if (command.endsWith("_versioned")) {
      return Promise.resolve(mock(command.replace(/_versioned$/, ""), args)).then(versioned);
    }
    if (!DOCUMENT_SAVES.test(command)) return mock(command, args);
    return Promise.resolve(mock(command, args)).then((result) =>
      versioned(result ?? (command === "update_note" ? args?.content : null)),
    );
  };
}