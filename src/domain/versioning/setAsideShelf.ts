/** Every "Set aside" gets its own shelf, so several can wait side by side. */
export const SET_ASIDE_SHELF_PREFIX = "cutready-setaside-";
/** The single shelf older builds used for "Set aside". Still listed and restorable. */
export const LEGACY_SET_ASIDE_SHELF = "cutready-stash";
/** Shown for shelves whose name couldn't be read back. */
export const DEFAULT_SET_ASIDE_NAME = "Set-aside changes";
/** Keeps the shelf's git ref path well under Windows' MAX_PATH. */
const MAX_ENCODED_NAME = 80;

export interface SetAsideShelf {
  id: string;
  name: string;
  /** When the work was set aside, epoch ms. */
  timeMs: number;
}

/** What a shelf looks like from Draftline: only the parts this module reads. */
export interface ShelfLike {
  id: string;
  version: { time_seconds: number };
}

/**
 * Git ref names forbid spaces and several punctuation marks, so the name is
 * percent-encoded down to letters, digits, `-`, `_` and `%`.
 */
function encodeName(name: string): string {
  return encodeURIComponent(name).replace(/[.!~*'()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeName(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded).trim() || null;
  } catch {
    return null;
  }
}

/** A unique shelf id carrying a readable name: prefix, epoch ms, random suffix, encoded name. */
export function setAsideShelfId(name: string, nowMs: number, random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  let chars = Array.from(name.trim().replace(/\s+/g, " "));
  let encoded = encodeName(chars.join(""));
  while (encoded.length > MAX_ENCODED_NAME) {
    chars = chars.slice(0, -1);
    encoded = encodeName(chars.join("").trimEnd());
  }
  return `${SET_ASIDE_SHELF_PREFIX}${Math.floor(nowMs)}-${suffix}${encoded ? `-${encoded}` : ""}`;
}

/** The name to record when work is set aside before an action, e.g. "Before switching to Draft 2". */
export function setAsideNameFor(target: string): string {
  const trimmed = target.trim();
  return trimmed ? `Before ${trimmed}` : DEFAULT_SET_ASIDE_NAME;
}

/** The readable name stored in a set-aside shelf id; null for other shelves. */
export function setAsideShelfName(id: string): string | null {
  if (id === LEGACY_SET_ASIDE_SHELF) return DEFAULT_SET_ASIDE_NAME;
  if (!id.startsWith(SET_ASIDE_SHELF_PREFIX)) return null;
  const match = /^\d+-[0-9a-z]+(?:-(.*))?$/.exec(id.slice(SET_ASIDE_SHELF_PREFIX.length));
  if (!match) return null;
  return (match[1] && decodeName(match[1])) || DEFAULT_SET_ASIDE_NAME;
}

/** The "Set aside" shelves, newest first. Discard shelves and others are left out. */
export function setAsideShelves(shelves: ShelfLike[]): SetAsideShelf[] {
  return shelves
    .flatMap((shelf) => {
      const name = setAsideShelfName(shelf.id);
      return name === null ? [] : [{ id: shelf.id, name, timeMs: shelf.version.time_seconds * 1000 }];
    })
    .sort((a, b) => b.timeMs - a.timeMs);
}
