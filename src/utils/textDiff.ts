/**
 * Lightweight word-level text diff for comparing planning row fields.
 * Uses a simple LCS (longest common subsequence) approach on word arrays.
 * No external dependencies.
 */

export type DiffSegment =
  | { type: "equal"; text: string }
  | { type: "added"; text: string }
  | { type: "removed"; text: string };

/**
 * Compute a word-level diff between two strings.
 * Returns an array of segments marked as equal, added, or removed.
 */
export function wordDiff(oldText: string, newText: string): DiffSegment[] {
  if (oldText === newText) return [{ type: "equal", text: oldText }];
  if (!oldText) return [{ type: "added", text: newText }];
  if (!newText) return [{ type: "removed", text: oldText }];

  const oldWords = tokenize(oldText);
  const newWords = tokenize(newText);

  // Build LCS table
  const m = oldWords.length;
  const n = newWords.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff segments
  const segments: DiffSegment[] = [];
  let i = m;
  let j = n;

  // Collect in reverse, then flip
  const raw: DiffSegment[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      raw.push({ type: "equal", text: oldWords[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: "added", text: newWords[j - 1] });
      j--;
    } else {
      raw.push({ type: "removed", text: oldWords[i - 1] });
      i--;
    }
  }

  raw.reverse();

  // Merge consecutive segments of the same type
  for (const seg of raw) {
    const last = segments[segments.length - 1];
    if (last && last.type === seg.type) {
      last.text += " " + seg.text;
    } else {
      segments.push({ ...seg });
    }
  }

  return segments;
}

/** Split text into word tokens, preserving meaningful whitespace boundaries. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

/** Per-field diff result for a planning row. */
export interface RowFieldDiff {
  field: string;
  segments: DiffSegment[];
}

/** All field diffs for a single row. */
export interface RowDiff {
  rowIndex: number;
  fields: RowFieldDiff[];
}

/**
 * Compare two row objects and return diffs for changed text fields.
 * Only includes fields that actually changed.
 */
export function diffRow(
  oldRow: Record<string, unknown> | { [key: string]: unknown },
  newRow: Record<string, unknown> | { [key: string]: unknown },
  rowIndex: number,
): RowDiff | null {
  const old_ = oldRow as Record<string, unknown>;
  const new_ = newRow as Record<string, unknown>;
  const textFields = ["time", "narrative", "demo_actions"];
  const fields: RowFieldDiff[] = [];

  for (const field of textFields) {
    const oldVal = String(old_[field] ?? "");
    const newVal = String(new_[field] ?? "");
    if (oldVal !== newVal) {
      fields.push({ field, segments: wordDiff(oldVal, newVal) });
    }
  }

  // Note visual/screenshot changes without inline diff
  if (String(old_.visual ?? "") !== String(new_.visual ?? "")) {
    fields.push({
      field: "visual",
      segments: [{ type: "added", text: new_.visual ? "Visual updated" : "Visual removed" }],
    });
  }
  if (String(old_.screenshot ?? "") !== String(new_.screenshot ?? "")) {
    fields.push({
      field: "screenshot",
      segments: [{ type: "added", text: new_.screenshot ? "Screenshot updated" : "Screenshot removed" }],
    });
  }

  return fields.length > 0 ? { rowIndex, fields } : null;
}
