// Checks a repository while its address is typed, before anything downloads.
import { useEffect, useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { workspaceIpc } from "../../ipc/workspace";
import { cloneErrorView } from "../../services/repoClone";
import { repoPreflight, type RepoNotice, type RepoPreflight } from "../../services/repoPreflight";

const SETTLE_MS = 600;

export interface RepoPreflightState {
  checking: boolean;
  result: RepoPreflight | null;
  /** Why the check failed; downloading may still work. */
  problem: string | null;
}

const idle: RepoPreflightState = { checking: false, result: null, problem: null };

/** Inspects `location` once typing settles; a newer address discards older answers. */
export function useRepoPreflight(location: string): RepoPreflightState {
  const [state, setState] = useState<RepoPreflightState>(idle);
  useEffect(() => {
    if (!location) {
      setState(idle);
      return;
    }
    let current = true;
    setState({ ...idle, checking: true });
    const timer = window.setTimeout(() => {
      workspaceIpc
        .inspectRepositoryForProject(location)
        .then((inspection) => current && setState({ ...idle, result: repoPreflight(inspection) }))
        .catch((error) => current && setState({ ...idle, problem: cloneErrorView(error).message }));
    }, SETTLE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [location]);
  return state;
}

function Notice({ notice }: { notice: RepoNotice }) {
  const warning = notice.tone === "warning";
  const Icon = warning ? AlertTriangle : Info;
  return (
    <li className={`flex items-start gap-2 text-xs ${warning ? "text-[rgb(var(--color-warning))]" : "text-[rgb(var(--color-text-secondary))]"}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{notice.message}</span>
    </li>
  );
}

export function RepoPreflightNotices({ state }: { state: RepoPreflightState }) {
  const notices: RepoNotice[] = state.problem
    ? [{ tone: "warning", message: `Couldn't check this repository: ${state.problem}` }]
    : state.result?.notices ?? [];
  return (
    <div aria-live="polite" className="mt-1.5">
      {state.checking && <p className="text-xs text-[rgb(var(--color-text-secondary))]">Checking repository…</p>}
      {notices.length > 0 && (
        <ul className="space-y-1" data-testid="repo-preflight-notices">
          {notices.map((notice) => <Notice key={notice.message} notice={notice} />)}
        </ul>
      )}
    </div>
  );
}
