// Download a repository and start (or open) a CutReady project inside it.
import type { ClonedRepository } from "@draftline/client";
import { commandErrorText, transferConflictPath } from "./commandErrors";

export interface CloneErrorView {
  /** `auth` means connecting GitHub may fix it. */
  kind: "auth" | "generic";
  message: string;
}

/** Which step failed: downloading, or creating the CutReady folder. */
export type RepoProjectPhase = "clone" | "create";

/** The folder name a clone of `url` (a Git URL or local path) gets by default. */
export function repoNameFromUrl(url: string): string {
  const name = url.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "").split(/[\\/:]/).pop();
  return name && name !== "." && name !== ".." ? name : "repository";
}

const RESERVED_WINDOWS_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * The folder Draftline's `init_project_in_repository` makes for `name`, or ""
 * when it would refuse it. Mirrors Draftline 0.14's `project_folder_name`.
 */
export function projectFolderName(name: string): string {
  let slug = name.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/, "");
  return slug && RESERVED_WINDOWS_NAMES.has(slug) ? `${slug}-project` : slug;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

const AUTH_MESSAGE = "The repository needs you to sign in. Connect GitHub, then try again.";
const LFS_MESSAGE =
  "This repository uses Git LFS, and its files couldn't be downloaded. Install Git LFS, or clone it with Git, then use Open folder.";

/** What to tell the user when cloning or starting the project failed. */
export function cloneErrorView(error: unknown, phase: RepoProjectPhase = "clone"): CloneErrorView {
  const text = commandErrorText(error);
  switch (errorCode(error)) {
    case "auth_failed":
    case "github_unauthorized":
      return { kind: "auth", message: AUTH_MESSAGE };
    case "network_failed":
      return { kind: "generic", message: "Couldn't reach the repository. Check the address and your connection." };
    case "remote_operation_timed_out":
      return { kind: "generic", message: "The repository stopped answering. Check your connection and try again." };
    case "unsupported_remote_transport":
      return { kind: "generic", message: "CutReady can't download from that kind of address. Use an https:// URL or a local path." };
    case "variation_not_found":
      return { kind: "generic", message: "That branch doesn't exist in the repository. Pick another branch." };
    case "folder_not_empty":
      return phase === "create"
        ? { kind: "generic", message: `${pathOr(error, "That folder")} already exists in the repository. Choose another name.` }
        : { kind: "generic", message: `${pathOr(error, "That folder")} already has files in it. Choose another location.` };
    case "folder_is_elsewhere":
      return { kind: "generic", message: "This repository already has a CutReady project. Open that one instead." };
    case "invalid_folder_marker":
      return { kind: "generic", message: "This repository's .draftline file isn't one CutReady can read. Fix the file, then try again." };
    case "newer_folder_marker":
      return { kind: "generic", message: "This repository's project was set up by a newer CutReady. Update CutReady, then try again." };
    case "invalid_project_settings":
      return { kind: "generic", message: `That project name won't work: ${text}` };
    case "not_a_repository":
      return { kind: "generic", message: "That folder isn't a Git repository." };
    case "git_filter_failed":
      return { kind: "generic", message: LFS_MESSAGE };
    case "github_repository_not_found":
      return { kind: "generic", message: "GitHub couldn't find that repository, or your account can't see it." };
    case "github_no_push_access":
      return { kind: "generic", message: "Your GitHub account can't send to this repository. Ask for write access, or use your own copy (a fork)." };
  }
  if (/\b401\b|authentication/i.test(text)) return { kind: "auth", message: AUTH_MESSAGE };
  if (/\blfs\b|filter/i.test(text)) return { kind: "generic", message: LFS_MESSAGE };
  return { kind: "generic", message: text };
}

function pathOr(error: unknown, fallback: string): string {
  const details = (error as { details?: { path?: unknown } }).details;
  if (typeof details?.path === "string" && details.path) return `"${details.path}"`;
  const path = transferConflictPath(error);
  return path ? `"${path}"` : fallback;
}

export interface RepoProjectDeps {
  /** Creates the CutReady folder `name` inside `parent`; resolves to its path. */
  initProject: (parent: string, name: string) => Promise<string>;
  /** Opens the project in `folder`; rejects if it didn't open. */
  openProject: (folder: string) => Promise<void>;
  /** Opens the folder `initProject` just made; rejects if it didn't open. */
  openCreated: (folder: string) => Promise<void>;
}

export type RepoProjectResult =
  | { kind: "opened-existing"; folder: string }
  | { kind: "created"; folder: string };

/** An error that remembers which step failed, so the message fits. */
export class RepoProjectError extends Error {
  constructor(
    readonly phase: RepoProjectPhase,
    readonly error: unknown,
  ) {
    super(commandErrorText(error));
  }
}

/**
 * Starts a project named `name` in a downloaded repository. A repository that
 * already has a CutReady project opens it instead, since a repository holds
 * one CutReady project.
 */
export async function startProjectInRepository(
  deps: RepoProjectDeps,
  repository: ClonedRepository,
  name: string,
): Promise<RepoProjectResult> {
  if (repository.project_path) {
    await deps.openProject(repository.project_path);
    return { kind: "opened-existing", folder: repository.project_path };
  }
  if (!repository.root) throw new Error("The download didn't produce a checkout to add a project to.");
  let folder: string;
  try {
    folder = await deps.initProject(repository.root, name);
  } catch (error) {
    throw new RepoProjectError("create", error);
  }
  await deps.openCreated(folder);
  return { kind: "created", folder };
}
