import { documentKindOf, mediaTypeOf } from "./classify";
import { diffNote, noteHasChanges } from "./noteDiff";
import { diffSketch, sketchHasChanges } from "./sketchDiff";
import { diffStoryboard, storyboardHasChanges } from "./storyboardDiff";
import type { ChangeSummary, ChangeTotals, DocumentChange, DocumentDetail, FileChangeInput } from "./types";

const EMPTY_TOTALS: ChangeTotals = {
  documents: 0,
  rowsAdded: 0,
  rowsRemoved: 0,
  rowsChanged: 0,
  sketchesEdited: 0,
  notesEdited: 0,
  storyboardsEdited: 0,
  mediaAdded: 0,
  mediaRemoved: 0,
  mediaChanged: 0,
  conflicts: 0,
  documentsAdded: 0,
  documentsDeleted: 0,
  documentsRenamed: 0,
};

const hasEditsOnBothSides = (input: FileChangeInput) => input.status === "modified" || input.status === "renamed";

function detailFor(input: FileChangeInput, kind: DocumentChange["kind"]): DocumentDetail | null {
  if (!hasEditsOnBothSides(input) || input.isBinary || input.before == null || input.after == null) return null;
  if (kind === "sketch") {
    const changes = diffSketch(input.before, input.after);
    return changes ? { kind, changes } : null;
  }
  if (kind === "storyboard") {
    const changes = diffStoryboard(input.before, input.after);
    return changes ? { kind, changes } : null;
  }
  if (kind === "note") return { kind, changes: diffNote(input.before, input.after) };
  return null;
}

export function describeFile(input: FileChangeInput): DocumentChange {
  const kind = documentKindOf(input.path);
  const mediaType = kind === "media" ? (mediaTypeOf(input.path) ?? undefined) : undefined;
  return {
    path: input.path,
    ...(input.previousPath ? { previousPath: input.previousPath } : {}),
    kind,
    ...(mediaType ? { mediaType } : {}),
    status: input.status,
    detail: detailFor(input, kind),
  };
}

/** A modified file counts as edited unless parsing proved nothing changed; a rename only when its content changed too. */
function contentEdited(change: DocumentChange): boolean {
  const detail = change.detail;
  if (!detail) return change.status === "modified";
  if (detail.kind === "sketch") return sketchHasChanges(detail.changes);
  if (detail.kind === "storyboard") return storyboardHasChanges(detail.changes);
  return noteHasChanges(detail.changes);
}

function addToTotals(totals: ChangeTotals, change: DocumentChange): void {
  totals.documents += 1;
  if (change.status === "conflicted") {
    totals.conflicts += 1;
    return;
  }
  if (change.kind === "media") {
    if (change.status === "added") totals.mediaAdded += 1;
    else if (change.status === "deleted") totals.mediaRemoved += 1;
    else totals.mediaChanged += 1;
    return;
  }
  if (change.status === "added") totals.documentsAdded += 1;
  else if (change.status === "deleted") totals.documentsDeleted += 1;
  else if (change.status === "renamed") totals.documentsRenamed += 1;

  if (change.status !== "modified" && change.status !== "renamed") return;
  if (change.detail?.kind === "sketch") {
    totals.rowsAdded += change.detail.changes.rowsAdded;
    totals.rowsRemoved += change.detail.changes.rowsRemoved;
    totals.rowsChanged += change.detail.changes.rowsChanged.length;
  }
  if (!contentEdited(change)) return;
  if (change.kind === "sketch") totals.sketchesEdited += 1;
  else if (change.kind === "note") totals.notesEdited += 1;
  else if (change.kind === "storyboard") totals.storyboardsEdited += 1;
}

/** Combines per-file inputs into a document-aware summary. Pure: callers load the content. */
export function summarizeChanges(inputs: readonly FileChangeInput[]): ChangeSummary {
  const documents = inputs.map(describeFile);
  const totals = { ...EMPTY_TOTALS };
  for (const change of documents) addToTotals(totals, change);
  return { documents, totals };
}

/** The part of a summary that touches `path`, with totals recounted. */
export function summaryForPath(summary: ChangeSummary, path: string): ChangeSummary {
  const documents = summary.documents.filter((doc) => doc.path === path || doc.previousPath === path);
  const totals = { ...EMPTY_TOTALS };
  for (const change of documents) addToTotals(totals, change);
  return { documents, totals };
}

/**
 * Loads before/after text for one changed file. For a rename, read `before`
 * from `previousPath` when it's known. Return null text for binaries or
 * missing sides.
 */
export type ChangeContentLoader = (
  file: FileChangeInput,
) => Promise<{ before: string | null; after: string | null; isBinary: boolean } | null>;

const NEEDS_CONTENT = new Set(["sketch", "storyboard", "note"]);

/** Fetches content only for edited text documents, then summarizes. Load failures degrade to file-level detail. */
export async function loadChangeSummary(
  files: readonly FileChangeInput[],
  load: ChangeContentLoader,
): Promise<ChangeSummary> {
  const inputs = await Promise.all(
    files.map(async (file): Promise<FileChangeInput> => {
      if (!hasEditsOnBothSides(file) || !NEEDS_CONTENT.has(documentKindOf(file.path))) return file;
      try {
        const content = await load(file);
        return content ? { ...file, ...content } : file;
      } catch {
        return file;
      }
    }),
  );
  return summarizeChanges(inputs);
}
