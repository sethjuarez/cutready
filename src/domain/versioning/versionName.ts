/** Longest version name the form, Tauri and the facade accept. Mirrored in Rust. */
export const MAX_VERSION_NAME = 72;

/** Why a version name can't be saved, or null when it's fine. Save `normalizeVersionName(name)`. */
export function versionNameError(name: string): string | null {
  const trimmed = normalizeVersionName(name);
  if (!trimmed) return "Name the version";
  if ([...trimmed].length > MAX_VERSION_NAME) return `Keep it to ${MAX_VERSION_NAME} characters or fewer`;
  return null;
}

/** The name as saved: surrounding whitespace removed. Validation counts this value. */
export function normalizeVersionName(name: string): string {
  return name.trim();
}

/** The saved message: the name, then a blank line and the comment when there is one. */
export function versionMessage(name: string, comment = ""): string {
  const trimmedComment = comment.trim();
  const trimmedName = normalizeVersionName(name);
  return trimmedComment ? `${trimmedName}\n\n${trimmedComment}` : trimmedName;
}

/** Trims and shortens text to a valid version name (used for suggestions). */
export function clampVersionName(name: string): string {
  const firstLine = name.split(/\r?\n/, 1)[0].trim();
  const chars = [...firstLine];
  if (chars.length <= MAX_VERSION_NAME) return firstLine;
  return `${chars.slice(0, MAX_VERSION_NAME - 1).join("").trimEnd()}…`;
}
