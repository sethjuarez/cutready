// Bringing the team's sent work into this project without asking the user to
// name anything. Only a real conflict needs them; everything else is silent.
import {
  applyDraftlineIncoming,
  mergeDraftlineIncomingWithToken,
  preflightDraftlineIncoming,
  preflightDraftlineMergeBase,
  preflightDraftlineMergeIncoming,
  preflightDraftlineRebaseIncoming,
  rebaseDraftlineIncoming,
  type DraftlineMergeIncomingReport,
} from "./draftlineVersioning";
import { teamUpdatesLabel, usesConventionalNames } from "../domain/versioning/teamUpdates";
import { rebasedIds } from "../domain/versioning/rebaseRemap";
import { draftlineErrorCode } from "./draftlineErrors";
import { applyRebasedIds } from "./rebaseRemap";
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
  const replayed = await replayUnsentSaves(remote, isCurrent);
  if (replayed) return replayed;
  if (!isCurrent()) return { kind: "cancelled" };
  const report = await preflightDraftlineMergeIncoming(remote);
  return isCurrent() ? settle(report, remote, isCurrent) : { kind: "cancelled" };
}

/** Refusals after which combining the work with a named version still can. */
const MERGE_INSTEAD = new Set(["incoming_conflicts", "versions_already_shared", "rebase_unsupported", "preflight_failed", "versions_on_other_timelines"]);

/**
 * Brings the team's work in by replaying the unsent saves on top of it, so no
 * extra version is made. Returns null when the work has to be combined
 * instead: files changed on both sides, saves another timeline also holds
 * (replaying would leave that timeline on the old copies), or history the
 * replay doesn't support. Every refusal leaves the project as it was.
 */
async function replayUnsentSaves(remote: string, isCurrent: () => boolean): Promise<TeamUpdateOutcome | null> {
  const report = await preflightDraftlineRebaseIncoming(remote);
  if (!isCurrent()) return { kind: "cancelled" };
  if (!report.can_rebase) return null;
  try {
    const rebase = await rebaseDraftlineIncoming(remote);
    // Another project is open now, so these tabs aren't the old project's. The
    // old copies of the replayed saves still exist, so its own tabs keep working.
    if (!isCurrent()) return { kind: "cancelled" };
    applyRebasedIds(rebasedIds(rebase.rewritten, rebase.dropped));
    return { kind: "brought-in", count: rebase.incoming.length };
  } catch (error) {
    if (MERGE_INSTEAD.has(draftlineErrorCode(error) ?? "")) return null;
    throw error;
  }
}

/** Whether people in this repository name versions the conventional way ("feat: …"). */
function conventionalRepository(report: DraftlineMergeIncomingReport): boolean {
  const names = [
    ...report.incoming.map((version) => version.name),
    ...useVersioningStore.getState().graphNodes.map((node) => node.message),
  ];
  return usesConventionalNames(names);
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
    // The replay couldn't run, so the work is combined in a version with a generated name.
    const label = teamUpdatesLabel(report.incoming, conventionalRepository(report));
    await mergeDraftlineIncomingWithToken(report.token, label, remote);
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
