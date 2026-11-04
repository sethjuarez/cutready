import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { MAX_VERSION_NAME, normalizeVersionName, versionMessage, versionNameError } from "../../domain/versioning";
import { useContributorIdentity } from "../../hooks/useContributorIdentity";
import { isSaveBlocked, runVersionOperation } from "../../services/versionOperation";
import { isSuggestConfigured, suggestVersion } from "../../services/versionSuggest";
import { useChangeSummaryStore } from "../../stores/changeSummaryStore";
import { useVersioningStore } from "../../stores/versioningStore";
import { useVersionSuggest, type SuggestFields, type VersionSuggestDeps } from "./useVersionSuggest";

const suggestDeps: VersionSuggestDeps = {
  isConfigured: () => isSuggestConfigured(),
  suggest: suggestVersion,
  getSummary: () => useChangeSummaryStore.getState().summary,
  isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine),
};

const inputClass =
  "w-full rounded-control border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1 text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";
const iconButtonClass =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover hover:text-[rgb(var(--color-accent))] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";
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
}

/** Name (required, ≤72) and optional comment, with ✨ Suggest. Enter in Name saves. */
export function VersionForm({
  submitLabel = "Save version",
  afterSave,
  onDone,
  onCancel,
  showComment = true,
  focusRequest,
}: VersionFormProps) {
  const saveVersion = useVersioningStore((s) => s.saveVersion);
  const promptSnapshot = useVersioningStore((s) => s.promptSnapshot);
  const saving = useVersioningStore((s) => s.saving);
  const [fields, setFields] = useState<SuggestFields>({ name: "", comment: "" });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const errorId = useId();
  const { identity, error: identityError, loading: identityLoading } = useContributorIdentity(true);
  const suggest = useVersionSuggest(fields, setFields, suggestDeps);

  useEffect(() => {
    nameRef.current?.focus();
  }, [focusRequest]);

  const nameError = versionNameError(fields.name);
  const needsIdentity = !!identityError || !!identity?.needs_setup;
  const canSave = !nameError && !busy && !saving && !identityLoading;

  const submit = useCallback(async () => {
    setTouched(true);
    if (!canSave) return;
    if (needsIdentity) {
      // The full dialog asks who is saving first.
      void promptSnapshot();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await runVersionOperation("Save version", async (summary) => {
        if (summary.documents.length === 0) return false;
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
      setBusy(false);
    }
  }, [afterSave, canSave, fields.comment, fields.name, needsIdentity, onDone, promptSnapshot, saveVersion]);

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
        <button
          type="button"
          onClick={() => void suggest.run()}
          disabled={!!suggest.disabledReason || suggest.status === "running"}
          className={iconButtonClass}
          title={suggest.disabledReason ?? (suggest.status === "running" ? "Suggesting… (Esc to cancel)" : "Suggest a name")}
          aria-label={suggest.status === "running" ? "Suggesting a name. Press Escape to cancel." : "Suggest a name"}
          data-testid="version-suggest"
        >
          {suggest.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
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
      {suggest.pending && (
        <div role="alert" className="flex items-center gap-2 rounded-control bg-[rgb(var(--color-surface-alt))] px-2 py-1.5 text-2xs text-[rgb(var(--color-text))]">
          <span className="min-w-0 flex-1 truncate" title={suggest.pending.name}>Replace with “{suggest.pending.name}”?</span>
          <button type="button" onClick={suggest.confirmReplace} className="font-medium text-[rgb(var(--color-accent))] hover:underline">Replace</button>
          <button type="button" onClick={suggest.keepMine} className="text-[rgb(var(--color-text-secondary))] hover:underline">Keep mine</button>
        </div>
      )}
      {suggest.status === "failed" && (
        <p className="text-2xs text-[rgb(var(--color-text-secondary))]" role="status">Couldn't suggest a name. Try again or type one.</p>
      )}
      {(showNameError || error) && (
        <p id={errorId} className="text-2xs text-error" role="alert">{error ?? nameError}</p>
      )}
      {needsIdentity && !identityLoading && (
        <p className="text-2xs text-[rgb(var(--color-text-secondary))]">CutReady will ask who is saving first.</p>
      )}
      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-7 rounded-control px-2 text-xs text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover">
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy || saving || identityLoading} className={primaryClass} data-testid="version-save">
          {(busy || saving) && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
