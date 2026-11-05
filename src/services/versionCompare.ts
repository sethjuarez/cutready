import type { ChangeKind, ChangedFile } from "@draftline/client";
import { compareFile, type FileComparison } from "../domain/compare/compareFile";
import { WORKSPACE } from "../domain/compare/compareTarget";
import type { FileStatus } from "../domain/changes";
import { fetchProjectImageDataUrl } from "../utils/projectImage";
import { facade } from "./draftlineVersioning";

const STATUS: Record<ChangeKind, FileStatus> = {
  Added: "added",
  Modified: "modified",
  Deleted: "deleted",
  Renamed: "renamed",
  Conflicted: "conflicted",
  TypeChanged: "modified",
};

export interface ComparedFile {
  /** Draftline path. */
  path: string;
  status: FileStatus;
  isBinary: boolean;
}

/** One side of an image comparison. */
export type ImageSide =
  | { state: "absent" }
  | { state: "ready"; src: string }
  | { state: "unavailable"; reason: string };

export type LoadedComparison =
  | Exclude<FileComparison, { view: "media" }>
  | { view: "media"; before: ImageSide; after: ImageSide };

/** Every file that differs between two sides; `to` may be WORKSPACE. Non-empty `paths` keeps only those. */
export async function listComparedFiles(from: string, to: string, paths: readonly string[] = []): Promise<ComparedFile[]> {
  const f = facade();
  const diff = to === WORKSPACE ? await f.diffVersionToWorkspace(from) : await f.diffVersions(from, to);
  const wanted = new Set(paths);
  return diff.files
    .filter((file: ChangedFile) => wanted.size === 0 || wanted.has(file.path))
    .map((file: ChangedFile) => ({ path: file.path, status: STATUS[file.kind] ?? "modified", isBinary: file.is_binary }));
}

async function readText(side: string, path: string) {
  const f = facade();
  const file = side === WORKSPACE ? await f.previewWorkspaceFile(path) : await f.previewVersionFile(side, path);
  return file ? { content: file.content ?? null, isBinary: file.is_binary } : null;
}

export interface CompareImageReader {
  /** Reads a working-copy image by Draftline path; null when it's outside the open project. */
  workspaceImage: (path: string) => Promise<string | null>;
}

async function imageSide(side: string, file: ComparedFile, present: boolean, reader: CompareImageReader): Promise<ImageSide> {
  if (!present) return { state: "absent" };
  if (side !== WORKSPACE) return { state: "unavailable", reason: "Preview not available for this version" };
  const src = await reader.workspaceImage(file.path).catch(() => null);
  return src ? { state: "ready", src } : { state: "unavailable", reason: "Couldn't load this image" };
}

/** A renamed file's older side lives at a previous path; Draftline diffs only name the new one. */
async function readRenamedBefore(from: string, file: ComparedFile, aliases: readonly string[]) {
  for (const alias of aliases) {
    if (alias === file.path) continue;
    const found = await readText(from, alias);
    if (found) return found;
  }
  return null;
}

const RENAMED = "This document was renamed. Comparing across a rename isn't supported here yet; filter History to the document to compare it.";

/**
 * Loads both sides of one changed file and builds its document-aware
 * comparison. `aliases` are the document's earlier paths, used to find a
 * renamed file's older side.
 */
export async function loadFileComparison(
  from: string,
  to: string,
  file: ComparedFile,
  reader: CompareImageReader,
  aliases: readonly string[] = [],
): Promise<LoadedComparison> {
  const beforePresent = file.status !== "added";
  const afterPresent = file.status !== "deleted";
  const [before, after] = await Promise.all([
    !beforePresent ? null : file.status === "renamed" ? readRenamedBefore(from, file, aliases) : readText(from, file.path),
    afterPresent ? readText(to, file.path) : null,
  ]);
  if (file.status === "renamed" && !before) return { view: "unavailable", reason: RENAMED };
  const comparison = compareFile({
    path: file.path,
    before: before?.content ?? null,
    after: after?.content ?? null,
    isBinary: file.isBinary || Boolean(before?.isBinary || after?.isBinary),
  });
  if (comparison.view !== "media") return comparison;
  const [beforeImage, afterImage] = await Promise.all([
    imageSide(from, file, beforePresent, reader),
    imageSide(to, file, afterPresent, reader),
  ]);
  return { view: "media", before: beforeImage, after: afterImage };
}

/** Reads working-copy images through the project's image command, which takes active-project paths. */
export function projectImageReader(toProjectPath: (path: string) => string | null): CompareImageReader {
  return {
    workspaceImage: async (path) => {
      const projectPath = toProjectPath(path);
      return projectPath === null ? null : fetchProjectImageDataUrl(projectPath);
    },
  };
}
