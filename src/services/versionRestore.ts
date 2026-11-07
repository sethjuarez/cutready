import { clampVersionName, versionMessage } from "../domain/versioning";
import { useSyncStore } from "../stores/syncStore";
import { useVersioningStore } from "../stores/versioningStore";
import { errorMessage, rewriteWorkspaceFiles } from "../stores/workspaceHelpers";
import { draftlineErrorCode, DraftlineErrorCode } from "./draftlineErrors";
import { draftlineClient, requireWorkspacePath } from "./draftlineVersioning";
import { useToastStore } from "../stores/toastStore";
import { requestPreAction } from "./preAction";
import { isSaveBlocked } from "./versionOperation";

/** The whole project, or just these Draftline paths (as listed in the version preview). */
export type RestoreScope = { kind: "project" } | { kind: "documents"; paths: string[] };

export interface RestoreRequest {
  versionId: string;
  /** The source version's name, used in the dialog target text. */
  versionName: string;
  scope: RestoreScope;
  /** Approved name of the new version. */
  name: string;
  comment?: string;
}

const RESTORE_MESSAGES: Record<string, string> = {
  no_paths_selected: "Pick at least one document to restore.",
  nothing_to_restore: "Nothing to restore. These documents already match that version.",
  path_kind_changed: "A file became a folder (or the other way round) since that version, so it can't be restored here.",
  [DraftlineErrorCode.PreflightFailed]: "Save or set aside your changes, then restore again.",
};

/** Friendly copy for a restore failure. */
export function restoreErrorMessage(err: unknown): string {
  const code = draftlineErrorCode(err);
  return (code && RESTORE_MESSAGES[code]) || errorMessage(err);
}

/** First line of a saved message: the version's name. */
function nameOf(versionName: string): string {
  return versionName.split(/\r?\n/, 1)[0].trim();
}

/** Prefilled name for the new version, e.g. "Restore Intro rewrite". Always ≤72. */
export function defaultRestoreName(versionName: string): string {
  const name = nameOf(versionName);
  return clampVersionName(name ? `Restore ${name}` : "Restore version");
}

/** Prefilled comment linking back to the source version. */
export function defaultRestoreComment(versionName: string, versionId: string): string {
  const name = nameOf(versionName);
  const short = versionId.slice(0, 7);
  return name ? `Restored from “${name}” (${short})` : `Restored from ${short}`;
}

/** Restores as a new version. Throws a friendly error; refreshes versioning state on success. */
export async function restoreVersion(request: RestoreRequest): Promise<void> {
  const label = versionMessage(request.name, request.comment);
  await rewriteWorkspaceFiles(async () => {
    try {
      const workspace_path = requireWorkspacePath();
      if (request.scope.kind === "project") {
        await draftlineClient.restoreVersionAsNewSave({ workspace_path, version_id: request.versionId, label });
      } else {
        await draftlineClient.restoreVersionPathsAsNewSave({ workspace_path, version_id: request.versionId, label, paths: request.scope.paths });
      }
    } catch (err) {
      throw new Error(restoreErrorMessage(err));
    }
  }, "Couldn't restore", { rethrow: true });
  await refreshAfterRestore();
  useToastStore.getState().show(`Restored as “${request.name.trim()}”.`, 4000, "success");
}

async function refreshAfterRestore(): Promise<void> {
  const versioning = useVersioningStore.getState();
  try {
    await versioning.loadVersions();
    await versioning.loadTimelines();
    await versioning.loadGraphData();
    await versioning.checkDirty();
    await versioning.checkRewound();
    await useSyncStore.getState().refreshSyncStatus();
  } catch (err) {
    console.error("Failed to refresh after restoring:", err);
  }
}

/**
 * Restore through the operation boundary, asking first when work is unsaved.
 * Failures after the dialog show there (with Try again); direct ones toast.
 */
export function startRestore(request: RestoreRequest): void {
  void requestPreAction({
    operation: "Restore",
    target: `restoring “${nameOf(request.versionName) || request.versionId.slice(0, 7)}”`,
    run: () => restoreVersion(request),
  }).catch((err) => {
    if (isSaveBlocked(err)) return;
    useToastStore.getState().show(`Couldn't restore: ${errorMessage(err)}`, 5000, "error");
  });
}
