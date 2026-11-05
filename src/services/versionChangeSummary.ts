import type { ChangeKind } from "@draftline/client";
import { loadChangeSummary, type ChangeSummary, type FileStatus } from "../domain/changes";
import { facade, requireWorkspacePath } from "./draftlineVersioning";

const STATUS: Record<ChangeKind, FileStatus> = {
  Added: "added",
  Modified: "modified",
  Deleted: "deleted",
  Renamed: "renamed",
  Conflicted: "conflicted",
  TypeChanged: "modified",
};

const CACHE_LIMIT = 200;
/** Versions never change, so a summary between two of them can be reused for the session. */
const cache = new Map<string, Promise<ChangeSummary>>();

async function compute(fromId: string, toId: string): Promise<ChangeSummary> {
  const f = facade();
  const diff = await f.diffVersions(fromId, toId);
  const read = async (version: string, path: string) => (await f.previewVersionFile(version, path)) ?? null;
  return loadChangeSummary(
    diff.files.map((file) => ({ path: file.path, status: STATUS[file.kind] ?? "modified", isBinary: file.is_binary })),
    async (file) => {
      // Draftline doesn't report a rename's old path, so only same-path edits get structured detail.
      if (file.isBinary || (file.status === "renamed" && !file.previousPath)) return null;
      const [before, after] = await Promise.all([read(fromId, file.path), read(toId, file.path)]);
      return {
        before: before?.content ?? null,
        after: after?.content ?? null,
        isBinary: Boolean(before?.is_binary || after?.is_binary),
      };
    },
  );
}

/** Document-aware summary of what changed between two versions. Failed loads aren't cached. */
export function loadVersionChangeSummary(fromId: string, toId: string): Promise<ChangeSummary> {
  let workspace: string;
  try {
    workspace = requireWorkspacePath();
  } catch (error) {
    return Promise.reject(error);
  }
  const key = `${workspace}\u0000${fromId}..${toId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = compute(fromId, toId);
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return promise;
}

export function clearVersionChangeSummaryCache() {
  cache.clear();
}
