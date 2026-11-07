// Download a repository and start (or open) a CutReady project inside it.
import type { ClonedRepository } from "../ipc/workspace";
import { commandErrorText, transferConflictPath } from "./commandErrors";

export interface CloneErrorView {
  /** `auth` means connecting GitHub may fix it. */
  kind: "auth" | "generic";
  message: string;
}

/** The folder name a clone of `url` (a Git URL or local path) gets by default. */
export function repoNameFromUrl(url: string): string {
  const name = url.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "").split(/[\\/:]/).pop();
  return name && name !== "." && name !== ".." ? name : "repository";
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

const AUTH_MESSAGE = "The repository needs you to sign in. Connect GitHub, then try again.";

/** What to tell the user when cloning or starting the project failed. */
export function cloneErrorView(error: unknown): CloneErrorView {
  const text = commandErrorText(error);
  switch (errorCode(error)) {
    case "auth_failed":
      return { kind: "auth", message: AUTH_MESSAGE };
    case "network_failed":
      return { kind: "generic", message: "Couldn't reach the repository. Check the address and your connection." };
    case "destination_not_empty":
      return { kind: "generic", message: `${transferConflictPathOr(error, "That folder")} already has files in it. Choose another location.` };
    case "invalid_marker":
      return { kind: "generic", message: "This repository's .draftline file isn't one CutReady can read. Update CutReady or fix the file." };
    case "file_exists":
      return { kind: "generic", message: `${transferConflictPathOr(error, "That folder")} already exists in the repository. Choose another name.` };
  }
  if (/\b401\b|authentication/i.test(text)) return { kind: "auth", message: AUTH_MESSAGE };
  if (/\blfs\b|filter/i.test(text)) {
    return { kind: "generic", message: "This repository uses Git LFS, which CutReady can't download yet. Clone it with Git, then use Open folder." };
  }
  return { kind: "generic", message: text };
}

function transferConflictPathOr(error: unknown, fallback: string): string {
  const details = (error as { details?: { path?: unknown } }).details;
  if (typeof details?.path === "string" && details.path) return `"${details.path}"`;
  const path = transferConflictPath(error);
  return path ? `"${path}"` : fallback;
}

export interface RepoProjectDeps {
  /** Resolves to the path of a new folder `name` in `root`; rejects if it exists. */
  reserveFolder: (root: string, name: string) => Promise<string>;
  /** Starts a CutReady project in `folder`; rejects if it didn't open. */
  createProject: (folder: string) => Promise<void>;
  /** Opens the project in `folder`; rejects if it didn't open. */
  openProject: (folder: string) => Promise<void>;
}

export type RepoProjectResult =
  | { kind: "opened-existing"; folder: string }
  | { kind: "created"; folder: string };

/**
 * Starts a project named `name` in a downloaded repository. A repository that
 * already has a CutReady folder opens that folder instead, since a repository
 * holds one CutReady project.
 */
export async function startProjectInRepository(
  deps: RepoProjectDeps,
  repository: ClonedRepository,
  name: string,
): Promise<RepoProjectResult> {
  if (repository.managedFolder) {
    await deps.openProject(repository.managedFolder);
    return { kind: "opened-existing", folder: repository.managedFolder };
  }
  const folder = await deps.reserveFolder(repository.root, name);
  await deps.createProject(folder);
  return { kind: "created", folder };
}
