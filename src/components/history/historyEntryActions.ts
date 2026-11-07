import type { ContextMenuItem } from "../ContextMenu";
import type { TimelineEntry } from "../../domain/history/timeline";

export interface HistoryEntryHandlers {
  preview: (entry: TimelineEntry) => void;
  compareWithPrevious: (entry: TimelineEntry) => void;
  compareWithNow: (entry: TimelineEntry) => void;
  restoreProject: (entry: TimelineEntry) => void;
  restoreDocument: (entry: TimelineEntry) => void;
  copyId: (entry: TimelineEntry) => void;
}

/**
 * The ⋯ menu for one timeline entry. "Restore this document" only appears in a
 * per-document timeline. Compare with previous needs a parent version. Restoring the version you're already on is disabled:
 * with nothing unsaved it changes nothing, and with unsaved work setting it
 * aside already gets you there (use Discard to drop the work instead).
 */
export function historyEntryMenuItems(
  entry: TimelineEntry,
  options: { documentTitle: string | null },
  on: HistoryEntryHandlers,
): Array<ContextMenuItem & { id: string }> {
  const noop = entry.isCurrent;
  const items: Array<ContextMenuItem & { id: string }> = [
    { id: "preview", label: "Preview", action: () => on.preview(entry) },
    { id: "compare-previous", label: "Compare with previous", disabled: !entry.parentId, action: () => on.compareWithPrevious(entry) },
    { id: "compare-now", label: "Compare with now", action: () => on.compareWithNow(entry) },
    { id: "separator-restore", separator: true },
    { id: "restore-project", label: "Restore project", disabled: noop, action: () => on.restoreProject(entry) },
  ];
  if (options.documentTitle) {
    items.push({ id: "restore-document", label: `Restore ${options.documentTitle}`, disabled: noop, action: () => on.restoreDocument(entry) });
  }
  items.push({ id: "separator-copy", separator: true }, { id: "copy-id", label: "Copy ID", action: () => on.copyId(entry) });
  return items;
}
