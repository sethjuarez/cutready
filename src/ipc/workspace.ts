// Typed wrappers for workspace folder helpers used by the home screen.
import { invoke } from "../services/tauri";

export const workspaceIpc = {
  /** The parent folder last used to create, clone or open a workspace, if any. */
  lastParentFolder: () => invoke<string | null>("get_last_parent_folder"),
  cloneFromUrl: (url: string, dest: string) => invoke<void>("clone_from_url", { url, dest }),
};

export type ImportConflict = "overwrite" | "rename";

/** Commands that import an outside document into the open project as a note. */
export type NoteImportCommand = "import_pptx" | "import_docx" | "import_pdf" | "import_markdown";

export const importIpc = {
  /** Imports `filePath` as a note and returns the note's project-relative path. */
  toNote: (command: NoteImportCommand, filePath: string, conflict?: ImportConflict) =>
    invoke<string>(command, conflict ? { filePath, conflict } : { filePath }),
};
