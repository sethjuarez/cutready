import { invoke } from "../services/tauri";

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

export function isProjectRelativeImagePath(path: string): boolean {
  const trimmed = path.trim();
  return (
    trimmed.length > 0 &&
    !URI_SCHEME_RE.test(trimmed) &&
    !trimmed.startsWith("/") &&
    !WINDOWS_DRIVE_RE.test(trimmed)
  );
}

export function projectRelativeScreenshotPath(src: string): string | null {
  const marker = ".cutready/screenshots/";
  const index = src.indexOf(marker);
  return index === -1 ? null : src.slice(index);
}

/**
 * Fetch a project image as a data URL via backend command.
 * Always works cross-platform regardless of asset protocol quirks.
 */
export async function fetchProjectImageDataUrl(relativePath: string): Promise<string> {
  return invoke<string>("read_project_image", { relativePath });
}
