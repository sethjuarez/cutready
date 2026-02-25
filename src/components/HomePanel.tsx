import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";

export function HomePanel() {
  const projects = useAppStore((s) => s.projects);
  const loading = useAppStore((s) => s.loading);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const createProject = useAppStore((s) => s.createProject);
  const openProject = useAppStore((s) => s.openProject);
  const deleteProject = useAppStore((s) => s.deleteProject);
  const loadDocuments = useAppStore((s) => s.loadDocuments);

  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    await createProject(name);
    setNewName("");
    setShowCreate(false);
  }, [newName, createProject]);

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
            Select a project or create a new one to get started.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          New Project
        </button>
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
              Create
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

      {/* Project list */}
      {loading && projects.length === 0 ? (
        <div className="text-center text-[var(--color-text-secondary)] py-12">
          Loading projects...
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-4">📁</div>
          <p className="text-[var(--color-text-secondary)]">
            No projects yet. Create one to get started.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {projects.map((p) => (
            <div
              key={p.id}
              className="group flex items-center justify-between p-4 rounded-xl bg-[var(--color-surface-alt)] border border-[var(--color-border)] hover:border-[var(--color-accent)]/40 transition-colors cursor-pointer"
              onClick={async () => {
                await openProject(p.id);
                await loadDocuments();
              }}
            >
              <div>
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Updated {formatRelativeDate(p.updated_at)}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete "${p.name}"?`)) {
                    deleteProject(p.id);
                  }
                }}
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-[var(--color-text-secondary)] hover:text-red-500 hover:bg-red-500/10 transition-all"
                title="Delete project"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          ))}
        </div>
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

