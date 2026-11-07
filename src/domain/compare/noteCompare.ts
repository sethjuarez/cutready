import { diffSequence } from "./sequenceDiff";

export interface WordSegment {
  op: "equal" | "insert" | "delete";
  text: string;
}

export type NoteBlock =
  | { status: "equal"; text: string }
  | { status: "added"; text: string }
  | { status: "removed"; text: string }
  | { status: "moved"; text: string }
  | { status: "changed"; before: string; after: string; words: WordSegment[] };

export interface NoteComparison {
  blocks: NoteBlock[];
}

export type BlockUnit = "paragraph" | "line";

/**
 * Paragraphs are blank-line separated, trimmed, and keyed with whitespace
 * normalized so reflowing doesn't count. Lines are exact, blank ones included,
 * so indentation and spacing changes show.
 */
function blocksOf(text: string, unit: BlockUnit): Array<{ text: string; key: string }> {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (unit === "line") {
    if (!normalized) return [];
    return normalized.replace(/\n$/, "").split("\n").map((line) => ({ text: line, key: line }));
  }
  return normalized
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({ text: block, key: block.replace(/\s+/g, " ") }));
}

const isSpace = (token: string) => /^\s/.test(token);
const sameToken = (a: string, b: string) => a === b || (isSpace(a) && isSpace(b));

/** Word-level diff of two blocks; whitespace runs match each other so reflowing doesn't count. */
export function diffWords(before: string, after: string): WordSegment[] {
  const a = before.match(/\S+|\s+/g) ?? [];
  const b = after.match(/\S+|\s+/g) ?? [];
  const segments: WordSegment[] = [];
  const push = (op: WordSegment["op"], text: string) => {
    const last = segments[segments.length - 1];
    if (last?.op === op) last.text += text;
    else segments.push({ op, text });
  };
  for (const step of diffSequence(a, b, sameToken)) {
    if (step.op === "equal") push("equal", b[step.b]);
    else if (step.op === "delete") push("delete", a[step.a]);
    else push("insert", b[step.b]);
  }
  return segments;
}

/**
 * Paragraph diff of two markdown notes. A paragraph that only changed place
 * shows once, where it landed, as moved. Inside each changed run, removed and
 * added paragraphs pair up in order as edits with a word diff; the surplus
 * counts as added or removed. A missing side reads as an empty note. Plain
 * text compares line by line instead.
 */
export function compareNote(
  beforeText: string | null | undefined,
  afterText: string | null | undefined,
  unit: BlockUnit = "paragraph",
): NoteComparison {
  const a = blocksOf(beforeText ?? "", unit);
  const b = blocksOf(afterText ?? "", unit);
  const script = diffSequence(a, b, (x, y) => x.key === y.key);

  // Paragraphs both deleted and inserted somewhere are moves; budget them per key.
  const deleted = new Map<string, number>();
  const inserted = new Map<string, number>();
  for (const step of script) {
    if (step.op === "delete") deleted.set(a[step.a].key, (deleted.get(a[step.a].key) ?? 0) + 1);
    else if (step.op === "insert") inserted.set(b[step.b].key, (inserted.get(b[step.b].key) ?? 0) + 1);
  }
  const movedOut = new Map<string, number>();
  for (const [key, count] of deleted) movedOut.set(key, Math.min(count, inserted.get(key) ?? 0));
  const movedIn = new Map(movedOut);
  const take = (budget: Map<string, number>, key: string) => {
    const left = budget.get(key) ?? 0;
    if (left > 0) budget.set(key, left - 1);
    return left > 0;
  };

  const blocks: NoteBlock[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const paired = Math.min(removed.length, added.length);
    for (let i = 0; i < paired; i += 1) {
      blocks.push({ status: "changed", before: removed[i], after: added[i], words: diffWords(removed[i], added[i]) });
    }
    for (const text of removed.slice(paired)) blocks.push({ status: "removed", text });
    for (const text of added.slice(paired)) blocks.push({ status: "added", text });
    removed = [];
    added = [];
  };
  for (const step of script) {
    if (step.op === "equal") {
      flush();
      blocks.push({ status: "equal", text: b[step.b].text });
    } else if (step.op === "delete") {
      if (!take(movedOut, a[step.a].key)) removed.push(a[step.a].text);
    } else if (take(movedIn, b[step.b].key)) {
      flush();
      blocks.push({ status: "moved", text: b[step.b].text });
    } else added.push(b[step.b].text);
  }
  flush();
  return { blocks };
}
const countWords = (text: string) => (text.match(/\S+/g) ?? []).length;

/** Words added and removed across the comparison. */
export function noteWordCounts(comparison: NoteComparison): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const block of comparison.blocks) {
    if (block.status === "added") added += countWords(block.text);
    else if (block.status === "removed") removed += countWords(block.text);
    else if (block.status === "changed") {
      for (const segment of block.words) {
        if (segment.op === "insert") added += countWords(segment.text);
        else if (segment.op === "delete") removed += countWords(segment.text);
      }
    }
  }
  return { added, removed };
}
