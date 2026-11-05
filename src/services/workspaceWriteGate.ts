/**
 * Draftline emits workspace events while a merge, switch, discard or restore
 * is still rewriting files, and a diff read during that window can fail
 * mid-write. Those commands run through the gate so event-driven refreshes
 * can wait for them.
 */
const WORKSPACE_WRITE_COMMANDS = new Set([
  "apply_incoming",
  "apply_shelf",
  "merge_incoming_with_resolutions",
  "merge_incoming_with_token",
  "merge_variation_with_resolutions",
  "move_project_folder",
  "restore_version_as_new_save",
  "restore_version_as_new_save_to_variation",
  "restore_version_paths_as_new_save",
  "retry_content_download",
  "selected_discard",
  "selected_shelve",
  "switch_variation",
]);

export function isWorkspaceWriteCommand(command: string): boolean {
  return WORKSPACE_WRITE_COMMANDS.has(command);
}

/** Wraps `invoke` so workspace-rewriting commands hold event-driven refreshes until they finish. */
export function gateWorkspaceWrites<I extends (command: string, ...rest: never[]) => Promise<unknown>>(invoke: I): I {
  return ((command: string, ...rest: never[]) =>
    isWorkspaceWriteCommand(command) ? whileWritingWorkspace(() => invoke(command, ...rest)) : invoke(command, ...rest)) as I;
}

let inFlight = 0;
const waiters = new Set<() => void>();

export async function whileWritingWorkspace<T>(write: () => Promise<T>): Promise<T> {
  inFlight++;
  try {
    return await write();
  } finally {
    inFlight--;
    if (inFlight === 0) {
      const ready = [...waiters];
      waiters.clear();
      for (const resolve of ready) resolve();
    }
  }
}

/** Resolves once no workspace write is in flight. */
export function workspaceWritesIdle(): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.add(resolve));
}
