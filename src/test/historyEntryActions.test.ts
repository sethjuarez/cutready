import { describe, expect, it, vi } from "vitest";
import { historyEntryMenuItems } from "../components/history/historyEntryActions";
import type { TimelineEntry } from "../domain/history/timeline";

const entry: TimelineEntry = {
  id: "v1", name: "Draft", comment: null, author: "Ada", timeSeconds: 1, parentId: null, isMerge: false, isCurrent: false, sent: null,
};
const handlers = () => ({ preview: vi.fn(), restoreProject: vi.fn(), restoreDocument: vi.fn(), copyId: vi.fn() });

describe("historyEntryMenuItems", () => {
  it("lists project actions, adding Restore document only in a per-document timeline", () => {
    const ids = (title: string | null) =>
      historyEntryMenuItems(entry, { documentTitle: title}, handlers()).filter((i) => !i.separator).map((i) => i.label);
    expect(ids(null)).toEqual(["Preview", "Restore project", "Copy ID"]);
    expect(ids("Intro")).toEqual(["Preview", "Restore project", "Restore Intro", "Copy ID"]);
  });

  it("disables restoring the version you're already on, unsaved work or not", () => {
    const restores = (e: TimelineEntry) =>
      historyEntryMenuItems(e, { documentTitle: "Intro" }, handlers()).filter((i) => i.id.startsWith("restore"));
    expect(restores({ ...entry, isCurrent: true }).every((i) => i.disabled)).toBe(true);
    expect(restores(entry).some((i) => i.disabled)).toBe(false);
  });

  it("routes each action to its handler with the entry", () => {
    const on = handlers();
    for (const item of historyEntryMenuItems(entry, { documentTitle: "Intro"}, on)) item.action?.();
    for (const fn of Object.values(on)) expect(fn).toHaveBeenCalledWith(entry);
  });
});
