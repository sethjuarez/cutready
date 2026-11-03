import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../stores/appStore";
import { open } from "../dialogs";
import { invoke } from "../services/tauri";
import { Download, FolderOpen, Sparkles, TableProperties, XCircle } from "lucide-react";
import { GitHubConnectionCard } from "./GitHubConnectionCard";
import { RecentWorkspaceList } from "./RecentWorkspaceList";

const formCard =
  "mt-4 rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] p-4 shadow-layer animate-[fadeSlideIn_0.15s_ease-out]";
const fieldClass =
  "h-control rounded-control border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 text-sm text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";
const primaryButton =
  "h-control rounded-control bg-[rgb(var(--color-accent))] px-3 text-sm font-semibold text-[rgb(var(--color-accent-fg))] transition-colors duration-fast hover:bg-[rgb(var(--color-accent-hover))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(var(--color-surface))] disabled:cursor-not-allowed disabled:opacity-40";
const subtleButton =
  "h-control rounded-control px-3 text-sm text-[rgb(var(--color-text-secondary))] transition-colors duration-fast hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

/** Tile tints per starter, from the content-type palette (accent for "blank"). */
const tileClass = {
  blank: "bg-[rgb(var(--color-accent))]/15 text-[rgb(var(--color-accent))]",
  doc: "bg-[rgb(var(--color-content-storyboard))]/15 text-[rgb(var(--color-content-storyboard))]",
  folder: "bg-[rgb(var(--color-content-note))]/15 text-[rgb(var(--color-content-note))]",
} as const;

function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function StarterCard({
  icon,
  tile,
  title,
  subtitle,
  active,
  onClick,
}: {
  icon: ReactNode;
  tile: keyof typeof tileClass;
  title: string;
  subtitle: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className={`flex flex-col items-start gap-2.5 rounded-card border bg-[rgb(var(--color-surface))] p-3.5 text-left shadow-card transition-shadow duration-fast ease-fluent hover:shadow-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] ${
        active ? "border-[rgb(var(--color-accent))]" : "border-[rgb(var(--color-border-subtle))]"
      }`}
    >
      <span aria-hidden="true" className={`grid h-9 w-9 shrink-0 place-items-center rounded-[6px] ${tileClass[tile]}`}>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs text-[rgb(var(--color-text-secondary))]">{subtitle}</span>
      </span>
    </button>
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
  const currentRoot = useAppStore((s) => s.currentProject?.root ?? null);

  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<{ type: "auth" | "generic"; message: string } | null>(null);

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
      title: "Choose location for new workspace",
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
      title: "Open workspace folder",
    });
    if (!selected) return;
    await openProject(selected);
  }, [openProject]);

  const handleClone = useCallback(async () => {
    setCloneError(null);
    const url = cloneUrl.trim();
    if (!url) return;

    // Extract repo name from URL for the folder name
    const repoName = url.replace(/[\\/]+$/, "").replace(/\.git$/, "").split(/[\\/]/).pop() || "cloned-project";

    let defaultPath: string | undefined;
    try {
      const last = await invoke<string | null>("get_last_parent_folder");
      if (last) defaultPath = last;
    } catch { /* ignore */ }

    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath,
      title: "Choose location to clone into",
    });
    if (!selected) return;

    const sep = selected.includes("\\") ? "\\" : "/";
    const dest = `${selected}${sep}${repoName}`;

    setCloning(true);
    try {
      await invoke("clone_from_url", {
        url,
        dest,
      });
      await openProject(dest);
      setCloneUrl("");
      setShowClone(false);
    } catch (err) {
      console.error("Clone failed:", err);
      const msg = String(err);
      if (msg.includes("401")) {
        setCloneError({ type: "auth", message: msg });
      } else {
        setCloneError({ type: "generic", message: msg });
      }
    } finally {
      setCloning(false);
    }
  }, [cloneUrl, openProject]);

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
    <div className="mx-auto w-full max-w-[900px] px-10 pb-20 pt-10">
      <div className="mb-1.5 inline-flex items-center gap-1.5 text-sm text-[rgb(var(--color-text-secondary))]">
        <Sparkles className="h-4 w-4 text-[rgb(var(--color-accent))]" aria-hidden="true" />
        {greeting()}
      </div>
      <h1 className="text-[28px] font-semibold leading-9 tracking-tight">What are you demoing?</h1>
      <p className="mt-1.5 text-sm text-[rgb(var(--color-text-secondary))]">
        Bring what you have. Plan it as sketches and storyboards, then let the agents help you write and polish it.
      </p>

      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
        <StarterCard
          icon={<TableProperties className="h-5 w-5" />}
          tile="blank"
          title="New workspace"
          subtitle="Start from scratch"
          active={showCreate}
          onClick={() => { setShowCreate(true); setShowClone(false); }}
        />
        <StarterCard
          icon={<Download className="h-5 w-5" />}
          tile="doc"
          title="Clone workspace"
          subtitle="From a Git URL"
          active={showClone}
          onClick={() => { setShowClone(true); setShowCreate(false); }}
        />
        <StarterCard
          icon={<FolderOpen className="h-5 w-5" />}
          tile="folder"
          title="Open workspace"
          subtitle="A project folder or code repo"
          onClick={handleOpen}
        />
      </div>

      {showCreate && (
        <div className={formCard}>
          <label htmlFor="home-workspace-name" className="mb-2 block text-sm font-medium">Workspace name</label>
          <div className="flex gap-2">
            <input
              id="home-workspace-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="My Demo"
              aria-label="Workspace name"
              autoFocus
              className={`${fieldClass} min-w-0 flex-1`}
            />
            <button onClick={handleCreate} disabled={!slug} className={primaryButton}>
              Choose Folder
            </button>
            <button onClick={() => { setShowCreate(false); setNewName(""); }} className={subtleButton}>
              Cancel
            </button>
          </div>
          {slug && (
            <div className="mt-2 text-xs text-[rgb(var(--color-text-secondary))]">
              Folder: <span className="font-mono text-[rgb(var(--color-text))]">{slug}</span>
            </div>
          )}
        </div>
      )}

      {showClone && (
        <div className={formCard}>
          <label htmlFor="home-clone-url" className="mb-2 block text-sm font-medium">Workspace URL</label>
          <div className="flex gap-2">
            <input
              id="home-clone-url"
              type="text"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleClone();
                if (e.key === "Escape") { setShowClone(false); setCloneUrl(""); setCloneError(null); }
              }}
              placeholder="https://github.com/org/repo.git"
              autoFocus
              className={`${fieldClass} min-w-0 flex-1`}
            />
            <button onClick={handleClone} disabled={!cloneUrl.trim() || cloning} className={primaryButton}>
              {cloning ? "Cloning..." : "Choose Folder & Clone"}
            </button>
            <button onClick={() => { setShowClone(false); setCloneUrl(""); setCloneError(null); }} className={subtleButton}>
              Cancel
            </button>
          </div>
          {cloneError?.type === "auth" && (
            <div className="mt-3 rounded-card border border-[rgb(var(--color-error))]/30 bg-[rgb(var(--color-error))]/5 p-3">
              <div className="flex items-start gap-2">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--color-error))]" />
                <div className="min-w-0 flex-1">
                  <p className="mb-2 text-xs font-medium text-[rgb(var(--color-error))]">Authentication required</p>
                  <p className="text-xs text-[rgb(var(--color-text-secondary))]">
                    Connect GitHub in CutReady, then try cloning again.
                  </p>
                </div>
              </div>
              <div className="mt-3">
                <GitHubConnectionCard compact />
              </div>
            </div>
          )}
          {cloneError?.type === "generic" && (
            <div className="mt-3 flex items-start gap-2 text-xs text-[rgb(var(--color-error))]">
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-all">{cloneError.message}</span>
            </div>
          )}
        </div>
      )}

      <div className="mb-2.5 mt-7 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Recent workspaces</h2>
        <button
          type="button"
          onClick={handleOpen}
          className="rounded-control text-sm text-[rgb(var(--color-accent))] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
        >
          Open folder…
        </button>
      </div>
      {loading && recentProjects.length === 0 ? (
        <p className="py-6 text-sm text-[rgb(var(--color-text-secondary))]">Loading...</p>
      ) : recentProjects.length === 0 ? (
        <p className="rounded-card border border-dashed border-[rgb(var(--color-border))] px-4 py-6 text-center text-sm text-[rgb(var(--color-text-secondary))]">
          No recent workspaces yet.
        </p>
      ) : (
        <RecentWorkspaceList projects={recentProjects} currentPath={currentRoot} onOpen={openProject} onRemove={removeRecentProject} />
      )}
    </div>
  );
}
