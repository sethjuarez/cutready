import { AlertTriangle, Download, Lock } from "lucide-react";
import { useVersioningStore } from "../stores/versioningStore";
import { recoveryInOtherFolderMessage } from "../services/draftlineErrors";
import { BannerButton, BannerRow } from "./BannerParts";
import { SetAsideBanner } from "./versioning/SetAsideBanner";

const OPERATION_LABELS: Record<string, string> = {
  save_version: "save",
  switch_variation: "branch switch",
  restore_version_as_new_save: "restore",
  discard_changes: "discard",
  apply_incoming: "update",
  publish_changes: "publish",
  send: "send",
  merge_incoming: "merge",
  shelve_changes: "shelve",
  discard_file: "file discard",
  delete_variation: "branch delete",
  apply_shelf: "shelf restore",
  delete_remote_variation: "shared branch delete",
  expire_support_refs: "cleanup",
  rename_variation: "branch rename",
  move_folder: "folder move",
  milestone_merge: "milestone merge",
  squash_versions: "squash",
  history_cleanup: "history cleanup",
};

function operationLabel(operation: string): string {
  // Draftline reports recovery operations in PascalCase (DiscardChanges) and locks in snake_case.
  const key = operation.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return OPERATION_LABELS[key] ?? key.replace(/_/g, " ");
}

/**
 * Shows what an interrupted or crashed operation left behind (pending
 * recovery, a stale lock) and large files whose content isn't downloaded,
 * with the action that fixes each.
 */
export function ProjectHealthBanner() {
  const health = useVersioningStore((s) => s.projectHealth);
  const busy = useVersioningStore((s) => s.projectHealthBusy);
  const resolveRecovery = useVersioningStore((s) => s.resolveRecovery);
  const dismissRecovery = useVersioningStore((s) => s.dismissRecovery);
  const clearStaleLock = useVersioningStore((s) => s.clearStaleLock);
  const retryContentDownload = useVersioningStore((s) => s.retryContentDownload);
  const warningIcon = <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-warning))]" />;

  return (
    <>
      {health.recovery && (
        <BannerRow testId="project-health-recovery" icon={warningIcon}>
          {health.recoveryInOtherFolder ? (
            <span className="flex-1">{recoveryInOtherFolderMessage(null)}</span>
          ) : (
            <>
              <span className="flex-1">
                A {operationLabel(health.recovery.operation)} was interrupted before it finished. Finish it before making more changes.
              </span>
              <BannerButton onClick={() => void resolveRecovery()} disabled={busy}>Finish</BannerButton>
              <BannerButton onClick={() => void dismissRecovery()} disabled={busy}>Dismiss</BannerButton>
            </>
          )}
        </BannerRow>
      )}
      {!health.recovery && health.staleLock && (
        <BannerRow testId="project-health-stale-lock" icon={<Lock className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-warning))]" />}>
          <span className="flex-1">
            CutReady closed during a {operationLabel(health.staleLock.operation)} and left the project locked.
          </span>
          <BannerButton onClick={() => void clearStaleLock()} disabled={busy}>Clear lock</BannerButton>
        </BannerRow>
      )}
      {health.missingContent.length > 0 && (
        <BannerRow testId="project-health-missing-content" icon={<Download className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-warning))]" />}>
          <span className="flex-1" title={health.missingContent.join("\n")}>
            {health.missingContent.length === 1
              ? "1 large file hasn't been downloaded yet."
              : `${health.missingContent.length} large files haven't been downloaded yet.`}
          </span>
          <BannerButton onClick={() => void retryContentDownload()} disabled={busy}>Download</BannerButton>
        </BannerRow>
      )}
      <SetAsideBanner disabled={busy || !!health.recovery} />
    </>
  );
}
