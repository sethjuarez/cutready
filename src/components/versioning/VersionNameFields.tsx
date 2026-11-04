import { useEffect, useId, useRef } from "react";
import { MAX_VERSION_NAME, versionNameError } from "../../domain/versioning";

export interface VersionNameDraft {
  name: string;
  comment: string;
}

const inputClass =
  "w-full rounded-control border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1 text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

/**
 * Name (required, ≤72, with a counter) and optional comment for a version the
 * app writes itself, such as a restore or a merge. The name starts selected.
 */
export function VersionNameFields({
  draft,
  onChange,
  nameTestId,
}: {
  draft: VersionNameDraft;
  onChange: (draft: VersionNameDraft) => void;
  nameTestId: string;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const errorId = useId();
  const error = versionNameError(draft.name);
  const chars = [...draft.name.trim()].length;

  useEffect(() => {
    nameRef.current?.select();
  }, []);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label htmlFor={nameId} className="text-2xs font-medium text-[rgb(var(--color-text-secondary))]">Name</label>
        <span className={`text-2xs ${chars > MAX_VERSION_NAME ? "text-error" : "text-[rgb(var(--color-text-tertiary))]"}`} aria-hidden="true">
          {chars}/{MAX_VERSION_NAME}
        </span>
      </div>
      <input
        id={nameId}
        ref={nameRef}
        value={draft.name}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        className={inputClass}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        data-testid={nameTestId}
        autoComplete="off"
      />
      <textarea
        value={draft.comment}
        onChange={(event) => onChange({ ...draft, comment: event.target.value })}
        placeholder="Comment (optional)"
        rows={2}
        className={`${inputClass} resize-none`}
        aria-label="Comment"
      />
      {error && <p id={errorId} className="text-2xs text-error" role="alert">{error}</p>}
    </div>
  );
}
