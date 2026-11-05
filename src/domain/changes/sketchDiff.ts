import { compareSketch, displayRowId } from "../compare/sketchCompare";
import { parseJsonObject } from "./parse";
import type { SketchChanges } from "./types";

/** Row-level changes between two sketch files, keyed by planning row id. Null when either side won't parse. */
export function diffSketch(beforeText: string | null | undefined, afterText: string | null | undefined): SketchChanges | null {
  if (!parseJsonObject(beforeText) || !parseJsonObject(afterText)) return null;
  const comparison = compareSketch(beforeText, afterText);
  if (!comparison) return null;
  const count = (status: string) => comparison.rows.filter((row) => row.status === status).length;
  return {
    rowsAdded: count("added"),
    rowsRemoved: count("removed"),
    rowsChanged: comparison.rows.filter((row) => row.status === "changed").map((row) => ({ id: displayRowId(row.key), fields: row.fields })),
    rowsMoved: comparison.rows.filter((row) => row.moved).length,
    fields: comparison.fields,
  };
}

export function sketchHasChanges(changes: SketchChanges): boolean {
  return (
    changes.rowsAdded + changes.rowsRemoved + changes.rowsChanged.length + changes.rowsMoved + changes.fields.length > 0
  );
}
