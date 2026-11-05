import type { ChangeKind, ChangedFile } from "@draftline/client";
import { compareFile, type FileComparison } from "../domain/compare/compareFile";
import { WORKSPACE } from "../domain/compare/compareTarget";
import { versionImage } from "../domain/compare/imageData";
import type { FileStatus } from "../domain/changes";
import { fetchProjectImageDataUrl } from "../utils/projectImage";
import { fileTooLargeMessage } from "./draftlineErrors";
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

/** One workspace's facade, captured once so a project switch mid-load can't mix data. */
type Facade = ReturnType<typeof facade>;

async function readText(f: Facade, side: string, path: string) {
  const file = side === WORKSPACE ? await f.previewWorkspaceFile(path) : await f.previewVersionFile(side, path);
  return file ? { path, content: file.content ?? null, isBinary: file.is_binary } : null;
}

export interface CompareImageReader {
  /** Reads a working-copy image by Draftline path; null when it's outside the open project. */
  workspaceImage: (path: string) => Promise<string | null>;
}

const NO_VERSION_PREVIEW = "Preview not available for this version";

/** A version's copy of an image; a denied or missing file and an over-cap one fall back to a message. */
async function versionImageSide(f: Facade, version: string, path: string): Promise<ImageSide> {
  try {
    const bytes = await f.readVersionFileBytes(version, path);
    return bytes ? versionImage(path, bytes.data_base64) : { state: "unavailable", reason: NO_VERSION_PREVIEW };
  } catch (err) {
    return { state: "unavailable", reason: fileTooLargeMessage(err) ?? NO_VERSION_PREVIEW };
  }
}

async function imageSide(f: Facade, side: string, path: string, present: boolean, reader: CompareImageReader): Promise<ImageSide> {
  if (!present) return { state: "absent" };
  if (side !== WORKSPACE) return versionImageSide(f, side, path);
  const src = await reader.workspaceImage(path).catch(() => null);
  return src ? { state: "ready", src } : { state: "unavailable", reason: "Couldn't load this image" };
}

/** A renamed file's older side lives at a previous path; Draftline diffs only name the new one. */
async function readRenamedBefore(f: Facade, from: string, file: ComparedFile, aliases: readonly string[]) {
  for (const alias of aliases) {
    if (alias === file.path) continue;
    const found = await readText(f, from, alias);
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
  const f = facade();
  const beforePresent = file.status !== "added";
  const afterPresent = file.status !== "deleted";
  const [before, after] = await Promise.all([
    !beforePresent ? null : file.status === "renamed" ? readRenamedBefore(f, from, file, aliases) : readText(f, from, file.path),
    afterPresent ? readText(f, to, file.path) : null,
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
    imageSide(f, from, before?.path ?? file.path, beforePresent, reader),
    imageSide(f, to, file.path, afterPresent, reader),
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
