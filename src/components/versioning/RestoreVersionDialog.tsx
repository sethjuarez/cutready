import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { versionNameError } from "../../domain/versioning";
import { defaultRestoreComment, defaultRestoreName, startRestore, type RestoreScope } from "../../services/versionRestore";
import { Dialog } from "../Dialog";
import { VersionNameFields, type VersionNameDraft } from "./VersionNameFields";

export interface RestoreTarget {
  versionId: string;
  versionName: string;
  scope: RestoreScope;
  /** Display names of the documents being restored (documents scope). */
  labels?: string[];
  /** The document didn't exist in this version, so restoring removes it. */
  removes?: boolean;
}

const primaryClass =
  "inline-flex h-7 items-center justify-center gap-1.5 rounded-control bg-[rgb(var(--color-accent))] px-3 text-xs font-medium text-[rgb(var(--color-accent-fg))] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] focus-visible:ring-offset-1";

/** Names the new version a restore creates, then restores through the pre-action boundary. */
export function RestoreVersionDialog({ target, onClose }: { target: RestoreTarget | null; onClose: () => void }) {
  return (
    <Dialog isOpen={!!target} onClose={onClose} width="w-[420px] max-w-[90vw]" labelledBy="restore-version-title">
      {target && <RestoreVersionForm key={`${target.versionId}:${target.scope.kind}`} target={target} onClose={onClose} />}
    </Dialog>
  );
}

function RestoreVersionForm({ target, onClose }: { target: RestoreTarget; onClose: () => void }) {
  const [draft, setDraft] = useState<VersionNameDraft>(() => ({
    name: defaultRestoreName(target.versionName),
    comment: defaultRestoreComment(target.versionName, target.versionId),
  }));
  const error = versionNameError(draft.name);
  const documents = target.scope.kind === "documents";
  const what = target.scope.kind === "project"
    ? "the whole project"
    : target.labels?.length === 1 ? `“${target.labels[0]}”` : `${target.scope.paths.length} documents`;

  return (
    <form
      className="space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (error) return;
        onClose();
        startRestore({ versionId: target.versionId, versionName: target.versionName, scope: target.scope, name: draft.name, comment: draft.comment });
      }}
      data-testid="restore-version-dialog"
    >
      <div className="flex items-start gap-2">
        <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--color-accent))]" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="restore-version-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">
            {documents ? "Restore document" : "Restore this version"}
          </h2>
          <p className="mt-0.5 text-xs text-[rgb(var(--color-text-secondary))]">
            {target.removes
              ? <>{what} didn't exist in this version, so restoring removes it. </>
              : <>Brings back {what} as it was in this version. </>}
            It's saved as a new version, so nothing in your history is lost.
          </p>
        </div>
      </div>
      <VersionNameFields draft={draft} onChange={setDraft} nameTestId="restore-name-input" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-7 rounded-control px-2 text-xs text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover">
          Cancel
        </button>
        <button type="submit" disabled={!!error} className={primaryClass} data-testid="restore-confirm">
          Restore
        </button>
      </div>
    </form>
  );
}
