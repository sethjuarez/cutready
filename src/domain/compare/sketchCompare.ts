import { changedFields, parseJsonObject } from "../changes/parse";
import { diffSequence } from "./sequenceDiff";

export const SKETCH_FIELDS = ["title", "description", "state", "locked", "metadata"] as const;

export type SketchRow = Record<string, unknown>;

export interface SketchRowDiff {
  /** Row id, or `\0index` for legacy rows without one. */
  key: string;
  status: "added" | "removed" | "changed" | "unchanged";
  /** Kept on both sides but its order relative to other rows changed. */
  moved: boolean;
  before: SketchRow | null;
  after: SketchRow | null;
  /** Fields that differ, for changed rows. */
  fields: string[];
}

export interface SketchComparison {
  /** Rows in display order: the after order, with removed rows where they used to be. */
  rows: SketchRowDiff[];
  /** Changed top-level fields such as title or description. */
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export function rowsOf(doc: Record<string, unknown>): SketchRow[] {
  return Array.isArray(doc.rows) ? doc.rows.filter((row): row is SketchRow => !!row && typeof row === "object") : [];
}

/**
 * Rows keyed by stable id. Legacy rows without an id fall back to their index,
 * on a key that can't collide with a real id. Null when ids repeat, since the
 * diff can't tell which duplicate is which.
 */
export function keyedRows(rows: SketchRow[]): Map<string, SketchRow> | null {
  const keyed = new Map<string, SketchRow>();
  rows.forEach((row, index) => {
    const key = typeof row.id === "string" && row.id ? row.id : `\u0000${index}`;
    keyed.set(key, row);
  });
  return keyed.size === rows.length ? keyed : null;
}

export const displayRowId = (key: string) => (key.startsWith("\u0000") ? `#${key.slice(1)}` : key);

export function rowFieldChanges(before: SketchRow, after: SketchRow): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("id");
  return changedFields(before, after, [...keys].sort());
}

/** Empty or missing text reads as an empty sketch; malformed text is null. */
function sketchOf(text: string | null | undefined): Record<string, unknown> | null {
  return text ? parseJsonObject(text) : {};
}

/**
 * Row-by-row comparison of two sketch files, keyed by planning row id. A
 * missing side reads as an empty sketch. Null when either side is malformed or
 * repeats a row id.
 */
export function compareSketch(beforeText: string | null | undefined, afterText: string | null | undefined): SketchComparison | null {
  const before = sketchOf(beforeText);
  const after = sketchOf(afterText);
  if (!before || !after) return null;
  const beforeRows = keyedRows(rowsOf(before));
  const afterRows = keyedRows(rowsOf(after));
  if (!beforeRows || !afterRows) return null;

  const beforeKeys = [...beforeRows.keys()];
  const afterKeys = [...afterRows.keys()];
  const kept = (key: string, previous: SketchRow, row: SketchRow, moved: boolean): SketchRowDiff => {
    const fields = rowFieldChanges(previous, row);
    return { key, status: fields.length ? "changed" : "unchanged", moved, before: previous, after: row, fields };
  };

  const rows: SketchRowDiff[] = [];
  for (const step of diffSequence(beforeKeys, afterKeys)) {
    if (step.op === "equal") {
      const key = afterKeys[step.b];
      rows.push(kept(key, beforeRows.get(key)!, afterRows.get(key)!, false));
    } else if (step.op === "delete") {
      const key = beforeKeys[step.a];
      // A row outside the common order shows where it landed, flagged as moved.
      if (!afterRows.has(key)) rows.push({ key, status: "removed", moved: false, before: beforeRows.get(key)!, after: null, fields: [] });
    } else {
      const key = afterKeys[step.b];
      const previous = beforeRows.get(key);
      rows.push(previous ? kept(key, previous, afterRows.get(key)!, true) : { key, status: "added", moved: false, before: null, after: afterRows.get(key)!, fields: [] });
    }
  }
  return { rows, fields: changedFields(before, after, SKETCH_FIELDS), before, after };
}
