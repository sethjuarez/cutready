export type DiffTone = "added" | "removed" | "changed" | "moved";

/** Row/block backgrounds; text stays readable because the diff tokens are tuned per theme. */
export const TONE_ROW: Record<DiffTone, string> = {
  added: "bg-diff-ins-bg/70",
  removed: "bg-diff-del-bg/70",
  changed: "bg-warning/10",
  moved: "",
};

const TONE_BADGE: Record<DiffTone, string> = {
  added: "bg-diff-ins-bg text-diff-ins-fg",
  removed: "bg-diff-del-bg text-diff-del-fg",
  changed: "bg-warning/15 text-text",
  moved: "bg-accent/10 text-text",
};

const TONE_LABEL: Record<DiffTone, string> = { added: "Added", removed: "Removed", changed: "Changed", moved: "Moved" };

/** A worded status chip, so changes never rely on color alone. */
export function DiffBadge({ tone, label }: { tone: DiffTone; label?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-px text-2xs font-medium ${TONE_BADGE[tone]}`}>
      {label ?? TONE_LABEL[tone]}
    </span>
  );
}

export const INSERTED_TEXT = "rounded-sm bg-diff-ins-bg text-diff-ins-fg";
export const DELETED_TEXT = "rounded-sm bg-diff-del-bg text-diff-del-fg line-through";
