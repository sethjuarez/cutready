/** Every discard gets its own shelf, so Undo restores exactly that discard. */
export const DISCARD_SHELF_PREFIX = "cutready-discard-";
/** Discard shelves older than this are pruned when a project opens. */
export const DISCARD_SHELF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A unique, sortable shelf name: prefix, epoch ms, random suffix. */
export function discardShelfName(nowMs: number, random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0");
  return `${DISCARD_SHELF_PREFIX}${Math.floor(nowMs)}-${suffix}`;
}

/** When a discard shelf was made, from its name; null for other shelves. */
export function discardShelfTime(id: string): number | null {
  if (!id.startsWith(DISCARD_SHELF_PREFIX)) return null;
  const match = /^(\d+)-[0-9a-z]+$/.exec(id.slice(DISCARD_SHELF_PREFIX.length));
  if (!match) return null;
  const ms = Number(match[1]);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** Discard shelves past the age limit. Other shelves (e.g. "Set aside") are never pruned. */
export function discardShelvesToPrune(
  shelfIds: string[],
  nowMs: number,
  maxAgeMs = DISCARD_SHELF_MAX_AGE_MS,
): string[] {
  return shelfIds.filter((id) => {
    const made = discardShelfTime(id);
    return made !== null && nowMs - made > maxAgeMs;
  });
}
