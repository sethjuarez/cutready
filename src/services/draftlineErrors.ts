import type { SafeNextAction } from "@draftline/client";

/**
 * Draftline error codes (from `draftline_error_code` in Draftline's Tauri
 * contract, plus CutReady's own Send codes) that get a plain-language message.
 */
export const DraftlineErrorCode = {
  MergeNeedsDeveloper: "merge_needs_developer",
  RecoveryInOtherFolder: "recovery_in_other_folder",
  SendOutsideNamespace: "send_outside_namespace",
  SendBaseUnknown: "send_base_unknown",
  PullRequestFailed: "pull_request_failed",
  GitIndexLocked: "git_index_locked",
  VariationOutsideNamespace: "variation_outside_namespace",
  LocalStateChanged: "local_state_changed",
  PreflightFailed: "preflight_failed",
  SendBaseNotOnRemote: "send_base_not_on_remote",
  FolderIsElsewhere: "folder_is_elsewhere",
  FolderMissing: "folder_missing",
  IncomingFolderElsewhere: "incoming_folder_elsewhere",
  InvalidFolderMarker: "invalid_folder_marker",
  NewerFolderMarker: "newer_folder_marker",
  BaseRenamed: "base_renamed",
  SendHasLfsPointers: "send_has_lfs_pointers",
  ProjectFolderRenamed: "project_folder_renamed",
} as const;

/** Draftline's next action when an interrupted operation belongs to another folder in the same checkout. */
export const FINISH_IN_OTHER_FOLDER: SafeNextAction = "finish_in_other_folder";

export const GIT_INDEX_LOCKED_MESSAGE = "Git is busy in this project's repository — try again in a moment. Nothing was changed.";
export const LOCAL_STATE_CHANGED_MESSAGE =
  "The project changed outside CutReady while this was running (for example, a developer committed). Nothing was lost — try again.";
export const VARIATION_OUTSIDE_NAMESPACE_MESSAGE =
  "That branch belongs to the code repository, not to CutReady. CutReady only works on its own branches and the main branch.";
export const SEND_OUTSIDE_NAMESPACE_MESSAGE =
  "This branch isn't a CutReady branch, so it can't be sent for review. Switch to a CutReady branch or the main branch, then send again.";
export const SEND_BASE_UNKNOWN_MESSAGE =
  "CutReady couldn't tell which branch to send this to for review. Check for updates, then try again.";
export const INVALID_FOLDER_MARKER_MESSAGE =
  "CutReady couldn't read which folder in this repository holds its project. Ask a developer to check the .draftline file at the repository root.";
export const NEWER_FOLDER_MARKER_MESSAGE =
  "This project was set up by a newer version of CutReady. Update CutReady to open it.";

/** The shared repository renamed its main branch; publishing the old name would recreate it. */
export function baseRenamedMessage(from?: string | null, to?: string | null): string {
  if (from && to) {
    return `The shared repository renamed ${from} to ${to}. Rename this branch to ${to}, then publish again.`;
  }
  return "The shared repository renamed its main branch. Rename this branch to match, then publish again.";
}

/** Send would push Git LFS pointers whose content the remote doesn't have. */
export function sendHasLfsPointersMessage(paths: string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return `These changes include Git LFS files CutReady can't upload: ${shown}${more}. Ask a developer to push them with git lfs push, then send again.`;
}

/** The remote doesn't have the branch a review would merge into. */
export function sendBaseNotOnRemoteMessage(base?: string | null): string {
  const branch = base ? `the ${base} branch` : "the branch to merge into";
  return `The shared repository doesn't have ${branch} yet, so this can't be sent for review. Ask a developer to publish it, then send again.`;
}

/**
 * Another folder in this repository already holds its CutReady project.
 * `folder` is that folder relative to the repository; empty or "." means the root.
 */
export function folderIsElsewhereMessage(folder?: string | null): string {
  const where = folder && folder !== "." ? `the "${folder}" folder` : "the repository's root folder";
  return `This repository's CutReady project is ${where}. Open that folder instead.`;
}

function folderName(folder?: string | null): string {
  return folder && folder !== "." ? `the "${folder}" folder` : "the repository's root folder";
}

/** The folder `.draftline` names no longer exists (a developer moved or renamed it). */
export function folderMissingMessage(folder?: string | null): string {
  return `This repository's CutReady project should be in ${folderName(folder)}, but that folder is missing. A developer may have moved or renamed it — ask them to restore it or update the .draftline file at the repository root.`;
}

/** A commit renamed the project folder; CutReady opens the new one with its history. */
export function projectFolderRenamedMessage(to?: string | null): string {
  return `This CutReady project moved to ${folderName(to)}. Open that folder instead.`;
}

/** Incoming changes moved the project to another folder. */
export function incomingFolderElsewhereMessage(folder?: string | null): string {
  return `The incoming changes move this CutReady project to ${folderName(folder)}. Ask a developer to bring them in, then open that folder.`;
}

/** Bringing in the base conflicts in files outside the CutReady folder. */
export function mergeNeedsDeveloperMessage(base: string): string {
  return `A developer needs to bring ${base} into this branch: files outside the CutReady folder conflict.`;
}

export function recoveryInOtherFolderMessage(folder?: string | null): string {
  const where = folder ? ` (${folder})` : "";
  return `An interrupted change has to be finished in the other folder that started it${where}. Open that folder in CutReady to finish it, then try again.`;
}

export function gitFilterFilesMessage(paths: string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  const subject = paths.length === 1 ? "This file uses" : "These files use";
  return `${subject} Git LFS or another Git filter, so CutReady can't save, overwrite, or discard ${paths.length === 1 ? "it" : "them"}: ${shown}${more}. Ask a developer to handle ${paths.length === 1 ? "it" : "them"} with Git.`;
}

function asRecord(error: unknown): Record<string, unknown> | null {
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return error && typeof error === "object" ? error as Record<string, unknown> : null;
}

/** The Draftline error code on a Tauri command error (object or JSON string). */
export function draftlineErrorCode(error: unknown): string | null {
  const code = asRecord(error)?.code;
  return typeof code === "string" ? code : null;
}

function draftlineErrorDetails(error: unknown): Record<string, unknown> | null {
  const details = asRecord(error)?.details;
  return details && typeof details === "object" ? details as Record<string, unknown> : null;
}

/** The old and new base names from a `base_renamed` publish refusal. */
export function baseRenamedBranches(error: unknown): { from: string; to: string } | null {
  if (draftlineErrorCode(error) !== DraftlineErrorCode.BaseRenamed) return null;
  const details = draftlineErrorDetails(error);
  const from = details?.from;
  const to = details?.to;
  return typeof from === "string" && typeof to === "string" ? { from, to } : null;
}

/** Paths a failed preflight refused because they need a Git filter (e.g. Git LFS). */
export function gitFilterHazardPaths(error: unknown): string[] {
  if (draftlineErrorCode(error) !== DraftlineErrorCode.PreflightFailed) return [];
  const hazards = draftlineErrorDetails(error)?.file_hazards;
  if (!Array.isArray(hazards)) return [];
  return hazards.flatMap((hazard) => {
    if (!hazard || typeof hazard !== "object") return [];
    const { kind, path } = hazard as { kind?: unknown; path?: unknown };
    const isGitFilter = kind === "git_filter" || kind === "GitFilter";
    return isGitFilter && typeof path === "string" ? [path] : [];
  });
}

/** Draftline reports the missing base only in its message: "the remote has no branch `main` ...". */
function sendBaseFromMessage(error: unknown): string | null {
  const message = asRecord(error)?.message;
  if (typeof message !== "string") return null;
  return /no branch `([^`]+)`/.exec(message)?.[1] ?? null;
}

/** Errors where Draftline refused before changing anything, so retrying is safe. */
export function isRetryableDraftlineError(error: unknown): boolean {
  const code = draftlineErrorCode(error);
  return code === DraftlineErrorCode.GitIndexLocked || code === DraftlineErrorCode.LocalStateChanged;
}

/**
 * A plain-language message for a Draftline error the user can act on, or null
 * when the error has no friendly mapping (callers fall back to its message).
 */
export function friendlyDraftlineErrorMessage(error: unknown): string | null {
  switch (draftlineErrorCode(error)) {
    case DraftlineErrorCode.MergeNeedsDeveloper:
      return mergeNeedsDeveloperMessage("the base branch");
    case DraftlineErrorCode.RecoveryInOtherFolder: {
      const folder = draftlineErrorDetails(error)?.folder;
      return recoveryInOtherFolderMessage(typeof folder === "string" ? folder : null);
    }
    case DraftlineErrorCode.SendOutsideNamespace:
      return SEND_OUTSIDE_NAMESPACE_MESSAGE;
    case DraftlineErrorCode.SendBaseUnknown:
      return SEND_BASE_UNKNOWN_MESSAGE;
    case DraftlineErrorCode.SendBaseNotOnRemote:
      return sendBaseNotOnRemoteMessage(sendBaseFromMessage(error));
    case DraftlineErrorCode.FolderIsElsewhere: {
      const folder = draftlineErrorDetails(error)?.folder;
      return folderIsElsewhereMessage(typeof folder === "string" ? folder : null);
    }
    case DraftlineErrorCode.InvalidFolderMarker:
      return INVALID_FOLDER_MARKER_MESSAGE;
    case DraftlineErrorCode.NewerFolderMarker:
      return NEWER_FOLDER_MARKER_MESSAGE;
    case DraftlineErrorCode.BaseRenamed: {
      const details = draftlineErrorDetails(error);
      return baseRenamedMessage(
        typeof details?.from === "string" ? details.from : null,
        typeof details?.to === "string" ? details.to : null,
      );
    }
    case DraftlineErrorCode.SendHasLfsPointers: {
      const paths = draftlineErrorDetails(error)?.paths;
      const list = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
      return sendHasLfsPointersMessage(list);
    }
    case DraftlineErrorCode.FolderMissing: {
      const folder = draftlineErrorDetails(error)?.folder;
      return folderMissingMessage(typeof folder === "string" ? folder : null);
    }
    case DraftlineErrorCode.ProjectFolderRenamed: {
      const to = draftlineErrorDetails(error)?.to;
      return projectFolderRenamedMessage(typeof to === "string" ? to : null);
    }
    case DraftlineErrorCode.IncomingFolderElsewhere: {
      const folder = draftlineErrorDetails(error)?.folder;
      return incomingFolderElsewhereMessage(typeof folder === "string" ? folder : null);
    }
    // pull_request_failed is raised by CutReady's own GitHub provider with an
    // actionable message (and 401s that must reach the sign-in path), so keep it.
    case DraftlineErrorCode.GitIndexLocked:
      return GIT_INDEX_LOCKED_MESSAGE;
    case DraftlineErrorCode.VariationOutsideNamespace:
      return VARIATION_OUTSIDE_NAMESPACE_MESSAGE;
    case DraftlineErrorCode.LocalStateChanged:
      return LOCAL_STATE_CHANGED_MESSAGE;
    case DraftlineErrorCode.PreflightFailed: {
      const paths = gitFilterHazardPaths(error);
      return paths.length > 0 ? gitFilterFilesMessage(paths) : null;
    }
    default:
      return null;
  }
}

const GUIDANCE_MESSAGES = [
  GIT_INDEX_LOCKED_MESSAGE,
  LOCAL_STATE_CHANGED_MESSAGE,
  VARIATION_OUTSIDE_NAMESPACE_MESSAGE,
  SEND_OUTSIDE_NAMESPACE_MESSAGE,
  SEND_BASE_UNKNOWN_MESSAGE,
  INVALID_FOLDER_MARKER_MESSAGE,
  NEWER_FOLDER_MARKER_MESSAGE,
];
const GUIDANCE_PREFIXES = [
  "The shared repository renamed ",
  "These changes include Git LFS files ",
  "A developer needs to bring ",
  "The shared repository doesn't have ",
  "This repository's CutReady project is ",
  "This repository's CutReady project should be in ",
  "The incoming changes move this CutReady project to ",
  "This CutReady project moved to ",
  "An interrupted change has to be finished in the other folder",
  "This file uses Git LFS",
  "These files use Git LFS",
];

/**
 * Whether a displayed error is one of the plain-language Draftline messages
 * above, so the sync bar shows it as-is instead of guessing from keywords
 * (a project path may contain "github", for example).
 */
export function isDraftlineGuidanceMessage(message: string): boolean {
  return GUIDANCE_MESSAGES.includes(message) || GUIDANCE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/** What to tell the user about a pending-recovery next action. */
export function recoveryNextActionMessage(action: SafeNextAction, folder?: string | null): string | null {
  return action === FINISH_IN_OTHER_FOLDER ? recoveryInOtherFolderMessage(folder) : null;
}

/** Whether CutReady can offer a button for a recovery next action in this project. */
export function canActOnRecoveryNextAction(action: SafeNextAction): boolean {
  return action !== FINISH_IN_OTHER_FOLDER;
}
