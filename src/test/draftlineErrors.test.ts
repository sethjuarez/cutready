import { describe, expect, it } from "vitest";
import {
  GIT_INDEX_LOCKED_MESSAGE,
  INVALID_FOLDER_MARKER_MESSAGE,
  LOCAL_STATE_CHANGED_MESSAGE,
  NEWER_FOLDER_MARKER_MESSAGE,
  SEND_BASE_UNKNOWN_MESSAGE,
  SEND_OUTSIDE_NAMESPACE_MESSAGE,
  VARIATION_OUTSIDE_NAMESPACE_MESSAGE,
  baseRenamedMessage,
  canActOnRecoveryNextAction,
  friendlyDraftlineErrorMessage,
  folderMissingMessage,
  gitFilterHazardPaths,
  incomingFolderElsewhereMessage,
  isDraftlineGuidanceMessage,
  isRetryableDraftlineError,
  mergeNeedsDeveloperMessage,
  recoveryNextActionMessage,
  sendHasLfsPointersMessage,
} from "../services/draftlineErrors";
import type { SafeNextAction } from "@draftline/client";
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
    ["invalid_folder_marker", INVALID_FOLDER_MARKER_MESSAGE],
    ["newer_folder_marker", NEWER_FOLDER_MARKER_MESSAGE],
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

  it("names renamed bases and LFS files Send can't upload", () => {
    const renamed = errorMessage({ code: "base_renamed", message: "x", details: { from: "master", to: "main" } });
    expect(renamed).toBe(baseRenamedMessage("master", "main"));
    expect(renamed).toContain("renamed master to main");
    expect(isDraftlineGuidanceMessage(renamed)).toBe(true);
    const lfs = errorMessage({
      code: "send_has_lfs_pointers",
      message: "x",
      details: { paths: ["cutready/a.png", "cutready/b.png", "cutready/c.png", "cutready/d.png"] },
    });
    expect(lfs).toBe(sendHasLfsPointersMessage(["cutready/a.png", "cutready/b.png", "cutready/c.png", "cutready/d.png"]));
    expect(lfs).toContain("and 1 more");
    expect(isDraftlineGuidanceMessage(lfs)).toBe(true);
  });

  it("names the missing folder and the folder incoming changes move to", () => {
    const missing = errorMessage({ code: "folder_missing", message: "x", details: { folder: "cutready" } });
    expect(missing).toBe(folderMissingMessage("cutready"));
    expect(missing).toContain("\"cutready\" folder");
    expect(isDraftlineGuidanceMessage(missing)).toBe(true);
    const incoming = errorMessage({ code: "incoming_folder_elsewhere", message: "x", details: { folder: "showcase" } });
    expect(incoming).toBe(incomingFolderElsewhereMessage("showcase"));
    expect(isDraftlineGuidanceMessage(incoming)).toBe(true);
    expect(folderMissingMessage(".")).toContain("root folder");
  });

  it("names the other folder for an interrupted operation", () => {
    const message = errorMessage({
      code: "recovery_in_other_folder",
      message: "another folder in this checkout has an incomplete Draftline operation: deck",
      details: { folder: "deck" },
    });
    expect(message).toBe(
      "An interrupted change has to be finished in the other folder that started it (deck). Open that folder in CutReady to finish it, then try again.",
    );
    expect(isDraftlineGuidanceMessage(message)).toBe(true);
  });

  it("names the folder that already holds the repository's CutReady project", () => {
    const sub = errorMessage({
      code: "folder_is_elsewhere",
      message: "this checkout's Draftline workspace is `docs/demo`; open that folder, or relocate the workspace",
      details: { folder: "docs/demo" },
    });
    expect(sub).toBe('This repository\'s CutReady project is the "docs/demo" folder. Open that folder instead.');
    expect(isDraftlineGuidanceMessage(sub)).toBe(true);

    const root = errorMessage(JSON.stringify({
      code: "folder_is_elsewhere",
      message: "this checkout's Draftline workspace is the repository root; open that folder, or relocate the workspace",
      details: { folder: "." },
    }));
    expect(root).toBe("This repository's CutReady project is the repository's root folder. Open that folder instead.");
  });

  it("names the missing review base when the remote lacks it", () => {
    const message = errorMessage({
      code: "send_base_not_on_remote",
      message: "the remote has no branch `main` to send to; publish it first or pass a base branch",
    });
    expect(message).toBe(
      "The shared repository doesn't have the main branch yet, so this can't be sent for review. Ask a developer to publish it, then send again.",
    );
    expect(isDraftlineGuidanceMessage(message)).toBe(true);
    expect(friendlyDraftlineErrorMessage({ code: "send_base_not_on_remote" })).toContain("the branch to merge into");
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

  it("offers no in-folder action for finish_in_other_folder", () => {
    const finish: SafeNextAction = "finish_in_other_folder";
    expect(canActOnRecoveryNextAction(finish)).toBe(false);
    expect(recoveryNextActionMessage(finish, "deck")).toContain("other folder that started it (deck)");
    expect(canActOnRecoveryNextAction("repair_recovery")).toBe(true);
    expect(recoveryNextActionMessage("repair_recovery")).toBeNull();
  });
});
