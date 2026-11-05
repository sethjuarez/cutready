import { describe, expect, it, vi } from "vitest";
import { LAST_PROJECT_KEY, openStartupProject, type StartupProjectDeps } from "../services/startupProject";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => void items.delete(key),
    items,
  };
}

function deps(overrides: Partial<StartupProjectDeps> & { opens?: boolean; error?: string | null } = {}) {
  const { opens = true, error = null, ...rest } = overrides;
  let open = false;
  return {
    startupPath: vi.fn(async () => null),
    openProject: vi.fn(async () => {
      open = opens;
    }),
    hasOpenProject: () => open,
    lastError: () => error,
    clearError: vi.fn(),
    loadRecentProjects: vi.fn(async () => {}),
    removeRecentProject: vi.fn(async () => {}),
    isCancelled: () => false,
    ...rest,
  };
}

describe("openStartupProject", () => {
  it("reopens the last project", async () => {
    const storage = memoryStorage({ [LAST_PROJECT_KEY]: "C:/demo" });
    const d = deps();
    await openStartupProject({ ...d, storage });
    expect(d.openProject).toHaveBeenCalledWith("C:/demo");
    expect(d.loadRecentProjects).not.toHaveBeenCalled();
    expect(storage.items.get(LAST_PROJECT_KEY)).toBe("C:/demo");
  });

  it("prefers the command-line project over the last one", async () => {
    const storage = memoryStorage({ [LAST_PROJECT_KEY]: "C:/demo" });
    const d = deps({ startupPath: vi.fn(async () => "C:/override") });
    await openStartupProject({ ...d, storage });
    expect(d.openProject).toHaveBeenCalledWith("C:/override");
  });

  it("lands on Home and drops a last project whose folder is gone", async () => {
    const storage = memoryStorage({ [LAST_PROJECT_KEY]: "C:/gone" });
    const d = deps({ opens: false, error: "Project not found: C:/gone" });
    await openStartupProject({ ...d, storage });
    expect(storage.items.has(LAST_PROJECT_KEY)).toBe(false);
    expect(d.removeRecentProject).toHaveBeenCalledWith("C:/gone");
    expect(d.clearError).toHaveBeenCalled();
    expect(d.loadRecentProjects).toHaveBeenCalled();
  });

  it("keeps a recent whose open failed for another reason", async () => {
    const storage = memoryStorage({ [LAST_PROJECT_KEY]: "C:/locked" });
    const d = deps({ opens: false, error: "The folder is in use" });
    await openStartupProject({ ...d, storage });
    expect(storage.items.has(LAST_PROJECT_KEY)).toBe(false);
    expect(d.removeRecentProject).not.toHaveBeenCalled();
    expect(d.loadRecentProjects).toHaveBeenCalled();
  });

  it("never forgets the user's project when a command-line project is missing", async () => {
    const storage = memoryStorage({ [LAST_PROJECT_KEY]: "C:/demo" });
    const d = deps({
      opens: false,
      error: "Project not found: C:/drill",
      startupPath: vi.fn(async () => "C:/drill"),
    });
    await openStartupProject({ ...d, storage });
    expect(storage.items.get(LAST_PROJECT_KEY)).toBe("C:/demo");
    expect(d.removeRecentProject).not.toHaveBeenCalled();
    expect(d.loadRecentProjects).toHaveBeenCalled();
  });

  it("shows recents when there is nothing to reopen", async () => {
    const d = deps();
    await openStartupProject({ ...d, storage: memoryStorage() });
    expect(d.openProject).not.toHaveBeenCalled();
    expect(d.loadRecentProjects).toHaveBeenCalled();
  });
});
