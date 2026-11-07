// New and Clone workspace forms, plus the pieces the home screen's other forms share.
import { useState } from "react";
import { XCircle } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { workspaceIpc } from "../../ipc/workspace";
import { GitHubConnectionCard } from "../GitHubConnectionCard";
import { cloneErrorView, repoNameFromUrl, type CloneErrorView } from "../../services/repoClone";

export const formCard =
  "mt-3 rounded-card border border-[rgb(var(--color-border-subtle))] bg-[rgb(var(--color-surface))] p-4 shadow-layer animate-[fadeSlideIn_0.15s_ease-out]";
export const fieldClass =
  "h-control rounded-control border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 text-sm text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";
export const primaryButton =
  "h-control rounded-control bg-[rgb(var(--color-accent))] px-3 text-sm font-semibold text-[rgb(var(--color-accent-fg))] transition-colors duration-fast hover:bg-[rgb(var(--color-accent-hover))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(var(--color-surface))] disabled:cursor-not-allowed disabled:opacity-40";
export const subtleButton =
  "h-control rounded-control px-3 text-sm text-[rgb(var(--color-text-secondary))] transition-colors duration-fast hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

export type ChooseFolder = (title: string) => Promise<string | null>;

export function joinPath(parent: string, child: string) {
  return `${parent}${parent.includes("\\") ? "\\" : "/"}${child}`;
}

export function folderSlug(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function NewWorkspaceForm({ chooseFolder, onClose }: { chooseFolder: ChooseFolder; onClose: () => void }) {
  const createProject = useAppStore((s) => s.createProject);
  const [name, setName] = useState("");
  const slug = folderSlug(name);

  const create = async () => {
    if (!slug) return;
    const parent = await chooseFolder("Choose location for new workspace");
    if (!parent) return;
    await createProject(joinPath(parent, slug));
    onClose();
  };

  return (
    <div className={formCard}>
      <label htmlFor="home-workspace-name" className="mb-2 block text-sm font-medium">Workspace name</label>
      <div className="flex gap-2">
        <input
          id="home-workspace-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="My Talk"
          aria-label="Workspace name"
          autoFocus
          className={`${fieldClass} min-w-0 flex-1`}
        />
        <button onClick={() => void create()} disabled={!slug} className={primaryButton}>Choose Folder</button>
        <button onClick={onClose} className={subtleButton}>Cancel</button>
      </div>
      {slug && (
        <div className="mt-2 text-xs text-[rgb(var(--color-text-secondary))]">
          Folder: <span className="font-mono text-[rgb(var(--color-text))]">{slug}</span>
        </div>
      )}
    </div>
  );
}

export function CloneWorkspaceForm({ chooseFolder, onClose }: { chooseFolder: ChooseFolder; onClose: () => void }) {
  const openProject = useAppStore((s) => s.openProject);
  const [url, setUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<CloneErrorView | null>(null);

  const clone = async () => {
    setError(null);
    const trimmed = url.trim();
    if (!trimmed) return;
    const parent = await chooseFolder("Choose location to clone into");
    if (!parent) return;
    const dest = joinPath(parent, repoNameFromUrl(trimmed));
    setCloning(true);
    try {
      // A hybrid repo opens its CutReady folder, not the repo root.
      await openProject(await workspaceIpc.cloneFromUrl(trimmed, dest));
      onClose();
    } catch (err) {
      console.error("Clone failed:", err);
      setError(cloneErrorView(err));
    } finally {
      setCloning(false);
    }
  };

  return (
    <div className={formCard}>
      <label htmlFor="home-clone-url" className="mb-2 block text-sm font-medium">Workspace URL</label>
      <div className="flex gap-2">
        <input
          id="home-clone-url"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void clone();
            if (e.key === "Escape") onClose();
          }}
          placeholder="https://github.com/org/repo.git"
          autoFocus
          className={`${fieldClass} min-w-0 flex-1`}
        />
        <button onClick={() => void clone()} disabled={!url.trim() || cloning} className={primaryButton}>
          {cloning ? "Cloning..." : "Choose Folder & Clone"}
        </button>
        <button onClick={onClose} className={subtleButton}>Cancel</button>
      </div>
      <CloneErrorNotice error={error} />
    </div>
  );
}

export function CloneErrorNotice({ error }: { error: CloneErrorView | null }) {
  if (error?.kind === "auth") {
    return (
      <div role="alert" className="mt-3 rounded-card border border-[rgb(var(--color-error))]/30 bg-[rgb(var(--color-error))]/5 p-3">
        <div className="flex items-start gap-2">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--color-error))]" />
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-xs font-medium text-[rgb(var(--color-error))]">Authentication required</p>
            <p className="text-xs text-[rgb(var(--color-text-secondary))]">{error.message}</p>
          </div>
        </div>
        <div className="mt-3"><GitHubConnectionCard compact /></div>
      </div>
    );
  }
  if (!error) return null;
  return (
    <div role="alert" className="mt-3 flex items-start gap-2 text-xs text-[rgb(var(--color-error))]">
      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="break-all">{error.message}</span>
    </div>
  );
}
