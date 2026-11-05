import type { IncomingVersion } from "./mergeSuggest";

/** The name every automatic "bring in what the team sent" version gets. */
export const TEAM_UPDATES_NAME = "Brought in team updates";

const MAX_LISTED = 20;
const MAX_LINE_CHARS = 120;

function flat(text: string, max = MAX_LINE_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One incoming save as a list line: "#24 lead queue (Dana)". */
export function teamUpdateLine(version: IncomingVersion): string {
  const name = flat(version.name) || "Untitled save";
  const author = version.author ? flat(version.author, 60) : "";
  return author ? `${name} (${author})` : name;
}

/**
 * The version label for an automatic team-update merge: the plain name, then
 * the incoming saves as the comment so history can show what came in.
 */
export function teamUpdatesLabel(incoming: readonly IncomingVersion[]): string {
  const listed = incoming.slice(0, MAX_LISTED).map((version) => `- ${teamUpdateLine(version)}`);
  const more = incoming.length - listed.length;
  if (more > 0) listed.push(`- …and ${more} more`);
  return listed.length > 0 ? `${TEAM_UPDATES_NAME}\n\n${listed.join("\n")}` : TEAM_UPDATES_NAME;
}

// A repository's commit template may put a short prefix ("[CutReady] ") before the name.
const GENERATED_NAME = /^(?:.{0,40}?[\s\]:)>-])?\s*(Brought in team updates|Merge updates(?: from \S+)?)$/;

/**
 * Which kind of generated name a version has, if any: the current
 * "Brought in team updates" (whose comment lists what came in) or an older
 * prefilled "Merge updates from …" (whose comment the person may have typed).
 */
export function teamUpdatesNameKind(name: string): "current" | "legacy" | null {
  const match = GENERATED_NAME.exec(name.split(/\r?\n/, 1)[0].trim());
  if (!match) return null;
  return match[1] === TEAM_UPDATES_NAME ? "current" : "legacy";
}

/** Whether a version name was generated for bringing in other people's work rather than typed by someone. */
export function isTeamUpdatesName(name: string): boolean {
  return teamUpdatesNameKind(name) !== null;
}

/**
 * What a team-update version brought in, read back from its comment's list:
 * the listed lines plus how many more were left off.
 */
export function teamUpdatesFromComment(comment: string | null | undefined): { lines: string[]; more: number } {
  const lines: string[] = [];
  let more = 0;
  for (const raw of comment?.split(/\r?\n/) ?? []) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const extra = /^- …and (\d+) more$/.exec(line);
    if (extra) more += Number(extra[1]);
    else lines.push(line.slice(2).trim());
  }
  return { lines, more };
}

/** One-line summary for a history row: "#24 lead queue (Dana) and 2 more". */
export function teamUpdatesSummary(comment: string | null | undefined): string | null {
  const { lines, more } = teamUpdatesFromComment(comment);
  if (lines.length === 0) return null;
  const rest = lines.length - 1 + more;
  return rest > 0 ? `${lines[0]} and ${rest} more` : lines[0];
}

/**
 * A version's name, comment and incoming list as people should read them.
 * Only versions that combined two lines of work (`isMerge`) with a generated
 * name are renamed; a legacy name keeps whatever comment it has.
 */
export function plainVersion(
  message: string,
  comment: string | null | undefined,
  isMerge: boolean,
): { name: string; comment: string; teamUpdates: string[] } {
  const name = message.split(/\r?\n/, 1)[0].trim();
  const kind = isMerge ? teamUpdatesNameKind(name) : null;
  if (kind === null) return { name, comment: comment ?? "", teamUpdates: [] };
  if (kind === "legacy") return { name: TEAM_UPDATES_NAME, comment: comment ?? "", teamUpdates: [] };
  const { lines, more } = teamUpdatesFromComment(comment);
  return {
    name: TEAM_UPDATES_NAME,
    comment: teamUpdatesSummary(comment) ?? "",
    teamUpdates: more > 0 ? [...lines, `…and ${more} more`] : lines,
  };
}

/** Distinct, non-empty authors of the incoming saves, in order. */
export function incomingAuthors(incoming: readonly IncomingVersion[]): string[] {
  return [...new Set(incoming.map((version) => version.author?.trim() ?? "").filter(Boolean))];
}

/** "Dana", "Dana and Lee", "Dana, Lee and 2 others"; "a teammate" when unknown. */
export function teammates(authors: readonly string[]): string {
  if (authors.length === 0) return "a teammate";
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} and ${authors[1]}`;
  const others = authors.length - 2;
  return `${authors[0]}, ${authors[1]} and ${others} ${others === 1 ? "other" : "others"}`;
}
