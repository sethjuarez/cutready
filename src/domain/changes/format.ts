import { documentName } from "./classify";
import type { ChangeTotals, DocumentChange } from "./types";

export interface SummaryChip {
  id: "conflicts" | "rows" | "sketches" | "notes" | "storyboards" | "media" | "documents";
  label: string;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function joinParts(parts: string[]): string {
  return parts.filter(Boolean).join(", ");
}

/** Short chips for the status popover, most specific first. Empty when nothing changed. */
export function summaryChips(totals: ChangeTotals): SummaryChip[] {
  const chips: SummaryChip[] = [];
  if (totals.conflicts) chips.push({ id: "conflicts", label: plural(totals.conflicts, "conflict") });
  const rows = joinParts([
    totals.rowsAdded ? `+${plural(totals.rowsAdded, "row")}` : "",
    totals.rowsRemoved ? `−${plural(totals.rowsRemoved, "row")}` : "",
    totals.rowsChanged ? `${plural(totals.rowsChanged, "row")} edited` : "",
  ]);
  if (rows) chips.push({ id: "rows", label: rows });
  if (totals.sketchesEdited) chips.push({ id: "sketches", label: `${plural(totals.sketchesEdited, "sketch", "sketches")} edited` });
  if (totals.storyboardsEdited) chips.push({ id: "storyboards", label: `${plural(totals.storyboardsEdited, "storyboard")} edited` });
  if (totals.notesEdited) chips.push({ id: "notes", label: `${plural(totals.notesEdited, "note")} edited` });
  const media = joinParts([
    totals.mediaAdded ? `+${plural(totals.mediaAdded, "media file")}` : "",
    totals.mediaRemoved ? `−${plural(totals.mediaRemoved, "media file")}` : "",
    totals.mediaChanged ? `${plural(totals.mediaChanged, "media file")} changed` : "",
  ]);
  if (media) chips.push({ id: "media", label: media });
  const documents = joinParts([
    totals.documentsAdded ? `${totals.documentsAdded} added` : "",
    totals.documentsDeleted ? `${totals.documentsDeleted} deleted` : "",
    totals.documentsRenamed ? `${totals.documentsRenamed} renamed` : "",
  ]);
  if (documents) chips.push({ id: "documents", label: `Documents: ${documents}` });
  return chips;
}

/** One-line description of a document's change for the per-document list. */
export function describeChange(change: DocumentChange): string {
  if (change.status === "conflicted") return "Conflicted";
  if (change.status === "added") return "Added";
  if (change.status === "deleted") return "Deleted";
  const renamed = change.status === "renamed" && change.previousPath ? `Renamed from ${documentName(change.previousPath)}` : "";
  const detail = describeDetail(change);
  return joinParts([renamed, detail]) || (change.status === "renamed" ? "Renamed" : "Edited");
}

function describeDetail(change: DocumentChange): string {
  const detail = change.detail;
  if (!detail) return "";
  if (detail.kind === "sketch") {
    const c = detail.changes;
    return joinParts([
      c.rowsAdded ? `+${plural(c.rowsAdded, "row")}` : "",
      c.rowsRemoved ? `−${plural(c.rowsRemoved, "row")}` : "",
      c.rowsChanged.length ? `${plural(c.rowsChanged.length, "row")} edited` : "",
      c.rowsMoved ? `${plural(c.rowsMoved, "row")} moved` : "",
      c.fields.includes("title") ? "title" : "",
      c.fields.includes("description") ? "description" : "",
    ]);
  }
  if (detail.kind === "storyboard") {
    const c = detail.changes;
    return joinParts([
      c.sectionsAdded.length ? `+${plural(c.sectionsAdded.length, "section")}` : "",
      c.sectionsRemoved.length ? `−${plural(c.sectionsRemoved.length, "section")}` : "",
      c.sectionsEdited.length ? `${plural(c.sectionsEdited.length, "section")} edited` : "",
      c.sectionsMoved ? `${plural(c.sectionsMoved, "section")} moved` : "",
      c.sketchesAdded.length ? `+${plural(c.sketchesAdded.length, "sketch", "sketches")}` : "",
      c.sketchesRemoved.length ? `−${plural(c.sketchesRemoved.length, "sketch", "sketches")}` : "",
      c.sketchesMoved ? `${plural(c.sketchesMoved, "sketch", "sketches")} moved` : "",
      c.fields.includes("title") ? "title" : "",
    ]);
  }
  const c = detail.changes;
  return joinParts([
    c.paragraphsAdded ? `+${plural(c.paragraphsAdded, "paragraph")}` : "",
    c.paragraphsRemoved ? `−${plural(c.paragraphsRemoved, "paragraph")}` : "",
    c.paragraphsChanged ? `${plural(c.paragraphsChanged, "paragraph")} edited` : "",
    c.wordsAdded ? `+${plural(c.wordsAdded, "word")}` : "",
    c.wordsRemoved ? `−${plural(c.wordsRemoved, "word")}` : "",
  ]);
}
