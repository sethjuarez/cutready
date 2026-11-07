// After unsent saves are replayed on top of the team's work, each of them has a
// new version id. Everything the app holds by version id follows the new ids;
// ids the team's work already contained ("dropped") are gone.
//
// Only the frontend holds version ids: open preview, file-diff and Compare
// tabs (persisted with the workspace's tabs), the timeline a person started
// from a save, and the diff selection. The op log and agent state store no
// version ids (the op log keys documents by content hash).
import { compareTabPath, compareTabTitle, parseCompareTabPath, WORKSPACE } from "../compare/compareTarget";
import { parseSnapshotDiffTarget, snapshotDiffTabPath } from "./snapshotDiffTab";

export interface RebasedIds {
  /** Old id → new id for each replayed save. */
  rewritten: ReadonlyMap<string, string>;
  /** Ids that no longer exist. */
  dropped: ReadonlySet<string>;
}

export function rebasedIds(rewritten: readonly { from: string; to: string }[], dropped: readonly string[]): RebasedIds {
  return { rewritten: new Map(rewritten.map(({ from, to }) => [from, to])), dropped: new Set(dropped) };
}

export function hasRebasedIds(ids: RebasedIds): boolean {
  return ids.rewritten.size > 0 || ids.dropped.size > 0;
}

/** The id after the rebase, or null if it no longer exists. Unaffected ids pass through. */
export function remapId(id: string, ids: RebasedIds): string | null {
  if (ids.dropped.has(id)) return null;
  return ids.rewritten.get(id) ?? id;
}

/** A label that was only the short id follows the id. */
function remapLabel(label: string, before: string, after: string): string {
  return label === before.slice(0, 7) ? after.slice(0, 7) : label;
}

interface Tab {
  id: string;
  type: string;
  path: string;
  title: string;
}

const SNAPSHOT_PREFIX = "snapshot:";

/** The tab after the rebase: same tab, renamed for new ids, or null when its version is gone. */
export function remapTab<T extends Tab>(tab: T, ids: RebasedIds, makeId: (type: T["type"], path: string) => string): T | null {
  if (tab.type === "snapshot-preview" && tab.path.startsWith(SNAPSHOT_PREFIX)) {
    const before = tab.path.slice(SNAPSHOT_PREFIX.length);
    const after = remapId(before, ids);
    if (after === null) return null;
    if (after === before) return tab;
    const path = SNAPSHOT_PREFIX + after;
    return { ...tab, id: makeId(tab.type, path), path };
  }
  if (tab.type === "compare") {
    const target = parseCompareTabPath(tab.path);
    if (!target) return tab;
    const from = remapId(target.from, ids);
    const to = target.to === WORKSPACE ? WORKSPACE : remapId(target.to, ids);
    if (from === null || to === null) return null;
    if (from === target.from && to === target.to) return tab;
    const next = {
      ...target,
      from,
      to,
      fromLabel: remapLabel(target.fromLabel, target.from, from),
      toLabel: remapLabel(target.toLabel, target.to, to),
    };
    const path = compareTabPath(next);
    const relabeled = next.fromLabel !== target.fromLabel || next.toLabel !== target.toLabel;
    return { ...tab, id: makeId(tab.type, path), path, title: relabeled ? compareTabTitle(next) : tab.title };
  }
  if (tab.type === "diff") {
    const target = parseSnapshotDiffTarget(tab.path);
    if (!target) return tab;
    const after = remapId(target.snapshotId, ids);
    if (after === null) return null;
    if (after === target.snapshotId) return tab;
    const path = snapshotDiffTabPath(after, target.filePath);
    return { ...tab, id: makeId(tab.type, path), path };
  }
  return tab;
}

/**
 * One editor group after the rebase: tabs renamed in place (the active one
 * followed), plus the ids of tabs whose version is gone, for the caller to close.
 */
export function remapTabGroup<T extends Tab>(
  tabs: readonly T[],
  activeTabId: string | null,
  ids: RebasedIds,
  makeId: (type: T["type"], path: string) => string,
): { tabs: T[]; activeTabId: string | null; gone: string[] } {
  const gone: string[] = [];
  let active = activeTabId;
  const next = tabs.map((tab) => {
    const mapped = remapTab(tab, ids, makeId);
    if (mapped === null) {
      gone.push(tab.id);
      return tab;
    }
    if (tab.id === activeTabId) active = mapped.id;
    return mapped;
  });
  return { tabs: next, activeTabId: active, gone };
}