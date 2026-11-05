// "New in existing repo": download a repository and start a CutReady folder inside it.
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useToastStore } from "../../stores/toastStore";
import type { CloneProgressEvent } from "@draftline/client";
import { workspaceIpc, type ClonedRepositoryResult } from "../../ipc/workspace";
import {
  cloneErrorView,
  repoNameFromUrl,
  projectFolderName,
  RepoProjectError,
  startProjectInRepository,
  type CloneErrorView,
} from "../../services/repoClone";
import { CloneProgressBar } from "./CloneProgressBar";
import {
  CloneErrorNotice,
  fieldClass,
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
  const [blobless, setBlobless] = useState(false);
  const [busy, setBusy] = useState<"cloning" | "creating" | null>(null);
  const [progress, setProgress] = useState<CloneProgressEvent | null>(null);
  const [error, setError] = useState<CloneErrorView | null>(null);
  // Kept after a clone so a taken folder name can be changed without downloading again.
  const [cloned, setCloned] = useState<{ key: string; repository: ClonedRepositoryResult; created?: string } | null>(null);

  const trimmed = source.trim();
  const slug = projectFolderName(name);
  const dest = parent && trimmed ? joinPath(parent, repoNameFromUrl(trimmed)) : null;
  const cloneKey = `${trimmed}\n${dest}\n${blobless}`;
  // Set once the CutReady folder exists; a retry only reopens it.
  const created = cloned?.key === cloneKey ? cloned.created : undefined;

  const pickParent = async () => {
    const picked = await chooseFolder("Choose where to download the repository");
    if (picked) setParent(picked);
  };

  const download = async (url: string, to: string): Promise<ClonedRepositoryResult> => {
    setBusy("cloning");
    setProgress(null);
    const repository = await workspaceIpc.cloneRepositoryForProject({ url, dest: to, blobless }, setProgress);
    setCloned({ key: cloneKey, repository });
    if (blobless && !repository.is_partial_clone) {
      useToastStore.getState().show("CutReady downloaded a full clone instead, so older versions are available.", 6000, "info");
    }
    return repository;
  };

  const start = async () => {
    if (!dest || !slug || busy) return;
    setError(null);
    try {
      const repository = cloned?.key === cloneKey ? cloned.repository : await download(trimmed, dest);
      setBusy("creating");
      const result = await startProjectInRepository(
        {
          initProject: async (root, folderName) => {
            const { workspace_path } = await workspaceIpc.createProjectInRepository(root, folderName);
            // A retry after a failed open reopens this folder instead of creating another.
            setCloned({ key: cloneKey, repository: { ...repository, project_path: workspace_path }, created: workspace_path });
            return workspace_path;
          },
          openProject: (folder) => confirmOpened(folder, useAppStore.getState().openProject),
          openCreated: (folder) => confirmOpened(folder, useAppStore.getState().createProject),
        },
        repository,
        name.trim(),
      );
      if (result.kind === "opened-existing" && result.folder !== created) {
        useToastStore.getState().show(
          `This repository already has a CutReady project, so it opened ${result.folder}.`,
          6000,
          "info",
        );
      }
      onClose();
    } catch (err) {
      console.error("New in existing repo failed:", err);
      setError(err instanceof RepoProjectError ? cloneErrorView(err.error, err.phase) : cloneErrorView(err));
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
        {blobless
          ? "Downloads the current files and the list of versions, but not the contents of older file versions."
          : "Downloads the whole repository, including its history."}
      </p>
      <label className="mt-2 flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={blobless}
          onChange={(e) => setBlobless(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Skip old file versions (faster download)
          <span className="block text-[rgb(var(--color-text-secondary))]">
            Older versions may not preview or compare.
          </span>
        </span>
      </label>

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
        disabled={created !== undefined}
        className={`${fieldClass} w-full`}
      />
      {created ? (
        <div className="mt-2 text-xs text-[rgb(var(--color-text-secondary))]">
          Created: <span className="font-mono text-[rgb(var(--color-text))]">{created}</span>
        </div>
      ) : slug && (
        <div className="mt-2 text-xs text-[rgb(var(--color-text-secondary))]">
          CutReady folder: <span className="font-mono text-[rgb(var(--color-text))]">{dest ? joinPath(dest, slug) : slug}</span>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className={subtleButton}>Cancel</button>
        <button onClick={() => void start()} disabled={!dest || !slug || busy !== null} className={primaryButton}>
          {busy === "cloning" ? "Downloading…" : busy === "creating" ? "Creating…" : created ? "Retry opening" : cloned?.key === cloneKey ? "Create workspace" : "Download & create"}
        </button>
      </div>
      {busy === "cloning" && <CloneProgressBar progress={progress} />}
      <CloneErrorNotice error={error} />
    </div>
  );
}
