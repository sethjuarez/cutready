import { useId, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { summaryChips } from "../../domain/changes/format";
import { setAsideFor } from "../../services/preAction";
import { isSaveBlocked } from "../../services/versionOperation";
import { useChangeSummaryStore } from "../../stores/changeSummaryStore";
import { usePreActionStore, type PendingPreAction } from "../../stores/preActionStore";
import { Dialog } from "../Dialog";
import { WorkspaceChangesList } from "../WorkspaceChangesList";
import { VersionForm } from "./VersionForm";

const secondaryClass =
  "h-7 rounded-control border border-[rgb(var(--color-border))] px-2.5 text-xs text-[rgb(var(--color-text))] hover:bg-fill-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";
const primaryClass =
  "h-7 rounded-control bg-[rgb(var(--color-accent))] px-3 text-xs font-medium text-[rgb(var(--color-accent-fg))] hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] focus-visible:ring-offset-1";

/** The one dialog shown when unsaved work blocks a restore, switch or update. Mounted once. */
export function PreActionHost() {
  const pending = usePreActionStore((s) => s.pending);
  const dismiss = usePreActionStore((s) => s.dismiss);
  if (!pending) return null;
  return <PreActionDialog key={pending.id} pending={pending} onClose={dismiss} />;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function PreActionDialog({ pending, onClose }: { pending: PendingPreAction; onClose: () => void }) {
  const titleId = useId();
  const totals = useChangeSummaryStore((s) => s.summary?.totals);
  const [saving, setSaving] = useState(false);
  const [working, setWorking] = useState(false);
  /** Set once the work is safe (saved or set aside) but the action itself failed. */
  const [continueError, setContinueError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const followUp = useRef<(() => Promise<void>) | undefined>(undefined);
  const busy = saving || working;
  const chips = totals ? summaryChips(totals) : [];
  const count = pending.changeCount;

  const continueAction = async () => {
    setWorking(true);
    setContinueError(null);
    try {
      await pending.run();
    } catch (err) {
      setContinueError(isSaveBlocked(err) ? "Couldn't save open edits." : errorText(err));
      setWorking(false);
      return;
    }
    onClose();
    await followUp.current?.().catch((err) => console.error("Follow-up failed:", err));
  };

  const setAside = async () => {
    if (busy) return;
    setWorking(true);
    setError(null);
    try {
      const result = await setAsideFor(pending);
      if (!result.shelved) {
        setError("Couldn't set your changes aside. Save them as a version instead.");
        setWorking(false);
        return;
      }
      followUp.current = result.followUp;
    } catch (err) {
      if (!isSaveBlocked(err)) setError(errorText(err));
      setWorking(false);
      return;
    }
    await continueAction();
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog isOpen onClose={close} align="top" topOffset="14vh" width="w-full max-w-lg mx-4" labelledBy={titleId}>
      <div className="cr-modal-surface overflow-hidden" data-testid="pre-action-dialog" aria-busy={busy || undefined}>
        <div className="flex items-start gap-3 border-b border-[rgb(var(--color-border))] px-5 py-4">
          <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-card bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))]">
            <AlertTriangle aria-hidden="true" className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold text-[rgb(var(--color-text))]">
              {continueError === null ? "Save your changes first?" : `Couldn't finish ${pending.target}`}
            </h2>
            {continueError === null ? (
              <>
                <p className="mt-1 text-sm text-[rgb(var(--color-text-secondary))]">
                  You have {count} unsaved {count === 1 ? "change" : "changes"}. Before{" "}
                  <span className="font-medium text-[rgb(var(--color-text))]">{pending.target}</span>, save them as a version
                  {pending.canSetAside ? " or set them aside to bring back later" : ""}.
                </p>
                {chips.length > 0 && (
                  <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]" data-testid="pre-action-summary">{chips.join(" · ")}</p>
                )}
                <WorkspaceChangesList />
                {!pending.canSetAside && (
                  <p className="mt-2 text-xs text-[rgb(var(--color-text-secondary))]">
                    Set aside isn't available while other set-aside changes are waiting to be brought back.
                  </p>
                )}
              </>
            ) : (
              <p className="mt-1 text-sm text-[rgb(var(--color-text-secondary))]" role="alert">
                Your changes are safe. {continueError}
              </p>
            )}
          </div>
        </div>
        {continueError === null ? (
          <div className="py-2">
            <VersionForm
              submitLabel="Save version & continue"
              onDone={() => void continueAction()}
              onCancel={close}
              disabled={working}
              onBusyChange={setSaving}
              extraAction={pending.canSetAside && (
                <button type="button" className={secondaryClass} disabled={busy} onClick={() => void setAside()} data-testid="pre-action-set-aside">
                  Set aside &amp; continue
                </button>
              )}
            />
            {error && <p className="px-3 pb-1 text-xs text-error" role="alert">{error}</p>}
          </div>
        ) : (
          <div className="flex justify-end gap-2 px-5 py-3">
            <button type="button" className={secondaryClass} disabled={busy} onClick={close}>Close</button>
            <button type="button" className={primaryClass} disabled={busy} onClick={() => void continueAction()} data-testid="pre-action-retry">
              Try again
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
