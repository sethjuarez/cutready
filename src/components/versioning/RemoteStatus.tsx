import { useState } from "react";
import { AlertTriangle, ArrowDown, GitMerge, RefreshCw, X } from "lucide-react";
import { classifySyncError } from "../../domain/versioning";
import { isDraftlineGuidanceMessage } from "../../services/draftlineErrors";
import { isContributorIdentityRequired } from "../../services/identity";
import { isSaveBlocked, runVersionOperation } from "../../services/versionOperation";
import { useAppStore } from "../../stores/appStore";
import { useSyncStore } from "../../stores/syncStore";
import { IncomingPreview } from "./IncomingPreview";

const linkButtonClass =
  "inline-flex h-6 items-center gap-1 rounded-control px-1.5 text-2xs font-medium text-[rgb(var(--color-accent))] hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-accent))]";

function incoming(operation: string, action: () => Promise<void>) {
  void runVersionOperation(operation, () => action()).catch((err) => {
    if (!isSaveBlocked(err)) console.error(`${operation} failed:`, err);
  });
}

/** Where work is shared, what's waiting to come in, and any sync problem (never hidden). */
export function RemoteStatus() {
  const currentRemote = useSyncStore((s) => s.currentRemote);
  const syncStatus = useSyncStore((s) => s.syncStatus);
  const baseStatus = useSyncStore((s) => s.baseStatus);
  const syncError = useSyncStore((s) => s.syncError);
  const isSyncing = useSyncStore((s) => s.isSyncing);
  const incomingCommits = useSyncStore((s) => s.incomingCommits);
  const fetchFromRemote = useSyncStore((s) => s.fetchFromRemote);
  const pullFromRemote = useSyncStore((s) => s.pullFromRemote);
  const getUpdatesFromBase = useSyncStore((s) => s.getUpdatesFromBase);
  const isHybrid = useAppStore((s) => s.currentProject?.hybrid === true);
  const [showIncoming, setShowIncoming] = useState(false);

  if (!currentRemote) {
    return (
      <p className="px-3 py-2 text-2xs text-[rgb(var(--color-text-secondary))]" data-testid="remote-status">
        <span aria-hidden="true" className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[rgb(var(--color-text-secondary))]/50" />
        Local project. Add a remote in Settings to send work.
      </p>
    );
  }

  const behind = syncStatus?.behind ?? 0;
  const baseBehind = isHybrid && baseStatus ? baseStatus.behind : 0;
  const error = syncError
    ? classifySyncError(syncError, { isIdentityRequired: isContributorIdentityRequired, isGuidance: isDraftlineGuidanceMessage })
    : null;

  return (
    <div className="border-t border-[rgb(var(--color-border-subtle))] px-3 py-2" data-testid="remote-status">
      <div className="flex items-center gap-2 text-2xs text-[rgb(var(--color-text-secondary))]">
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${error ? "bg-warning" : "bg-success"}`}
        />
        <span className="min-w-0 flex-1 truncate" title={currentRemote.url}>
          {error ? "Sync needs attention" : "Connected"} · {currentRemote.name}
        </span>
        <button
          type="button"
          onClick={() => void fetchFromRemote({ notifyAuthRequired: true })}
          disabled={isSyncing}
          className={linkButtonClass}
          title="Check for updates"
        >
          <RefreshCw className={`h-3 w-3 ${isSyncing ? "motion-safe:animate-spin" : ""}`} aria-hidden="true" />
          Check
        </button>
      </div>
      {behind > 0 && (
        <div className="mt-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowIncoming((value) => !value)}
            aria-expanded={showIncoming}
            className="min-w-0 flex-1 truncate text-left text-2xs text-[rgb(var(--color-text))] hover:underline"
          >
            {behind} incoming version{behind === 1 ? "" : "s"} from collaborators
          </button>
          <button type="button" onClick={() => incoming("Get updates", pullFromRemote)} disabled={isSyncing} className={linkButtonClass}>
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
            Get updates
          </button>
        </div>
      )}
      {showIncoming && behind > 0 && <div className="mt-1"><IncomingPreview commits={incomingCommits} inline /></div>}
      {baseBehind > 0 && baseStatus && (
        <div className="mt-1.5 flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-2xs text-[rgb(var(--color-text))]">
            {baseBehind} new change{baseBehind === 1 ? "" : "s"} on {baseStatus.base}
          </span>
          <button
            type="button"
            onClick={() => incoming("Get updates", getUpdatesFromBase)}
            disabled={isSyncing}
            className={linkButtonClass}
            title={`Get updates from ${baseStatus.base}`}
          >
            <GitMerge className="h-3 w-3" aria-hidden="true" />
            Get updates
          </button>
        </div>
      )}
      {error && (
        <div className="mt-1.5 flex items-start gap-1.5 text-2xs text-error" title={syncError ?? undefined} role="status" data-sync-error={error.kind}>
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error.text}</span>
          <button
            type="button"
            onClick={() => useSyncStore.setState({ syncError: null })}
            className="shrink-0 rounded p-0.5 text-[rgb(var(--color-text-secondary))] hover:text-[rgb(var(--color-text))]"
            aria-label="Dismiss sync error"
            title="Dismiss"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
