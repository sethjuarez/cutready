import { RotateCcw } from "lucide-react";

/** Per-document restore in a version preview. `removes`: the document didn't exist in that version. */
export function RestoreDocumentButton({ removes, onClick }: { removes: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 text-xs font-medium text-[rgb(var(--color-text))] transition-colors hover:border-[rgb(var(--color-accent))] hover:text-[rgb(var(--color-accent))]"
      title={removes
        ? "This document didn't exist in this version. Restoring removes it, saved as a new version"
        : "Bring this document back as it was in this version, saved as a new version"}
      data-testid="restore-document"
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
      {removes ? "Remove (restore this version)" : "Restore this document"}
    </button>
  );
}
