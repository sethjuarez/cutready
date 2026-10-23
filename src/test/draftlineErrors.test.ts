import { describe, expect, it } from "vitest";
import {
  GIT_INDEX_LOCKED_MESSAGE,
  LOCAL_STATE_CHANGED_MESSAGE,
  SEND_BASE_UNKNOWN_MESSAGE,
  SEND_OUTSIDE_NAMESPACE_MESSAGE,
  VARIATION_OUTSIDE_NAMESPACE_MESSAGE,
  canActOnRecoveryNextAction,
  friendlyDraftlineErrorMessage,
  gitFilterHazardPaths,
  isDraftlineGuidanceMessage,
  isRetryableDraftlineError,
  mergeNeedsDeveloperMessage,
  recoveryNextActionMessage,
  type CutReadySafeNextAction,
} from "../services/draftlineErrors";
import { errorMessage, remoteSyncErrorMessage } from "../stores/appStore";

function preflightFailed(hazards: Array<{ path: string; kind: string }>) {
  return {
    code: "preflight_failed",
    message: "operation preflight failed",
    details: {
      operation: "save",
      will_write_files: true,
      dirty_files: [],
      file_hazards: hazards,
      untracked_assets: [],
      unresolved_conflicts: [],
      large_files: [],
      binary_files: [],
      variation_divergence: null,
      can_proceed: false,
    },
  };
}

describe("Draftline error messages", () => {
  it.each([
    ["git_index_locked", GIT_INDEX_LOCKED_MESSAGE],
    ["local_state_changed", LOCAL_STATE_CHANGED_MESSAGE],
    ["variation_outside_namespace", VARIATION_OUTSIDE_NAMESPACE_MESSAGE],
    ["send_outside_namespace", SEND_OUTSIDE_NAMESPACE_MESSAGE],
    ["send_base_unknown", SEND_BASE_UNKNOWN_MESSAGE],
    ["merge_needs_developer", mergeNeedsDeveloperMessage("the base branch")],
  ])("maps %s to a plain-language message", (code, expected) => {
    const error = { code, message: "technical detail" };
    expect(friendlyDraftlineErrorMessage(error)).toBe(expected);
    expect(errorMessage(error)).toBe(expected);
    expect(remoteSyncErrorMessage(error)).toBe(expected);
    expect(isDraftlineGuidanceMessage(expected)).toBe(true);
  });

  it("reads codes from JSON-serialized command errors", () => {
    expect(errorMessage("{\"code\":\"git_index_locked\",\"message\":\"Git is busy\"}")).toBe(GIT_INDEX_LOCKED_MESSAGE);
  });

  it("keeps the GitHub provider's own pull request failure message", () => {
    const missingRemote = {
      code: "pull_request_failed",
      message: "Send for review only supports GitHub remotes.",
    };
    expect(friendlyDraftlineErrorMessage(missingRemote)).toBeNull();
    expect(errorMessage(missingRemote)).toBe("Send for review only supports GitHub remotes.");
    expect(
      remoteSyncErrorMessage({
        code: "pull_request_failed",
        message: "GitHub create pull request failed (401 Unauthorized): Bad credentials",
      }),
    ).toBe("GitHub rejected the remote operation. Reconnect GitHub in Settings, then try again.");
  });

  it("names the other project for an interrupted operation", () => {
    const message = errorMessage({
      code: "recovery_in_other_project",
      message: "another project in this checkout has an incomplete Draftline operation: deck",
      details: { project: "deck" },
    });
    expect(message).toBe(
      "An interrupted change has to be finished in the other project that started it (deck). Open that project in CutReady to finish it, then try again.",
    );
    expect(isDraftlineGuidanceMessage(message)).toBe(true);
  });

  it("lists files that need Git LFS or another filter", () => {
    const error = preflightFailed([
      { path: "media/intro.mp4", kind: "git_filter" },
      { path: "notes.md", kind: "untracked" },
    ]);
    expect(gitFilterHazardPaths(error)).toEqual(["media/intro.mp4"]);
    expect(errorMessage(error)).toBe(
      "This file uses Git LFS or another Git filter, so CutReady can't save, overwrite, or discard it: media/intro.mp4. Ask a developer to handle it with Git.",
    );
  });

  it("summarizes many filtered files", () => {
    const error = preflightFailed(["a.png", "b.png", "c.png", "d.png"].map((path) => ({ path, kind: "git_filter" })));
    expect(errorMessage(error)).toBe(
      "These files use Git LFS or another Git filter, so CutReady can't save, overwrite, or discard them: a.png, b.png, c.png and 1 more. Ask a developer to handle them with Git.",
    );
  });

  it("leaves other preflight failures and unknown codes to their messages", () => {
    expect(friendlyDraftlineErrorMessage(preflightFailed([{ path: "x.md", kind: "untracked" }]))).toBeNull();
    expect(errorMessage({ code: "git", message: "git operation failed: boom" })).toBe("git operation failed: boom");
    expect(errorMessage(new Error("plain"))).toBe("plain");
  });

  it("treats refusals that changed nothing as retryable", () => {
    expect(isRetryableDraftlineError({ code: "git_index_locked" })).toBe(true);
    expect(isRetryableDraftlineError({ code: "local_state_changed" })).toBe(true);
    expect(isRetryableDraftlineError({ code: "merge_needs_developer" })).toBe(false);
  });

  it("offers no in-project action for finish_in_other_project", () => {
    const finish: CutReadySafeNextAction = "finish_in_other_project";
    expect(canActOnRecoveryNextAction(finish)).toBe(false);
    expect(recoveryNextActionMessage(finish, "deck")).toContain("other project that started it (deck)");
    expect(canActOnRecoveryNextAction("repair_recovery")).toBe(true);
    expect(recoveryNextActionMessage("repair_recovery")).toBeNull();
  });
});
