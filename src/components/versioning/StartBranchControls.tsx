import { useEffect, useRef, useState } from "react";
import { ChevronDown, GitBranch, RotateCcw } from "lucide-react";
import type { DraftlineVariationCreatePreflight } from "../../services/draftlineVersioning";

/** "Start timeline from here": names a new timeline from a previewed version and switches to it. */
export function StartBranchControls({
  activeTimelineLabel,
  menuOpen,
  newTimelineName,
  onMenuOpenChange,
  onNewTimelineNameChange,
  onAdoptConflict,
  onCancelConflict,
  onRestore,
  onUseConflictSuggestion,
  restoreConflict,
  restoreDisabled,
  restoring,
  snapshotLabel,
}: {
  activeTimelineLabel: string;
  menuOpen: boolean;
  newTimelineName: string;
  onMenuOpenChange: (open: boolean) => void;
  onNewTimelineNameChange: (value: string) => void;
  onAdoptConflict: () => void;
  onCancelConflict: () => void;
  onRestore: () => void;
  onUseConflictSuggestion: (name: string) => void;
  restoreConflict: DraftlineVariationCreatePreflight | null;
  restoreDisabled: boolean;
  restoring: boolean;
  snapshotLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const targetLabel = newTimelineName.trim() || "new timeline";

  useEffect(() => {
    if (!menuOpen) {
      setConfirming(false);
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onMenuOpenChange(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onMenuOpenChange(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, onMenuOpenChange]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => onMenuOpenChange(!menuOpen)}
        disabled={restoring}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:cursor-not-allowed disabled:opacity-45"
        title="Start a new timeline from this preview and switch to it"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {restoring ? "Starting..." : "Start timeline from here"}
        <ChevronDown className={`h-3 w-3 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
      </button>

      {menuOpen && (
        <div
          role="dialog"
          aria-label="Restore snapshot"
          className="absolute right-0 top-full z-dropdown mt-1 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-2 shadow-xl"
        >
          <div className="mb-2 rounded-lg bg-[rgb(var(--color-surface-alt))] px-3 py-2 text-xs text-[rgb(var(--color-text-secondary))]">
            <GitBranch className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
            You are previewing <span className="font-medium text-[rgb(var(--color-text))]">{snapshotLabel}</span>. To write from it,
            CutReady starts the timeline <span className="font-medium text-[rgb(var(--color-text))]">{targetLabel}</span> and switches there. Your edits stay unsaved until you save a version.
          </div>
          <label>
            <span className="mb-1 block text-2xs font-medium uppercase tracking-wider text-[rgb(var(--color-text-secondary))]">
              New timeline name
            </span>
            <input
              value={newTimelineName}
              onChange={(event) => {
                setConfirming(false);
                onNewTimelineNameChange(event.target.value);
              }}
              placeholder="timeline-name"
              className="h-8 w-full rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] px-2 text-xs text-[rgb(var(--color-text))] outline-none placeholder:text-[rgb(var(--color-text-secondary))]/50 focus:border-[rgb(var(--color-accent))]"
            />
          </label>
          <div className="mt-2 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))]/60 px-3 py-2 text-2xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
            Current timeline <span className="font-medium text-[rgb(var(--color-text))]">{activeTimelineLabel}</span> stays untouched. Save asks for a version name later.
          </div>
          {restoreConflict && (
            <SnapshotBranchConflictPanel
              preflight={restoreConflict}
              onUseSuggestion={onUseConflictSuggestion}
              onAdopt={onAdoptConflict}
              onCancel={onCancelConflict}
            />
          )}
          <button
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              onMenuOpenChange(false);
              void onRestore();
            }}
            disabled={restoreDisabled}
            className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-[rgb(var(--color-accent))] px-3 text-xs font-semibold text-[rgb(var(--color-accent-fg))] transition-colors hover:bg-[rgb(var(--color-accent-hover))] disabled:pointer-events-none disabled:opacity-45"
            title="Start the timeline and switch to it"
          >
            {restoring ? "Starting..." : confirming ? "Confirm new timeline" : "Start timeline"}
          </button>
        </div>
      )}
    </div>
  );
}

function SnapshotBranchConflictPanel({
  preflight,
  onUseSuggestion,
  onAdopt,
  onCancel,
}: {
  preflight: DraftlineVariationCreatePreflight;
  onUseSuggestion: (name: string) => void;
  onAdopt: () => void;
  onCancel: () => void;
}) {
  const canAdopt = preflight.remote_collision || preflight.remote_only_collision;
  const message = canAdopt
    ? `A shared timeline "${preflight.variation}" already exists${preflight.existing_remote_head?.label ? ` at "${preflight.existing_remote_head.label}"` : ""}.`
    : `A timeline "${preflight.variation}" already exists.`;

  return (
    <div className="mt-2 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-2xs leading-relaxed text-[rgb(var(--color-text-secondary))]">
      <div className="font-medium text-warning">{message}</div>
      <div className="mt-1">Pick another name, switch to the shared timeline, or cancel.</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {preflight.suggested_alternative && (
          <button
            type="button"
            onClick={() => onUseSuggestion(preflight.suggested_alternative!)}
            className="rounded-md border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1 font-medium text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]"
          >
            Use {preflight.suggested_alternative}
          </button>
        )}
        {canAdopt && (
          <button
            type="button"
            onClick={onAdopt}
            className="rounded-md bg-[rgb(var(--color-accent))] px-2 py-1 font-medium text-[rgb(var(--color-accent-fg))] hover:bg-[rgb(var(--color-accent-hover))]"
          >
            Adopt and switch
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-2 py-1 font-medium text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
