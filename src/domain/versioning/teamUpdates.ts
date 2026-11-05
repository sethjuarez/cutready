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

/**
 * Whether a version name was generated for bringing in other people's work,
 * rather than typed by someone: the current name or the older prefilled
 * "Merge updates from …" names.
 */
export function isTeamUpdatesName(name: string): boolean {
  const first = name.split(/\r?\n/, 1)[0].trim();
  return first === TEAM_UPDATES_NAME || /^Merge updates( from .+)?$/.test(first);
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
