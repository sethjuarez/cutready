// Typed wrappers for workspace folder helpers used by the home screen, and for importing files.
import { Channel, invoke } from "../services/tauri";
import type { buildProviderConfig } from "../utils/providerConfig";
import type {
  ClonedRepository,
  CloneProgressEvent,
  InitProjectInRepositoryResult,
  ProjectSettings,
  RepositoryInspection,
} from "@draftline/client";

export const workspaceIpc = {
  /** The parent folder last used to create, clone or open a workspace, if any. */
  lastParentFolder: () => invoke<string | null>("get_last_parent_folder"),
  /** Clones `url` into `dest`; resolves to the folder Draftline opened (the managed folder in a hybrid repo). */
  cloneFromUrl: (url: string, dest: string) => invoke<string>("clone_from_url", { url, dest }),
  /** Clones without claiming the repo; `project_path` is set when the repo already has a project. */
  cloneRepositoryForProject: (request: CloneRequest, onProgress: (event: CloneProgressEvent) => void) => {
    const channel = new Channel<CloneProgressEvent>();
    channel.onmessage = onProgress;
    return invoke<ClonedRepositoryResult>("clone_repository_for_project", {
      url: request.url,
      dest: request.dest,
      branch: request.branch ?? null,
      blobless: request.blobless,
      onProgress: channel,
    });
  },
  /** Creates CutReady folder `name` inside `parent` and records it in `.draftline`; commits nothing. */
  createProjectInRepository: (parent: string, name: string, baseBranch: string | null = null) =>
    invoke<InitProjectInRepositoryResult>("init_project_in_repository_for_project", { parent, name, baseBranch }),
  /** Looks at a repository URL or local checkout before downloading it; changes nothing. */
  inspectRepositoryForProject: (location: string) => invoke<RepositoryInspection>("inspect_repository_for_project", { location }),
  /** What the open hybrid project's `.draftline` records. */
  readProjectSettings: (workspacePath: string) =>
    invoke<ProjectSettings>("project_settings", { request: { workspace_path: workspacePath } }),
  /** Saves new project settings as their own version; null clears one. */
  saveProjectSettings: (workspacePath: string, baseBranch: string | null, commitTemplate: string | null) =>
    invoke<ProjectSettings>("update_project_settings", {
      request: { workspace_path: workspacePath, base_branch: baseBranch, commit_template: commitTemplate },
    }),
};

export interface CloneRequest {
  url: string;
  dest: string;
  branch?: string | null;
  /** Skip old file contents; servers that can't do this send everything. */
  blobless: boolean;
}

export type ClonedRepositoryResult = ClonedRepository & {
  /** True when the checkout skipped old file contents. */
  is_partial_clone: boolean;
};

export type ImportConflict = "overwrite" | "rename";

/** Commands that import an outside document into the open project as a note. */
export type NoteImportCommand = "import_pptx" | "import_docx" | "import_pdf" | "import_markdown";

export interface VideoImportProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

export interface VideoImportPlanningContextReference {
  kind: "sketch" | "storyboard" | "note";
  path: string;
  title: string;
}

export interface VideoImportPlanningContext {
  text: string;
  references: VideoImportPlanningContextReference[];
}

export interface VideoImportResult {
  sketch_path: string;
  note_path?: string;
  row_count: number;
  llm_refined: boolean;
  llm_refinement_status?: string | null;
}

export interface VideoImportOptions {
  llmConfig?: ReturnType<typeof buildProviderConfig>;
  planningContext?: VideoImportPlanningContext;
}

const withConflict = (filePath: string, conflict?: ImportConflict) => (conflict ? { filePath, conflict } : { filePath });

export const importIpc = {
  /** Imports `filePath` as a note and returns the note's project-relative path. */
  toNote: (command: NoteImportCommand, filePath: string, conflict?: ImportConflict) =>
    invoke<string>(command, withConflict(filePath, conflict)),
  /** Imports a `.sk` file; returns the sketch's project-relative path. */
  sketch: (filePath: string, conflict?: ImportConflict) => invoke<string>("import_sketch", withConflict(filePath, conflict)),
  /** Imports a `.sb` file; returns the storyboard's project-relative path. */
  storyboard: (filePath: string, conflict?: ImportConflict) =>
    invoke<string>("import_storyboard", withConflict(filePath, conflict)),
  /** Turns a demo video into a sketch, reporting each phase to `onProgress`. */
  videoWithProgress: (
    filePath: string,
    options: VideoImportOptions,
    onProgress: (progress: VideoImportProgress) => void,
    conflict?: ImportConflict,
  ) => {
    const channel = new Channel<VideoImportProgress>();
    channel.onmessage = onProgress;
    return invoke<VideoImportResult>("import_video_with_progress", {
      ...withConflict(filePath, conflict),
      ...(options.llmConfig ? { llmConfig: options.llmConfig } : {}),
      ...(options.planningContext ? { planningContext: options.planningContext } : {}),
      onProgress: channel,
    });
  },
};
