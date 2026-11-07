import type { NoteChanges } from "./types";

/** Paragraphs are blank-line separated blocks, whitespace-normalized. */
export function paragraphsOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Multiset difference: items of `a` not matched in `b`. */
function unmatched(a: readonly string[], b: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const item of b) counts.set(item, (counts.get(item) ?? 0) + 1);
  const rest: string[] = [];
  for (const item of a) {
    const left = counts.get(item) ?? 0;
    if (left > 0) counts.set(item, left - 1);
    else rest.push(item);
  }
  return rest;
}

/**
 * Paragraph and word counts between two markdown notes. Removed and added
 * paragraphs are paired up as "changed" one-for-one; any surplus counts as
 * added or removed.
 */
export function diffNote(beforeText: string | null | undefined, afterText: string | null | undefined): NoteChanges {
  const before = paragraphsOf(beforeText ?? "");
  const after = paragraphsOf(afterText ?? "");
  const removed = unmatched(before, after);
  const added = unmatched(after, before);
  const paragraphsChanged = Math.min(removed.length, added.length);

  const beforeWords = words(removed.join(" "));
  const afterWords = words(added.join(" "));
  return {
    paragraphsAdded: added.length - paragraphsChanged,
    paragraphsRemoved: removed.length - paragraphsChanged,
    paragraphsChanged,
    wordsAdded: unmatched(afterWords, beforeWords).length,
    wordsRemoved: unmatched(beforeWords, afterWords).length,
  };
}

export function noteHasChanges(changes: NoteChanges): boolean {
  return changes.paragraphsAdded + changes.paragraphsRemoved + changes.paragraphsChanged > 0;
}
