import { documentName, describeChange, summaryChips, type ChangeSummary } from "../changes";
import { clampVersionName } from "./versionName";

export interface VersionSuggestion {
  name: string;
  comment: string;
}

const MAX_LISTED_DOCUMENTS = 40;

const SYSTEM_PROMPT = `You name versions of a presentation project (storyboards, sketches, notes and media).
Given a summary of unsaved changes, reply with JSON only: {"name": "...", "comment": "..."}.
- name: what changed, in plain words, at most 60 characters, no trailing period, no Git terms.
- comment: one to three short sentences with the useful detail, or "" if the name says it all.`;

/** The change summary as plain text for the model. */
export function describeSummaryForPrompt(summary: ChangeSummary): string {
  const lines = summaryChips(summary.totals).map((chip) => `- ${chip.label}`);
  const docs = summary.documents.slice(0, MAX_LISTED_DOCUMENTS).map(
    (doc) => `- ${doc.kind} "${documentName(doc.path)}": ${describeChange(doc)}`,
  );
  const more = summary.documents.length - docs.length;
  if (more > 0) docs.push(`- …and ${more} more`);
  return [`Totals:`, ...lines, ``, `Documents:`, ...docs].join("\n");
}

export function suggestionMessages(summary: ChangeSummary) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: describeSummaryForPrompt(summary) },
  ];
}

/** Reads the model's reply; tolerates code fences and prose around the JSON. Null when unusable. */
export function parseSuggestion(reply: string | null | undefined): VersionSuggestion | null {
  if (!reply) return null;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as { name?: unknown; comment?: unknown };
    const name = typeof parsed.name === "string" ? clampVersionName(parsed.name) : "";
    if (!name) return null;
    const comment = typeof parsed.comment === "string" ? parsed.comment.trim() : "";
    return { name, comment };
  } catch {
    return null;
  }
}

export type SuggestFill =
  /** Nothing typed: fill in place. */
  | { kind: "fill"; name: string; comment: string }
  /** The user typed something: ask "Replace?" first. */
  | { kind: "confirm"; name: string; comment: string };

/** Suggestions fill empty fields; replacing typed text needs a confirmation. */
export function applySuggestion(
  current: { name: string; comment: string },
  suggestion: VersionSuggestion,
  /** Text Suggest itself last filled in, which may be replaced without asking. */
  lastSuggested: { name: string; comment: string } | null,
): SuggestFill {
  const typed = (value: string, previous: string | undefined) => value.trim() !== "" && value !== previous;
  const userTyped = typed(current.name, lastSuggested?.name) || typed(current.comment, lastSuggested?.comment);
  return { kind: userTyped ? "confirm" : "fill", name: suggestion.name, comment: suggestion.comment };
}
