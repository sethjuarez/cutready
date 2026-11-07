// The sidebar's project-wide "Import…" row: click to pick files, chevron for the other sources.
import { useState, type MouseEvent } from "react";
import { useAppStore } from "../../stores/appStore";
import { useImportStore, type ImportRequest } from "../../stores/importStore";
import { ContextMenu } from "../ContextMenu";
import { NavIcon } from "../navIcons";

export function ImportNavRow() {
  const root = useAppStore((s) => s.currentProject?.root ?? null);
  const busy = useImportStore((s) => s.busy);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  if (!root) return null;

  const start = (request: ImportRequest) => useImportStore.getState().requestImport(request, root);
  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuAt({ x: rect.left, y: rect.bottom + 4 });
  };

  return (
    <div className="cr-trow" data-menu-open={menuAt ? "true" : undefined}>
      <button
        type="button"
        className="cr-nv"
        onClick={() => start({ kind: "files" })}
        disabled={busy}
        aria-busy={busy || undefined}
        title="Import files into this project (or drop them on the sidebar)"
        data-testid="explorer-import-menu"
      >
        <span className={`ico${busy ? " animate-pulse" : ""}`}><NavIcon name="import" size={16} /></span>
        <span className="lbl">{busy ? "Importing…" : "Import…"}</span>
      </button>
      <span className="acts">
        <button
          type="button"
          onClick={openMenu}
          disabled={busy}
          aria-label="More import options"
          title="More import options"
          aria-haspopup="menu"
          aria-expanded={menuAt ? true : false}
          data-testid="explorer-import-more"
        >
          <NavIcon name="chevD" size={14} />
        </button>
      </span>
      {menuAt && (
        <ContextMenu
          position={menuAt}
          onClose={() => setMenuAt(null)}
          items={[
            { label: "Files…", icon: <NavIcon name="import" size={14} />, action: () => start({ kind: "files" }) },
            { label: "Video as sketch…", icon: <NavIcon name="clapper" size={14} />, action: () => start({ kind: "video" }) },
            { separator: true },
            { label: "Paste from clipboard…", icon: <NavIcon name="note" size={14} />, action: () => start({ kind: "clipboard" }) },
          ]}
        />
      )}
    </div>
  );
}
