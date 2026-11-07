import { useMemo, useState } from "react";
import { GitMerge } from "lucide-react";
import { versionMessage, versionNameError, type IncomingVersion } from "../../domain/versioning";
import { isSuggestConfigured, suggestMergeName } from "../../services/versionSuggest";
import { useMergeNameStore, type PendingMergeName } from "../../stores/mergeNameStore";
import { Dialog } from "../Dialog";
import { VersionNameFields, type VersionNameDraft } from "./VersionNameFields";
import { SuggestButton, SuggestNotices } from "./SuggestControls";
import { useVersionSuggest, type VersionSuggestDeps } from "./useVersionSuggest";

const primaryClass =
  "inline-flex h-7 items-center justify-center gap-1.5 rounded-control bg-[rgb(var(--color-accent))] px-3 text-xs font-medium text-[rgb(var(--color-accent-fg))] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] focus-visible:ring-offset-1";

/** Approves the name of a merge before incoming changes are applied. Mounted once. */
export function MergeNameHost() {
  const pending = useMergeNameStore((s) => s.pending);
  const answer = useMergeNameStore((s) => s.answer);
  return (
    <Dialog isOpen={!!pending} onClose={() => answer(null)} width="w-[420px] max-w-[90vw]" labelledBy="merge-name-title">
      {pending && <MergeNameForm key={pending.id} pending={pending} onAnswer={answer} />}
    </Dialog>
  );
}

function MergeNameForm({ pending, onAnswer }: { pending: PendingMergeName; onAnswer: (message: string | null) => void }) {
  const [draft, setDraft] = useState<VersionNameDraft>({ name: pending.defaultName, comment: "" });
  const error = versionNameError(draft.name);
  // ✨ Suggest names the merge from the versions it brings in, not from local work.
  const deps = useMemo<VersionSuggestDeps<IncomingVersion[]>>(() => ({
    isConfigured: () => isSuggestConfigured(),
    suggest: (versions) => suggestMergeName(pending.source, versions),
    getSummary: () => (pending.incoming.length > 0 ? pending.incoming : null),
    isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine),
  }), [pending]);
  const suggest = useVersionSuggest(draft, setDraft, deps, { name: pending.defaultName, comment: "" });

  return (
    <form
      className="cr-modal-surface space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!error) onAnswer(versionMessage(draft.name, draft.comment));
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && suggest.cancel()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      data-testid="merge-name-dialog"
    >
      <div className="flex items-start gap-2">
        <GitMerge className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(var(--color-accent))]" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="merge-name-title" className="text-sm font-semibold text-[rgb(var(--color-text))]">Name this merge</h2>
          <p className="mt-0.5 text-xs text-[rgb(var(--color-text-secondary))]">
            Bringing in updates from {pending.source} saves a new version that combines them with your work.
          </p>
        </div>
      </div>
      <VersionNameFields
        draft={draft}
        onChange={setDraft}
        nameTestId="merge-name-input"
        nameAction={pending.incoming.length > 0 ? <SuggestButton suggest={suggest} testId="merge-name-suggest" /> : undefined}
        notices={<SuggestNotices suggest={suggest} />}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => onAnswer(null)} className="h-7 rounded-control px-2 text-xs text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover">
          Cancel
        </button>
        <button type="submit" disabled={!!error} className={primaryClass} data-testid="merge-name-confirm">
          Merge
        </button>
      </div>
    </form>
  );
}
