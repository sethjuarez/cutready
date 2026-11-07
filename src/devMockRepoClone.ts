// Web-shim fixtures for the commands that download a repository to start a project.
import type { ClonedRepository } from "./ipc/workspace";

type Args = Record<string, unknown> | undefined;

const handlers: Record<string, (args: Args) => unknown> = {
  // Clones open the destination itself; an unmarked repo has no managed folder yet.
  clone_from_url: (args) => (args as { dest: string }).dest,
  clone_repository_for_project: (args): ClonedRepository => ({ root: (args as { dest: string }).dest, managedFolder: null }),
  reserve_project_folder: (args) => {
    const { root, name } = args as { root: string; name: string };
    return `${root}${root.includes("\\") ? "\\" : "/"}${name}`;
  },
};

export function isRepoCloneMockCommand(cmd: string): boolean {
  return Object.prototype.hasOwnProperty.call(handlers, cmd);
}

export function mockRepoCloneInvoke(cmd: string, args: Args): unknown {
  return handlers[cmd](args);
}
