import type { AssetInfo, NarrationAssetInfo } from "../stores/appStore";

/** What a library item is. Visuals are generated framing images, so they file under Images. */
export type MediaKind = "image" | "visual" | "video" | "audio";
export type MediaFilter = "all" | "images" | "video" | "audio" | "unused";

export const MEDIA_FILTERS: { id: MediaFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "images", label: "Images" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "unused", label: "Unused" },
];

/** One file in the project's media library, with the documents that use it. */
export interface MediaItem {
  path: string;
  name: string;
  kind: MediaKind;
  size: number;
  modifiedAt: number;
  /** Sketches (.sk) that reference this file, deduplicated. */
  sketches: string[];
  /** Notes (.md) that reference this file, deduplicated. */
  notes: string[];
}

/** Folders the app manages; only files in these can be removed from the library. */
const MANAGED_PREFIXES = [".cutready/screenshots/", ".cutready/visuals/", ".cutready/narration/"];

const fileName = (path: string) => path.split("/").pop() ?? path;

function splitReferences(referencedBy: readonly string[]) {
  const unique = [...new Set(referencedBy)];
  return {
    sketches: unique.filter((ref) => ref.endsWith(".sk")),
    notes: unique.filter((ref) => ref.endsWith(".md")),
  };
}

function audioOrVideo(mimeType: string): MediaKind {
  return mimeType.startsWith("video/") ? "video" : "audio";
}

/** Merge images, visuals and narration takes into one library, newest first. */
export function toMediaItems(assets: readonly AssetInfo[], narrations: readonly NarrationAssetInfo[]): MediaItem[] {
  const items: MediaItem[] = [
    ...assets.map((asset) => ({
      path: asset.path,
      name: fileName(asset.path),
      kind: (asset.assetType === "visual" ? "visual" : "image") as MediaKind,
      size: asset.size,
      modifiedAt: asset.modifiedAt ?? 0,
      ...splitReferences(asset.referencedBy),
    })),
    ...narrations.map((take) => ({
      path: take.path,
      name: fileName(take.path),
      kind: audioOrVideo(take.mimeType),
      size: take.size,
      modifiedAt: take.modifiedAt ?? 0,
      ...splitReferences(take.referencedBy),
    })),
  ];
  return items.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
}

/** Not referenced by any sketch or note. */
export function isUnused(item: MediaItem): boolean {
  return item.sketches.length === 0 && item.notes.length === 0;
}

function matchesFilter(item: MediaItem, filter: MediaFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "images": return item.kind === "image" || item.kind === "visual";
    case "video": return item.kind === "video";
    case "audio": return item.kind === "audio";
    case "unused": return isUnused(item);
  }
}

/** Items for a filter chip, narrowed by a case-insensitive name search. */
export function filterMedia(items: readonly MediaItem[], filter: MediaFilter, query = ""): MediaItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter((item) => matchesFilter(item, filter) && (!needle || item.name.toLowerCase().includes(needle)));
}

/** Count per filter chip, ignoring search. */
export function filterCounts(items: readonly MediaItem[]): Record<MediaFilter, number> {
  const counts = { all: 0, images: 0, video: 0, audio: 0, unused: 0 } as Record<MediaFilter, number>;
  for (const item of items) {
    for (const { id } of MEDIA_FILTERS) if (matchesFilter(item, id)) counts[id] += 1;
  }
  return counts;
}

/**
 * What "Remove unused" would do: unused files in app-managed folders are removed;
 * unused files elsewhere in the project are listed as kept, never deleted.
 */
export function removalPlan(items: readonly MediaItem[]): { remove: MediaItem[]; keep: MediaItem[] } {
  const unused = items.filter(isUnused);
  const managed = (item: MediaItem) => MANAGED_PREFIXES.some((prefix) => item.path.startsWith(prefix));
  return { remove: unused.filter(managed), keep: unused.filter((item) => !managed(item)) };
}

/** Paths to pass to each delete command, split by the folder that owns them. */
export function removalPaths(remove: readonly MediaItem[]): { images: string[]; narrations: string[] } {
  return {
    images: remove.filter((item) => !item.path.startsWith(".cutready/narration/")).map((item) => item.path),
    narrations: remove.filter((item) => item.path.startsWith(".cutready/narration/")).map((item) => item.path),
  };
}

const plural = (count: number, word: "sketch" | "note") =>
  `${count} ${word}${count === 1 ? "" : word === "sketch" ? "es" : "s"}`;

/** "Used in 2 sketches", "Used in 1 sketch and 1 note", or "Unused". */
export function usedInLabel(item: MediaItem): string {
  const parts = [
    item.sketches.length > 0 && plural(item.sketches.length, "sketch"),
    item.notes.length > 0 && plural(item.notes.length, "note"),
  ].filter(Boolean);
  return parts.length === 0 ? "Unused" : `Used in ${parts.join(" and ")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
