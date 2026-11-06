import { useRef } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { chipState, type ChipStateKind } from "../../domain/versioning";
import { useChangeSummaryStore } from "../../stores/changeSummaryStore";
import { useSavesToSend } from "../../hooks/useSavesToSend";
import { useVersioningStore } from "../../stores/versioningStore";
import { ChangesPopover } from "./ChangesPopover";

const chipClass =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-control px-2 text-xs transition-colors duration-fast ease-fluent hover:bg-fill-hover hover:text-[rgb(var(--color-text))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

const DOT: Record<Exclude<ChipStateKind, "failed" | "saving">, { status: string; className: string }> = {
  changes: { status: "warn", className: "bg-warning shadow-[0_0_0_3px_rgb(var(--color-warning)/0.2)]" },
  "to-send": { status: "info", className: "bg-[rgb(var(--color-accent))]" },
  saved: { status: "ok", className: "bg-success" },
};

/** Saved · N changes · N to send · Saving… · Couldn't save – Retry. Opens the changes popover. */
export function StatusChip() {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const changedCount = useVersioningStore((s) => s.changedFiles.length);
  const storeSaving = useVersioningStore((s) => s.saving);
  const operationBusy = useChangeSummaryStore((s) => s.busyCount > 0);
  const saving = storeSaving || operationBusy;
  const toSendCount = useSavesToSend();
  const saveFailure = useChangeSummaryStore((s) => s.saveFailure);
  const popoverOpen = useChangeSummaryStore((s) => s.popoverOpen);
  const setPopoverOpen = useChangeSummaryStore((s) => s.setPopoverOpen);

  const state = chipState({ saving, saveFailed: !!saveFailure, changedCount, toSendCount });
  const failed = state.kind === "failed";
  const title = failed
    ? `${saveFailure?.operation ?? "Save"} stopped because your latest edits couldn't be saved. Retry`
    : `${state.label}. Show changes and versions`;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`${chipClass} ${failed ? "text-error" : "text-[rgb(var(--color-text-secondary))]"}`}
        onClick={() => {
          if (failed && saveFailure) {
            void saveFailure.retry().catch(() => undefined);
            return;
          }
          setPopoverOpen(!popoverOpen);
        }}
        title={title}
        aria-label={title}
        aria-haspopup={failed ? undefined : "dialog"}
        aria-expanded={failed ? undefined : popoverOpen}
        data-testid="titlebar-sync-status"
        data-state={state.kind}
      >
        {state.kind === "failed" ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : state.kind === "saving" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <span
            aria-hidden="true"
            data-status={DOT[state.kind].status}
            className={`h-2 w-2 shrink-0 rounded-full ${DOT[state.kind].className}`}
          />
        )}
        <span className="truncate max-[900px]:sr-only">{state.label}</span>
      </button>
      <ChangesPopover anchorRef={anchorRef} />
    </>
  );
}
