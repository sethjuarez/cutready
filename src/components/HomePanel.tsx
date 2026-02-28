import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

/* ── Decorative icon components ───────────────────────────── */

function LogoMark() {
  return (
    <div className="relative w-16 h-16">
      {/* Gradient glow behind the icon */}
      <div
        className="absolute inset-0 rounded-2xl blur-xl opacity-40"
        style={{ background: "linear-gradient(135deg, var(--color-accent), #e879a8)" }}
      />
      <img
        src="/cutready.svg"
        alt="CutReady"
        className="relative w-16 h-16 drop-shadow-lg"
        draggable={false}
      />
    </div>
  );
}

function ActionIcon({ type }: { type: "new" | "open" }) {
  if (type === "new") {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

function ProjectAvatar({ name }: { name: string }) {
  const initials = name
    .split(/[-_ ]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  // Deterministic color from name
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hues = [260, 200, 330, 170, 20, 45]; // purple, blue, pink, teal, orange, amber
  const hue = hues[Math.abs(hash) % hues.length];

  return (
    <div
      className="w-10 h-10 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0 transition-transform group-hover:scale-105"
      style={{ background: `hsl(${hue}, 55%, 55%)` }}
    >
      {initials || "?"}
    </div>
  );
}

/* ── Main component ───────────────────────────────────────── */

export function HomePanel() {
  const recentProjects = useAppStore((s) => s.recentProjects);
  const loading = useAppStore((s) => s.loading);
  const loadRecentProjects = useAppStore((s) => s.loadRecentProjects);
  const removeRecentProject = useAppStore((s) => s.removeRecentProject);
  const createProject = useAppStore((s) => s.createProject);
  const openProject = useAppStore((s) => s.openProject);

  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const slug = newName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  useEffect(() => {
    loadRecentProjects();
  }, [loadRecentProjects]);

  const handleCreate = useCallback(async () => {
    if (!slug) return;
    let defaultPath: string | undefined;
    try {
      const last = await invoke<string | null>("get_last_parent_folder");
      if (last) defaultPath = last;
    } catch { /* ignore */ }

    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath,
      title: "Choose location for new project",
    });
    if (!selected) return;

    const sep = selected.includes("\\") ? "\\" : "/";
    const projectPath = `${selected}${sep}${slug}`;
    await createProject(projectPath);
    setNewName("");
    setShowCreate(false);
  }, [slug, createProject]);

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
    <div className="flex items-center justify-center h-full overflow-y-auto px-6 py-6">
      {/* ── Decorative background gradient ── */}
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.04]"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 20%, var(--color-accent), transparent)",
        }}
      />

      {/* Two-column layout: hero left, recent projects right */}
      <div className="relative flex items-start gap-12 w-full max-w-3xl">
        {/* ── Left column: hero + actions ── */}
        <div className="flex flex-col items-start flex-1 min-w-0">
          {/* Hero */}
          <div className="flex items-center gap-4 mb-6">
            <LogoMark />
            <div>
              <h1 className="text-3xl font-bold tracking-tight">CutReady</h1>
              <p className="text-[var(--color-text-secondary)] text-sm leading-relaxed mt-0.5">
                Plan, record, and produce polished demo videos.
              </p>
            </div>
          </div>

          {/* Action cards */}
          <div className="grid grid-cols-2 gap-3 w-full mb-6">
            <button
              onClick={() => setShowCreate(true)}
              className="group flex flex-col items-center gap-2 p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-alt)] hover:border-[var(--color-accent)] hover:shadow-lg hover:shadow-[var(--color-accent)]/5 transition-all"
            >
              <div className="w-9 h-9 rounded-lg bg-[var(--color-accent)] text-white flex items-center justify-center group-hover:scale-110 transition-transform">
                <ActionIcon type="new" />
              </div>
              <div>
                <div className="text-sm font-semibold">New Project</div>
                <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Start from scratch
                </div>
              </div>
            </button>
            <button
              onClick={handleOpen}
              className="group flex flex-col items-center gap-2 p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-alt)] hover:border-[var(--color-accent)] hover:shadow-lg hover:shadow-[var(--color-accent)]/5 transition-all"
            >
              <div className="w-9 h-9 rounded-lg border-2 border-[var(--color-border)] text-[var(--color-text-secondary)] flex items-center justify-center group-hover:border-[var(--color-accent)] group-hover:text-[var(--color-accent)] group-hover:scale-110 transition-all">
                <ActionIcon type="open" />
              </div>
              <div>
                <div className="text-sm font-semibold">Open Project</div>
                <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Pick an existing folder
                </div>
              </div>
            </button>
          </div>

          {/* Create project inline form */}
          {showCreate && (
            <div className="w-full mb-6 p-4 rounded-xl bg-[var(--color-surface-alt)] border border-[var(--color-accent)] shadow-lg shadow-[var(--color-accent)]/5 animate-[fadeSlideIn_0.15s_ease-out]">
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
                  disabled={!slug}
                  className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Choose Folder
                </button>
                <button
                  onClick={() => { setShowCreate(false); setNewName(""); }}
                  className="px-3 py-2 rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface)] transition-colors"
                >
                  Cancel
                </button>
              </div>
              {slug && (
                <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                  Folder: <span className="font-mono text-[var(--color-text)]">{slug}</span>
                </div>
              )}
            </div>
          )}

          {/* Keyboard shortcut hint */}
          <div className="pt-2 text-left">
            <span className="text-xs text-[var(--color-text-secondary)] opacity-60">
              <kbd className="px-1.5 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] text-[10px] font-mono">Ctrl</kbd>
              {" + "}
              <kbd className="px-1.5 py-0.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-alt)] text-[10px] font-mono">K</kbd>
              {" "}
              Command Palette
            </span>
          </div>
        </div>

        {/* ── Right column: recent projects ── */}
        <div className="w-72 shrink-0 min-h-0">
          {loading && recentProjects.length === 0 ? (
            <div className="text-center text-[var(--color-text-secondary)] py-6">
              Loading...
            </div>
          ) : recentProjects.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-sm text-[var(--color-text-secondary)]">
                No recent projects yet.
              </p>
            </div>
          ) : (
            <>
              <h2 className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider mb-2">
                Recent Projects
              </h2>
              <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto pr-1">
                {recentProjects.map((p) => {
                  const name = p.path.split(/[/\\]/).pop() ?? "project";
                  return (
                    <div
                      key={p.path}
                      className="group flex items-center gap-3 p-2.5 rounded-xl bg-[var(--color-surface-alt)] border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:shadow-md hover:shadow-[var(--color-accent)]/5 transition-all cursor-pointer"
                      onClick={() => openProject(p.path)}
                    >
                      <ProjectAvatar name={name} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{name}</div>
                        <div className="text-xs text-[var(--color-text-secondary)] mt-0.5 truncate">
                          {p.path}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-1 shrink-0">
                        <span className="text-[10px] text-[var(--color-text-secondary)]">
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
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────────── */

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

