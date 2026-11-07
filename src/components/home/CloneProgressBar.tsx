// Shows how far a repository download has got.
import type { CloneProgressEvent } from "@draftline/client";

const STAGE_LABEL: Record<CloneProgressEvent["stage"], string> = {
  receiving: "Downloading",
  resolving: "Unpacking",
  checking_out: "Writing files",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Percent done in the current stage, or null before the stage knows its size. */
export function stagePercent(progress: CloneProgressEvent): number | null {
  if (!progress.total) return null;
  return Math.min(100, Math.round((progress.completed / progress.total) * 100));
}

export function CloneProgressBar({ progress }: { progress: CloneProgressEvent | null }) {
  const percent = progress ? stagePercent(progress) : null;
  const label = progress ? STAGE_LABEL[progress.stage] : "Connecting";
  const bytes = progress && progress.received_bytes > 0 ? ` · ${formatBytes(progress.received_bytes)}` : "";
  return (
    <div className="mt-3" data-testid="clone-progress">
      <div className="mb-1 flex justify-between text-xs text-[rgb(var(--color-text-secondary))]">
        <span>{label}…{bytes}</span>
        {percent !== null && <span>{percent}%</span>}
      </div>
      <div
        role="progressbar"
        aria-label={`${label} the repository`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-1.5 overflow-hidden rounded-full bg-[rgb(var(--color-surface-alt))]"
      >
        <div
          className={`h-full rounded-full bg-[rgb(var(--color-accent))] ${percent === null ? "w-1/3 animate-pulse" : "transition-[width]"}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
