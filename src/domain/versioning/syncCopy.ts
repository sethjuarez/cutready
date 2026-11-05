// Every sync message a user reads. Kept in one place so a test can hold it to
// plain language: no Git words (see syncCopy.test.ts).
import { teammates } from "./teamUpdates";

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const syncCopy = {
  upToDate: "Up to date",
  sending: "Sending…",
  checking: "Checking…",
  /** Check, Get updates and Send share one busy flag, so the pill stays neutral. */
  syncing: "Syncing…",
  notConnected: "Not connected",
  connected: "Connected",
  getUpdates: "Get updates",
  alreadyUpToDate: "Already up to date.",
  savesWaiting: (count: number) => `${plural(count, "save")} waiting to send`,
  teamHasUpdates: (count: number) => `Team has ${plural(count, "new update")}`,
  gotTeamUpdates: (count: number) => (count > 0 ? `Got ${plural(count, "team update")}.` : "Got the team's updates."),
  pickedUp: (count: number) => (count > 0 ? ` (also picked up ${plural(count, "team update")})` : ""),
  sent: (pickedUp = 0, forReview = false) =>
    `${forReview ? "Sent for review" : "Sent"} ✓${syncCopy.pickedUp(pickedUp)}`,
  /** Conflict panel title: "You and Dana both changed compass.sk". */
  conflictTitle: (authors: readonly string[], paths: readonly string[]) =>
    `You and ${teammates(authors)} both changed ${paths.length === 1 ? fileName(paths[0]) : plural(paths.length, "file")}`,
  conflict: (authors: readonly string[]) =>
    `You and ${teammates(authors)} changed the same thing. Choose what to keep.`,
  couldNotSend: "Couldn't check what still needs sending. Nothing was sent — try Send again.",
  moreTeamUpdates: "The team sent more updates while yours were coming in. Nothing was sent — try Send again.",
  needsAttention: "Sync needs attention",
  /** The one-line status pill: problems first, then what's coming in, then what's waiting to go out. */
  status: ({ error = false, ahead = 0, behind = 0 }: { error?: boolean; ahead?: number; behind?: number }) =>
    error ? syncCopy.needsAttention
      : behind > 0 ? syncCopy.teamHasUpdates(behind)
        : ahead > 0 ? syncCopy.savesWaiting(ahead)
          : syncCopy.upToDate,
  getSharedUpdates: "Get the shared project's updates",
  sharedTimelines: "Shared timelines",
  findingSharedTimelines: "Looking for shared timelines…",
  noSharedTimelines: (filter?: string) => (filter ? `No shared timelines match "${filter}"` : "No other shared timelines"),
  switchedToShared: (name: string) => `Switched to the shared timeline "${name}".`,
  sharedUpdates: (count: number) => `${plural(count, "update")} to the shared project`,
  sharedUpdatesNeedDeveloper:
    "The team's updates touch code outside this project. Ask a developer to bring them in.",
} as const;
