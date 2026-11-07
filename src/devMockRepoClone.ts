// Web-shim fixtures for the commands that download a repository to start a project.
import type { InitProjectInRepositoryResult } from "@draftline/client";
import type { ClonedRepositoryResult } from "./ipc/workspace";

type Args = Record<string, unknown> | undefined;

const join = (parent: string, name: string) => `${parent}${parent.includes("\\") ? "\\" : "/"}${name}`;
const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const handlers: Record<string, (args: Args) => unknown> = {
  clone_from_url: (args) => (args as { dest: string }).dest,
  // A fresh clone without a CutReady project yet.
  clone_repository_for_project: (args): ClonedRepositoryResult => {
    const { dest, blobless } = args as { dest: string; blobless?: boolean };
    return {
      location_kind: "local",
      is_repository: true,
      root: dest,
      project: null,
      current_branch: "main",
      default_branch: "main",
      branches: ["main"],
      remotes: [{ name: "origin", url: "https://github.com/contoso/app.git" }],
      lfs: { used: false, available: true },
      target_folder: null,
      project_path: null,
      is_partial_clone: Boolean(blobless),
    };
  },
  init_project_in_repository_for_project: (args) => {
    const { parent, name, baseBranch } = args as { parent: string; name: string; baseBranch?: string | null };
    const folder = slug(name);
    return {
      workspace_path: join(parent, folder),
      settings: { folder, id: "mock-project", base_branch: baseBranch ?? null, commit_template: null },
      diagnostics: {},
    } as unknown as InitProjectInRepositoryResult;
  },
};

export function isRepoCloneMockCommand(cmd: string): boolean {
  return Object.prototype.hasOwnProperty.call(handlers, cmd);
}

export function mockRepoCloneInvoke(cmd: string, args: Args): unknown {
  return handlers[cmd](args);
}