// Typed wrappers for workspace folder helpers used by the home screen.
import { invoke } from "../services/tauri";

export const workspaceIpc = {
  /** The parent folder last used to create, clone or open a workspace, if any. */
  lastParentFolder: () => invoke<string | null>("get_last_parent_folder"),
  /** Clones `url` into `dest`; resolves to the folder Draftline opened (the managed folder in a hybrid repo). */
  cloneFromUrl: (url: string, dest: string) => invoke<string>("clone_from_url", { url, dest }),
  /** Clones without claiming the repo; `managedFolder` is set when the repo already has a `.draftline` marker. */
  cloneRepositoryForProject: (url: string, dest: string) =>
    invoke<ClonedRepository>("clone_repository_for_project", { url, dest }),
  /** The path of a new folder `name` inside `root`; rejects with `file_exists` if it is taken. */
  reserveProjectFolder: (root: string, name: string) =>
    invoke<string>("reserve_project_folder", { root, name }),
};

export interface ClonedRepository {
  root: string;
  managedFolder: string | null;
}

export type ImportConflict = "overwrite" | "rename";

/** Commands that import an outside document into the open project as a note. */
export type NoteImportCommand = "import_pptx" | "import_docx" | "import_pdf" | "import_markdown";

export const importIpc = {
  /** Imports `filePath` as a note and returns the note's project-relative path. */
  toNote: (command: NoteImportCommand, filePath: string, conflict?: ImportConflict) =>
    invoke<string>(command, conflict ? { filePath, conflict } : { filePath }),
};
