/** The working copy, as one side of a comparison. */
export const WORKSPACE = "workspace";

export interface CompareTarget {
  /** Version ID of the older side. */
  from: string;
  /** Version ID of the newer side, or WORKSPACE. */
  to: string;
  fromLabel: string;
  toLabel: string;
  /** Draftline path of the one document to compare; null for every changed document. */
  path: string | null;
  documentTitle: string | null;
  /** Earlier Draftline paths of that document, so a compare from before a rename still finds it. */
  aliases?: string[];
}

const PREFIX = "cutready://compare?";

export function compareTabPath(target: CompareTarget): string {
  const params = new URLSearchParams({ from: target.from, to: target.to, fromLabel: target.fromLabel, toLabel: target.toLabel });
  if (target.path) params.set("path", target.path);
  if (target.documentTitle) params.set("title", target.documentTitle);
  for (const alias of target.aliases ?? []) if (alias !== target.path) params.append("alias", alias);
  return PREFIX + params.toString();
}

export function parseCompareTabPath(path: string): CompareTarget | null {
  if (!path.startsWith(PREFIX)) return null;
  const params = new URLSearchParams(path.slice(PREFIX.length));
  const from = params.get("from");
  const to = params.get("to");
  if (!from || !to) return null;
  return {
    from,
    to,
    fromLabel: params.get("fromLabel") || from.slice(0, 7),
    toLabel: params.get("toLabel") || (to === WORKSPACE ? "Now" : to.slice(0, 7)),
    path: params.get("path"),
    documentTitle: params.get("title"),
    ...(params.has("alias") ? { aliases: params.getAll("alias") } : {}),
  };
}

/** Every Draftline path the target's document has had; empty for a whole-project compare. */
export function comparePaths(target: CompareTarget): string[] {
  return target.path ? [target.path, ...(target.aliases ?? []).filter((alias) => alias !== target.path)] : [];
}

export function compareTabTitle(target: CompareTarget): string {
  const subject = target.documentTitle ? `${target.documentTitle}: ` : "";
  return `${subject}${target.fromLabel} ↔ ${target.toLabel}`;
}
