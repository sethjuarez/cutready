import type { DocumentKind, MediaType } from "./types";

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const VIDEO = /\.(mp4|mov|webm|mkv|avi|m4v)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i;

export function mediaTypeOf(path: string): MediaType | null {
  const normalized = path.replace(/\\/g, "/");
  if (/(^|\/)\.cutready\/visuals\/[^/]+\.json$/i.test(normalized)) return "visual";
  if (IMAGE.test(normalized)) return "image";
  if (VIDEO.test(normalized)) return "video";
  if (AUDIO.test(normalized)) return "audio";
  return null;
}

export function documentKindOf(path: string): DocumentKind {
  if (/\.sk$/i.test(path)) return "sketch";
  if (/\.sb$/i.test(path)) return "storyboard";
  if (/\.md$/i.test(path)) return "note";
  if (mediaTypeOf(path)) return "media";
  return "other";
}

/** File name without folders or the CutReady document extension. */
export function documentName(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return name.replace(/\.(sk|sb|md)$/i, "");
}
