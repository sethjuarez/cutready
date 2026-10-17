import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useContributorIdentity } from "../../hooks/useContributorIdentity";
import {
  clearContributorIdentity,
  formatIdentity,
  identitySourceLabel,
  setContributorIdentity,
  type ResolvedIdentity,
} from "../../services/identity";
import { inputClass } from "../../styles";

const labelClass = "text-sm font-medium text-[rgb(var(--color-text))]";
const buttonClass = "px-3 py-2 rounded-lg text-xs font-medium transition-opacity disabled:opacity-50";

export function ProfileTab() {
  const { identity, setIdentity, error: loadError } = useContributorIdentity();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!identity) return;
    setName(identity.name_source === "fallback" ? "" : identity.name);
    setEmail(identity.email ?? "");
  }, [identity]);

  const run = async (action: () => Promise<ResolvedIdentity>, message: string) => {
    setBusy(true);
    setStatus(null);
    try {
      setIdentity(await action());
      setStatus({ ok: true, message });
    } catch (err) {
      setStatus({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const unchanged = identity?.profile
    && identity.profile.name === name.trim()
    && (identity.profile.email ?? "") === email.trim();

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-[rgb(var(--color-text-secondary))]">
        CutReady signs your snapshots with this name and email. It is saved on this computer, not in the project, so each collaborator keeps their own.
      </p>

      <div
        data-testid="profile-current"
        className="flex flex-col gap-1 px-3 py-2.5 rounded-lg border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))]"
      >
        <span className="text-xs text-[rgb(var(--color-text-secondary))]">Saving as</span>
        <span className="text-sm font-medium text-[rgb(var(--color-text))]">
          {identity ? formatIdentity(identity) : loadError ? "Unavailable" : "Loading\u2026"}
        </span>
        {identity && (
          <span className="text-xs text-[rgb(var(--color-text-secondary))]">
            Name from {identitySourceLabel(identity.name_source)}
            {identity.email && <> &middot; email from {identitySourceLabel(identity.email_source)}</>}
          </span>
        )}
        {identity?.needs_setup && (
          <span className="mt-1 flex items-center gap-1.5 text-xs text-[rgb(var(--color-accent))]">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            No email found. Add one so collaborators can see who saved each snapshot.
          </span>
        )}
        {loadError && <span className="text-xs text-error">{loadError}</span>}
      </div>

      <fieldset className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>Name</span>
          <input
            data-testid="profile-name-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={labelClass}>Email</span>
          <input
            data-testid="profile-email-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputClass}
          />
        </label>
        <div className="flex gap-2">
          <button
            data-testid="profile-save"
            onClick={() => run(() => setContributorIdentity(name, email), "Saved. New snapshots use this identity.")}
            disabled={busy || !name.trim() || !email.trim() || Boolean(unchanged)}
            className={`${buttonClass} bg-[rgb(var(--color-accent))] text-[rgb(var(--color-accent-fg))] hover:opacity-90`}
          >
            Save
          </button>
          {identity?.profile && (
            <button
              data-testid="profile-reset"
              onClick={() => run(clearContributorIdentity, "Using the detected identity.")}
              disabled={busy}
              className={`${buttonClass} border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-alt))]`}
            >
              Use detected
            </button>
          )}
        </div>
        {status && (
          <p className={`text-xs ${status.ok ? "text-success" : "text-error"}`}>{status.message}</p>
        )}
      </fieldset>
    </div>
  );
}
