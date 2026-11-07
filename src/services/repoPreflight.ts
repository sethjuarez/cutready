// What "New in existing repo" says about a repository before downloading it.
import type { RepositoryInspection } from "@draftline/client";
import { cloneErrorView } from "./repoClone";

export interface RepoNotice {
  tone: "info" | "warning";
  message: string;
}

export interface RepoPreflight {
  notices: RepoNotice[];
  /** Where saves can be sent, when there is a choice; the first is the default. CutReady's own variations are left out. */
  targets: string[];
}

/** Notices and the send-to choices for an inspected repository. */
export function repoPreflight(inspection: RepositoryInspection): RepoPreflight {
  const notices: RepoNotice[] = [];
  if (inspection.project) {
    notices.push({
      tone: "info",
      message: `This repository already has a CutReady project in "${inspection.project.folder}". CutReady will open it instead of creating another.`,
    });
  }
  if (inspection.lfs.used && !inspection.lfs.available) {
    notices.push({
      tone: "warning",
      message: "This repository uses Git LFS, which isn't installed. Install Git LFS first, or large files won't download.",
    });
  }
  const github = inspection.github;
  if (inspection.github_error) {
    notices.push({
      tone: "warning",
      message: `CutReady couldn't check your GitHub access: ${cloneErrorView(inspection.github_error).message}`,
    });
  }
  if (github && !github.can_push) {
    const name = `${github.repository.owner}/${github.repository.repo}`;
    notices.push({
      tone: "warning",
      message: `Your GitHub account can't send changes to ${name}. Ask for write access, or fork it on GitHub and use your fork.`,
    });
  }
  const defaultTarget = inspection.project?.base_branch ?? inspection.default_branch ?? github?.default_branch ?? null;
  const targets = [...new Set([defaultTarget, ...inspection.branches].filter((name): name is string => !!name && !name.startsWith("cutready/")))];
  return { notices, targets: targets.length > 1 ? targets : [] };
}
