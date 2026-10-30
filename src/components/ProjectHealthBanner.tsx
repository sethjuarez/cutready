import { AlertTriangle, Archive, Download, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useAppStore } from "../stores/appStore";
import { recoveryInOtherFolderMessage } from "../services/draftlineErrors";

const OPERATION_LABELS: Record<string, string> = {
  save_version: "save",
  switch_variation: "branch switch",
  restore_version_as_new_save: "restore",
  discard_changes: "discard",
  apply_incoming: "update",
  publish_changes: "publish",
  send: "send",
  merge_incoming: "merge",
};

function operationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? operation.replace(/_/g, " ");
}

function BannerButton({ onClick, disabled, label, children }: { onClick: () => void; disabled: boolean; label?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="shrink-0 rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-0.5 text-xs font-medium text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-inset))] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function BannerRow({ icon, testId, children }: { icon: ReactNode; testId: string; children: ReactNode }) {
  return (
    <div
      data-testid={testId}
      role="status"
      className="flex items-center gap-2 border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-3 py-1.5 text-xs text-[rgb(var(--color-text-secondary))]"
    >
      {icon}
      {children}
    </div>
  );
}

/**
 * Shows what an interrupted or crashed operation left behind (pending
 * recovery, a stale lock) and large files whose content isn't downloaded,
 * with the action that fixes each.
 */
export function ProjectHealthBanner() {
  const health = useAppStore((s) => s.projectHealth);
  const busy = useAppStore((s) => s.projectHealthBusy);
  const resolveRecovery = useAppStore((s) => s.resolveRecovery);
  const dismissRecovery = useAppStore((s) => s.dismissRecovery);
  const clearStaleLock = useAppStore((s) => s.clearStaleLock);
  const retryContentDownload = useAppStore((s) => s.retryContentDownload);
  const hasStash = useAppStore((s) => s.hasStash);
  const popStash = useAppStore((s) => s.popStash);
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
      {hasStash && (
        <BannerRow testId="project-health-shelf" icon={<Archive className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-accent))]" />}>
          <span className="flex-1">You have shelved changes.</span>
          <BannerButton onClick={() => void popStash()} disabled={busy || !!health.recovery} label="Restore shelved changes">Restore</BannerButton>
        </BannerRow>
      )}
    </>
  );
}
