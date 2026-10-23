import type { SafeNextAction } from "@draftline/client";

/**
 * Draftline error codes (from `draftline_error_code` in Draftline's Tauri
 * contract, plus CutReady's own Send codes) that get a plain-language message.
 */
export const DraftlineErrorCode = {
  MergeNeedsDeveloper: "merge_needs_developer",
  RecoveryInOtherProject: "recovery_in_other_project",
  SendOutsideNamespace: "send_outside_namespace",
  SendBaseUnknown: "send_base_unknown",
  PullRequestFailed: "pull_request_failed",
  GitIndexLocked: "git_index_locked",
  VariationOutsideNamespace: "variation_outside_namespace",
  LocalStateChanged: "local_state_changed",
  PreflightFailed: "preflight_failed",
} as const;

/**
 * `@draftline/client` 0.2.0 predates `finish_in_other_project`; Draftline
 * returns it when an interrupted operation belongs to another project in the
 * same checkout.
 */
export type CutReadySafeNextAction = SafeNextAction | "finish_in_other_project";

export const FINISH_IN_OTHER_PROJECT: CutReadySafeNextAction = "finish_in_other_project";

export const GIT_INDEX_LOCKED_MESSAGE = "Git is busy in this project's repository — try again in a moment. Nothing was changed.";
export const LOCAL_STATE_CHANGED_MESSAGE =
  "The project changed outside CutReady while this was running (for example, a developer committed). Nothing was lost — try again.";
export const VARIATION_OUTSIDE_NAMESPACE_MESSAGE =
  "That branch belongs to the code repository, not to CutReady. CutReady only works on its own branches and the main branch.";
export const SEND_OUTSIDE_NAMESPACE_MESSAGE =
  "This branch isn't a CutReady branch, so it can't be sent for review. Switch to a CutReady branch or the main branch, then send again.";
export const SEND_BASE_UNKNOWN_MESSAGE =
  "CutReady couldn't tell which branch to send this to for review. Check for updates, then try again.";

/** Bringing in the base conflicts in files outside the CutReady folder. */
export function mergeNeedsDeveloperMessage(base: string): string {
  return `A developer needs to bring ${base} into this branch: files outside the CutReady folder conflict.`;
}

export function recoveryInOtherProjectMessage(project?: string | null): string {
  const where = project ? ` (${project})` : "";
  return `An interrupted change has to be finished in the other project that started it${where}. Open that project in CutReady to finish it, then try again.`;
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
    case DraftlineErrorCode.RecoveryInOtherProject: {
      const project = draftlineErrorDetails(error)?.project;
      return recoveryInOtherProjectMessage(typeof project === "string" ? project : null);
    }
    case DraftlineErrorCode.SendOutsideNamespace:
      return SEND_OUTSIDE_NAMESPACE_MESSAGE;
    case DraftlineErrorCode.SendBaseUnknown:
      return SEND_BASE_UNKNOWN_MESSAGE;
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
];
const GUIDANCE_PREFIXES = [
  "A developer needs to bring ",
  "An interrupted change has to be finished in the other project",
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
export function recoveryNextActionMessage(action: CutReadySafeNextAction, project?: string | null): string | null {
  return action === FINISH_IN_OTHER_PROJECT ? recoveryInOtherProjectMessage(project) : null;
}

/** Whether CutReady can offer a button for a recovery next action in this project. */
export function canActOnRecoveryNextAction(action: CutReadySafeNextAction): boolean {
  return action !== FINISH_IN_OTHER_PROJECT;
}
