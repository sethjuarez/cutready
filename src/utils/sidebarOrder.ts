/** Sort items by manifest order. Items not in the manifest go at the end. */
export function applySidebarOrder<T extends { path: string }>(items: T[], order: string[]): T[] {
  if (!order.length) return items;
  const indexMap = new Map(order.map((p, i) => [p, i]));
  return [...items].sort((a, b) => {
    const ai = indexMap.get(a.path) ?? Infinity;
    const bi = indexMap.get(b.path) ?? Infinity;
    return ai - bi;
  });
}
