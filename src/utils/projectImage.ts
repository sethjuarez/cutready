import { invoke, convertFileSrc } from "@tauri-apps/api/core";

/**
 * Resolve a project-relative image path to a displayable URL.
 *
 * Strategy:
 * 1. Try the asset protocol via convertFileSrc (works on Windows).
 * 2. If on macOS or asset protocol fails, fall back to reading
 *    the image via a Tauri command and returning a data URL.
 *
 * Use this instead of raw convertFileSrc for project images.
 */
export function resolveProjectImageUrl(projectRoot: string, relativePath: string): string {
  return convertFileSrc(`${projectRoot}/${relativePath}`);
}

/**
 * Fetch a project image as a data URL via backend command.
 * Always works cross-platform regardless of asset protocol quirks.
 */
export async function fetchProjectImageDataUrl(relativePath: string): Promise<string> {
  return invoke<string>("read_project_image", { relativePath });
}
