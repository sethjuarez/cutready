import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { MAX_VERSION_NAME, normalizeVersionName, versionMessage, versionNameError } from "../../domain/versioning";
import { useContributorIdentity } from "../../hooks/useContributorIdentity";
import { setContributorIdentity } from "../../services/identity";
import { isSaveBlocked, runVersionOperation } from "../../services/versionOperation";
import { isSuggestConfigured, suggestVersion } from "../../services/versionSuggest";
import { useChangeSummaryStore } from "../../stores/changeSummaryStore";
import { useVersioningStore } from "../../stores/versioningStore";
import { useVersionSuggest, type SuggestFields, type VersionSuggestDeps } from "./useVersionSuggest";
import { SuggestButton, SuggestNotices } from "./SuggestControls";
import { VersionIdentityFields, type IdentityDraft } from "./VersionIdentityFields";

const suggestDeps: VersionSuggestDeps = {
  isConfigured: () => isSuggestConfigured(),
  suggest: suggestVersion,
  getSummary: () => useChangeSummaryStore.getState().summary,
  isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine),
};

const inputClass =
  "w-full rounded-control border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1 text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";
const primaryClass =
  "inline-flex h-7 items-center justify-center gap-1.5 rounded-control bg-[rgb(var(--color-accent))] px-3 text-xs font-medium text-[rgb(var(--color-accent-fg))] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))] focus-visible:ring-offset-1";

export interface VersionFormProps {
  /** Primary button label, e.g. "Save version" or "Save & send". */
  submitLabel?: string;
  /** Runs after the version is saved, inside the same operation (e.g. Send). */
  afterSave?: (version: { name: string; comment: string }) => Promise<void>;
  onDone?: () => void;
  onCancel?: () => void;
  /** Shows the optional Comment field, saved as the version's commit body. */
  showComment?: boolean;
  /** Focus the name whenever this changes. */
  focusRequest?: number;
  /** Shown before the buttons, e.g. "Set aside & continue" in the pre-action dialog. */
  extraAction?: ReactNode;
  /** Something else is running (e.g. set aside); saving waits. */
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

/** Name (required, ≤72) and optional comment, with ✨ Suggest. Enter in Name saves. */
export function VersionForm({
  submitLabel = "Save version",
  afterSave,
  onDone,
  onCancel,
  showComment = true,
  focusRequest,
  extraAction,
  disabled = false,
  onBusyChange,
}: VersionFormProps) {
  const saveVersion = useVersioningStore((s) => s.saveVersion);
  const saving = useVersioningStore((s) => s.saving);
  const [fields, setFields] = useState<SuggestFields>({ name: "", comment: "" });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // Synchronous single-flight: state updates land too late to stop a double submit.
  const inFlight = useRef(false);
  const nameId = useId();
  const errorId = useId();
  const { identity, setIdentity, error: identityError, loading: identityLoading } = useContributorIdentity(true);
  const [author, setAuthor] = useState<IdentityDraft>({ name: "", email: "" });
  const suggest = useVersionSuggest(fields, setFields, suggestDeps);

  useEffect(() => {
    nameRef.current?.focus();
  }, [focusRequest]);

  // Start from whatever name the system knows, e.g. the OS account.
  const suggestedAuthor = identity?.needs_setup ? identity.name ?? "" : "";
  useEffect(() => {
    if (suggestedAuthor) setAuthor((draft) => (draft.name ? draft : { ...draft, name: suggestedAuthor }));
  }, [suggestedAuthor]);

  const nameError = versionNameError(fields.name);
  const needsIdentity = !!identity?.needs_setup;
  const authorMissing = needsIdentity && (!author.name.trim() || !author.email.trim());
  const canSave = !nameError && !busy && !saving && !disabled && !identityLoading && !identityError && !authorMissing;

  const submit = useCallback(async () => {
    setTouched(true);
    if (!canSave || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      if (needsIdentity) setIdentity(await setContributorIdentity(author.name.trim(), author.email.trim()));
      const saved = await runVersionOperation("Save version", async (summary) => {
        if (summary.documents.length === 0 && !useVersioningStore.getState().isDirty) return false;
        await saveVersion(versionMessage(fields.name, fields.comment));
        return true;
      });
      if (!saved) {
        setError("Nothing to save. Everything is already in a version.");
        return;
      }
      const version = { name: normalizeVersionName(fields.name), comment: fields.comment.trim() };
      setFields({ name: "", comment: "" });
      setTouched(false);
      await afterSave?.(version);
      onDone?.();
    } catch (err) {
      // The chip shows "Couldn't save – Retry" when edits couldn't be written.
      if (!isSaveBlocked(err)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }, [afterSave, author, canSave, fields.comment, fields.name, needsIdentity, onBusyChange, onDone, saveVersion, setIdentity]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && suggest.cancel()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const showNameError = touched && nameError;
  const chars = [...fields.name.trim()].length;

  return (
    <form
      className="space-y-2 px-3 py-2"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      aria-label="Save version"
    >
      <div className="flex items-center justify-between">
        <label htmlFor={nameId} className="text-2xs font-medium text-[rgb(var(--color-text-secondary))]">
          Name
        </label>
        <span className={`text-2xs ${chars > MAX_VERSION_NAME ? "text-error" : "text-[rgb(var(--color-text-tertiary))]"}`} aria-hidden="true">
          {chars}/{MAX_VERSION_NAME}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <input
          id={nameId}
          ref={nameRef}
          value={fields.name}
          onChange={(event) => setFields({ ...fields, name: event.target.value })}
          onBlur={() => fields.name && setTouched(true)}
          placeholder="What changed?"
          className={inputClass}
          aria-invalid={showNameError ? true : undefined}
          aria-describedby={showNameError || error ? errorId : undefined}
          data-testid="version-name-input"
          autoComplete="off"
        />
        <SuggestButton suggest={suggest} testId="version-suggest" />
      </div>
      {showComment && (
        <textarea
          value={fields.comment}
          onChange={(event) => setFields({ ...fields, comment: event.target.value })}
          placeholder="Comment (optional)"
          rows={2}
          className={`${inputClass} resize-none`}
          aria-label="Comment"
        />
      )}
      <SuggestNotices suggest={suggest} />
      {(showNameError || error) && (
        <p id={errorId} className="text-2xs text-error" role="alert">{error ?? nameError}</p>
      )}
      {needsIdentity && <VersionIdentityFields draft={author} onChange={setAuthor} />}
      {identityError && (
        <p className="text-2xs text-error" role="alert" data-testid="version-identity-error">
          Couldn't load who is saving. Check Settings › Profile, then try again.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {extraAction}
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy} className="h-7 rounded-control px-2 text-xs text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover">
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy || saving || disabled || identityLoading || !!identityError} className={primaryClass} data-testid="version-save">
          {(busy || saving) && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
