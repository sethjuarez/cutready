import { useEffect, useState } from "react";
import { Copy, Eye, FileClock, RotateCcw } from "lucide-react";
import type { TimelineEntry } from "../../domain/history/timeline";
import type { HistoryDocument } from "../../stores/historyFilterStore";
import { useToastStore } from "../../stores/toastStore";
import { ContextMenu } from "../ContextMenu";
import { RestoreVersionDialog, type RestoreTarget } from "../versioning/RestoreVersionDialog";
import { historyEntryMenuItems } from "./historyEntryActions";

const ICONS: Record<string, React.ReactNode> = {
  preview: <Eye className="h-3.5 w-3.5" />,
  "restore-project": <RotateCcw className="h-3.5 w-3.5" />,
  "restore-document": <FileClock className="h-3.5 w-3.5" />,
  "copy-id": <Copy className="h-3.5 w-3.5" />,
};

function copyVersionId(id: string) {
  const toast = useToastStore.getState();
  const failed = () => toast.show("Couldn't copy the version ID", 4000, "error");
  if (!navigator.clipboard?.writeText) return failed();
  try {
    void navigator.clipboard.writeText(id).then(() => toast.show("Copied version ID", 2500, "success"), failed);
  } catch {
    failed();
  }
}

/**
 * Owns a timeline entry's ⋯ menu and the restore dialog its actions open. The
 * menu remembers only the version ID and reads the entry from the live
 * timeline, so a reload never leaves it acting on stale state.
 */
export function useHistoryEntryMenu(document: HistoryDocument | null, entries: TimelineEntry[], preview: (id: string) => void) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [restore, setRestore] = useState<RestoreTarget | null>(null);
  const entry = menu ? entries.find((candidate) => candidate.id === menu.id) ?? null : null;

  useEffect(() => {
    if (menu && !entry) setMenu(null);
  }, [menu, entry]);
  useEffect(() => setMenu(null), [document?.path]);

  const items = entry
    ? historyEntryMenuItems(entry, { documentTitle: document?.title ?? null }, {
      preview: (entry) => preview(entry.id),
      restoreProject: (entry) => setRestore({ versionId: entry.id, versionName: entry.name, scope: { kind: "project" } }),
      restoreDocument: (entry) => document && setRestore({
        versionId: entry.id,
        versionName: entry.name,
        scope: { kind: "documents", paths: [document.path] },
        labels: [document.title],
        removes: entry.pathChange === "Deleted",
      }),
      copyId: (entry) => copyVersionId(entry.id),
    }).map((item) => ({ ...item, icon: ICONS[item.id] }))
    : [];

  const element = (
    <>
      {menu && entry && <ContextMenu items={items} position={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} />}
      <RestoreVersionDialog target={restore} onClose={() => setRestore(null)} />
    </>
  );
  return { openMenu: (entry: TimelineEntry, x: number, y: number) => setMenu({ id: entry.id, x, y }), element };
}
