const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** Raster formats by their leading bytes. */
function sniffRaster(dataBase64: string): string | null {
  let head: string;
  try {
    head = atob(dataBase64.slice(0, 16));
  } catch {
    return null;
  }
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  if (head.startsWith("BM") && head.length >= 6) return "image/bmp";
  return null;
}

/** Base64 of "version https://git-lfs", the first line of a Git LFS pointer file. */
const LFS_POINTER = "dmVyc2lvbiBodHRwczovL2dpdC1sZnM";

export type VersionImage = { state: "ready"; src: string } | { state: "unavailable"; reason: string };

/** The image MIME type: the leading bytes win for raster formats, else the extension. */
export function imageMimeType(path: string, dataBase64: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return sniffRaster(dataBase64) ?? MIME_BY_EXTENSION[extension] ?? null;
}

/** A displayable image from a version's base64 bytes; Draftline returns no MIME type. */
export function versionImage(path: string, dataBase64: string): VersionImage {
  if (dataBase64.startsWith(LFS_POINTER)) return { state: "unavailable", reason: "Stored with Git LFS, so there's no preview of this version" };
  const mime = imageMimeType(path, dataBase64);
  return mime ? { state: "ready", src: `data:${mime};base64,${dataBase64}` } : { state: "unavailable", reason: "Preview not available for this version" };
}
