import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

export function HomePanel() {
  const recentProjects = useAppStore((s) => s.recentProjects);
  const loading = useAppStore((s) => s.loading);
  const loadRecentProjects = useAppStore((s) => s.loadRecentProjects);
  const removeRecentProject = useAppStore((s) => s.removeRecentProject);
  const createProject = useAppStore((s) => s.createProject);
  const openProject = useAppStore((s) => s.openProject);

  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    loadRecentProjects();
  }, [loadRecentProjects]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;

    // Get the last parent folder to start from
    let defaultPath: string | undefined;
    try {
      const last = await invoke<string | null>("get_last_parent_folder");
      if (last) defaultPath = last;
    } catch { /* ignore */ }

    // Show folder picker
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath,
      title: "Choose location for new project",
    });

    if (!selected) return;

    // Create the project inside the selected folder
    const projectPath = `${selected}/${name}`;
    await createProject(projectPath);
    setNewName("");
    setShowCreate(false);
  }, [newName, createProject]);

  const handleOpen = useCallback(async () => {
    let defaultPath: string | undefined;
    try {
      const last = await invoke<string | null>("get_last_parent_folder");
      if (last) defaultPath = last;
    } catch { /* ignore */ }

    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath,
      title: "Open project folder",
    });

    if (!selected) return;
    await openProject(selected);
  }, [openProject]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleCreate();
      if (e.key === "Escape") {
        setShowCreate(false);
        setNewName("");
      }
    },
    [handleCreate],
  );

  return (
    <div className="max-w-xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Open a project folder or create a new one.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleOpen}
            className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]/40 transition-colors"
          >
            Open Folder
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-colors"
          >
            New Project
          </button>
        </div>
      </div>

      {/* Create project inline form */}
      {showCreate && (
        <div className="mb-6 p-4 rounded-xl bg-[var(--color-surface-alt)] border border-[var(--color-border)]">
          <label className="block text-sm font-medium mb-2">Project name</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="My Demo"
              autoFocus
              className="flex-1 px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)]/50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40"
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Choose Folder
            </button>
            <button
              onClick={() => {
                setShowCreate(false);
                setNewName("");
              }}
              className="px-3 py-2 rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Recent projects list */}
      {loading && recentProjects.length === 0 ? (
        <div className="text-center text-[var(--color-text-secondary)] py-12">
          Loading...
        </div>
      ) : recentProjects.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-4">📁</div>
          <p className="text-[var(--color-text-secondary)]">
            No recent projects. Open or create a project folder to get started.
          </p>
        </div>
      ) : (
        <>
          <h2 className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider mb-3">
            Recent Projects
          </h2>
          <div className="flex flex-col gap-2">
            {recentProjects.map((p) => (
              <div
                key={p.path}
                className="group flex items-center justify-between p-4 rounded-xl bg-[var(--color-surface-alt)] border border-[var(--color-border)] hover:border-[var(--color-accent)]/40 transition-colors cursor-pointer"
                onClick={() => openProject(p.path)}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {p.path.split(/[/\\]/).pop()}
                  </div>
                  <div className="text-xs text-[var(--color-text-secondary)] mt-0.5 truncate">
                    {p.path}
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-4 shrink-0">
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    {formatRelativeDate(p.last_opened)}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRecentProject(p.path);
                    }}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 text-[var(--color-text-secondary)] hover:text-red-500 transition-all"
                    title="Remove from recent"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function formatRelativeDate(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

