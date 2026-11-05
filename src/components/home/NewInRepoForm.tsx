// "New in existing repo": download a repository and start a CutReady folder inside it.
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useToastStore } from "../../stores/toastStore";
import { workspaceIpc, type ClonedRepository } from "../../ipc/workspace";
import { cloneErrorView, repoNameFromUrl, startProjectInRepository, type CloneErrorView } from "../../services/repoClone";
import {
  CloneErrorNotice,
  fieldClass,
  folderSlug,
  formCard,
  joinPath,
  primaryButton,
  subtleButton,
  type ChooseFolder,
} from "./NewWorkspaceForms";
import { isOpenProject } from "../../utils/home";

/** Runs a store action that swallows its errors, then checks `folder` is the open project. */
async function confirmOpened(folder: string, run: (folder: string) => Promise<void>): Promise<void> {
  useAppStore.getState().clearError();
  await run(folder);
  const { error, currentProject, adoptionPrompt } = useAppStore.getState();
  if (error) throw new Error(error);
  if (adoptionPrompt || !isOpenProject(currentProject, folder)) {
    throw new Error(`Couldn't open ${folder}. Try opening it from Home.`);
  }
}

export function NewInRepoForm({ chooseFolder, onClose }: { chooseFolder: ChooseFolder; onClose: () => void }) {
  const [source, setSource] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [name, setName] = useState("cutready");
  const [busy, setBusy] = useState<"cloning" | "creating" | null>(null);
  const [error, setError] = useState<CloneErrorView | null>(null);
  // Kept after a clone so a taken folder name can be changed without downloading again.
  const [cloned, setCloned] = useState<{ key: string; repository: ClonedRepository } | null>(null);

  const trimmed = source.trim();
  const slug = folderSlug(name);
  const dest = parent && trimmed ? joinPath(parent, repoNameFromUrl(trimmed)) : null;
  const cloneKey = `${trimmed}\n${dest}`;

  const pickParent = async () => {
    const picked = await chooseFolder("Choose where to download the repository");
    if (picked) setParent(picked);
  };

  const start = async () => {
    if (!dest || !slug || busy) return;
    setError(null);
    try {
      let repository = cloned?.key === cloneKey ? cloned.repository : null;
      if (!repository) {
        setBusy("cloning");
        repository = await workspaceIpc.cloneRepositoryForProject(trimmed, dest);
        setCloned({ key: cloneKey, repository });
      }
      setBusy("creating");
      const result = await startProjectInRepository(
        {
          reserveFolder: workspaceIpc.reserveProjectFolder,
          createProject: (folder) => confirmOpened(folder, useAppStore.getState().createProject),
          openProject: (folder) => confirmOpened(folder, useAppStore.getState().openProject),
        },
        repository,
        slug,
      );
      if (result.kind === "opened-existing") {
        useToastStore.getState().show(
          `This repository already has a CutReady project, so it opened ${result.folder}.`,
          6000,
          "info",
        );
      }
      onClose();
    } catch (err) {
      console.error("New in existing repo failed:", err);
      setError(cloneErrorView(err));
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void start();
    if (e.key === "Escape") onClose();
  };

  return (
    <div className={formCard}>
      <label htmlFor="home-repo-source" className="mb-2 block text-sm font-medium">Repository</label>
      <input
        id="home-repo-source"
        type="text"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="https://github.com/org/repo.git or a local repo path"
        autoFocus
        className={`${fieldClass} w-full`}
      />
      <p className="mt-1.5 text-xs text-[rgb(var(--color-text-secondary))]">
        Downloads the whole repository, including its history.
      </p>

      <div className="mt-3 text-sm font-medium" id="home-repo-parent-label">Download to</div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void pickParent()}
          aria-labelledby="home-repo-parent-label"
          className={`${subtleButton} inline-flex items-center gap-1.5 border border-[rgb(var(--color-border))]`}
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
          Choose folder…
        </button>
        <span className="min-w-0 truncate font-mono text-xs text-[rgb(var(--color-text-secondary))]" title={dest ?? undefined}>
          {dest ?? parent ?? "No folder chosen"}
        </span>
      </div>

      <label htmlFor="home-repo-workspace-name" className="mt-3 mb-2 block text-sm font-medium">Workspace name</label>
      <input
        id="home-repo-workspace-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
        className={`${fieldClass} w-full`}
      />
      {slug && (
        <div className="mt-2 text-xs text-[rgb(var(--color-text-secondary))]">
          CutReady folder: <span className="font-mono text-[rgb(var(--color-text))]">{dest ? joinPath(dest, slug) : slug}</span>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className={subtleButton}>Cancel</button>
        <button onClick={() => void start()} disabled={!dest || !slug || busy !== null} className={primaryButton}>
          {busy === "cloning" ? "Downloading…" : busy === "creating" ? "Creating…" : cloned?.key === cloneKey ? "Create workspace" : "Download & create"}
        </button>
      </div>
      <CloneErrorNotice error={error} />
    </div>
  );
}
