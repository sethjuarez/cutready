// Document-aware change summaries, built on Draftline's file-level diffs.

export type DocumentKind = "sketch" | "storyboard" | "note" | "media" | "other";
export type MediaType = "image" | "video" | "audio" | "visual";
export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "conflicted";

/** One changed file as Draftline reports it, with optional before/after text. */
export interface FileChangeInput {
  path: string;
  status: FileStatus;
  /** Path before a rename, when known. */
  previousPath?: string;
  isBinary?: boolean;
  before?: string | null;
  after?: string | null;
}

export interface SketchRowChange {
  id: string;
  /** Changed fields (e.g. "narrative", "demo_actions", "screenshot"). */
  fields: string[];
}

export interface SketchChanges {
  rowsAdded: number;
  rowsRemoved: number;
  rowsChanged: SketchRowChange[];
  rowsMoved: number;
  /** Changed top-level fields such as title or description. */
  fields: string[];
}

export interface NoteChanges {
  paragraphsAdded: number;
  paragraphsRemoved: number;
  paragraphsChanged: number;
  wordsAdded: number;
  wordsRemoved: number;
}

export interface StoryboardChanges {
  sectionsAdded: string[];
  sectionsRemoved: string[];
  /** Sections whose description changed. */
  sectionsEdited: string[];
  sectionsMoved: number;
  sketchesAdded: string[];
  sketchesRemoved: string[];
  sketchesMoved: number;
  fields: string[];
}

export type DocumentDetail =
  | { kind: "sketch"; changes: SketchChanges }
  | { kind: "note"; changes: NoteChanges }
  | { kind: "storyboard"; changes: StoryboardChanges };

export interface DocumentChange {
  path: string;
  previousPath?: string;
  kind: DocumentKind;
  mediaType?: MediaType;
  status: FileStatus;
  /** Structured detail when both sides parsed; null for adds, deletes, conflicts, binaries or parse failures. */
  detail: DocumentDetail | null;
}

export interface ChangeTotals {
  documents: number;
  rowsAdded: number;
  rowsRemoved: number;
  rowsChanged: number;
  sketchesEdited: number;
  notesEdited: number;
  storyboardsEdited: number;
  mediaAdded: number;
  mediaRemoved: number;
  /** Media modified or renamed (e.g. an edited visual). */
  mediaChanged: number;
  conflicts: number;
  documentsAdded: number;
  documentsDeleted: number;
  documentsRenamed: number;
}

export interface ChangeSummary {
  documents: DocumentChange[];
  totals: ChangeTotals;
}
