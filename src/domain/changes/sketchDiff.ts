import { changedFields, movedKeys, parseJsonObject } from "./parse";
import type { SketchChanges, SketchRowChange } from "./types";

const SKETCH_FIELDS = ["title", "description", "state", "locked", "metadata"];

type Row = Record<string, unknown>;

function rowsOf(doc: Record<string, unknown>): Row[] {
  return Array.isArray(doc.rows) ? doc.rows.filter((row): row is Row => !!row && typeof row === "object") : [];
}

/**
 * Rows keyed by stable id. Legacy rows without an id fall back to their index,
 * on a key that can't collide with a real id. Null when ids repeat, since the
 * diff can't tell which duplicate is which.
 */
function keyedRows(rows: Row[]): Map<string, Row> | null {
  const keyed = new Map<string, Row>();
  rows.forEach((row, index) => {
    const key = typeof row.id === "string" && row.id ? row.id : `\u0000${index}`;
    keyed.set(key, row);
  });
  return keyed.size === rows.length ? keyed : null;
}

const displayId = (key: string) => (key.startsWith("\u0000") ? `#${key.slice(1)}` : key);

function rowFieldChanges(before: Row, after: Row): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("id");
  return changedFields(before, after, [...keys].sort());
}

/** Row-level changes between two sketch files, keyed by planning row id. Null when either side won't parse. */
export function diffSketch(beforeText: string | null | undefined, afterText: string | null | undefined): SketchChanges | null {
  const before = parseJsonObject(beforeText);
  const after = parseJsonObject(afterText);
  if (!before || !after) return null;
  const beforeRows = keyedRows(rowsOf(before));
  const afterRows = keyedRows(rowsOf(after));
  if (!beforeRows || !afterRows) return null;

  const rowsChanged: SketchRowChange[] = [];
  let rowsAdded = 0;
  for (const [key, row] of afterRows) {
    const previous = beforeRows.get(key);
    if (!previous) {
      rowsAdded += 1;
      continue;
    }
    const fields = rowFieldChanges(previous, row);
    if (fields.length > 0) rowsChanged.push({ id: displayId(key), fields });
  }

  return {
    rowsAdded,
    rowsRemoved: [...beforeRows.keys()].filter((key) => !afterRows.has(key)).length,
    rowsChanged,
    rowsMoved: movedKeys([...beforeRows.keys()], [...afterRows.keys()]).size,
    fields: changedFields(before, after, SKETCH_FIELDS),
  };
}

export function sketchHasChanges(changes: SketchChanges): boolean {
  return (
    changes.rowsAdded + changes.rowsRemoved + changes.rowsChanged.length + changes.rowsMoved + changes.fields.length > 0
  );
}
