import { Loader2, Sparkles } from "lucide-react";
import type { VersionSuggestState } from "./useVersionSuggest";

const iconButtonClass =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-[rgb(var(--color-text-secondary))] hover:bg-fill-hover hover:text-[rgb(var(--color-accent))] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

/** ✨ Suggest: runs only on click; Esc cancels while it's running. */
export function SuggestButton({ suggest, testId }: { suggest: VersionSuggestState; testId: string }) {
  const running = suggest.status === "running";
  return (
    <button
      type="button"
      onClick={() => void suggest.run()}
      disabled={!!suggest.disabledReason || running}
      className={iconButtonClass}
      title={suggest.disabledReason ?? (running ? "Suggesting… (Esc to cancel)" : "Suggest a name")}
      aria-label={running ? "Suggesting a name. Press Escape to cancel." : "Suggest a name"}
      data-testid={testId}
    >
      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  );
}

/** The "Replace?" confirmation and the failure note under the fields. */
export function SuggestNotices({ suggest }: { suggest: VersionSuggestState }) {
  return (
    <>
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
    </>
  );
}
