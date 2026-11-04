/** Parses a JSON object, returning null for missing, empty or malformed text. */
export function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The listed fields whose JSON values differ between the two objects. */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
}

/**
 * Keys present on both sides whose relative order changed: those outside the
 * longest run that kept its old order. Keys must be unique on each side.
 */
export function movedKeys(before: readonly string[], after: readonly string[]): Set<string> {
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  const position = new Map(before.filter((key) => afterSet.has(key)).map((key, index) => [key, index]));
  const reordered = after.filter((key) => beforeSet.has(key));
  const kept = longestIncreasingRun(reordered.map((key) => position.get(key) ?? 0));
  return new Set(reordered.filter((_, index) => !kept.has(index)));
}

/** Indexes of one longest strictly increasing subsequence. */
function longestIncreasingRun(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const previous: number[] = new Array(values.length).fill(-1);
  values.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[tails[mid]] < value) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  });
  const kept = new Set<number>();
  for (let index = tails.length ? tails[tails.length - 1] : -1; index >= 0; index = previous[index]) kept.add(index);
  return kept;
}

/** Labels repeated values by occurrence ("a", "a", "b" -> "a\u00000", "a\u00001", "b\u00000") so duplicates diff by count. */
export function occurrenceKeys(values: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const count = seen.get(value) ?? 0;
    seen.set(value, count + 1);
    return `${value}\u0000${count}`;
  });
}

export const keyValue = (key: string) => key.slice(0, key.lastIndexOf("\u0000"));
