import { useId } from "react";

export interface IdentityDraft {
  name: string;
  email: string;
}

const inputClass =
  "w-full rounded-control border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-2 py-1 text-xs text-[rgb(var(--color-text))] placeholder:text-[rgb(var(--color-text-secondary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

/** Who is saving, asked once on this computer before the first version. */
export function VersionIdentityFields({ draft, onChange }: { draft: IdentityDraft; onChange: (draft: IdentityDraft) => void }) {
  const nameId = useId();
  const emailId = useId();
  return (
    <fieldset className="space-y-1.5" data-testid="version-identity">
      <legend className="text-2xs text-[rgb(var(--color-text-secondary))]">
        Who is saving? Collaborators see this on each version. CutReady remembers it on this computer.
      </legend>
      <label htmlFor={nameId} className="sr-only">Your name</label>
      <input
        id={nameId}
        value={draft.name}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        placeholder="Your name"
        className={inputClass}
        autoComplete="name"
        data-testid="version-author-name"
      />
      <label htmlFor={emailId} className="sr-only">Your email</label>
      <input
        id={emailId}
        type="email"
        value={draft.email}
        onChange={(event) => onChange({ ...draft, email: event.target.value })}
        placeholder="you@example.com"
        className={inputClass}
        autoComplete="email"
        data-testid="version-author-email"
      />
    </fieldset>
  );
}
