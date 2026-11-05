import { useId, useState } from "react";
import { Archive } from "lucide-react";
import type { SetAsideShelf } from "../../domain/versioning";
import { useVersioningStore } from "../../stores/versioningStore";
import { formatRelativeDate } from "../../utils/relativeDate";
import { BannerButton, BannerRow } from "../BannerParts";

const icon = <Archive aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[rgb(var(--color-accent))]" />;

function ShelfActions({ shelf, disabled }: { shelf: SetAsideShelf; disabled: boolean }) {
  const popStash = useVersioningStore((s) => s.popStash);
  const dropStash = useVersioningStore((s) => s.dropStash);
  const busy = useVersioningStore((s) => s.setAsideBusy);
  // "kept" returns focus to Delete after Keep, so keyboard users don't lose their place.
  const [mode, setMode] = useState<"idle" | "confirming" | "kept">("idle");
  const off = disabled || busy;
  if (mode === "confirming") {
    return (
      <>
        <span className="shrink-0 font-medium text-[rgb(var(--color-text))]">Delete for good?</span>
        <BannerButton onClick={() => void dropStash(shelf.id)} key="confirm" disabled={off} autoFocus label={`Delete ${shelf.name} for good`} testId="set-aside-delete-confirm">
          Delete
        </BannerButton>
        <BannerButton key="keep" onClick={() => setMode("kept")} label={`Keep ${shelf.name}`}>Keep</BannerButton>
      </>
    );
  }
  return (
    <>
      <BannerButton key="restore" onClick={() => void popStash(shelf.id)} disabled={off} label={`Restore ${shelf.name}`} testId="set-aside-restore">
        Restore
      </BannerButton>
      <BannerButton key="delete" onClick={() => setMode("confirming")} disabled={off} autoFocus={mode === "kept"} label={`Delete ${shelf.name}`} testId="set-aside-delete">
        Delete
      </BannerButton>
    </>
  );
}

function ShelfLabel({ shelf, now }: { shelf: SetAsideShelf; now: Date }) {
  const when = new Date(shelf.timeMs);
  return (
    <span className="min-w-0 flex-1 truncate" title={`${shelf.name} · ${when.toLocaleString()}`}>
      <span className="font-medium text-[rgb(var(--color-text))]">{shelf.name}</span>
      <span> · {formatRelativeDate(when.toISOString(), now)}</span>
    </span>
  );
}

/** Work set aside before a switch, restore or update, each restorable or deletable. */
export function SetAsideBanner({ disabled, now = new Date() }: { disabled: boolean; now?: Date }) {
  const shelves = useVersioningStore((s) => s.setAsideShelves);
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (shelves.length === 0) return null;

  if (shelves.length === 1) {
    const [shelf] = shelves;
    return (
      <BannerRow testId="project-health-shelf" icon={icon}>
        <span className="shrink-0">Set aside:</span>
        <ShelfLabel shelf={shelf} now={now} />
        <ShelfActions shelf={shelf} disabled={disabled} />
      </BannerRow>
    );
  }

  return (
    <div data-testid="project-health-shelf">
      <BannerRow testId="project-health-shelf-summary" icon={icon}>
        <span className="flex-1">{shelves.length} sets of changes are set aside.</span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-[rgb(var(--color-accent))] hover:bg-[rgb(var(--color-surface-inset))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]"
        >
          {open ? "Hide" : "Show"}
        </button>
      </BannerRow>
      {open && (
        <ul id={listId} aria-label="Set-aside changes" className="border-b border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-alt))] py-1">
          {shelves.map((shelf) => (
            <li key={shelf.id} className="flex items-center gap-2 py-1 pl-8 pr-3 text-xs text-[rgb(var(--color-text-secondary))]">
              <ShelfLabel shelf={shelf} now={now} />
              <ShelfActions shelf={shelf} disabled={disabled} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
