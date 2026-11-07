import type { DiffEntry } from "../types/sketch";
import { loadChangeSummary, type ChangeSummary, type FileChangeInput, type FileStatus } from "../domain/changes";
import { listDraftlineChangedFiles, previewDraftlineWorkspaceDiffFile } from "./draftlineVersioning";

const STATUSES = new Set<FileStatus>(["added", "deleted", "modified", "renamed", "conflicted"]);

export function diffEntryToInput(entry: DiffEntry): FileChangeInput {
  const status = STATUSES.has(entry.status as FileStatus) ? (entry.status as FileStatus) : "modified";
  return { path: entry.path, status };
}

/** Reads the unsaved changes from Draftline and summarizes them per document. */
export async function loadWorkspaceChangeSummary(): Promise<ChangeSummary> {
  const entries = await listDraftlineChangedFiles();
  return loadChangeSummary(entries.map(diffEntryToInput), async (file) => {
    // Draftline doesn't report a rename's old path, so only same-path edits get structured detail.
    if (file.status === "renamed" && !file.previousPath) return null;
    const content = await previewDraftlineWorkspaceDiffFile(file.path);
    return {
      before: content.headPresent ? content.headContent : null,
      after: content.workingPresent ? content.workingContent : null,
      isBinary: content.isBinary,
    };
  });
}
