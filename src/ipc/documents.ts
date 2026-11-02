// Typed document reads and saves (architecture v3 §4.13). services/documentSaves
// calls these: every app save carries the version and text of the document the
// editor was synced to, and every result comes back versioned.
import { invoke } from "../services/tauri";

export type DocumentKind = "sketch" | "storyboard" | "note";

/** Commands that save an open document; each takes `expectedVersion` and `base`. */
export type DocumentSaveCommand =
  | "update_sketch"
  | "update_sketch_title"
  | "set_sketch_lock"
  | "set_planning_row_lock"
  | "set_planning_cell_lock"
  | "update_storyboard"
  | "set_storyboard_lock"
  | "add_sketch_to_storyboard"
  | "remove_sketch_from_storyboard"
  | "add_section_to_storyboard"
  | "reorder_storyboard_items"
  | "update_note";

/** A document text and its version (SHA-256 of the file bytes). */
export interface SyncedDocument {
  content: string;
  version: string;
}

/** A read or committed document: the model, its exact file text, and its version. */
export interface Versioned<T> extends SyncedDocument {
  document: T;
  /** Whether the save was merged onto changes made since its base. */
  merged: boolean;
  /** For a merged save, the save's own document: what the editor holds. */
  synced?: SyncedDocument;
}

export const documentsIpc = {
  read: <T>(kind: DocumentKind, relativePath: string) =>
    kind === "sketch"
      ? invoke<Versioned<T>>("get_sketch_versioned", { relativePath })
      : kind === "storyboard"
        ? invoke<Versioned<T>>("get_storyboard_versioned", { relativePath })
        : invoke<Versioned<T>>("get_note_versioned", { relativePath }),
  save: <T>(command: DocumentSaveCommand, args: Record<string, unknown>) => invoke<Versioned<T>>(command, args),
  createCopy: (relativePath: string, content: string) =>
    invoke<Versioned<string>>("create_document_copy", { relativePath, content }),
};
