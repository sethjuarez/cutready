// Opens the project CutReady should show at launch: a command-line/env path
// (`--project`, `CUTREADY_PROJECT`) first, then the last project the user opened.

export const LAST_PROJECT_KEY = "cutready:lastProject";

export interface StartupProjectDeps {
  startupPath: () => Promise<string | null>;
  openProject: (path: string) => Promise<void>;
  hasOpenProject: () => boolean;
  lastError: () => string | null;
  clearError: () => void;
  loadRecentProjects: () => Promise<void>;
  removeRecentProject: (path: string) => Promise<void>;
  isCancelled: () => boolean;
  storage?: Pick<Storage, "getItem" | "removeItem">;
}

/** The backend reports a vanished folder as `Project not found: <path>`. */
export function isMissingProjectError(error: string | null): boolean {
  return error?.startsWith("Project not found") ?? false;
}

export async function openStartupProject(deps: StartupProjectDeps): Promise<void> {
  const storage = deps.storage ?? localStorage;
  const startupPath = await deps.startupPath().catch(() => null);
  if (deps.isCancelled()) return;

  const persistedPath = storage.getItem(LAST_PROJECT_KEY);
  const path = startupPath || persistedPath;
  if (!path) {
    await deps.loadRecentProjects();
    return;
  }

  await deps.openProject(path);
  if (deps.isCancelled() || deps.hasOpenProject()) return;

  // Reopening failed (moved, deleted or refused): land on Home instead of
  // surfacing an error and failing again on every launch.
  const missing = isMissingProjectError(deps.lastError());
  if (!startupPath && persistedPath) {
    storage.removeItem(LAST_PROJECT_KEY);
    if (missing) await deps.removeRecentProject(persistedPath);
  }
  deps.clearError();
  await deps.loadRecentProjects();
}
