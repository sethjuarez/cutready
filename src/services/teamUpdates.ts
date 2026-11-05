// Bringing the team's sent work into this project without asking the user to
// name anything. Only a real conflict needs them; everything else is silent.
import {
  applyDraftlineIncoming,
  mergeDraftlineIncomingWithToken,
  preflightDraftlineIncoming,
  preflightDraftlineMergeBase,
  preflightDraftlineMergeIncoming,
  type DraftlineMergeIncomingReport,
} from "./draftlineVersioning";
import { teamUpdatesLabel } from "../domain/versioning/teamUpdates";
import { useVersioningStore } from "../stores/versioningStore";
import type { SyncStatus } from "../types/sketch";

export type TeamUpdateOutcome =
  /** Nothing new from the team. */
  | { kind: "none" }
  /** The team's saves are in; `count` is how many came in. */
  | { kind: "brought-in"; count: number }
  /** Someone changed the same files; the conflict panel is open. */
  | { kind: "conflict"; count: number; status: SyncStatus }
  /** Nothing changed; tell the user why. */
  | { kind: "blocked"; message: string; status?: SyncStatus }
  /** The project changed underneath; nothing was touched. */
  | { kind: "cancelled" };

/** Where the updates come from: this timeline's sent copy, or the project's shared starting point. */
export type TeamUpdateSource = "incoming" | "base";

export const SAVE_BEFORE_UPDATES_MESSAGE = "Save or discard your changes first, then get the team's updates.";
export const UPDATES_UNSAFE_MESSAGE = "The team's updates can't be brought in safely right now.";
/** Shown in the conflict panel header for team updates. */
export const TEAM_UPDATES_SOURCE = "team updates";

/**
 * Brings in what the team sent. Throws Draftline errors for the caller to word.
 * `isCurrent` is checked after every await: Draftline calls follow the open
 * project, so a switch mid-way must stop before anything is changed.
 */
export async function bringInTeamUpdates(
  remote: string,
  from: TeamUpdateSource,
  isCurrent: () => boolean = () => true,
): Promise<TeamUpdateOutcome> {
  if (from === "base") {
    const report = await preflightDraftlineMergeBase(remote);
    return isCurrent() ? settle(report, remote, isCurrent) : { kind: "cancelled" };
  }

  const preflight = await preflightDraftlineIncoming(remote);
  if (!isCurrent()) return { kind: "cancelled" };
  const status = { ahead: preflight.syncStatus.ahead, behind: preflight.syncStatus.behind };
  if (preflight.dirtyFiles.length > 0) return { kind: "blocked", message: SAVE_BEFORE_UPDATES_MESSAGE, status };
  if (preflight.canProceed) {
    if (status.behind === 0) return { kind: "none" };
    // Only the team moved: their saves simply become ours, no new version.
    await applyDraftlineIncoming(remote);
    return { kind: "brought-in", count: status.behind };
  }
  if (preflight.syncStatus.state !== "needsMerge") return { kind: "blocked", message: UPDATES_UNSAFE_MESSAGE, status };
  const report = await preflightDraftlineMergeIncoming(remote);
  return isCurrent() ? settle(report, remote, isCurrent) : { kind: "cancelled" };
}

async function settle(
  report: DraftlineMergeIncomingReport,
  remote: string,
  isCurrent: () => boolean,
): Promise<TeamUpdateOutcome> {
  const status = { ahead: report.syncStatus.ahead, behind: report.syncStatus.behind };
  const count = report.incoming.length || status.behind;
  if (report.dirtyFiles.length > 0) return { kind: "blocked", message: SAVE_BEFORE_UPDATES_MESSAGE, status };
  if (report.canMergeCleanly && report.token) {
    // Interim until Draftline's rebase_onto_incoming: a token-pinned merge with
    // a generated name. The rebase will replay the user's saves on top instead,
    // so history shows only versions people named themselves.
    await mergeDraftlineIncomingWithToken(report.token, teamUpdatesLabel(report.incoming), remote);
    return isCurrent() ? { kind: "brought-in", count } : { kind: "cancelled" };
  }
  if (report.conflicts.length > 0 && report.token) {
    useVersioningStore.setState({
      isMerging: true,
      mergeSource: TEAM_UPDATES_SOURCE,
      mergeTarget: "incoming",
      mergeConflicts: report.conflicts,
      draftlineMergeToken: report.token,
      draftlineMergeRemote: remote,
      draftlineMergeIncoming: report.incoming,
    });
    return { kind: "conflict", count, status };
  }
  if (status.behind === 0) return { kind: "none" };
  return { kind: "blocked", message: UPDATES_UNSAFE_MESSAGE, status };
}
