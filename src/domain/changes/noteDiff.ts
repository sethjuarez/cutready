import { compareNote, noteWordCounts } from "../compare/noteCompare";
import type { NoteChanges } from "./types";

/**
 * Paragraph and word counts between two markdown notes. Removed and added
 * paragraphs in the same spot pair up as "changed"; any surplus counts as
 * added or removed, and paragraphs that only moved don't count.
 */
export function diffNote(beforeText: string | null | undefined, afterText: string | null | undefined): NoteChanges {
  const comparison = compareNote(beforeText, afterText);
  const count = (status: string) => comparison.blocks.filter((block) => block.status === status).length;
  const words = noteWordCounts(comparison);
  return {
    paragraphsAdded: count("added"),
    paragraphsRemoved: count("removed"),
    paragraphsChanged: count("changed"),
    wordsAdded: words.added,
    wordsRemoved: words.removed,
  };
}

export function noteHasChanges(changes: NoteChanges): boolean {
  return changes.paragraphsAdded + changes.paragraphsRemoved + changes.paragraphsChanged > 0;
}
